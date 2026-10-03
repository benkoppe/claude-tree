import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, PubSub } from "effect"
import { TestClock } from "effect/testing"

import { makeCodexSidecar, type CodexSidecarProcess } from "../../src/infrastructure/providers/codex/sidecar"
import { makeCodexTuiProxy } from "../../src/infrastructure/providers/codex/tui-proxy"
import { stopTestServer } from "./helpers/stop-test-server"

for (const phase of ["directory", "write", "mode", "sync", "port"] as const) {
  test(`default sidecar acquisition waits for slow ${phase} work instead of its former deadline`, async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const wait = () => Effect.runPromise(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
      const removed: string[] = []
      let spawned = false
      let resolveExit!: (code: number) => void
      const process: CodexSidecarProcess = {
        pid: 42001, exitCode: null, exited: new Promise((resolve) => { resolveExit = resolve }),
        stderr: new ReadableStream({ start(controller) { controller.close() } }),
        kill() { Object.assign(process, { exitCode: 0 }); resolveExit(0) }, unref() {},
      }
      const acquisition = yield* Effect.forkChild(makeCodexSidecar("codex", {
        makeTemporaryDirectory: async () => { if (phase === "directory") await wait(); return "/controlled/codex" },
        writeToken: async () => { if (phase === "write") await wait() },
        setTokenMode: async () => { if (phase === "mode") await wait() },
        syncToken: async () => { if (phase === "sync") await wait() },
        allocatePort: async () => { if (phase === "port") await wait(); return 42002 },
        removeDirectory: async (directory) => { removed.push(directory) },
        spawn: () => { spawned = true; return process },
        signalProcessGroup: (child, signal) => child.kill(signal),
      }))
      yield* Deferred.await(entered)
      yield* TestClock.adjust(120_000)
      expect(acquisition.pollUnsafe()).toBeUndefined()
      expect(spawned).toBeFalse()
      yield* Deferred.succeed(release, undefined)
      const sidecar = yield* Fiber.join(acquisition)
      expect(spawned).toBeTrue()
      yield* sidecar.close()
      expect(removed).toEqual(["/controlled/codex"])
    }).pipe(Effect.provide(TestClock.layer()))))
  })
}

test("unlimited sidecar acquisition remains cancellable and rolls back before spawning", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    let aborted = false
    let removed = false
    let spawned = false
    const acquisition = yield* Effect.forkChild(makeCodexSidecar("codex", {
      makeTemporaryDirectory: async () => "/controlled/codex",
      writeToken: async (_path, _token, { signal }) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")) }, { once: true })
        Deferred.doneUnsafe(entered, Effect.void)
      }),
      removeDirectory: async () => { removed = true },
      spawn: () => { spawned = true; throw new Error("must not spawn") },
    }))
    yield* Deferred.await(entered)
    yield* TestClock.adjust(120_000)
    expect(acquisition.pollUnsafe()).toBeUndefined()
    yield* Fiber.interrupt(acquisition)
    expect(Exit.isFailure(yield* Fiber.await(acquisition))).toBeTrue()
    expect(aborted).toBeTrue()
    expect(removed).toBeTrue()
    expect(spawned).toBeFalse()
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("proxy adoption waits beyond its former acknowledgment budget without forwarding early", async () => {
  const clients = new Set<Bun.ServerWebSocket<undefined>>()
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }) },
    websocket: {
      open(socket) { clients.add(socket) }, close(socket) { clients.delete(socket) },
      message(socket) {
        socket.send(JSON.stringify({ id: 1, result: { thread: {
          id: "real", preview: "New thread", updatedAt: 1, cwd: "/project", ephemeral: false, parentThreadId: null,
        } } }))
      },
    },
  })
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const proxy = yield* makeCodexTuiProxy({
        upstreamUrl: `ws://127.0.0.1:${server.port}`, bearerToken: "controlled", initialThreadId: "temporary",
        initialThreadIsTemporary: true,
      })
      const transitions = yield* PubSub.subscribe(proxy.transitions)
      const client = new WebSocket(proxy.remoteUrl, { headers: { Authorization: "Bearer controlled" } })
      yield* Effect.addFinalizer(() => Effect.sync(() => client.terminate()))
      yield* Effect.promise(() => new Promise<void>((resolve, reject) => {
        client.addEventListener("open", () => resolve(), { once: true })
        client.addEventListener("error", reject, { once: true })
      }))
      let forwarded = false
      const response = new Promise<string>((resolve) => client.addEventListener("message", (event) => {
        forwarded = true; resolve(event.data as string)
      }, { once: true }))
      client.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }))
      const transition = yield* PubSub.take(transitions)
      yield* TestClock.adjust(120_000)
      expect(forwarded).toBeFalse()
      expect(client.readyState).toBe(WebSocket.OPEN)
      yield* Deferred.succeed(transition.acknowledgment, undefined)
      expect(JSON.parse(yield* Effect.promise(() => response)).result.thread.id).toBe("real")
      yield* proxy.close()
    }).pipe(Effect.provide(TestClock.layer()))))
  } finally {
    for (const client of clients) client.terminate()
    await stopTestServer(server)
  }
})
