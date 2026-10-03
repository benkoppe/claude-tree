import { describe, expect, test } from "bun:test"
import { stopTestServer } from "./helpers/stop-test-server"
import { Cause, Deferred, Effect, Exit, Fiber, PubSub } from "effect"
import { TestClock } from "effect/testing"
import type { ProviderTerminalEvent } from "../../src/services/provider"

import {
  CodexCleanupError,
  CodexConnectionError,
  CodexMutationAmbiguousError,
  CodexProcessError,
  CodexProtocolError,
  CodexRequestTimeout,
  CodexRpcError,
  connectCodexAppServerSidecar,
  makeCodexAppServerClient,
  type CodexAppServerProcess,
} from "../../src/infrastructure/providers/codex/app-server"
import {
  CodexTuiProxyError,
  makeCodexTuiProxy,
} from "../../src/infrastructure/providers/codex/tui-proxy"

describe("Effect Codex app-server transport", () => {
  test("a response cannot bypass its caller's outstanding transport write", async () => {
    const dispatched = Deferred.makeUnsafe<void>()
    let release!: () => void
    let completed = false
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/read") controls.respond(message.id, { thread: thread("held") })
    }, { write(data, messages) {
      if (messages[0]?.method !== "thread/read") return data.length
      return new Promise<number>((resolve) => {
        release = () => resolve(data.length)
        Deferred.doneUnsafe(dispatched, Effect.void)
      })
    } })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      yield* Effect.addFinalizer(() => Effect.sync(() => release?.()))
      const read = yield* Effect.forkChild(client.readThread("held").pipe(
        Effect.tap(() => Effect.sync(() => { completed = true })),
      ))
      yield* Deferred.await(dispatched)
      yield* TestClock.adjust(0)
      expect(completed).toBeFalse()
      release()
      expect((yield* Fiber.join(read)).id).toBe("held")
      expect(completed).toBeTrue()
    })).pipe(Effect.provide(TestClock.layer())))
  })

  test("real proxy keeps lifecycle authority across ancillary close and reconnects without resubmission", async () => {
    const token = "reconnect-token"
    const upstream = controlledProtocolServer(token)
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { proxy, events, connect, forward: send } = yield* lifecycleReplayFixture(upstream, token)
        const primary = yield* connect("primary")
        const ancillary = yield* connect("ancillary")
        const started = { method: "turn/started", params: { threadId: "root", turn: { id: "one", status: "inProgress" } } }
        yield* send(primary, started)
        yield* Effect.promise(() => waitUntil(() => events.length === 2))
        // A second connection's contradictory evidence is still forwarded, but is not authoritative.
        yield* send(ancillary, { method: "turn/completed", params: { threadId: "root", turn: { id: "one", status: "completed" } } })
        const ancillaryClosed = socketClosed(ancillary.socket)
        ancillary.upstream.close(1008, "🧪".repeat(30))
        const ancillaryClose = yield* Effect.promise(() => ancillaryClosed)
        expect(ancillaryClose.code).toBe(1011)
        expect(ancillaryClose.reason).toStartWith("Upstream closed (1008): 🧪")
        expect(Buffer.byteLength(ancillaryClose.reason)).toBeLessThanOrEqual(123)
        expect(ancillaryClose.reason).not.toContain("�")
        yield* send(primary, { method: "thread/status/changed", params: { threadId: "root", status: { type: "active", activeFlags: ["waitingOnApproval"] } } })
        yield* Effect.promise(() => waitUntil(() => events.length >= 3))
        expect(events.map((event) => event._tag)).toEqual(["Observation", "Activity", "Activity"])
        const primaryClosed = socketClosed(primary.socket)
        primary.upstream.close(1000)
        yield* Effect.promise(() => primaryClosed)
        yield* Effect.promise(() => waitUntil(() => events.length === 4))
        expect(events[3]).toEqual({ _tag: "Unavailable", sessionId: "root" })
        const reconnect = yield* connect("reconnect")
        yield* send(reconnect, started)
        yield* send(reconnect, { method: "turn/completed", params: { threadId: "root", turn: { id: "one", status: "completed" } } })
        yield* Effect.promise(() => waitUntil(() => events.length === 6))
        expect(events.slice(4)).toEqual([
          { _tag: "Activity", sessionId: "root", activity: "working" },
          { _tag: "Activity", sessionId: "root", activity: "idle" },
        ])
        expect(events.filter((event) => event._tag === "Observation")).toHaveLength(1)
        yield* proxy.close()
      })))
    } finally {
      await upstream.close()
    }
  })

  test("real proxy recovers a missed reconnect start and releases only unsupported authoritative root evidence", async () => {
    const token = "correlation-token"
    const upstream = controlledProtocolServer(token)
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { proxy, events, connect, forward } = yield* lifecycleReplayFixture(upstream, token)
        const send = (client: { socket: WebSocket; upstream: Bun.ServerWebSocket<unknown> }, method: string, params: unknown) =>
          forward(client, { method, params })
        const turn = (id: string, status: string) => ({ threadId: "root", turn: { id, status } })
        const primary = yield* connect("primary")
        yield* send(primary, "turn/started", turn("one", "inProgress"))
        yield* Effect.promise(() => waitUntil(() => events.length === 2))
        const closed = socketClosed(primary.socket)
        primary.upstream.close(1000)
        yield* Effect.promise(() => closed)
        yield* Effect.promise(() => waitUntil(() => events.length === 3))
        const reconnect = yield* connect("reconnect")
        yield* send(reconnect, "thread/status/changed", { threadId: "root", status: { type: "active", activeFlags: [] } })
        yield* send(reconnect, "turn/completed", turn("two", "completed"))
        yield* Effect.promise(() => waitUntil(() => events.length === 5))
        expect(events.slice(2)).toEqual([
          { _tag: "Unavailable", sessionId: "root" },
          { _tag: "Activity", sessionId: "root", activity: "working" },
          { _tag: "Activity", sessionId: "root", activity: "idle" },
        ])
        yield* send(reconnect, "turn/started", turn("three", "inProgress"))
        const ancillary = yield* connect("ancillary")
        yield* send(ancillary, "turn/completed", { threadId: "root", turn: null })
        yield* send(reconnect, "turn/completed", { threadId: "child", turn: null })
        yield* send(reconnect, "thread/status/changed", {
          threadId: "root", status: { type: "active", activeFlags: ["waitingOnApproval"] },
        })
        yield* Effect.promise(() => waitUntil(() => events.length === 8))
        expect(events.filter((event) => event._tag === "Unavailable")).toHaveLength(1)
        for (const unsupported of [
          { method: "thread/status/changed", params: { threadId: "root", status: { type: "active", activeFlags: ["futureFlag"] } } },
          { method: "turn/completed", params: turn("three", "future") },
        ]) {
          const before = events.length
          yield* send(reconnect, unsupported.method, unsupported.params)
          yield* send(reconnect, "turn/started", turn("three", "inProgress"))
          yield* Effect.promise(() => waitUntil(() => events.length === before + 2))
          expect(events.slice(before)).toEqual([
            { _tag: "Unavailable", sessionId: "root" },
            { _tag: "Activity", sessionId: "root", activity: "working" },
          ])
        }
        yield* send(reconnect, "turn/completed", turn("three", "completed"))
        yield* Effect.promise(() => waitUntil(() => {
          const last = events.at(-1)
          return last?._tag === "Activity" && last.activity === "idle"
        }))
        expect(events.filter((event) => event._tag === "Observation")).toHaveLength(2)
        yield* proxy.close()
      })))
    } finally {
      await upstream.close()
    }
  })

  test("initialization waits for the initialized notification's actual dispatch", async () => {
    const dispatched = Deferred.makeUnsafe<void>()
    let release!: () => void
    let acquired = false
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
    }, { write(data, messages) {
      if (messages[0]?.method !== "initialized") return data.length
      return new Promise<number>((resolve) => {
        release = () => resolve(data.length)
        Deferred.doneUnsafe(dispatched, Effect.void)
      })
    } })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => release?.()))
      const acquisition = yield* Effect.forkChild(makeCodexAppServerClient("codex", {
        spawn: () => transport.process,
      }).pipe(Effect.tap(() => Effect.sync(() => { acquired = true }))))
      yield* Deferred.await(dispatched)
      yield* TestClock.adjust(0)
      expect(acquired).toBeFalse()
      release()
      yield* Fiber.join(acquisition)
      expect(acquired).toBeTrue()
    })).pipe(Effect.provide(TestClock.layer())))
  })

  test("replays native lifecycle through the real proxy without changing stock TUI frames", async () => {
    const token = "replay-token"
    const upstream = controlledProtocolServer(token)
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const proxy = yield* makeCodexTuiProxy({
          upstreamUrl: `ws://127.0.0.1:${upstream.server.port}`,
          bearerToken: token, initialThreadId: "root",
        })
        const subscription = yield* PubSub.subscribe(proxy.providerEvents)
        const socket = new WebSocket(proxy.remoteUrl, { headers: { Authorization: `Bearer ${token}` } })
        yield* Effect.addFinalizer(() => Effect.sync(() => socket.terminate()))
        yield* Effect.promise(() => socketOpened(socket))
        socket.send(JSON.stringify({ method: "replay/ready" }))
        yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 1))
        const frames = [
          { method: "turn/started", params: { threadId: "root", turn: { id: "one", status: "inProgress", items: [] } } },
          { method: "thread/status/changed", params: { threadId: "root", status: { type: "active", activeFlags: ["waitingOnApproval"] } } },
          { method: "turn/completed", params: { threadId: "child", turn: { id: "child", status: "completed" } } },
          { method: "thread/status/changed", params: { threadId: "root", status: { type: "idle" } } },
          { method: "turn/completed", params: { threadId: "root", turn: { id: "one", status: "completed", items: [] } } },
        ]
        for (const frame of frames) {
          const raw = JSON.stringify(frame)
          const forwarded = socketMessage(socket)
          upstream.requests[0]!.socket.send(raw)
          expect(yield* Effect.promise(() => forwarded)).toBe(raw)
        }
        const events = yield* Effect.forEach([0, 1, 2, 3], () => PubSub.take(subscription))
        expect(events).toEqual([
          { _tag: "Observation", sessionId: "root", observation: { _tag: "Submission" } },
          { _tag: "Activity", sessionId: "root", activity: "working" },
          { _tag: "Activity", sessionId: "root", activity: "blocked" },
          { _tag: "Activity", sessionId: "root", activity: "idle" },
        ])
        yield* proxy.close()
      })))
    } finally {
      await upstream.close()
    }
  })

  test("aggregates initialization failure with incomplete app-server rollback", async () => {
    const transport = fakeProcess(() => {}, { ignoreEnd: true })

    const error = await Effect.runPromise(Effect.flip(Effect.scoped(
      makeCodexAppServerClient("codex", {
        spawn: () => transport.process,
        requestTimeoutMs: 5,
        shutdownTimeoutMs: 2,
      }),
    )))

    expect(error).toBeInstanceOf(CodexCleanupError)
    expect(error.cause).toBeInstanceOf(AggregateError)
    expect((error.cause as AggregateError).errors).toHaveLength(2)
    expect(transport.signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(transport.unrefs).toBe(2)
  })

  test("initializes and correlates split, out-of-order JSONL responses", async () => {
    const reads = new Map<string, number | string | undefined>()
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") {
        controls.respond(message.id, { userAgent: "test", future: true }, true)
      }
      if (message.method === "thread/read") {
        const params = message.params as { threadId: string }
        reads.set(params.threadId, message.id)
        if (reads.size === 2) {
          controls.respond(reads.get("fast"), { thread: thread("fast") })
          controls.respond(reads.get("slow"), { thread: thread("slow") }, true)
        }
      }
    })

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("/usr/bin/codex", {
        spawn(command) {
          expect(command).toEqual(["/usr/bin/codex", "app-server", "--stdio"])
          return transport.process
        },
      })
      return yield* Effect.all([
        client.readThread("slow"),
        client.readThread("fast"),
      ], { concurrency: "unbounded" })
    })))

    expect(result.map((value) => value.id)).toEqual(["slow", "fast"])
    expect(result[0]?.futureField).toBe("accepted")
    expect(transport.messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/read",
      "thread/read",
    ])
    expect(transport.ended).toBeTrue()
  })

  test("times out one request and ignores its late response", async () => {
    let expiredId: number | undefined
    const expiredDispatched = Deferred.makeUnsafe<void>()
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/read") {
        const params = message.params as { threadId: string }
        if (params.threadId === "expired" && typeof message.id === "number") {
          expiredId = message.id
          Deferred.doneUnsafe(expiredDispatched, Effect.void)
        }
        else controls.respond(message.id, { thread: thread(params.threadId) })
      }
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", {
        spawn: () => transport.process,
        requestTimeoutMs: 10,
      })
      const expired = yield* Effect.forkChild(client.readThread("expired"))
      yield* Deferred.await(expiredDispatched)
      yield* TestClock.adjust(10)
      const timeout = yield* Effect.flip(Fiber.join(expired))
      expect(timeout).toBeInstanceOf(CodexRequestTimeout)
      expect(timeout).toMatchObject({ method: "thread/read", timeoutMs: 10 })

      transport.respond(expiredId, { thread: thread("expired") })
      expect((yield* client.readThread("live")).id).toBe("live")
    })).pipe(Effect.provide(TestClock.layer())))
  })

  test.each([0, -1, Infinity, NaN])("rejects invalid request patience before spawning (%s)", (value) => {
    let spawned = false
    expect(() => makeCodexAppServerClient("codex", {
      requestTimeoutMs: value,
      spawn: () => { spawned = true; throw new Error("must not spawn") },
    })).toThrow(RangeError)
    expect(spawned).toBeFalse()
  })

  test("default initialization and requests wait beyond former deadlines", async () => {
    const initialized = Deferred.makeUnsafe<void>()
    const dispatched = Deferred.makeUnsafe<void>()
    let initializeId: number | undefined
    let readId: number | undefined
    const transport = fakeProcess((message) => {
      if (message.method === "initialize") {
        initializeId = typeof message.id === "number" ? message.id : undefined
        Deferred.doneUnsafe(initialized, Effect.void)
      }
      if (message.method === "thread/read") {
        readId = typeof message.id === "number" ? message.id : undefined
        Deferred.doneUnsafe(dispatched, Effect.void)
      }
    })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const acquisition = yield* Effect.forkChild(makeCodexAppServerClient("codex", { spawn: () => transport.process }))
      yield* Deferred.await(initialized)
      yield* TestClock.adjust(60_000)
      transport.respond(initializeId, {})
      const client = yield* Fiber.join(acquisition)
      const read = yield* Effect.forkChild(client.readThread("slow"))
      yield* Deferred.await(dispatched)
      yield* TestClock.adjust(60_000)
      transport.respond(readId, { thread: thread("slow") })
      expect((yield* Fiber.join(read)).id).toBe("slow")
    })).pipe(Effect.provide(TestClock.layer())))
  })

  test("request timeout covers a hung serialized write", async () => {
    let releaseWrite: (() => void) | undefined
    const writeStarted = Deferred.makeUnsafe<void>()
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
    }, {
      write(data, messages) {
        if (!messages.some((message) => message.method === "thread/read")) return data.length
        return new Promise<number>((resolve) => {
          releaseWrite = () => resolve(data.length)
          Deferred.doneUnsafe(writeStarted, Effect.void)
        })
      },
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", {
        spawn: () => transport.process,
        requestTimeoutMs: 10,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => releaseWrite?.()))
      const read = yield* Effect.forkChild(client.readThread("blocked"))
      yield* Deferred.await(writeStarted)
      yield* TestClock.adjust(10)
      expect(yield* Effect.flip(Fiber.join(read))).toBeInstanceOf(CodexRequestTimeout)
      releaseWrite?.()
    })).pipe(Effect.provide(TestClock.layer())))
  })

  test("interruption removes a request blocked in serialized write", async () => {
    let blockedId: number | undefined
    const blockedDispatched = Deferred.makeUnsafe<void>()
    let releaseWrite: (() => void) | undefined
    let blockNextRead = true
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/read") {
        const params = message.params as { threadId: string }
        if (params.threadId === "blocked" && typeof message.id === "number") {
          blockedId = message.id
        }
        if (params.threadId === "live") controls.respond(message.id, { thread: thread("live") })
      }
    }, {
      write(data, messages) {
        if (!blockNextRead || !messages.some((message) => message.method === "thread/read")) return data.length
        blockNextRead = false
        return new Promise<number>((resolve) => {
          releaseWrite = () => resolve(data.length)
          Deferred.doneUnsafe(blockedDispatched, Effect.void)
        })
      },
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      yield* Effect.addFinalizer(() => Effect.sync(() => releaseWrite?.()))
      const fiber = yield* Effect.forkChild(client.readThread("blocked"))
      yield* Deferred.await(blockedDispatched)
      yield* Fiber.interrupt(fiber)
      releaseWrite?.()
      transport.respond(blockedId, { thread: thread("blocked") })
      expect((yield* client.readThread("live")).id).toBe("live")
    })))
  })

  test("never sends a queued request after its fiber is cancelled", async () => {
    let releaseBlocker!: () => void
    const blockerDispatched = Deferred.makeUnsafe<void>()
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/read") {
        const params = message.params as { threadId: string }
        if (params.threadId === "blocker") {
          controls.respond(message.id, { thread: thread("blocker") })
        }
        if (params.threadId === "live") controls.respond(message.id, { thread: thread("live") })
      }
    }, {
      write(data, messages) {
        if (!messages.some((message) =>
          message.method === "thread/read" &&
          (message.params as { threadId?: string }).threadId === "blocker"
        )) return data.length
        return new Promise<number>((resolve) => {
          releaseBlocker = () => resolve(data.length)
          Deferred.doneUnsafe(blockerDispatched, Effect.void)
        })
      },
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      yield* Effect.addFinalizer(() => Effect.sync(() => releaseBlocker?.()))
      const blocker = yield* Effect.forkChild(client.readThread("blocker"))
      yield* Deferred.await(blockerDispatched)
      const cancelled = yield* Effect.forkChild(client.readThread("cancelled"))
      yield* TestClock.adjust(0)
      yield* Fiber.interrupt(cancelled)
      releaseBlocker()
      expect((yield* Fiber.join(blocker)).id).toBe("blocker")
      expect((yield* client.readThread("live")).id).toBe("live")
      expect(transport.messages.some((message) =>
        message.method === "thread/read" &&
        (message.params as { threadId?: string }).threadId === "cancelled"
      )).toBeFalse()
    })).pipe(Effect.provide(TestClock.layer())))
  })

  test("reclaims cancelled queued writes while a transport write is blocked", async () => {
    const dispatched = Deferred.makeUnsafe<void>()
    let release!: () => void
    let blockerId: number | string | undefined
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/read") {
        const { threadId } = message.params as { threadId: string }
        if (threadId === "blocker") blockerId = message.id
        else controls.respond(message.id, { thread: thread(threadId) })
      }
    }, { write(data, messages) {
      if ((messages[0]?.params as { threadId?: string } | undefined)?.threadId !== "blocker") return data.length
      return new Promise<number>((resolve) => {
        release = () => { resolve(data.length); transport.respond(blockerId, { thread: thread("blocker") }) }
        Deferred.doneUnsafe(dispatched, Effect.void)
      })
    } })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process, maxPendingRequests: 2 })
      yield* Effect.addFinalizer(() => Effect.sync(() => release?.()))
      const blocker = yield* Effect.forkChild(client.readThread("blocker"))
      yield* Deferred.await(dispatched)
      for (let index = 0; index < 16; index += 1) {
        const cancelled = yield* Effect.forkChild(index % 2 === 0
          ? client.readThread(`cancelled-${index}`)
          : client.forkThread("source", "turn", "/project"))
        yield* TestClock.adjust(0)
        yield* Fiber.interrupt(cancelled)
        const exit = yield* Fiber.await(cancelled)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      }
      const live = yield* Effect.forkChild(client.readThread("live"))
      yield* TestClock.adjust(0)
      release()
      expect((yield* Fiber.join(blocker)).id).toBe("blocker")
      expect((yield* Fiber.join(live)).id).toBe("live")
      expect(transport.messages.filter((message) => message.method === "thread/read")).toHaveLength(2)
      expect(transport.messages.some((message) => message.method === "thread/fork")).toBeFalse()
    })).pipe(Effect.provide(TestClock.layer())))
  })

  test("reports a dispatched fork timeout as ambiguous without retrying", async () => {
    let forkCalls = 0
    const error = await Effect.runPromise(Effect.provide(Effect.scoped(Effect.gen(function*() {
      const forkDispatched = yield* Deferred.make<void>()
      const transport = fakeProcess((message, controls) => {
        if (message.method === "initialize") controls.respond(message.id, {})
        if (message.method === "thread/fork") {
          forkCalls++
          Deferred.doneUnsafe(forkDispatched, Effect.void)
        }
      })
      const client = yield* makeCodexAppServerClient("codex", {
        spawn: () => transport.process,
        requestTimeoutMs: 10,
      })
      const fiber = yield* Effect.forkChild(client.forkThread("parent", "turn", "/project"))
      yield* Deferred.await(forkDispatched)
      yield* TestClock.adjust(10)
      return yield* Fiber.join(fiber).pipe(Effect.flip)
    })), TestClock.layer()))

    expect(error).toBeInstanceOf(CodexMutationAmbiguousError)
    expect(error).toMatchObject({ method: "thread/fork" })
    expect(forkCalls).toBe(1)
  })

  test("settles a dispatched fork as ambiguous when close drains pending requests", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const forkDispatched = yield* Deferred.make<void>()
      const transport = fakeProcess((message, controls) => {
        if (message.method === "initialize") controls.respond(message.id, {})
        if (message.method === "thread/fork") Deferred.doneUnsafe(forkDispatched, Effect.void)
      })
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      const fiber = yield* Effect.forkChild(client.forkThread("parent", "turn", "/project"))
      yield* Deferred.await(forkDispatched)
      yield* client.close()
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(error).toBeInstanceOf(CodexMutationAmbiguousError)
      expect(error.cause).toBeInstanceOf(CodexProcessError)
    })))
  })

  test("settles a dispatched mutation whose active transport write is still blocked", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const forkDispatched = yield* Deferred.make<void>()
      let releaseWrite!: () => void
      const transport = fakeProcess((message, controls) => {
        if (message.method === "initialize") controls.respond(message.id, {})
        if (message.method === "thread/fork") Deferred.doneUnsafe(forkDispatched, Effect.void)
      }, {
        write(data, messages) {
          if (!messages.some((message) => message.method === "thread/fork")) return data.length
          return new Promise<number>((resolve) => {
            releaseWrite = () => resolve(data.length)
          })
        },
      })
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      yield* Effect.addFinalizer(() => Effect.sync(() => releaseWrite?.()))
      const mutation = yield* Effect.forkChild(client.forkThread("parent", "turn", "/project"))
      yield* Deferred.await(forkDispatched)
      const closing = yield* Effect.forkChild(client.close())
      const error = yield* Fiber.join(mutation).pipe(Effect.flip)
      expect(error).toBeInstanceOf(CodexMutationAmbiguousError)
      releaseWrite()
      yield* Fiber.join(closing)
    })))
  })

  test("reports interruption after fork dispatch as explicit ambiguity", async () => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      const fiber = yield* Effect.forkChild(client.forkThread("parent", "turn", "/project"))
      yield* Effect.promise(() => waitUntil(() => transport.messages.some(
        (message) => message.method === "thread/fork",
      )))
      yield* Fiber.interrupt(fiber)
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(error).toBeInstanceOf(CodexMutationAmbiguousError)
      expect(error).toMatchObject({ method: "thread/fork" })
    })))
  })

  test("treats malformed fork success as ambiguous but preserves explicit RPC rejection", async () => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method !== "thread/fork") return
      const params = message.params as { lastTurnId: string }
      if (params.lastTurnId === "malformed") {
        controls.respond(message.id, { thread: {} })
      } else {
        controls.emit(`${JSON.stringify({
          id: message.id,
          error: { code: -32600, message: "fork rejected" },
        })}\n`)
      }
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      expect(yield* Effect.flip(client.forkThread("parent", "malformed", "/project")))
        .toBeInstanceOf(CodexMutationAmbiguousError)
      expect(yield* Effect.flip(client.forkThread("parent", "rejected", "/project")))
        .toBeInstanceOf(CodexRpcError)
    })))
  })

  test("rejects an oversized JSONL record before buffering it without bound", async () => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/read") controls.emit("x".repeat(65))
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", {
        spawn: () => transport.process,
        maxJsonlRecordBytes: 64,
      })
      const error = yield* Effect.flip(client.readThread("large"))
      expect(error).toBeInstanceOf(CodexProtocolError)
      expect(error).toMatchObject({ message: expect.stringContaining("exceeded 64 bytes") })
    })))
  })

  test("fails all pending requests on malformed JSONL or an unknown response id", async () => {
    for (const emitFailure of [
      (transport: FakeProcess) => transport.emit("not-json\n"),
      (transport: FakeProcess) => transport.respond(99_999, {}),
    ]) {
      let reads = 0
      const transport = fakeProcess((message) => {
        if (message.method === "initialize") transport.respond(message.id, {})
        if (message.method === "thread/read" && ++reads === 2) emitFailure(transport)
      })

      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
        const errors = yield* Effect.all([
          Effect.flip(client.readThread("one")),
          Effect.flip(client.readThread("two")),
        ], { concurrency: "unbounded" })
        expect(errors.every((error) => error instanceof CodexProtocolError)).toBeTrue()
      })))
    }
  })

  test("rejects malformed required thread data but preserves forward-compatible extras", async () => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/read") {
        const params = message.params as { threadId: string }
        const value = thread(params.threadId === "mismatch" ? "other" : params.threadId)
        value.turns = params.threadId !== "bad"
          ? [{
              id: "turn-1",
              status: "completed",
              futureTurn: true,
              items: [{ id: "item-1", type: "agentMessage", text: "hello", futureItem: true }],
            }]
          : [{
              id: "turn-1",
              status: "completed",
              items: [{ id: "item-1", type: "agentMessage", future: true }],
            }]
        controls.respond(message.id, { thread: value })
      }
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      const good = yield* client.readThread("good")
      expect(good.futureField).toBe("accepted")
      expect(good.turns[0]?.futureTurn).toBeTrue()
      expect(good.turns[0]?.items[0]?.futureItem).toBeTrue()
      expect(yield* Effect.flip(client.readThread("bad"))).toBeInstanceOf(CodexProtocolError)
      const mismatch = yield* Effect.flip(client.readThread("mismatch"))
      expect(mismatch).toBeInstanceOf(CodexProtocolError)
      expect(mismatch.message).toContain('did not match "mismatch"')
    })))
  })

  test("rejects empty and duplicate protocol identifiers", async () => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/read") {
        const value = thread("duplicate")
        value.turns = [
          { id: "turn-1", status: "completed", items: [] },
          { id: "turn-1", status: "completed", items: [] },
        ]
        controls.respond(message.id, { thread: value })
      }
      if (message.method === "thread/loaded/list") controls.respond(message.id, { data: ["same", "same"] })
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      expect(yield* Effect.flip(client.readThread(""))).toBeInstanceOf(CodexProtocolError)
      expect(yield* Effect.flip(client.readThread("duplicate"))).toBeInstanceOf(CodexProtocolError)
      expect(yield* Effect.flip(client.listLoadedThreadIds())).toBeInstanceOf(CodexProtocolError)
    })))
  })

  test.each(["account/login/start", "item/commandExecution/requestApproval", "item/tool/requestUserInput"])(
    "fails closed without answering server request %s", async (method) => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/loaded/list") {
        controls.emit(`${JSON.stringify({ id: "server-1", method, params: {} })}\n`)
      }
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      const error = yield* Effect.flip(client.listLoadedThreadIds())
      expect(error).toBeInstanceOf(CodexProtocolError)
      expect(error.message).toContain(`Unsupported server request: ${method}`)
    })))
    expect(transport.messages.some((message) => message.id === "server-1")).toBeFalse()
  })

  test("fails pending requests on process exit with bounded stderr diagnostics", async () => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/read") {
        controls.stderr("x".repeat(20_000))
      }
    }, { onStderrDrained: () => transport.exit(17) })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      const error = yield* Effect.flip(client.readThread("dies"))
      expect(error).toBeInstanceOf(CodexProcessError)
      if (error instanceof CodexProcessError) {
        expect(error.exitCode).toBe(17)
        expect(error.stderr).toBe("x".repeat(8_192))
      }
    })))
  })

  test("scope cleanup escalates through bounded TERM and KILL waits", async () => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
    }, { ignoreEnd: true, exitOnKill: "SIGKILL" })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* makeCodexAppServerClient("codex", {
        spawn: () => transport.process,
        shutdownTimeoutMs: 5,
      })
    })))

    expect(transport.signals).toEqual(["SIGTERM", "SIGKILL"])
  })

  test("reports a typed cleanup error and cancels readers when the process survives SIGKILL", async () => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
    }, { ignoreEnd: true })

    const exit = await Effect.runPromise(Effect.exit(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", {
        spawn: () => transport.process,
        shutdownTimeoutMs: 5,
      })
      const unrefsBeforeClose = transport.unrefs
      const explicitError = yield* Effect.flip(client.close())
      expect(explicitError).toBeInstanceOf(CodexCleanupError)
      expect(transport.unrefs).toBeGreaterThan(unrefsBeforeClose)
    }))))

    expect(Exit.isFailure(exit)).toBeTrue()
    if (Exit.isSuccess(exit)) throw new Error("expected cleanup failure")
    expect(Cause.squash(exit.cause)).toBeInstanceOf(CodexCleanupError)
    expect(transport.signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"])
    expect(transport.readersCancelled.sort()).toEqual(["stderr", "stdout"])
  })

  test("reports typed scope cleanup failure", async () => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
    }, { ignoreEnd: true })

    const exit = await Effect.runPromise(Effect.exit(Effect.scoped(Effect.gen(function*() {
      yield* makeCodexAppServerClient("codex", {
        spawn: () => transport.process,
        shutdownTimeoutMs: 5,
      })
    }))))

    expect(Exit.isFailure(exit)).toBeTrue()
    if (Exit.isSuccess(exit)) throw new Error("expected cleanup failure")
    expect(Cause.squash(exit.cause)).toBeInstanceOf(CodexCleanupError)
    expect(transport.signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(transport.unrefs).toBe(2)
  })

  test("cleanup continues after transport close and signal failures", async () => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
    }, {
      ignoreEnd: true,
      endError: new Error("end failed"),
      killError: new Error("kill failed"),
    })

    const exit = await Effect.runPromise(Effect.exit(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", {
        spawn: () => transport.process,
        shutdownTimeoutMs: 5,
      })
      const unrefsBeforeClose = transport.unrefs
      const explicitError = yield* Effect.flip(client.close())
      expect(explicitError).toBeInstanceOf(CodexCleanupError)
      expect(transport.unrefs).toBeGreaterThan(unrefsBeforeClose)
    }))))

    expect(Exit.isFailure(exit)).toBeTrue()
    if (Exit.isSuccess(exit)) throw new Error("expected cleanup failure")
    expect(Cause.squash(exit.cause)).toBeInstanceOf(CodexCleanupError)
    expect(transport.signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"])
    expect(transport.readersCancelled.sort()).toEqual(["stderr", "stdout"])
  })

  test("retries typed cleanup and repeats TERM/KILL escalation", async () => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
    }, {
      ignoreEnd: true,
      exitOnKill: "SIGKILL",
      exitOnKillAttempt: 2,
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", {
        spawn: () => transport.process,
        shutdownTimeoutMs: 5,
      })
      expect(yield* Effect.flip(client.close())).toBeInstanceOf(CodexCleanupError)
      yield* client.close()
    })))

    expect(transport.signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"])
  })
})

