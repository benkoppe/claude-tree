import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Deferred, Effect, Fiber, PubSub } from "effect"

import { makeAppRuntime, type AppRuntime } from "../../src/application/runtime"
import type { ApplicationState } from "../../src/application/state"
import { projectRootsViewModel } from "../../src/application/view-model"
import { nativePersistencePlatform, PersistencePlatform } from "../../src/infrastructure/metadata/platform"
import type { CodexAppServerClient, CodexThread } from "../../src/infrastructure/providers/codex/app-server"
import { CodexProvider } from "../../src/infrastructure/providers/codex/provider"
import { makeCodexTuiProxy } from "../../src/infrastructure/providers/codex/tui-proxy"
import type { TerminalProcess, TerminalProcessCallbacks, TerminalRenderer } from "../../src/infrastructure/terminal"
import { makeProviderStateRepository } from "../../src/services/provider-state-repository"
import type { ProviderTerminalEvent } from "../../src/services/provider"
import { makeTerminalSupervisor, type TerminalActivityEvent } from "../../src/services/terminal-supervisor"
import { makeSessionGuard } from "../../src/infrastructure/session-guard"
import { stopTestServer } from "./helpers/stop-test-server"

test("agent management replay: hidden completion, stale evidence, and verified durable owner release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-replay-"))
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const pty = new ReplayPty()
      let providerClosed = false
      const repository = yield* makeProviderStateRepository({
        projectDirectory: directory, providerId: "codex", stateHome: join(directory, "state"),
        instanceId: "replay",
      }).pipe(Effect.provideService(PersistencePlatform, nativePersistencePlatform))
      let connected = yield* Deferred.make<Bun.ServerWebSocket<undefined>>()
      const upstreamClients = new Set<Bun.ServerWebSocket<undefined>>()
      const upstream = Bun.serve<undefined>({
        hostname: "127.0.0.1", port: 0,
        fetch(request, server) {
          if (request.headers.get("Authorization") !== "Bearer replay-token") return new Response(null, { status: 401 })
          return server.upgrade(request) ? undefined : new Response(null, { status: 400 })
        },
        websocket: {
          open(socket) { upstreamClients.add(socket); Effect.runSync(Deferred.succeed(connected, socket)) },
          close(socket) { upstreamClients.delete(socket) },
          message() {},
        },
      })
      yield* Effect.addFinalizer(() => Effect.promise(async () => {
        for (const socket of upstreamClients) socket.terminate()
        await stopTestServer(upstream)
      }))

      let thread = transcript(directory, "baseline", true)
      let heldRead: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined
      let reads = 0
      const transport: CodexAppServerClient = {
        listThreads: () => Effect.sync(() => ({ data: [thread], nextCursor: null })),
        listLoadedThreadIds: () => Effect.succeed(["root"]),
        readThread: () => Effect.gen(function*() {
          reads += 1
          const captured = thread
          const barrier = heldRead
          heldRead = undefined
          if (barrier) {
            yield* Deferred.succeed(barrier.entered, undefined)
            yield* Deferred.await(barrier.release)
          }
          return captured
        }),
        forkThread: () => Effect.die("Replay must never mutate the provider"),
        close: () => Effect.void,
      }
      let remoteUrl = ""
      let providerEvents!: PubSub.PubSub<ProviderTerminalEvent>
      const provider = new CodexProvider(directory, "codex", {
        appServerFactory: () => Effect.succeed(transport),
        observedServicesFactory: (_executable, initialThreadId) => Effect.gen(function*() {
          const proxy = yield* makeCodexTuiProxy({
            upstreamUrl: `ws://127.0.0.1:${upstream.port}`, bearerToken: "replay-token", initialThreadId,
          })
          remoteUrl = proxy.remoteUrl
          providerEvents = proxy.providerEvents
          return {
            ...proxy, bearerToken: "replay-token",
            resources: { kind: "codex" as const, sidecarProcessGroupId: 42002 },
            close: () => proxy.close().pipe(Effect.tap(() => Effect.sync(() => { providerClosed = true }))),
          }
        }),
      })
      let surfaceReleased = false
      let screenLines = ["› ", "", "? for shortcuts"]
      const renderer: TerminalRenderer = {
        columns: 80, rows: 24,
        createSurface: (id) => ({
          id, write() {}, focus() {}, blur() {}, setActive() {},
          screen: () => ({ lines: screenLines, cursor: { x: 2, y: 0, visible: true } }),
          release() { surfaceReleased = true },
        }),
        clearSelection() {}, copyToClipboard() {}, onSelection: () => () => {},
      }
      let app!: AppRuntime
      const activities: TerminalActivityEvent[] = []
      const supervisor = yield* makeTerminalSupervisor({
        renderer, metadata: repository, guard: makeSessionGuard(join(directory, "session-guards"), "codex"),
        processes: { spawn(launch, _dimensions, callbacks) {
          expect(launch.cwd).toBe(directory)
          expect(launch.command).toContain("resume")
          expect(launch.command).toContain(remoteUrl)
          pty.callbacks = callbacks
          return pty
        } },
        events: {
          onActivityChanged(event) { activities.push(event); app.terminalEvents.onActivityChanged?.(event) },
          onObservation: (event) => app.terminalEvents.onObservation?.(event),
          onProcessExited: (event) => app.terminalEvents.onProcessExited?.(event),
          onSessionChanged: (event) => app.terminalEvents.onSessionChanged?.(event),
          onSessionTransitionError: (event) => app.terminalEvents.onSessionTransitionError?.(event),
        },
      })
      app = yield* makeAppRuntime({ provider, metadata: repository, terminals: supervisor, completionDelaysMs: [0] })
      yield* app.enterRoot("root")
      yield* app.resumeSession("root")
      const owner = (yield* supervisor.ownershipSnapshot)[0]!
      expect(owner).toMatchObject({ sessionId: "root", state: "running", processGroupId: pty.pid })
      yield* app.returnFromTerminal
      yield* settled(app)
      expect(yield* supervisor.activeSessionId).toBeNull()

      // The fake stock TUI receives every frame unmodified through the production proxy.
      let socket = new WebSocket(remoteUrl, { headers: { Authorization: "Bearer replay-token" } })
      yield* Effect.addFinalizer(() => Effect.sync(() => socket.terminate()))
      yield* Effect.promise(() => new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true })
        socket.addEventListener("error", reject, { once: true })
      }))
      let serverSocket = yield* Deferred.await(connected)
      const replayFrame = (method: string, params: unknown) => Effect.gen(function*() {
        const raw = JSON.stringify({ method, params })
        const forwarded = new Promise<string>((resolve) => {
          socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true })
        })
        serverSocket.send(raw)
        expect(yield* Effect.promise(() => forwarded)).toBe(raw)
      })
      const replay = (method: string, threadId: string, turnId: string, status: string) =>
        replayFrame(method, { threadId, turn: { id: turnId, status } })
      const statusBarrier = (activity: "blocked" | "working") => Effect.gen(function*() {
        yield* replayFrame("thread/status/changed", { threadId: "root", status: {
          type: "active", activeFlags: activity === "blocked" ? ["waitingOnApproval"] : [],
        } })
        yield* until(app, (state) => state.terminals.get("root")?.activity === activity)
      })
      yield* replay("turn/started", "root", "one", "inProgress")
      yield* until(app, (state) => state.terminals.get("root")?.activity === "working")
      yield* settled(app)
      const activityCount = activities.length
      yield* replay("turn/completed", "child", "child-turn", "completed")
      yield* statusBarrier("blocked")
      expect(activities.slice(activityCount).map((event) => event.activity)).toEqual(["blocked"])
      yield* statusBarrier("working")

      // A completed read captured for turn one arrives only after turn two supersedes it.
      thread = transcript(directory, "one", true)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      heldRead = { entered, release }
      yield* replay("turn/completed", "root", "one", "completed")
      yield* Deferred.await(entered)
      thread = transcript(directory, "two", false)
      yield* replay("turn/started", "root", "two", "inProgress")
      yield* until(app, (state) => state.terminals.get("root")?.activity === "working")
      yield* Deferred.succeed(release, undefined)
      const current = yield* until(app, (state) => state.refresh.active.size === 0 && previews(state).includes("Question two"))
      expect(previews(current)).not.toContain("Answer one")
      expect(current.unviewedSessionIds.has("root")).toBeFalse()

      const beforeStale = activities.length
      yield* replay("turn/completed", "root", "one", "completed")
      yield* statusBarrier("blocked")
      expect(activities.slice(beforeStale).map((event) => event.activity)).toEqual(["blocked"])
      yield* statusBarrier("working")
      expect(yield* app.handleTerminalActivity(activities[0]!)).toBeFalse()

      thread = transcript(directory, "two", true)
      yield* replay("turn/completed", "root", "two", "completed")
      const completed = yield* until(app, (state) => state.refresh.active.size === 0 && state.unviewedSessionIds.has("root"))
      expect(previews(completed)).toEqual(["Question baseline", "Answer baseline", "Question two", "Answer two"])
      expect(completed.pendingCompletions.has("root")).toBeFalse()
      expect(projectRootsViewModel(completed)[0]?.status).toBe("unviewed")
      const view = (yield* app.getViewModel).surface
      expect(view._tag).toBe("Graph")
      if (view._tag === "Graph") {
        expect(view.status).toBe("unviewed")
        expect(view.nodes.find((node) => node._tag === "Endpoint")?.status).toBe("unviewed")
      }
      const readsBeforeDuplicate = reads
      yield* replay("turn/completed", "root", "two", "completed")
      yield* settled(app)
      expect(reads).toBe(readsBeforeDuplicate)
      expect((yield* supervisor.ownershipSnapshot)[0]?.ownerId).toBe(owner.ownerId)

      // Reconnect misses a start frame; new-connection evidence cannot be vetoed
      // by the previous connection's settled or active-turn correlation.
      yield* Effect.scoped(Effect.gen(function*() {
        const nativeEvents = yield* PubSub.subscribe(providerEvents)
        const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }))
        serverSocket.close(1000, "Replay reconnect")
        expect((yield* PubSub.take(nativeEvents))._tag).toBe("Unavailable")
        yield* Effect.promise(() => closed)
      }))
      connected = yield* Deferred.make<Bun.ServerWebSocket<undefined>>()
      socket = new WebSocket(remoteUrl, { headers: { Authorization: "Bearer replay-token" } })
      yield* Effect.promise(() => new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true })
        socket.addEventListener("error", reject, { once: true })
      }))
      serverSocket = yield* Deferred.await(connected)
      const completedPrefix = thread.turns
      thread = { ...thread, turns: [...completedPrefix, ...transcript(directory, "three", false).turns.slice(1)] }
      yield* statusBarrier("working")
      // Unsupported root evidence releases native priority without guessing Idle.
      screenLines = ["press enter to confirm or esc to cancel"]
      yield* replayFrame("thread/status/changed", { threadId: "root", status: { type: "active", activeFlags: ["futureFlag"] } })
      yield* until(app, (state) => state.terminals.get("root")?.activity === "blocked")
      thread = { ...thread, turns: [...completedPrefix, ...transcript(directory, "three", true).turns.slice(1)] }
      yield* replay("turn/completed", "root", "three", "completed")
      yield* until(app, (state) => previews(state).includes("Answer three") && state.pendingCompletions.size === 0)

      // Keep the runtime owner and its guard until exit verification settles.
      const verifying = yield* Deferred.make<void>()
      const verified = yield* Deferred.make<void>()
      pty.verification = { entered: verifying, release: verified }
      const stopping = yield* Effect.forkChild(app.stopSession("root"))
      yield* Deferred.await(verifying)
      const stoppingOwner = (yield* supervisor.ownershipSnapshot)[0]
      const closedBeforeVerification = providerClosed
      const openBeforeVerification = pty.ptyOpen
      yield* Deferred.succeed(verified, undefined)
      expect(stoppingOwner).toMatchObject({
        ownerId: owner.ownerId, state: "stopping",
      })
      expect(closedBeforeVerification).toBeFalse()
      expect(openBeforeVerification).toBeTrue()
      yield* Fiber.join(stopping)
      yield* settled(app)
      expect(pty.signals).toEqual(["SIGTERM"])
      expect(pty.isGroupAlive()).toBeFalse()
      expect(pty.ptyOpen).toBeFalse()
      expect(pty.detached).toBeTrue()
      expect(providerClosed).toBeTrue()
      expect(surfaceReleased).toBeTrue()
      expect(yield* supervisor.ownershipSnapshot).toEqual([])
      expect([...yield* supervisor.ownedSessionIds]).toEqual([])
      expect((yield* app.getState).terminals.has("root")).toBeFalse()
      expect((yield* app.getState).unviewedSessionIds.has("root")).toBeFalse()
      expect(yield* app.handleTerminalActivity({ ...activities.at(-1)!, sequenceId: 999, activity: "working" })).toBeFalse()
      // Reopen the actual on-disk state, rather than trusting a cached repository view.
      const reopened = yield* makeProviderStateRepository({
        projectDirectory: directory, providerId: "codex", stateHome: join(directory, "state"),
        instanceId: "replay-check", requireExisting: true,
      }).pipe(Effect.provideService(PersistencePlatform, nativePersistencePlatform))
      expect(yield* reopened.load).not.toHaveProperty("terminalOwners")
      yield* app.shutdown
    })))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function transcript(cwd: string, turnId: string, completed: boolean): CodexThread {
  const turn = (id: string, done: boolean) => ({
    id, status: done ? "completed" as const : "inProgress" as const,
    items: [
      { id: `user-${id}`, type: "userMessage", content: [{ type: "text", text: `Question ${id}` }] },
      ...(done ? [{ id: `agent-${id}`, type: "agentMessage", text: `Answer ${id}` }] : []),
    ],
  })
  return { id: "root", name: null, preview: "Replay", updatedAt: 1, cwd, gitInfo: null,
    turns: turnId === "baseline" ? [turn(turnId, completed)] : [turn("baseline", true), turn(turnId, completed)] }
}

