import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, PubSub } from "effect"
import { TestClock } from "effect/testing"

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
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") {
        controls.respond(message.id, { userAgent: "test", future: true }, true)
      }
      if (message.method === "thread/read") {
        const params = message.params as { threadId: string }
        setTimeout(
          () => controls.respond(message.id, { thread: thread(params.threadId) }, params.threadId === "slow"),
          params.threadId === "slow" ? 10 : 0,
        )
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
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/read") {
        const params = message.params as { threadId: string }
        if (params.threadId === "expired" && typeof message.id === "number") expiredId = message.id
        else controls.respond(message.id, { thread: thread(params.threadId) })
      }
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", {
        spawn: () => transport.process,
        requestTimeoutMs: 10,
      })
      const timeout = yield* Effect.flip(client.readThread("expired"))
      expect(timeout).toBeInstanceOf(CodexRequestTimeout)
      expect(timeout).toMatchObject({ method: "thread/read", timeoutMs: 10 })

      transport.respond(expiredId, { thread: thread("expired") })
      yield* Effect.sleep(5)
      expect((yield* client.readThread("live")).id).toBe("live")
    })))
  })

  test("request timeout covers a hung serialized write", async () => {
    let releaseWrite: (() => void) | undefined
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
    }, {
      write(data, messages) {
        if (!messages.some((message) => message.method === "thread/read")) return data.length
        return new Promise<number>((resolve) => {
          releaseWrite = () => resolve(data.length)
        })
      },
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", {
        spawn: () => transport.process,
        requestTimeoutMs: 10,
      })
      expect(yield* Effect.flip(client.readThread("blocked"))).toBeInstanceOf(CodexRequestTimeout)
      releaseWrite?.()
    })))
  })

  test("interruption removes a request blocked in serialized write", async () => {
    let blockedId: number | undefined
    let releaseWrite: (() => void) | undefined
    let blockNextRead = true
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/read") {
        const params = message.params as { threadId: string }
        if (params.threadId === "blocked" && typeof message.id === "number") blockedId = message.id
        if (params.threadId === "live") controls.respond(message.id, { thread: thread("live") })
      }
    }, {
      write(data, messages) {
        if (!blockNextRead || !messages.some((message) => message.method === "thread/read")) return data.length
        blockNextRead = false
        return new Promise<number>((resolve) => {
          releaseWrite = () => resolve(data.length)
        })
      },
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      const fiber = yield* Effect.forkChild(client.readThread("blocked"))
      yield* Effect.promise(() => waitUntil(() => blockedId !== undefined))
      yield* Fiber.interrupt(fiber)
      releaseWrite?.()
      yield* Effect.sleep(5)
      transport.respond(blockedId, { thread: thread("blocked") })
      yield* Effect.sleep(5)
      expect((yield* client.readThread("live")).id).toBe("live")
    })))
  })

  test("never sends a queued request after its fiber is cancelled", async () => {
    let releaseBlocker!: () => void
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/read") {
        const params = message.params as { threadId: string }
        if (params.threadId === "blocker") {
          controls.respond(message.id, { thread: thread("blocker") })
        }
      }
    }, {
      write(data, messages) {
        if (!messages.some((message) =>
          message.method === "thread/read" &&
          (message.params as { threadId?: string }).threadId === "blocker"
        )) return data.length
        return new Promise<number>((resolve) => {
          releaseBlocker = () => resolve(data.length)
        })
      },
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      const blocker = yield* Effect.forkChild(client.readThread("blocker"))
      yield* Effect.promise(() => waitUntil(() => transport.messages.some((message) =>
        message.method === "thread/read" &&
        (message.params as { threadId?: string }).threadId === "blocker"
      )))
      const cancelled = yield* Effect.forkChild(client.readThread("cancelled"))
      yield* Effect.sleep(5)
      yield* Fiber.interrupt(cancelled)
      releaseBlocker()
      expect((yield* Fiber.join(blocker)).id).toBe("blocker")
      yield* Effect.sleep(5)
      expect(transport.messages.some((message) =>
        message.method === "thread/read" &&
        (message.params as { threadId?: string }).threadId === "cancelled"
      )).toBeFalse()
    })))
  })

  test("reports a sent fork as ambiguous when its response deadline expires", async () => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", {
        spawn: () => transport.process,
        requestTimeoutMs: 10,
      })
      const error = yield* Effect.flip(client.forkThread("parent", "turn", "/project"))
      expect(error).toBeInstanceOf(CodexMutationAmbiguousError)
      expect(error).toMatchObject({ method: "thread/fork" })
    })))
  })

  test("uses TestClock to settle a dispatched mutation timeout exactly once", async () => {
    const error = await Effect.runPromise(Effect.provide(Effect.scoped(Effect.gen(function*() {
      const forkDispatched = yield* Deferred.make<void>()
      const transport = fakeProcess((message, controls) => {
        if (message.method === "initialize") controls.respond(message.id, {})
        if (message.method === "thread/fork") Deferred.doneUnsafe(forkDispatched, Effect.void)
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
        value.turns = params.threadId === "good"
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
      expect(yield* Effect.flip(client.readThread("mismatch"))).toBeInstanceOf(CodexProtocolError)
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

  test("answers unsupported server requests without exposing a raw request API", async () => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/loaded/list") {
        controls.emit(`${JSON.stringify({ id: "server-1", method: "account/login/start", params: {} })}\n`)
        controls.respond(message.id, { data: ["loaded"] })
      }
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      expect(yield* client.listLoadedThreadIds()).toEqual(["loaded"])
      yield* Effect.sleep(5)
    })))
    expect(transport.messages).toContainEqual({
      id: "server-1",
      error: { code: -32601, message: "Unsupported server request: account/login/start" },
    })
  })

  test("fails pending requests on process exit with bounded stderr diagnostics", async () => {
    const transport = fakeProcess((message, controls) => {
      if (message.method === "initialize") controls.respond(message.id, {})
      if (message.method === "thread/read") {
        controls.stderr("x".repeat(20_000))
        setTimeout(() => controls.exit(17), 5)
      }
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* makeCodexAppServerClient("codex", { spawn: () => transport.process })
      const error = yield* Effect.flip(client.readThread("dies"))
      expect(error).toBeInstanceOf(CodexProcessError)
      if (error instanceof CodexProcessError) {
        expect(error.exitCode).toBe(17)
        expect((error.stderr ?? "").length).toBeLessThanOrEqual(8_192)
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
      return yield* Effect.flip(client.close())
    }))))

    expect(Exit.isFailure(exit)).toBeTrue()
    if (Exit.isSuccess(exit)) throw new Error("expected cleanup failure")
    expect(Cause.squash(exit.cause)).toBeInstanceOf(CodexCleanupError)
    expect(transport.signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"])
    expect(transport.readersCancelled.sort()).toEqual(["stderr", "stdout"])
    expect(transport.unrefs).toBe(3)
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
      return yield* Effect.flip(client.close())
    }))))

    expect(Exit.isFailure(exit)).toBeTrue()
    if (Exit.isSuccess(exit)) throw new Error("expected cleanup failure")
    expect(Cause.squash(exit.cause)).toBeInstanceOf(CodexCleanupError)
    expect(transport.signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"])
    expect(transport.readersCancelled.sort()).toEqual(["stderr", "stdout"])
    expect(transport.unrefs).toBe(3)
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
      void server.stop(true)
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
      for (const socket of sockets) socket.terminate()
      void server.stop(true)
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

        const noTransition = yield* Effect.forkChild(
          PubSub.take(subscription).pipe(Effect.timeoutOption(50)),
        )
        client.send(JSON.stringify({ id: 4, method: "thread/fork", params: { threadId: "thread-d" } }))
        yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 4))
        upstream.respond(4, {
          ...topLevelThread("child"),
          parentThreadId: "thread-d",
        })
        expect((yield* Fiber.join(noTransition))._tag).toBe("None")
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

  test("forwards current-sized Codex responses without closing the proxy", async () => {
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

        const largePayload = "x".repeat(7_500_000)
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

  test("does not forward a switch response until its transition is acknowledged", async () => {
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
        let forwarded = false
        const response = socketMessage(client).then((message) => {
          forwarded = true
          return message
        })
        client.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }))
        yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 1))
        upstream.respond(1, topLevelThread("thread-b"))

        const request = yield* PubSub.take(subscription).pipe(Effect.timeout(1_000))
        yield* Effect.sleep(20)
        expect(forwarded).toBeFalse()
        yield* Deferred.succeed(request.acknowledgment, undefined)
        expect(JSON.parse(yield* Effect.promise(() => response))).toMatchObject({
          id: 1,
          result: { thread: { id: "thread-b" } },
        })
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
        client.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }))
        yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 1))
        upstream.respond(1, topLevelThread("thread-b"))
        yield* PubSub.take(subscription).pipe(Effect.timeout(1_000))
        expect((yield* Effect.promise(() => closed)).code).toBe(1011)
      }))))
      expect(Exit.isFailure(exit)).toBeTrue()
      if (Exit.isSuccess(exit)) throw new Error("expected cleanup failure")
      expect(Cause.squash(exit.cause)).toBeInstanceOf(CodexTuiProxyError)
    } finally {
      await upstream.close()
    }
  })

  test("awaits queued publications and returns typed proxy cleanup failures", async () => {
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
        yield* PubSub.subscribe(proxy.transitions)
        const client = new WebSocket(proxy.remoteUrl, {
          headers: { Authorization: `Bearer ${token}` },
        })
        yield* Effect.promise(() => socketOpened(client))
        client.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }))
        client.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }))
        yield* Effect.promise(() => waitUntil(() => upstream.requests.length === 2))
        upstream.respond(1, topLevelThread("thread-b"))
        upstream.respond(2, topLevelThread("thread-c"))
        yield* Effect.sleep(20)
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
    stderr: (text) => stderrController.enqueue(encoder.encode(text)),
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
      cancel: () => { readersCancelled.push("stderr") },
    }),
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
      for (const socket of sockets) socket.terminate()
      void server.stop(true)
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