describe("Effect Codex sidecar and TUI proxy", () => {
  test("bounds sidecar connection attempts", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, bunServer) {
        await Bun.sleep(100)
        return bunServer.upgrade(request)
          ? undefined
          : new Response("Upgrade required", { status: 426 })
      },
      websocket: { message() {} },
    })

    try {
      const error = await Effect.runPromise(Effect.scoped(
        connectCodexAppServerSidecar(`ws://127.0.0.1:${server.port}`, {
          bearerToken: "sidecar-secret",
          connectTimeoutMs: 10,
        }),
      )).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(CodexConnectionError)
      expect(error).toMatchObject({ url: `ws://127.0.0.1:${server.port}` })
    } finally {
      await stopTestServer(server)
    }
  })

  test("authenticates a loopback sidecar and rejects binary protocol messages", async () => {
    const authorizations: string[] = []
    const sockets = new Set<Bun.ServerWebSocket<unknown>>()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        authorizations.push(request.headers.get("authorization") ?? "")
        return bunServer.upgrade(request)
          ? undefined
          : new Response("Upgrade required", { status: 426 })
      },
      websocket: {
        open(socket) { sockets.add(socket) },
        message(socket, data) {
          const request = JSON.parse(String(data)) as WireMessage
          if (request.method === "initialize") socket.send(JSON.stringify({ id: request.id, result: {} }))
          if (request.method === "thread/read") socket.send(new Uint8Array([1, 2, 3]))
        },
        close(socket) { sockets.delete(socket) },
      },
    })

    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const client = yield* connectCodexAppServerSidecar(`ws://127.0.0.1:${server.port}`, {
          bearerToken: "sidecar-secret",
          connectTimeoutMs: 500,
        })
        expect(yield* Effect.flip(client.readThread("binary"))).toBeInstanceOf(CodexProtocolError)
      })))
      expect(authorizations).toEqual(["Bearer sidecar-secret"])
    } finally {
      try {
        for (const socket of sockets) socket.close(1000, "Test complete")
        await waitUntil(() => sockets.size === 0)
      } finally {
        for (const socket of sockets) socket.terminate()
        await stopTestServer(server)
      }
    }
  })

  test("authorizes clients, correlates all switch methods, filters child threads, and preserves order", async () => {
    const token = "proxy-secret"
    const upstream = controlledProtocolServer(token)
    let proxyUrl = ""

    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const proxy = yield* makeCodexTuiProxy({
          upstreamUrl: `ws://127.0.0.1:${upstream.server.port}`,
          bearerToken: token,
          initialThreadId: "thread-a",
        })
        proxyUrl = proxy.remoteUrl
        const unauthorized = yield* Effect.promise(() => fetch(proxy.remoteUrl.replace("ws:", "http:")))
        expect(unauthorized.status).toBe(401)

        const subscription = yield* PubSub.subscribe(proxy.transitions)
        const transitionsFiber = yield* Effect.forkChild(
          Effect.all([
            takeAndAcknowledgeProxyTransition(subscription),
            takeAndAcknowledgeProxyTransition(subscription),
            takeAndAcknowledgeProxyTransition(subscription),
          ], { concurrency: 1 }),
        )
        const client = new WebSocket(proxy.remoteUrl, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const responses: unknown[] = []
        client.addEventListener("message", (event) => responses.push(JSON.parse(String(event.data))))
        yield* Effect.promise(() => socketOpened(client))

        client.send(JSON.stringify({
          id: 1,
          method: "thread/fork",
          params: { threadId: "thread-a", beforeTurnId: "turn-1" },
        }))
        client.send(JSON.stringify({ id: "two", method: "thread/resume", params: { threadId: "thread-c" } }))
        client.send(JSON.stringify({ id: 3, method: "thread/start", params: { cwd: "/project" } }))
        yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 3))

        upstream.respond("two", topLevelThread("thread-c"))
        upstream.respond(1, topLevelThread("thread-b"))
        upstream.respond(3, topLevelThread("thread-d"))
        const transitions = yield* Fiber.join(transitionsFiber).pipe(Effect.timeout(1_000))
        expect(transitions.map((event) => [
          event.operation,
          event._tag === "CodexThreadTransition" ? event.threadId : "failed",
        ])).toEqual([
          ["resume", "thread-c"],
          ["fork", "thread-b"],
          ["start", "thread-d"],
        ])
        expect(transitions.map((event) => event.previousThreadId)).toEqual([
          "thread-a",
          "thread-a",
          "thread-a",
        ])
        expect(transitions[1]?._tag).toBe("CodexThreadTransition")
        expect(transitions[1]).toMatchObject({
          requestedThreadId: "thread-a",
          forkPointTurnId: "turn-1",
        })

        yield* Effect.promise(() => waitUntil(() => responses.length === 3))
        const filteredResponse = socketMessage(client)
        client.send(JSON.stringify({ id: 4, method: "thread/fork", params: { threadId: "thread-d" } }))
        yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 4))
        upstream.respond(4, {
          ...topLevelThread("child"),
          parentThreadId: "thread-d",
        })
        expect(JSON.parse(yield* Effect.promise(() => filteredResponse))).toMatchObject({ id: 4 })
        expect(yield* PubSub.size(proxy.transitions)).toBe(0)
        client.close()
      })))

      await expect(fetch(proxyUrl.replace("ws:", "http:"))).rejects.toThrow()
    } finally {
      await upstream.close()
    }
  })

  for (const firstOperation of ["start", "resume", "fork"] as const) {
    test(`classifies a temporary terminal's first ${firstOperation} as adoption and its next fork as native`, async () => {
      const token = "proxy-secret"
      const upstream = controlledProtocolServer(token)
      try {
        await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
          const proxy = yield* makeCodexTuiProxy({
            upstreamUrl: `ws://127.0.0.1:${upstream.server.port}`,
            bearerToken: token,
            initialThreadId: "pending-codex-one",
            initialThreadIsTemporary: true,
          })
          const subscription = yield* PubSub.subscribe(proxy.transitions)
          const client = new WebSocket(proxy.remoteUrl, {
            headers: { Authorization: `Bearer ${token}` },
          })
          yield* Effect.promise(() => socketOpened(client))

          const firstResponse = socketMessage(client)
          client.send(JSON.stringify({
            id: 1,
            method: `thread/${firstOperation}`,
            params: firstOperation === "start"
              ? { cwd: "/project" }
              : firstOperation === "resume"
                ? { threadId: "real" }
                : { threadId: "source-thread", beforeTurnId: "turn-1" },
          }))
          yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 1))
          upstream.respond(1, topLevelThread("real"))
          const first = yield* takeAndAcknowledgeProxyTransition(subscription).pipe(
            Effect.timeout(1_000),
          )
          yield* Effect.promise(() => firstResponse)

          const forkResponse = socketMessage(client)
          client.send(JSON.stringify({
            id: 2,
            method: "thread/fork",
            params: { threadId: "real", beforeTurnId: "turn-2" },
          }))
          yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 2))
          upstream.respond(2, topLevelThread("fork-one"))
          const fork = yield* takeAndAcknowledgeProxyTransition(subscription).pipe(
            Effect.timeout(1_000),
          )
          yield* Effect.promise(() => forkResponse)

          expect(first).toMatchObject({
            _tag: "CodexThreadTransition",
            operation: firstOperation,
            kind: "temporary-adoption",
            previousThreadId: "pending-codex-one",
            threadId: "real",
            cwd: "/project",
            ...(firstOperation === "fork"
              ? { requestedThreadId: "source-thread", forkPointTurnId: "turn-1" }
              : {}),
          })
          expect(fork).toMatchObject({
            _tag: "CodexThreadTransition",
            operation: "fork",
            kind: "native-fork",
            previousThreadId: "real",
            threadId: "fork-one",
            cwd: "/project",
          })
          client.close()
        })))
      } finally {
        await upstream.close()
      }
    })
  }

  test("rejects binary TUI messages and bounds the pre-open queue", async () => {
    const token = "proxy-secret"
    const upstream = controlledProtocolServer(token, 100)
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const proxy = yield* makeCodexTuiProxy({
          upstreamUrl: `ws://127.0.0.1:${upstream.server.port}`,
          bearerToken: token,
          initialThreadId: "thread-a",
          connectTimeoutMs: 500,
          maxPreOpenMessages: 1,
          maxPendingRequests: 1,
        })
        const binary = new WebSocket(proxy.remoteUrl, {
          headers: { Authorization: `Bearer ${token}` },
        })
        yield* Effect.promise(() => socketOpened(binary))
        const binaryClose = socketClosed(binary)
        binary.send(new Uint8Array([1, 2, 3]))
        expect((yield* Effect.promise(() => binaryClose)).code).toBe(1003)

        const queued = new WebSocket(proxy.remoteUrl, {
          headers: { Authorization: `Bearer ${token}` },
        })
        yield* Effect.promise(() => socketOpened(queued))
        const queuedClose = socketClosed(queued)
        queued.send(JSON.stringify({ method: "one" }))
        queued.send(JSON.stringify({ method: "two" }))
        expect((yield* Effect.promise(() => queuedClose)).code).toBe(1009)

        const pending = new WebSocket(proxy.remoteUrl, {
          headers: { Authorization: `Bearer ${token}` },
        })
        yield* Effect.promise(() => socketOpened(pending))
        const pendingClose = socketClosed(pending)
        pending.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }))
        pending.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }))
        expect((yield* Effect.promise(() => pendingClose)).code).toBe(1013)
      })))
    } finally {
      await upstream.close()
    }
  })

  test("ordinary MCP startup bursts bypass the identity barrier queue and preserve order", async () => {
    const token = "bootstrap-token"
    const upstream = controlledProtocolServer(token)
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const proxy = yield* makeCodexTuiProxy({
          upstreamUrl: `ws://127.0.0.1:${upstream.server.port}`, bearerToken: token,
          initialThreadId: "thread-a", maxServerMessages: 1, maxServerMessageBytes: 128,
        })
        const client = new WebSocket(proxy.remoteUrl, { headers: { Authorization: `Bearer ${token}` } })
        yield* Effect.addFinalizer(() => Effect.sync(() => client.terminate()))
        yield* Effect.promise(() => socketOpened(client))
        const received: string[] = []
        const frames = Array.from({ length: 1_024 }, (_, index) => JSON.stringify({
          method: "mcpServer/startupStatusChanged", params: { name: "codex_apps", index },
        }))
        const forwarded = new Promise<void>((resolve, reject) => {
          client.addEventListener("message", (event) => {
            received.push(event.data as string)
            if (received.length === frames.length) resolve()
          })
          client.addEventListener("close", () => reject(new Error("Proxy closed during MCP bootstrap")))
        })
        client.send(JSON.stringify({ method: "bootstrap" }))
        yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 1))
        for (const frame of frames) upstream.requests[0]!.socket.send(frame)
        yield* Effect.promise(() => forwarded).pipe(Effect.timeout(5_000))
        expect(received).toEqual(frames)
        expect(client.readyState).toBe(WebSocket.OPEN)
        yield* proxy.close()
      })))
    } finally { await upstream.close() }
  })

  test("proxy queue overflow preserves its cause when terminating upstream", async () => {
    const token = "overflow-token"
    const upstream = controlledProtocolServer(token)
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const proxy = yield* makeCodexTuiProxy({
          upstreamUrl: `ws://127.0.0.1:${upstream.server.port}`, bearerToken: token,
          initialThreadId: "thread-a", maxServerMessages: 1,
        })
        const subscription = yield* PubSub.subscribe(proxy.transitions)
        const client = new WebSocket(proxy.remoteUrl, { headers: { Authorization: `Bearer ${token}` } })
        yield* Effect.addFinalizer(() => Effect.sync(() => client.terminate()))
        yield* Effect.promise(() => socketOpened(client))
        client.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }))
        yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 1))
        upstream.respond(1, topLevelThread("thread-b"))
        const request = yield* PubSub.take(subscription)
        const closed = socketClosed(client)
        upstream.requests[0]!.socket.send(JSON.stringify({ method: "progress", params: {} }))
        const event = yield* Effect.promise(() => closed)
        expect(event.code).toBe(1013)
        expect(event.reason).toBe("Upstream message queue limit exceeded")
        yield* Deferred.succeed(request.acknowledgment, undefined)
        yield* proxy.close()
      })))
    } finally { await upstream.close() }
  })

  test("forwards large ordinary Codex responses without charging identity queue capacity", async () => {
    const token = "proxy-secret"
    const upstream = controlledProtocolServer(token)
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const proxy = yield* makeCodexTuiProxy({
          upstreamUrl: `ws://127.0.0.1:${upstream.server.port}`,
          bearerToken: token,
          initialThreadId: "thread-a",
        })
        const client = new WebSocket(proxy.remoteUrl, {
          headers: { Authorization: `Bearer ${token}` },
        })
        yield* Effect.promise(() => socketOpened(client))

        const largePayload = "x".repeat(9_500_000)
        const firstResponse = socketMessage(client, 5_000)
        client.send(JSON.stringify({ id: 1, method: "plugin/list", params: {} }))
        yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 1))
        upstream.respond(1, { payload: largePayload })
        const first = JSON.parse(yield* Effect.promise(() => firstResponse)) as {
          result: { thread: { payload: string } }
        }
        expect(first.result.thread.payload).toBe(largePayload)
        expect(client.readyState).toBe(WebSocket.OPEN)

        const secondResponse = socketMessage(client)
        client.send(JSON.stringify({ id: 2, method: "plugin/list", params: {} }))
        yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 2))
        upstream.respond(2, { payload: "next" })
        const second = JSON.parse(yield* Effect.promise(() => secondResponse)) as {
          id: number
          result: { thread: { payload: string } }
        }
        expect(second).toMatchObject({ id: 2, result: { thread: { payload: "next" } } })
        client.close()
      })))
    } finally {
      await upstream.close()
    }
  })

  test("publishes TransitionFailed when a tracked destination omits required cwd metadata", async () => {
    const token = "proxy-secret"
    const upstream = controlledProtocolServer(token)
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const proxy = yield* makeCodexTuiProxy({
          upstreamUrl: `ws://127.0.0.1:${upstream.server.port}`,
          bearerToken: token,
          initialThreadId: "thread-a",
        })
        const subscription = yield* PubSub.subscribe(proxy.transitions)
        const client = new WebSocket(proxy.remoteUrl, {
          headers: { Authorization: `Bearer ${token}` },
        })
        yield* Effect.promise(() => socketOpened(client))
        client.send(JSON.stringify({ id: 1, method: "thread/start", params: { cwd: "/project" } }))
        yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 1))
        const malformed = topLevelThread("thread-b")
        delete malformed.cwd
        upstream.respond(1, malformed)
        const transition = yield* takeAndAcknowledgeProxyTransition(subscription).pipe(Effect.timeout(1_000))
        expect(transition._tag).toBe("TransitionFailed")
        if (transition._tag === "TransitionFailed") {
          expect(transition.error).toBeInstanceOf(CodexTuiProxyError)
          expect(transition).toMatchObject({ operation: "start", previousThreadId: "thread-a" })
        }
        client.close()
      })))
    } finally {
      await upstream.close()
    }
  })

  test("bounds transition acknowledgment and closes without forwarding", async () => {
    const token = "proxy-secret"
    const upstream = controlledProtocolServer(token)
    try {
      const exit = await Effect.runPromise(Effect.exit(Effect.scoped(Effect.gen(function*() {
        const proxy = yield* makeCodexTuiProxy({
          upstreamUrl: `ws://127.0.0.1:${upstream.server.port}`,
          bearerToken: token,
          initialThreadId: "thread-a",
          transitionAcknowledgmentTimeoutMs: 10,
        })
        const subscription = yield* PubSub.subscribe(proxy.transitions)
        const client = new WebSocket(proxy.remoteUrl, {
          headers: { Authorization: `Bearer ${token}` },
        })
        yield* Effect.promise(() => socketOpened(client))
        const closed = socketClosed(client)
        const forwarded: unknown[] = []
        client.addEventListener("message", (event) => forwarded.push(event.data))
        client.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }))
        yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 1))
        upstream.respond(1, topLevelThread("thread-b"))
        yield* PubSub.take(subscription).pipe(Effect.timeout(1_000))
        expect((yield* Effect.promise(() => closed)).code).toBe(1011)
        expect(forwarded).toEqual([])
      }))))
      expect(Exit.isFailure(exit)).toBeTrue()
      if (Exit.isSuccess(exit)) throw new Error("expected cleanup failure")
      expect(Cause.squash(exit.cause)).toBeInstanceOf(CodexTuiProxyError)
    } finally {
      await upstream.close()
    }
  })

  test("returns a typed proxy cleanup failure for an unacknowledged transition", async () => {
    const token = "proxy-secret"
    const upstream = controlledProtocolServer(token)
    let proxyUrl = ""
    try {
      const error = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const proxy = yield* makeCodexTuiProxy({
          upstreamUrl: `ws://127.0.0.1:${upstream.server.port}`,
          bearerToken: token,
          initialThreadId: "thread-a",
          transitionCapacity: 1,
          cleanupTimeoutMs: 10,
        })
        proxyUrl = proxy.remoteUrl
        const subscription = yield* PubSub.subscribe(proxy.transitions)
        const client = new WebSocket(proxy.remoteUrl, {
          headers: { Authorization: `Bearer ${token}` },
        })
        yield* Effect.promise(() => socketOpened(client))
        client.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }))
        yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 1))
        upstream.respond(1, topLevelThread("thread-b"))
        yield* PubSub.take(subscription).pipe(Effect.timeout(1_000))
        return yield* Effect.flip(proxy.close())
      })))
      expect(error).toBeInstanceOf(CodexTuiProxyError)
      await expect(fetch(proxyUrl.replace("ws:", "http:"))).rejects.toThrow()
    } finally {
      await upstream.close()
    }
  })
})

