import { expect, spyOn, test } from "bun:test"

import { Cause, Clock, Effect, Exit, Fiber, PubSub, Scope } from "effect"
import { TestClock } from "effect/testing"

import { makeClaudeLifecycleHooks, type ClaudeLifecycleHooks } from "../../src/infrastructure/providers/claude/lifecycle-hooks"

function connection(hooks: ClaudeLifecycleHooks) {
  const settings = JSON.parse(hooks.settings)
  const hook = settings.hooks.Stop[0].hooks[0]
  return {
    url: hook.url as string,
    headers: { Authorization: `Bearer ${hooks.env.CLAUDE_TREE_HOOK_TOKEN}` },
  }
}

test("installs only additive observational Stop and StopFailure HTTP hooks", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const hooks = (yield* makeClaudeLifecycleHooks("session"))!
    const { url, headers } = connection(hooks)
    expect(JSON.parse(hooks.settings)).toEqual({ hooks: {
      Stop: [{ hooks: [{ type: "http", url, timeout: 1,
        headers: { Authorization: "Bearer ${CLAUDE_TREE_HOOK_TOKEN}" },
        allowedEnvVars: ["CLAUDE_TREE_HOOK_TOKEN"] }] }],
      StopFailure: [{ hooks: [{ type: "http", url, timeout: 1,
        headers: { Authorization: "Bearer ${CLAUDE_TREE_HOOK_TOKEN}" },
        allowedEnvVars: ["CLAUDE_TREE_HOOK_TOKEN"] }] }],
    } })
    expect(new URL(url).hostname).toBe("127.0.0.1")
    expect(hooks.settings).not.toContain(hooks.env.CLAUDE_TREE_HOOK_TOKEN!)
    expect(PubSub.capacity(hooks.activityHints)).toBe(1)
    // Publication is valid before subscription; the supervisor subscribes before spawn.
    const send = (event: string) => Effect.promise(() => fetch(url, {
      method: "POST", headers, body: JSON.stringify({ session_id: "session", hook_event_name: event,
        last_assistant_message: "discard this", error: "discard this too" }),
    }))
    expect((yield* send("Stop")).status).toBe(200)
    const subscription = yield* PubSub.subscribe(hooks.activityHints)
    for (const event of ["Stop", "StopFailure"]) {
      const response = yield* send(event)
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toEqual({})
      expect(yield* PubSub.take(subscription)).toBe("reconcile")
    }
    yield* send("Stop")
    yield* send("StopFailure")
    expect(yield* PubSub.size(hooks.activityHints)).toBe(1)
    expect(yield* PubSub.take(subscription)).toBe("reconcile")
  })))
})

test("authenticates before validating method, path, JSON, session, and subagent fields", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const hooks = (yield* makeClaudeLifecycleHooks("session"))!
    const { url, headers } = connection(hooks)
    yield* PubSub.subscribe(hooks.activityHints)
    const valid = { session_id: "session", hook_event_name: "Stop" }
    const cases: Array<[string, RequestInit, number]> = [
      [url, { method: "POST", body: "not json" }, 401],
      [url, { method: "POST", headers: { Authorization: "Bearer wrong" }, body: JSON.stringify(valid) }, 401],
      [url, { method: "GET", headers }, 405],
      [url + "/wrong", { method: "POST", headers, body: JSON.stringify(valid) }, 404],
      ...["not json", "null", "[]", "{}", JSON.stringify({ ...valid, session_id: "other" }),
        JSON.stringify({ ...valid, hook_event_name: "SubagentStop" }),
        JSON.stringify({ ...valid, agent_id: "child" }), JSON.stringify({ ...valid, agent_id: null }),
      ].map((body): [string, RequestInit, number] => [url, { method: "POST", headers, body }, 400]),
      [url, { method: "POST", headers, body: "x".repeat(65 * 1024) }, 413],
    ]
    for (const [target, init, status] of cases) {
      const response = yield* Effect.promise(() => fetch(target, init))
      expect(response.status).toBe(status)
      expect(yield* PubSub.size(hooks.activityHints)).toBe(0)
    }
  })))
})