function previews(state: ApplicationState): string[] {
  const read = state.provider.transcripts.get("root")
  return read?._tag === "Available" ? read.messages.map((message) => message.preview) : []
}

function until(app: AppRuntime, predicate: (state: ApplicationState) => boolean) {
  return Effect.gen(function*() {
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const state = yield* app.getState
      if (predicate(state)) return state
      yield* Effect.yieldNow
    }
    throw new Error("Replay did not reach its expected actor state")
  })
}

function settled(app: AppRuntime) {
  return until(app, (state) => state.refresh.active.size === 0)
}

class ReplayPty implements TerminalProcess {
  readonly pid = 42001
  readonly processGroupId = this.pid
  readonly exited: Promise<number>
  readonly ptyDrained: Promise<void>
  exitCode: number | null = null
  ptyOpen = true
  detached = false
  callbacks!: TerminalProcessCallbacks
  readonly signals: NodeJS.Signals[] = []
  verification?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
  private resolveExit!: (code: number) => void
  private resolveDrain!: () => void
  constructor() {
    this.exited = new Promise((resolve) => { this.resolveExit = resolve })
    this.ptyDrained = new Promise((resolve) => { this.resolveDrain = resolve })
  }
  write() {}
  resize() {}
  signalGroup(signal: NodeJS.Signals) {
    this.signals.push(signal)
    this.exitCode = 0
    this.resolveExit(0)
  }
  isGroupAlive() { return this.exitCode === null }
  waitForGroupExit() {
    return Effect.gen({ self: this }, function*() {
      if (this.verification) {
        yield* Deferred.succeed(this.verification.entered, undefined)
        yield* Deferred.await(this.verification.release)
      }
      return !this.isGroupAlive()
    })
  }
  closePty() { this.ptyOpen = false; this.resolveDrain(); this.callbacks.onPtyClosed() }
  unref() { this.detached = true }
}