interface WireMessage {
  readonly id?: number | string
  readonly method?: string
  readonly params?: unknown
  readonly error?: unknown
}

function takeAndAcknowledgeProxyTransition(
  subscription: PubSub.Subscription<import("../../src/infrastructure/providers/codex/tui-proxy").CodexTuiProxyTransitionRequest>,
): Effect.Effect<import("../../src/infrastructure/providers/codex/tui-proxy").CodexTuiProxyTransition> {
  return Effect.gen(function*() {
    const request = yield* PubSub.take(subscription)
    yield* Deferred.succeed(request.acknowledgment, undefined)
    return request.transition
  })
}

interface FakeControls {
  emit(text: string): void
  stderr(text: string): void
  respond(id: number | string | undefined, result: unknown, split?: boolean): void
  exit(code: number): void
}

interface FakeProcess extends FakeControls {
  readonly process: CodexAppServerProcess
  readonly messages: WireMessage[]
  readonly ended: boolean
  readonly signals: NodeJS.Signals[]
  readonly readersCancelled: string[]
  readonly unrefs: number
}

function fakeProcess(
  onMessage: (message: WireMessage, controls: FakeControls) => void,
  options: {
    readonly ignoreEnd?: boolean
    readonly exitOnKill?: NodeJS.Signals
    readonly exitOnKillAttempt?: number
    readonly endError?: unknown
    readonly killError?: unknown
    readonly onStderrDrained?: () => void
    readonly write?: (data: string, messages: readonly WireMessage[]) => number | Promise<number>
  } = {},
): FakeProcess {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>
  let stderrController!: ReadableStreamDefaultController<Uint8Array>
  let resolveExited!: (code: number) => void
  let ended = false
  let exited = false
  const messages: WireMessage[] = []
  const signals: NodeJS.Signals[] = []
  const readersCancelled: string[] = []
  let unrefs = 0
  let stderrEmitted = false
  const encoder = new TextEncoder()
  const close = (code: number) => {
    if (exited) return
    exited = true
    ended = true
    try { stdoutController.close() } catch {}
    try { stderrController.close() } catch {}
    resolveExited(code)
  }
  const controls: FakeControls = {
    emit: (text) => stdoutController.enqueue(encoder.encode(text)),
    stderr(text) {
      stderrEmitted = true
      stderrController.enqueue(encoder.encode(text))
    },
    respond(id, result, split = false) {
      const line = `${JSON.stringify({ id, result })}\n`
      if (!split) {
        controls.emit(line)
        return
      }
      const middle = Math.floor(line.length / 2)
      controls.emit(line.slice(0, middle))
      controls.emit(line.slice(middle))
    },
    exit: close,
  }
  const process: CodexAppServerProcess = {
    stdin: {
      write(data) {
        const written: WireMessage[] = []
        for (const line of data.trimEnd().split("\n")) {
          const message = JSON.parse(line) as WireMessage
          messages.push(message)
          written.push(message)
          onMessage(message, controls)
        }
        return options.write?.(data, written) ?? data.length
      },
      flush: () => 0,
      end() {
        ended = true
        if (options.endError !== undefined) throw options.endError
        if (!options.ignoreEnd) close(0)
      },
    },
    stdout: new ReadableStream({
      start: (controller) => { stdoutController = controller },
      cancel: () => { readersCancelled.push("stdout") },
    }),
    stderr: new ReadableStream({
      start: (controller) => { stderrController = controller },
      pull() {
        if (stderrEmitted) {
          stderrEmitted = false
          options.onStderrDrained?.()
        }
      },
      cancel: () => { readersCancelled.push("stderr") },
    }, { highWaterMark: 0 }),
    exited: new Promise((resolve) => { resolveExited = resolve }),
    kill(signal = "SIGTERM") {
      const normalized = typeof signal === "string" ? signal : "SIGTERM"
      signals.push(normalized)
      if (options.killError !== undefined) throw options.killError
      const matchingAttempts = signals.filter((signal) => signal === options.exitOnKill).length
      if (normalized === options.exitOnKill &&
        matchingAttempts >= (options.exitOnKillAttempt ?? 1)) close(0)
    },
    unref() { unrefs += 1 },
  }
  return {
    process,
    messages,
    signals,
    readersCancelled,
    get unrefs() { return unrefs },
    get ended() { return ended },
    ...controls,
  }
}