test("explicit close is idempotent, shuts down hints, and makes the endpoint unreachable", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const hooks = (yield* makeClaudeLifecycleHooks("session"))!
    const { url } = connection(hooks)
    yield* Effect.all([hooks.close, hooks.close], { concurrency: "unbounded" })
    yield* hooks.close
    expect(yield* PubSub.isShutdown(hooks.activityHints)).toBeTrue()
    yield* Effect.promise(async () => { await expect(fetch(url)).rejects.toThrow() })
  })))
})

test("scope closure is a cleanup backstop", async () => {
  const hooks = (await Effect.runPromise(Effect.scoped(makeClaudeLifecycleHooks("session"))))!
  expect(await Effect.runPromise(PubSub.isShutdown(hooks.activityHints))).toBeTrue()
  await expect(fetch(connection(hooks).url)).rejects.toThrow()
})

test("bind failure falls back only after shutting down its hint resource", async () => {
  const shutdown = spyOn(PubSub, "shutdown")
  try {
    const result = await Effect.runPromise(Effect.scoped(makeClaudeLifecycleHooks("session", () => {
      throw new Error("bind unavailable")
    })))
    expect(result).toBeUndefined()
    expect(shutdown).toHaveBeenCalledTimes(1)
    const hints = shutdown.mock.calls[0]![0]
    expect(await Effect.runPromise(PubSub.isShutdown(hints))).toBeTrue()
  } finally {
    shutdown.mockRestore()
  }
})

test("cleanup failures remain typed and retryable rather than optional fallback", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    let stops = 0
    const hooks = (yield* makeClaudeLifecycleHooks("session", () => ({
      port: 1234,
      stop: async () => { if (++stops === 1) throw new Error("stop failed") },
    })))!
    const result = yield* Effect.result(hooks.close)
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderCleanupError" } })
    expect(yield* PubSub.isShutdown(hooks.activityHints)).toBeTrue()
    yield* hooks.close
    yield* hooks.close
    expect(stops).toBe(2)
  })))
})

test("bounds streamed bodies and concurrent readers, cancelling active requests on close", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    let handle!: (request: Request) => Promise<Response>
    const hooks = (yield* makeClaudeLifecycleHooks("session", (fetch) => {
      handle = fetch
      return { port: 1234, stop: async () => {} }
    }))!
    const { url, headers } = connection(hooks)
    yield* PubSub.subscribe(hooks.activityHints)
    let cancelled = 0
    const stream = () => new ReadableStream<Uint8Array>({ cancel() { cancelled += 1 } })
    const requests = Array.from({ length: 4 }, () => handle(new Request(url, {
      method: "POST", headers, body: stream(),
    })))
    const excess = yield* Effect.promise(() => handle(new Request(url, {
      method: "POST", headers, body: "{}",
    })))
    expect(excess.status).toBe(429)
    yield* hooks.close
    const responses = yield* Effect.promise(() => Promise.all(requests))
    expect(responses.map((response) => response.status)).toEqual([503, 503, 503, 503])
    expect(cancelled).toBe(4)
    expect(PubSub.publishUnsafe(hooks.activityHints, "reconcile")).toBeFalse()
  })))

  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    let handle!: (request: Request) => Promise<Response>
    const hooks = (yield* makeClaudeLifecycleHooks("session", (fetch) => {
      handle = fetch
      return { port: 1234, stop: async () => {} }
    }))!
    const { url, headers } = connection(hooks)
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024))
        controller.enqueue(new Uint8Array(32 * 1024 + 1))
      },
      cancel() { cancelled = true },
    })
    expect((yield* Effect.promise(() => handle(new Request(url, { method: "POST", headers, body })))).status).toBe(413)
    expect(cancelled).toBeTrue()
  })))
})