function thread(id: string): {
  id: string
  name: null
  preview: string
  updatedAt: number
  cwd: string
  gitInfo: null
  turns: Array<Record<string, unknown>>
  futureField: string
} {
  return {
    id,
    name: null,
    preview: id,
    updatedAt: 1,
    cwd: "/project",
    gitInfo: null,
    turns: [],
    futureField: "accepted",
  }
}

function lifecycleReplayFixture(upstream: ReturnType<typeof controlledProtocolServer>, token: string) {
  return Effect.gen(function*() {
    const proxy = yield* makeCodexTuiProxy({
      upstreamUrl: `ws://127.0.0.1:${upstream.server.port}`,
      bearerToken: token, initialThreadId: "root",
    })
    const subscription = yield* PubSub.subscribe(proxy.providerEvents)
    const events: ProviderTerminalEvent[] = []
    yield* Effect.forkScoped(Effect.forever(PubSub.take(subscription).pipe(
      Effect.tap((event) => Effect.sync(() => { events.push(event) })),
    )))
    const connect = (marker: string) => Effect.gen(function*() {
      const socket = new WebSocket(proxy.remoteUrl, { headers: { Authorization: `Bearer ${token}` } })
      yield* Effect.addFinalizer(() => Effect.sync(() => socket.terminate()))
      yield* Effect.promise(() => socketOpened(socket))
      socket.send(JSON.stringify({ method: marker }))
      yield* Effect.promise(() => waitUntil(() => upstream.requests.some((request) => request.message.method === marker)))
      return { socket, upstream: upstream.requests.find((request) => request.message.method === marker)!.socket }
    })
    const forward = (client: { socket: WebSocket; upstream: Bun.ServerWebSocket<unknown> }, frame: unknown) =>
      Effect.promise(async () => {
        const raw = JSON.stringify(frame)
        const forwarded = socketMessage(client.socket)
        client.upstream.send(raw)
        expect(await forwarded).toBe(raw)
      })
    return { proxy, events, connect, forward }
  })
}

function controlledProtocolServer(token: string, openDelayMs = 0): {
  readonly server: ReturnType<typeof Bun.serve>
  readonly requests: Array<{ socket: Bun.ServerWebSocket<unknown>; message: WireMessage }>
  respond(id: number | string, thread: Record<string, unknown>): void
  close(): Promise<void>
} {
  const requests: Array<{ socket: Bun.ServerWebSocket<unknown>; message: WireMessage }> = []
  const sockets = new Set<Bun.ServerWebSocket<unknown>>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bunServer) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("Unauthorized", { status: 401 })
      }
      if (openDelayMs > 0) await Bun.sleep(openDelayMs)
      return bunServer.upgrade(request)
        ? undefined
        : new Response("Upgrade required", { status: 426 })
    },
    websocket: {
      open(socket) { sockets.add(socket) },
      message(socket, data) {
        requests.push({ socket, message: JSON.parse(String(data)) as WireMessage })
      },
      close(socket) { sockets.delete(socket) },
    },
  })
  return {
    server,
    requests,
    respond(id, value) {
      const request = requests.find((candidate) => candidate.message.id === id)
      if (!request) throw new Error(`Missing request ${String(id)}`)
      request.socket.send(JSON.stringify({ id, result: { thread: value } }))
    },
    async close() {
      try {
        for (const socket of sockets) socket.close(1000, "Test complete")
        await waitUntil(() => sockets.size === 0)
      } finally {
        for (const socket of sockets) socket.terminate()
        await stopTestServer(server)
      }
    },
  }
}

function topLevelThread(id: string): Record<string, unknown> {
  return {
    id,
    preview: id,
    updatedAt: 12,
    cwd: "/project",
    ephemeral: false,
    parentThreadId: null,
    futureField: true,
  }
}

function socketOpened(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket did not open")), 2_000)
    socket.addEventListener("open", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("WebSocket failed to open"))
    }, { once: true })
  })
}

function socketClosed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket did not close")), 2_000)
    socket.addEventListener("close", (event) => {
      clearTimeout(timer)
      resolve(event)
    }, { once: true })
  })
}

function socketMessage(socket: WebSocket, timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket did not receive a message")), timeoutMs)
    socket.addEventListener("message", (event) => {
      clearTimeout(timer)
      if (typeof event.data === "string") resolve(event.data)
      else reject(new Error("WebSocket received a binary message"))
    }, { once: true })
  })
}

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!condition() && performance.now() < deadline) await Bun.sleep(5)
  if (!condition()) throw new Error("Condition was not met before timeout")
}