test("request deadline cancels a stalled body without publishing a hint", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    let handle!: (request: Request) => Promise<Response>
    const hooks = (yield* makeClaudeLifecycleHooks("session", (fetch) => {
      handle = fetch
      return { port: 1234, stop: async () => {} }
    }))!
    const { url, headers } = connection(hooks)
    yield* PubSub.subscribe(hooks.activityHints)
    let cancelled = false
    const timer = spyOn(globalThis, "setTimeout")
    let response: Promise<Response>
    try {
      response = handle(new Request(url, { method: "POST", headers,
        body: new ReadableStream({ cancel() { cancelled = true } }),
      }))
      const [deadline, delay] = timer.mock.calls.at(-1)!
      expect(delay).toBe(750)
      if (typeof deadline !== "function") throw new Error("Missing request deadline")
      deadline()
    } finally {
      timer.mockRestore()
    }
    expect((yield* Effect.promise(() => response)).status).toBe(408)
    expect(cancelled).toBeTrue()
    expect(yield* PubSub.size(hooks.activityHints)).toBe(0)
  })))
})

test("stalled explicit cleanup reports within the supervisor deadline and scope safely retries", async () => {
  await Effect.runPromise(Effect.provide(Effect.gen(function*() {
    const scope = yield* Scope.make()
    let stops = 0
    let rejectStop!: (error: Error) => void
    const hooks = (yield* Effect.provideService(makeClaudeLifecycleHooks("session", () => ({
      port: 1234,
      stop: () => ++stops === 1 ? new Promise<void>((_, reject) => { rejectStop = reject }) : Promise.resolve(),
    })), Scope.Scope, scope))!
    const fiber = yield* Effect.forkChild(Effect.result(
      Effect.interruptible(hooks.close).pipe(Effect.timeoutOrElse({
        duration: 500,
        orElse: () => Effect.fail(new Error("Supervisor cleanup deadline exceeded")),
      })),
    ))
    yield* TestClock.adjust(200)
    expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderCleanupError" } })
    expect(yield* Clock.currentTimeMillis).toBe(200)
    expect(yield* PubSub.isShutdown(hooks.activityHints)).toBeTrue()
    // A late rejection is still observed by tryPromise, not an unhandled rejection.
    rejectStop(new Error("Late stop failure"))
    yield* Effect.interruptible(Scope.close(scope, Exit.void)).pipe(Effect.timeoutOrElse({
      duration: 500,
      orElse: () => Effect.fail(new Error("Supervisor scope deadline exceeded")),
    }))
    yield* hooks.close
    yield* Scope.close(scope, Exit.void)
    expect(stops).toBe(2)
  }), TestClock.layer()))
})

test("stalled scope backstop is bounded and repeated explicit close remains safe", async () => {
  await Effect.runPromise(Effect.provide(Effect.gen(function*() {
    const scope = yield* Scope.make()
    let stops = 0
    let resolveStop!: () => void
    const hooks = (yield* Effect.provideService(makeClaudeLifecycleHooks("session", () => ({
      port: 1234,
      stop: () => ++stops === 1 ? new Promise<void>((resolve) => { resolveStop = resolve }) : Promise.resolve(),
    })), Scope.Scope, scope))!
    const fiber = yield* Effect.forkChild(Effect.exit(
      Effect.interruptible(Scope.close(scope, Exit.void)).pipe(Effect.timeoutOrElse({
        duration: 500,
        orElse: () => Effect.fail(new Error("Supervisor scope deadline exceeded")),
      })),
    ))
    yield* TestClock.adjust(200)
    const exit = yield* Fiber.join(fiber)
    expect(Exit.isFailure(exit)).toBeTrue()
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "ProviderCleanupError" })
    expect(yield* Clock.currentTimeMillis).toBe(200)
    expect(yield* PubSub.isShutdown(hooks.activityHints)).toBeTrue()
    resolveStop()
    yield* Effect.all([hooks.close, hooks.close], { concurrency: "unbounded" })
    yield* Scope.close(scope, Exit.void)
    yield* hooks.close
    expect(stops).toBe(2)
  }), TestClock.layer()))
})
