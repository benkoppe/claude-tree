import { describe, expect, test } from "bun:test"
import { forkSession, getSessionMessages, InMemorySessionStore, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { ClaudeTerminalObserver } from "../../src/infrastructure/providers/claude/terminal-observer"
import { ClaudeProvider } from "../../src/infrastructure/providers/claude/provider"

import {
  ApplicationShutdownError,
  ApplicationOperationError,
  IntentRejectedError,
  makeAppRuntime,
  makeNavigationWriter,
  RemovalOperationError,
  selectProjectedTranscript,
  selectSessionStatus,
  type AppRuntime,
  type ApplicationMetadataFacet,
  type ApplicationState,
} from "../../src/application"
import {
  PersistenceError,
  ProviderError,
  SessionOwnedError,
} from "../../src/domain/errors"
import {
  NullTerminalObserver,
  type AgentMessage,
  type AgentSession,
  type AgentSessionSnapshot,
  type TerminalObservation,
  type TerminalScreen,
} from "../../src/domain/model"
import type {
  BranchRelation,
  PendingIdentityAdoption,
  ProjectState,
} from "../../src/domain/persistence"
import {
  makeBranchMutationReconciliationSignal,
  type AgentProviderApi,
  type BranchOutcome,
  type PreparedTerminal,
} from "../../src/services/provider"
import {
  TerminalCleanupError,
  type TerminalSupervisorApi,
} from "../../src/services/terminal-supervisor"

const ROOT = "root"
const CHILD = "child"

describe("application actor", () => {
  for (const { target, streaming } of (["wrapped identifier", "unknown", "unreadable", "duplicate"] as const).flatMap((target) =>
    (target === "wrapped identifier" ? [false] : [false, true]).map((streaming) => ({ target, streaming })))) {
    test(`SDK-backed native fork rewind reconciles a ${target} target before the replacement answer (streaming: ${streaming})`, async () => {
      const waitForState = (runtime: AppRuntime, predicate: (state: ApplicationState) => boolean, description = "SDK workflow state") => Effect.gen(function*() {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const state = yield* runtime.getState
          if (predicate(state)) return state
          // Let SDK promises and Node I/O settle without advancing reconciliation timers.
          yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
        }
        return yield* Effect.die(`Timed out waiting for ${description}`)
      })
      const fixture = makeFixture()
      const store = new InMemorySessionStore()
      const sourceId = crypto.randomUUID()
      const sourceIds: string[] = Array.from({ length: 6 }, () => crypto.randomUUID())
      const prompt = "use veryLongIdentifier with care"
      const texts = ["first question", "first answer", prompt, "discarded answer", target === "duplicate" ? prompt : "last question", "last answer"]
      const projectKey = process.cwd().replaceAll("/", "-")
      const sessionIds: string[] = [sourceId]
      const sdkReads: Array<{ sessionId: string; ids: readonly string[] }> = []
      const observer = new ClaudeTerminalObserver()
      const provider = new ClaudeProvider(process.cwd(), {
        resolveExecutable: () => "/usr/bin/claude",
        observerFactory: () => observer,
        sdk: {
          async getSessionInfo(sessionId) {
            return sessionIds.includes(sessionId) ? { sessionId, summary: sessionId, lastModified: 1 } : undefined
          },
          async listSessions() {
            return sessionIds.map((sessionId) => ({ sessionId, summary: sessionId, lastModified: 1 }))
          },
          async getSessionMessages(sessionId, options) {
            const messages = await getSessionMessages(sessionId, { ...options, sessionStore: options.sessionStore ?? store })
            sdkReads.push({ sessionId, ids: messages.map((message) => message.uuid) })
            return messages
          },
          async forkSession(sessionId, options) {
            const result = await forkSession(sessionId, { ...options, sessionStore: store })
            sessionIds.push(result.sessionId)
            return result
          },
          async importSessionToStore(sessionId, destination) {
            await destination.append({ projectKey, sessionId }, store.getEntries({ projectKey, sessionId }))
          },
        },
      }, { forkValidationRetryDelaysMs: [] })
      await store.append({ projectKey, sessionId: sourceId }, sourceIds.map((id, index) =>
        sdkWorkflowEntry(sourceId, id, sourceIds[index - 1] ?? null, index % 2 ? "assistant" : "user", texts[index]!)))

      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const runtime = yield* makeAppRuntime({ ...fixture.options, provider })
        yield* waitForState(runtime, (state) => !state.refresh.initialPending)
        yield* runtime.branchFrom({ sessionId: sourceId, messageId: sourceIds[5]! })
        const childId = sessionIds[1]!
        const branched = yield* runtime.getState
        const relation = branched.relations.find((item) => item.childSessionId === childId)!
        expect(relation.sharedMessages.map((pair) => pair.parentMessageId)).toEqual(sourceIds)
        const copiedIds = relation.sharedMessages.map((pair) => pair.childMessageId)
        expect(copiedIds.every((id) => !sourceIds.includes(id))).toBeTrue()
        yield* runtime.returnFromTerminal
        yield* waitForState(runtime, (state) => state.refresh.active.size === 0)
        yield* runtime.resumeSession(childId)
        const ownerId = (yield* runtime.getState).terminals.get(childId)!.ownerId!
        let sequenceId = 0
        const delivered: TerminalObservation[] = []
        const deliver = (observation: TerminalObservation) => Effect.gen(function*() {
          delivered.push(observation)
          expect(yield* runtime.handleTerminalObservation({ ownerId, sequenceId: ++sequenceId, sessionId: childId, wasActive: true, observation })).toBeTrue()
        })
        const drain = () => Effect.forEach(observer.takeObservations(), deliver, { discard: true })
        const screen = (lines: readonly string[]): TerminalScreen => ({ lines, cursor: { x: 0, y: 0, visible: false } })
        const picker = screen([
          "│ Rewind │", "│ Restore and fork the conversation to the │", "│ point before… │",
          ...(target === "unreadable" ? [] : [`│ ❯ ${target === "unknown" ? "not in provider history" : prompt} │`]),
        ])
        observer.observeScreen(picker)
        yield* drain()
        expect(observer.observeInput(new TextEncoder().encode("\r"))).toBeUndefined()
        observer.observeScreen(picker)
        yield* drain()
        expect(delivered).toEqual([])
        const restored = target === "unreadable"
          ? screen(["Restored history; composer not visible"])
          : screen(["────────────────────────────────", `❯ ${target === "unknown" ? "not in provider history" : "use veryLongIdenti"}`, ...(target === "unknown" ? [] : ["  fier with care"]), "────────────────────────────────"])
        const readsBeforeRewind = sdkReads.length
        observer.observeScreen(restored)
        yield* drain()
        expect(delivered).toEqual([{ _tag: "Rewind" }])
        expect([...(yield* runtime.getState).refresh.active.values()].some((refresh) =>
          refresh.reason === "reconciliation" && refresh.sessionIds.has(childId))).toBeTrue()
        const draft = observer.observeDraft(restored)
        yield* drain()
        if (draft !== undefined) yield* deliver({ _tag: "Draft", draft })
        const observed = yield* runtime.getState
        expect(observed.rewindAnchors.has(childId)).toBe(target === "wrapped identifier")
        expect(selectProjectedTranscript(observed, childId).map((item) => item.id)).toEqual(target === "wrapped identifier" ? copiedIds.slice(0, 2) : copiedIds)
        if (target === "wrapped identifier") {
          yield* runtime.returnFromTerminal
          const view = yield* runtime.getViewModel
          expect(view.surface._tag).toBe("Graph")
          if (view.surface._tag !== "Graph") throw new Error("Expected graph")
          const boundary = view.surface.nodes.find((node) => node._tag === "Message" && node.preview === "first answer")!
          const endpoint = view.surface.nodes.find((node) => node._tag === "Endpoint" && node.session.id === childId)
          expect(endpoint?.parentIds).toEqual([boundary.id])
        }
        // Unanchored rewinds must reconcile without a return, idle, or manual refresh.
        yield* TestClock.adjust(100)
        yield* waitForState(runtime, (state) => sdkReads.length > readsBeforeRewind && state.refresh.active.size === 0, "rewind reconciliation")
        if (target !== "wrapped identifier") yield* runtime.returnFromTerminal
        const returned = yield* runtime.getState
        expect(selectProjectedTranscript(returned, childId).map((item) => item.id)).toEqual(target === "wrapped identifier" ? copiedIds.slice(0, 2) : copiedIds)
        expect(selectProjectedTranscript(returned, sourceId).map((item) => item.id)).toEqual(sourceIds)
        yield* waitForState(runtime, (state) => state.refresh.active.size === 0)
        expect((yield* Effect.promise(() => getSessionMessages(childId, { dir: process.cwd(), sessionStore: store }))).map((item) => item.uuid)).toEqual(copiedIds)

        const replacementId = crypto.randomUUID()
        const submission = observer.observeInput(new TextEncoder().encode("replacement user only\r"))
        yield* drain()
        expect(submission?._tag).toBe("Submission")
        if (submission) yield* deliver(submission)
        const transitions = observer.observeOutput(new TextEncoder().encode("\u001b]0;⠋ Claude Code\u0007"))
        expect(transitions).toEqual(["working"])
        for (const activity of transitions) {
          expect(yield* runtime.handleTerminalActivity({ ownerId, sequenceId: ++sequenceId, sessionId: childId, wasActive: false, activity })).toBeTrue()
        }
        yield* Effect.promise(() => store.append({ projectKey, sessionId: childId }, [
          sdkWorkflowEntry(childId, replacementId, copiedIds[1]!, "user", "replacement user only"),
        ]))
        let tailId = replacementId
        if (streaming) {
          const id = crypto.randomUUID()
          yield* Effect.promise(() => store.append({ projectKey, sessionId: childId }, [
            sdkWorkflowEntry(childId, id, tailId, "assistant", "streaming first block", null),
          ]))
          tailId = id
        }
        const discoveryReads = sdkReads.length
        yield* TestClock.adjust(100)
        yield* waitForState(runtime, (state) => sdkReads.length > discoveryReads &&
          (target === "wrapped identifier" ? selectProjectedTranscript(state, childId).at(-1)?.id === replacementId : state.replacementCandidates.has(childId)), "submission discovery")
        if (target !== "wrapped identifier") {
          expect((yield* runtime.getState).replacementCandidates.has(childId)).toBeTrue()
        }
        if (streaming) {
          yield* Effect.promise(() => store.append({ projectKey, sessionId: childId }, [
            sdkWorkflowEntry(childId, crypto.randomUUID(), tailId, "assistant", "streaming second block", null),
          ]))
        }
        yield* TestClock.adjust(100)
        const accepted = yield* waitForState(runtime, (state) => selectProjectedTranscript(state, childId).at(-1)?.id === replacementId, "replacement acceptance")
        const replacementReads = sdkReads.slice(discoveryReads).filter((read) => read.sessionId === childId)
        expect(replacementReads.map((read) => read.ids.slice(0, 3))).toEqual(
          Array.from({ length: target === "wrapped identifier" ? 1 : 2 }, () => [...copiedIds.slice(0, 2), replacementId]),
        )
        expect(replacementReads.map((read) => read.ids.length)).toEqual(streaming ? [4, 5] : target === "wrapped identifier" ? [3] : [3, 3])
        expect(selectSessionStatus(accepted, childId)).toBe("working")
        expect(selectProjectedTranscript(accepted, childId).map((item) => item.id)).toEqual([...copiedIds.slice(0, 2), replacementId])
        expect(selectProjectedTranscript(accepted, sourceId).map((item) => item.id)).toEqual(sourceIds)
        expect(accepted.pendingCompletions.size).toBe(0)
        expect(accepted.unviewedSessionIds.size).toBe(0)
        expect(accepted.modal).toBeNull()
        const view = yield* runtime.getViewModel
        expect(view.surface._tag).toBe("Graph")
        if (view.surface._tag !== "Graph") throw new Error("Expected graph")
        const user = view.surface.nodes.find((node) => node._tag === "Message" && node.preview === "replacement user only")!
        const endpoint = view.surface.nodes.find((node) => node._tag === "Endpoint" && node.session.id === childId)
        expect(endpoint?.parentIds).toEqual([user.id])
        expect(endpoint?._tag === "Endpoint" && endpoint.status).toBe("working")
        expect(store.getEntries({ projectKey, sessionId: childId }).filter((entry) => copiedIds.includes(entry.uuid!))).toHaveLength(6)
      }).pipe(Effect.provide(TestClock.layer()))))
    })
  }

  test("forks a 10,000-message tree while refresh is stalled and preserves the child after the late snapshot", async () => {
    const fixture = makeFixture()
    const messages = Array.from({ length: 10_000 }, (_, index) => message(`m${index}`, index % 2 ? "agent" : "user", `message ${index}`, index))
    fixture.snapshot = snapshot([session(ROOT, "Large tree")], new Map([[ROOT, messages]]))
    const child = prepared("large-fork", "Large fork")
    fixture.branchOutcome = {
      _tag: "ValidatedBranch", ...child,
      derivation: {
        parentSessionId: ROOT, childSessionId: child.session.id, sourceMessageId: "m9999",
        sharedMessages: messages.map((item, index) => ({ parentMessageId: item.id, childMessageId: `copy${index}` })),
      },
    }
    const started = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* waitForState(runtime, (state) => !state.refresh.initialPending)
      fixture.fullSnapshot = () => Effect.gen(function*() {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return fixture.snapshot
      })
      const refresh = yield* Effect.forkScoped(runtime.refresh())
      yield* Deferred.await(started)
      yield* runtime.branchFrom({ sessionId: ROOT, messageId: "m9999" })
      const during = yield* runtime.getState
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(refresh)
      yield* runtime.returnFromTerminal
      const view = yield* runtime.getViewModel
      return { during, after: yield* runtime.getState, view }
    })))
    expect(result.during.refresh.active.size).toBe(1)
    expect(result.after.terminals.has(child.session.id)).toBeTrue()
    expect(result.after.relations).toHaveLength(1)
    expect(result.view.surface._tag).toBe("Graph")
    expect(fixture.calls.filter((call) => call === `show:${child.session.id}`)).toHaveLength(1)
  })

  test("cursor acceptance and terminal display do not wait for navigation persistence", async () => {
    const fixture = makeFixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const metadata = { ...fixture.options.metadata, updateMetadata: (transform: Parameters<ApplicationMetadataFacet["updateMetadata"]>[0]) =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)),
          Effect.andThen(fixture.options.metadata.updateMetadata(transform))) }
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata })
      yield* waitForState(runtime, (state) => !state.refresh.initialPending)
      yield* runtime.selectRoot(ROOT)
      yield* Deferred.await(started)
      for (let index = 0; index < 100; index++) yield* runtime.selectRoot(index % 2 ? ROOT : CHILD)
      yield* runtime.enterRoot(ROOT)
      const opening = yield* Effect.forkChild(runtime.openEndpoint(ROOT))
      yield* waitForState(runtime, (state) => state.surface._tag === "Terminal")
      expect(fixture.calls).toContain(`show:${ROOT}`)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(opening)
    })))
  })

  test("the catalogue is usable during hydration and entering a root reads only its family", async () => {
    const fixture = makeFixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const listed = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const provider = { ...fixture.options.provider,
        loadSessionSnapshotProgressively: (publish: (value: AgentSessionSnapshot) => Effect.Effect<void>) => Effect.gen(function*() {
          yield* publish({ sessions: fixture.snapshot.sessions, transcripts: new Map() })
          yield* Deferred.succeed(listed, undefined)
          yield* Deferred.await(release)
          return fixture.snapshot
        }),
      }
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider })
      yield* Deferred.await(listed)
      yield* waitForState(runtime, (state) => state.provider.sessions.size === 2)
      const catalogue = yield* runtime.getViewModel
      expect(catalogue.initialLoadPending).toBeFalse()
      expect(catalogue.refreshing).toBeTrue()
      expect(catalogue.surface._tag).toBe("Roots")
      if (catalogue.surface._tag !== "Roots") throw new Error("Expected roots")
      expect(catalogue.surface.roots).toHaveLength(2)
      expect(catalogue.surface.roots.every((root) => root.history._tag === "Loading")).toBeTrue()
      yield* runtime.selectRoot(ROOT)
      yield* runtime.enterRoot(ROOT)
      expect(fixture.incrementalReads).toEqual([[ROOT]])
      expect((yield* runtime.getState).surface._tag).toBe("Graph")
      expect((yield* runtime.getState).refresh.initialPending).toBeTrue()
      yield* Deferred.succeed(release, undefined)
      const completed = yield* waitForState(runtime, (state) => state.refresh.active.size === 0)
      expect(completed.surface._tag).toBe("Graph")
    })))
  })

  test("a late family load cannot take focus from a newer navigation", async () => {
    const fixture = makeFixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const release = yield* Deferred.make<void>()
      const provider = { ...fixture.options.provider,
        loadSessionSnapshotProgressively: (publish: (value: AgentSessionSnapshot) => Effect.Effect<void>) =>
          publish({ sessions: fixture.snapshot.sessions, transcripts: new Map() }).pipe(Effect.andThen(Effect.never)),
        loadSessionSnapshotFor: (ids: readonly string[]) => Deferred.await(release).pipe(
          Effect.andThen(fixture.options.provider.loadSessionSnapshotFor(ids))),
      }
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider })
      yield* waitForState(runtime, (state) => state.provider.sessions.size === 2)
      const entering = yield* Effect.forkChild(Effect.flip(runtime.enterRoot(ROOT)))
      yield* waitForState(runtime, (state) => state.refresh.active.has("refresh:navigation"))
      yield* runtime.selectRoot(CHILD, "newer-selection")
      yield* Deferred.succeed(release, undefined)
      const error = yield* Fiber.join(entering)
      expect(error).toBeInstanceOf(IntentRejectedError)
      const state = yield* runtime.getState
      expect(state.surface).toEqual({ _tag: "Roots", selectedSessionId: CHILD })
      expect(state.selectionId).toBe("newer-selection")
    })))
  })

  test("a failed startup root can be retried through Enter without global discovery", async () => {
    const fixture = makeFixture()
    const readable = fixture.snapshot
    fixture.snapshot = { ...readable, transcripts: new Map(readable.transcripts).set(ROOT, { _tag: "Unavailable", reason: "history reconstruction failed" }) }
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* waitForState(runtime, (state) => !state.refresh.initialPending)
      const view = yield* runtime.getViewModel
      if (view.surface._tag !== "Roots") throw new Error("Expected roots")
      expect(view.surface.roots.find((root) => root.sessionId === ROOT)?.history._tag).toBe("Unavailable")
      yield* runtime.selectRoot(ROOT)
      const failed = yield* Effect.flip(runtime.enterRoot(ROOT))
      expect(failed.message).toContain("history reconstruction failed")
      expect((yield* runtime.getState).surface).toEqual({ _tag: "Roots", selectedSessionId: ROOT })
      fixture.snapshot = readable
      yield* runtime.closeModal
      yield* runtime.enterRoot(ROOT)
      expect((yield* runtime.getState).surface._tag).toBe("Graph")
      expect((yield* runtime.getState).historyStatus.get(ROOT)?._tag).toBe("Ready")
      expect(fixture.incrementalReads).toEqual([[ROOT], [ROOT]])
      expect(fixture.fullLoads).toBe(1)
    })))
  })

  test("a provider-interrupted fork settles its caller and leaves later actor requests usable", async () => {
    const fixture = makeFixture()
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider: { ...fixture.options.provider, branchFrom: () => Effect.interrupt } })
      const fork = yield* Effect.exit(runtime.branchFrom({ sessionId: ROOT, messageId: "q" }))
      yield* runtime.openModal({ _tag: "About" })
      return { fork, state: yield* runtime.getState }
    })))
    expect(Exit.isFailure(result.fork)).toBeTrue()
    expect(result.state.modal).toEqual({ _tag: "About" })
  })

  test("returns a loading runtime and accepts input while initial discovery is deferred", async () => {
    const fixture = makeFixture()
    const discoveryStarted = Deferred.makeUnsafe<void>()
    const releaseDiscovery = Deferred.makeUnsafe<void>()
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      loadSessionSnapshot: Effect.gen(function*() {
        yield* Deferred.succeed(discoveryStarted, undefined)
        yield* Deferred.await(releaseDiscovery)
        return fixture.snapshot
      }),
    }

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider })
      yield* Deferred.await(discoveryStarted)
      const loading = yield* runtime.getViewModel
      yield* runtime.openModal({ _tag: "About" })
      const interactive = yield* runtime.getState
      yield* runtime.shutdown
      return { loading, interactive, stopped: yield* runtime.getState }
    })))

    expect(result.loading.initialLoadPending).toBeTrue()
    expect(result.interactive.modal).toEqual({ _tag: "About" })
    expect(result.stopped.shutdown).toBe("stopped")
    expect(fixture.shutdowns).toBe(1)
  })

  test("publishes initial discovery failure without failing runtime construction", async () => {
    const fixture = makeFixture()
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      loadSessionSnapshot: Effect.fail(new ProviderError({
        providerId: "test",
        operation: "snapshot",
        message: "provider discovery unavailable",
      })),
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider })
      return yield* waitForState(runtime, (candidate) => !candidate.refresh.initialPending)
    })))

    expect(state.modal).toEqual({ _tag: "Error", message: "provider discovery unavailable" })
    expect(state.surface).toEqual({ _tag: "Roots", selectedSessionId: null })
  })

  test("returns typed rejections for invalid requests", async () => {
    const fixture = makeFixture()
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      return yield* Effect.exit(runtime.stopSession("missing"))
    })))
    expect(Exit.isFailure(exit)).toBeTrue()
    if (Exit.isFailure(exit)) expect(Exit.findErrorOption(exit).pipe(Option.getOrThrow)).toBeInstanceOf(IntentRejectedError)
  })

  test("preserves the provider receiver when preparing a resumed session", async () => {
    const fixture = makeFixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
    })))

    expect(fixture.prepareResumeReceiver).toBe(fixture.options.provider)
  })

  test("contains a synchronous terminal show defect and serves a later request", async () => {
    const fixture = makeFixture()
    const show = fixture.options.terminals.show
    let attempts = 0
    const terminals: TerminalSupervisorApi = {
      ...fixture.options.terminals,
      show: (terminal) => {
        attempts += 1
        if (attempts === 1) throw new Error("show constructor defect")
        return show(terminal)
      },
    }

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, terminals })
      const failed = yield* Effect.exit(runtime.resumeSession(ROOT))
      yield* runtime.closeModal
      yield* runtime.resumeSession(ROOT)
      return { failed, state: yield* runtime.getState }
    })))

    expect(Exit.isFailure(result.failed)).toBeTrue()
    if (Exit.isFailure(result.failed)) {
      expect(Exit.findErrorOption(result.failed).pipe(Option.getOrThrow)).toBeInstanceOf(ApplicationOperationError)
    }
    expect(attempts).toBe(2)
    expect(result.state.surface).toMatchObject({ _tag: "Terminal", sessionId: ROOT })
  })

  test("filters stale owner events and accepts current sequenced events", async () => {
    const fixture = makeFixture()
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
      const stale = yield* runtime.handleTerminalActivity(activity("stale-owner", 1, ROOT, "working"))
      const current = yield* runtime.handleTerminalActivity(activity("owner-1", 1, ROOT, "working"))
      const duplicate = yield* runtime.handleTerminalActivity(activity("owner-1", 1, ROOT, "blocked"))
      return { stale, current, duplicate, state: yield* runtime.getState }
    })))
    expect(result.stale).toBeFalse()
    expect(result.current).toBeTrue()
    expect(result.duplicate).toBeFalse()
    expect(result.state.terminals.get(ROOT)?.activity).toBe("working")
  })

  test("handles intentional stop and natural exit without crossing owners", async () => {
    const fixture = makeFixture()
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
      yield* runtime.returnFromTerminal
      yield* runtime.resumeSession(CHILD)
      yield* runtime.returnFromTerminal
      yield* runtime.stopSession(ROOT)
      const exited = yield* runtime.handleTerminalExit({
        ownerId: "owner-2",
        sequenceId: 1,
        sessionId: CHILD,
        exitCode: 0,
        wasActive: false,
      })
      yield* Effect.yieldNow
      return { exited, state: yield* runtime.getState }
    })))
    expect(result.exited).toBeTrue()
    expect(result.state.terminals.size).toBe(0)
    expect(fixture.calls).toContain("stop:root")
    expect(fixture.incrementalReads.some((ids) => ids.includes(ROOT))).toBeTrue()
    expect(fixture.incrementalReads.some((ids) => ids.includes(CHILD))).toBeTrue()
  })

  test("removes an undiscovered temporary session after a successful explicit stop", async () => {
    const fixture = makeFixture()
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.selectGraph(ROOT, {
        kind: "message",
        preferred: { sessionId: ROOT, messageId: "q" },
        aliases: [{ sessionId: ROOT, messageId: "q" }],
      })
      yield* runtime.newSession
      yield* runtime.stopSession("temporary")
      return yield* waitForState(runtime, (candidate) =>
        fixture.incrementalReads.some((ids) => ids.includes("temporary")) &&
        !candidate.local.sessions.has("temporary"))
    })))

    expect(state.local.temporarySessionIds.has("temporary")).toBeFalse()
    expect(state.surface._tag).toBe("Roots")
  })

  test("removes an undiscovered blank temporary session after natural exit", async () => {
    const fixture = makeFixture()
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.selectGraph(ROOT, {
        kind: "message",
        preferred: { sessionId: ROOT, messageId: "q" },
        aliases: [{ sessionId: ROOT, messageId: "q" }],
      })
      yield* runtime.newSession
      expect(yield* runtime.handleTerminalExit({
        ownerId: "owner-1",
        sequenceId: 1,
        sessionId: "temporary",
        exitCode: 0,
        wasActive: true,
      })).toBeTrue()
      return yield* waitForState(runtime, (candidate) =>
        fixture.incrementalReads.some((ids) => ids.includes("temporary")) &&
        !candidate.local.sessions.has("temporary"))
    })))

    expect(state.local.temporarySessionIds.has("temporary")).toBeFalse()
    expect(state.surface._tag).toBe("Roots")
  })

  test("natural active exit follows the exiting endpoint ancestor and persists it", async () => {
    const fixture = makeFixture()
    const childAgent = message("child-agent", "agent", "child answer", 1)
    const branch = {
      ...relation(CHILD, ROOT),
      sharedMessages: [{ parentMessageId: "q", childMessageId: "cq" }],
    }
    fixture.snapshot = snapshot(
      [session(ROOT, "Root"), session(CHILD, "Child")],
      new Map([
        [ROOT, [message("q", "user", "question", 0)]],
        [CHILD, [message("cq", "user", "question", 0), childAgent]],
      ]),
    )
    let metadataState: ProjectState = { relations: [branch], removals: [] }
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      loadMetadata: Effect.sync(() => metadataState),
      updateMetadata: (transform) => Effect.sync(() => {
        metadataState = transform(metadataState)
        return metadataState
      }),
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata })
      yield* waitForState(runtime, (candidate) => !candidate.refresh.initialPending)
      yield* runtime.selectGraph(ROOT, {
        kind: "message",
        preferred: { sessionId: ROOT, messageId: "q" },
        aliases: [{ sessionId: ROOT, messageId: "q" }],
      })
      yield* runtime.resumeSession(CHILD)
      expect(yield* runtime.handleTerminalExit({
        ownerId: "owner-1",
        sequenceId: 1,
        sessionId: CHILD,
        exitCode: 0,
        wasActive: true,
      })).toBeTrue()
      return yield* waitForState(runtime, (candidate) =>
        candidate.surface._tag === "Graph" && candidate.surface.target.kind === "message" &&
        candidate.surface.target.preferred.messageId === childAgent.id &&
        metadataState.navigation?.view === "graph" &&
        metadataState.navigation.target.kind === "message" &&
        metadataState.navigation.target.preferred.messageId === childAgent.id)
    })))

    expect(state.surface).toMatchObject({
      _tag: "Graph",
      target: { kind: "message", preferred: { sessionId: CHILD, messageId: childAgent.id } },
    })
  })

  test("natural hidden exit does not steal the current navigator selection", async () => {
    const fixture = makeFixture()
    const selected = { kind: "endpoint" as const, sessionId: CHILD }
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
      yield* runtime.returnFromTerminal
      yield* runtime.selectGraph(CHILD, selected)
      expect(yield* runtime.handleTerminalExit({
        ownerId: "owner-1",
        sequenceId: 1,
        sessionId: ROOT,
        exitCode: 0,
        wasActive: false,
      })).toBeTrue()
      return yield* runtime.getState
    })))

    expect(state.surface).toEqual({ _tag: "Graph", familySessionId: CHILD, target: selected })
  })

  test("delayed active exit does not overwrite newer navigator selection", async () => {
    const fixture = makeFixture()
    let metadataState: ProjectState = { relations: [], removals: [] }
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      loadMetadata: Effect.sync(() => metadataState),
      updateMetadata: (transform) => Effect.sync(() => {
        metadataState = transform(metadataState)
        return metadataState
      }),
    }
    const selected = { kind: "endpoint" as const, sessionId: CHILD }
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata })
      yield* runtime.resumeSession(ROOT)
      const delayedExit = {
        ownerId: "owner-1",
        sequenceId: 1,
        sessionId: ROOT,
        exitCode: 0,
        wasActive: true,
      } as const
      yield* runtime.returnFromTerminal
      yield* runtime.selectGraph(CHILD, selected)
      expect(yield* runtime.handleTerminalExit(delayedExit)).toBeTrue()
      return yield* runtime.getState
    })))

    expect(state.surface).toEqual({ _tag: "Graph", familySessionId: CHILD, target: selected })
    expect(metadataState.navigation).toEqual({
      view: "graph",
      familySessionId: CHILD,
      target: selected,
    })
  })

  test("buffers one owner transition while another owner continues", async () => {
    const fixture = makeFixture()
    const ackStarted = Deferred.makeUnsafe<void>()
    const ackRelease = Deferred.makeUnsafe<void>()
    let metadataUpdates = 0
    const metadata = {
      ...fixture.options.metadata,
      updateMetadata: (transform: (state: ProjectState) => ProjectState) => {
        metadataUpdates += 1
        return fixture.options.metadata.updateMetadata(transform)
      },
      ack: (token: string) => Effect.gen(function*() {
        fixture.acked.push(token)
        yield* Deferred.succeed(ackStarted, undefined)
        yield* Deferred.await(ackRelease)
      }),
    }
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata })
      yield* runtime.resumeSession(ROOT)
      yield* runtime.returnFromTerminal
      yield* runtime.resumeSession(CHILD)
      yield* runtime.returnFromTerminal
      const updatesBeforeTransition = metadataUpdates

      const acknowledgment = yield* Deferred.make<void, unknown>()
      const accepted = yield* runtime.handleTerminalSessionChanged({
        ownerId: "owner-1",
        sequenceId: 1,
        previousSessionId: ROOT,
        session: session("adopted", "Adopted"),
        kind: "native-fork",
        adoptionToken: "adoption",
        wasActive: false,
        acknowledgment,
        relation: relation("adopted", ROOT),
      })
      expect(accepted).toBeTrue()
      yield* Deferred.await(ackStarted)
      const buffered = yield* Effect.forkScoped(
        runtime.handleTerminalActivity(activity("owner-1", 2, "adopted", "working")),
      )
      expect(yield* runtime.handleTerminalActivity(activity("owner-2", 1, CHILD, "blocked"))).toBeTrue()
      expect((yield* runtime.getState).terminals.get(CHILD)?.activity).toBe("blocked")
      expect((yield* runtime.getState).terminals.has("adopted")).toBeTrue()
      expect(Option.isNone(yield* Deferred.poll(acknowledgment))).toBeTrue()
      expect(metadataUpdates).toBe(updatesBeforeTransition)

      yield* Deferred.succeed(ackRelease, undefined)
      yield* Deferred.await(acknowledgment)
      expect(yield* Fiber.join(buffered)).toBeTrue()
      return yield* runtime.getState
    })))
    expect(state.terminals.get("adopted")?.activity).toBe("working")
    expect(state.terminals.get(CHILD)?.activity).toBe("blocked")
    expect(state.provider.sessions.has(ROOT)).toBeTrue()
    expect(state.local.sessions.has("adopted")).toBeTrue()
    expect(state.relations).toContainEqual(relation("adopted", ROOT))
    expect(fixture.acked).toContain("adoption")
  })

  test("uses the terminal transition kind instead of inferring it from local temporary IDs", async () => {
    const fixture = makeFixture()
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.newSession
      fixture.adoptOwner("temporary", "native-child")
      const acknowledgment = yield* Deferred.make<void, unknown>()
      expect(yield* runtime.handleTerminalSessionChanged({
        ownerId: "owner-1",
        sequenceId: 1,
        previousSessionId: "temporary",
        session: session("native-child", "Native child"),
        kind: "native-fork",
        adoptionToken: "native-from-temporary",
        wasActive: true,
        acknowledgment,
      })).toBeTrue()
      yield* Deferred.await(acknowledgment)
      const stopped = yield* Effect.exit(runtime.stopSession("temporary"))
      return { stopped, state: yield* runtime.getState }
    })))

    expect(Exit.isFailure(result.stopped)).toBeTrue()
    expect(result.state.local.sessions.has("temporary")).toBeTrue()
    expect(result.state.local.temporarySessionIds.has("temporary")).toBeTrue()
    expect(result.state.local.sessions.has("native-child")).toBeTrue()
    expect(result.state.terminals.has("native-child")).toBeTrue()
    expect(fixture.calls).not.toContain("stop:native-child")
    expect(fixture.calls).not.toContain("stop:temporary")
  })

  test("fresh source actions ignore an earlier native-fork transition", async () => {
    const fixture = makeFixture()
    const child = "native-child"
    const committed: Array<{ removal: ProjectState["removals"][number]; affected: readonly string[] }> = []
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      commitRemoval: (removal, affected) => Effect.sync(() => {
        committed.push({ removal, affected })
        return removal
      }),
    }
    const removal = {
      kind: "subtree" as const,
      target: { kind: "endpoint" as const, sessionId: ROOT, afterMessageId: null },
      createdAt: "2026-09-03T00:00:00.000Z",
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata })
      yield* runtime.resumeSession(ROOT)
      fixture.adoptOwner(ROOT, child)
      const acknowledgment = yield* Deferred.make<void, unknown>()
      expect(yield* runtime.handleTerminalSessionChanged({
        ownerId: "owner-1",
        sequenceId: 1,
        previousSessionId: ROOT,
        session: session(child, "Native child"),
        kind: "native-fork",
        adoptionToken: "source-to-child",
        wasActive: true,
        acknowledgment,
        relation: {
          ...relation(child, ROOT),
          sharedMessages: [{ parentMessageId: "q", childMessageId: "cq" }],
        },
      })).toBeTrue()
      yield* Deferred.await(acknowledgment)
      yield* runtime.returnFromTerminal
      yield* runtime.resumeSession(ROOT)
      yield* runtime.stopSession(ROOT)
      yield* runtime.remove(removal, [ROOT])
      return yield* runtime.getState
    })))

    expect(fixture.calls.filter((call) => call === `show:${ROOT}`)).toHaveLength(2)
    expect(fixture.calls).toContain(`stop:${ROOT}`)
    expect(fixture.calls).not.toContain(`stop:${child}`)
    expect(committed).toEqual([{ removal, affected: [ROOT] }])
    expect(state.terminals.has(ROOT)).toBeFalse()
    expect(state.terminals.has(child)).toBeTrue()
  })

  test("removal admitted before a native fork follows the transitioned owner", async () => {
    const fixture = makeFixture()
    const child = "native-child"
    const staleStopStarted = Deferred.makeUnsafe<void>()
    const releaseStaleStop = Deferred.makeUnsafe<void>()
    let committedRemoval: ProjectState["removals"][number] | undefined
    const terminals: TerminalSupervisorApi = {
      ...fixture.options.terminals,
      stopSession: (sessionId) => {
        fixture.calls.push(`stop:${sessionId}`)
        if (sessionId === ROOT) {
          return Effect.gen(function*() {
            yield* Deferred.succeed(staleStopStarted, undefined)
            yield* Deferred.await(releaseStaleStop)
            return false
          })
        }
        return Effect.succeed(sessionId === child)
      },
    }
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      commitRemoval: (removal, affected) => Effect.sync(() => {
        expect(affected).toEqual([child])
        committedRemoval = removal
        return removal
      }),
    }
    const removal = {
      kind: "subtree" as const,
      target: { kind: "endpoint" as const, sessionId: ROOT, afterMessageId: null },
      createdAt: "2026-09-03T00:00:00.000Z",
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata, terminals })
      yield* runtime.resumeSession(ROOT)
      const removing = yield* Effect.forkScoped(runtime.remove(removal, [ROOT]))
      yield* Deferred.await(staleStopStarted)
      fixture.adoptOwner(ROOT, child)
      const acknowledgment = yield* Deferred.make<void, unknown>()
      expect(yield* runtime.handleTerminalSessionChanged({
        ownerId: "owner-1",
        sequenceId: 1,
        previousSessionId: ROOT,
        session: session(child, "Native child"),
        kind: "native-fork",
        adoptionToken: "fork-during-remove",
        wasActive: true,
        acknowledgment,
        relation: {
          ...relation(child, ROOT),
          sharedMessages: [{ parentMessageId: "q", childMessageId: "cq" }],
        },
      })).toBeTrue()
      yield* Deferred.await(acknowledgment)
      yield* Deferred.succeed(releaseStaleStop, undefined)
      yield* Fiber.join(removing)
      return yield* runtime.getState
    })))

    expect(fixture.calls).toEqual(expect.arrayContaining([`stop:${ROOT}`, `stop:${child}`]))
    expect(committedRemoval).toEqual({
      ...removal,
      target: { ...removal.target, sessionId: child },
    })
    expect(state.removals).toContainEqual(committedRemoval!)
    expect(state.terminals.has(child)).toBeFalse()
  })

  for (const mode of ["explicit stop", "natural exit"] as const) {
    test(`prunes an undiscovered adopted temporary session after ${mode}`, async () => {
      const fixture = makeFixture()
      const persisted = "persisted"
      const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const runtime = yield* makeAppRuntime(fixture.options)
        yield* runtime.newSession
        const acknowledgment = yield* Deferred.make<void, unknown>()
        expect(yield* runtime.handleTerminalSessionChanged({
          ownerId: "owner-1",
          sequenceId: 1,
          previousSessionId: "temporary",
          session: session(persisted, "Persisted"),
          kind: "temporary-adoption",
          adoptionToken: `temporary-${mode}`,
          wasActive: true,
          acknowledgment,
        })).toBeTrue()
        yield* Deferred.await(acknowledgment)
        expect((yield* runtime.getState).local.temporarySessionIds.has(persisted)).toBeTrue()
        if (mode === "explicit stop") yield* runtime.stopSession(persisted)
        else {
          expect(yield* runtime.handleTerminalExit({
            ownerId: "owner-1",
            sequenceId: 2,
            sessionId: persisted,
            exitCode: 0,
            wasActive: true,
          })).toBeTrue()
        }
        return yield* waitForState(runtime, (candidate) =>
          fixture.incrementalReads.some((ids) => ids.includes(persisted)) &&
          !candidate.local.sessions.has(persisted))
      })))

      expect(state.local.temporarySessionIds.has(persisted)).toBeFalse()
      if (mode === "explicit stop") expect(fixture.calls).toContain(`stop:${persisted}`)
    })
  }

  test("fails the terminal barrier when adoption acknowledgment fails", async () => {
    const fixture = makeFixture()
    const failure = persistenceFailure("ack failed")
    const metadata = { ...fixture.options.metadata, ack: () => Effect.fail(failure) }
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata })
      yield* runtime.resumeSession(ROOT)
      const acknowledgment = yield* Deferred.make<void, unknown>()
      const accepted = yield* runtime.handleTerminalSessionChanged({
        ownerId: "owner-1",
        sequenceId: 1,
        previousSessionId: ROOT,
        session: session("adopted", "Adopted"),
        kind: "native-fork",
        adoptionToken: "adoption",
        wasActive: true,
        acknowledgment,
      })
      const barrier = yield* Effect.exit(Deferred.await(acknowledgment))
      return { accepted, barrier, state: yield* runtime.getState }
    })))
    expect(result.accepted).toBeTrue()
    expect(Exit.isFailure(result.barrier)).toBeTrue()
    expect(result.state.terminals.has("adopted")).toBeTrue()
    expect(result.state.modal).toEqual({
      _tag: "Error",
      message: "Acknowledge session identity: ack failed",
    })
  })

  test("contains a synchronous adoption acknowledgment defect and drains the owner", async () => {
    const fixture = makeFixture()
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      ack: () => {
        throw new Error("ack constructor defect")
      },
    }
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata })
      yield* runtime.resumeSession(ROOT)
      const acknowledgment = yield* Deferred.make<void, unknown>()
      const accepted = yield* runtime.handleTerminalSessionChanged({
        ownerId: "owner-1",
        sequenceId: 1,
        previousSessionId: ROOT,
        session: session("adopted", "Adopted"),
        kind: "native-fork",
        adoptionToken: "defective-ack",
        wasActive: true,
        acknowledgment,
      })
      const barrier = yield* Effect.exit(Deferred.await(acknowledgment))
      const later = yield* runtime.handleTerminalActivity(activity("owner-1", 2, "adopted", "working"))
      return { accepted, barrier, later, state: yield* runtime.getState }
    })))

    expect(result.accepted).toBeTrue()
    expect(Exit.isFailure(result.barrier)).toBeTrue()
    expect(result.later).toBeTrue()
    expect(result.state.terminals.get("adopted")?.activity).toBe("working")
    expect(result.state.modal?._tag === "Error" ? result.state.modal.message : "").toContain("ack constructor defect")
  })

  test("fails a defective transition projection without terminating the actor", async () => {
    const fixture = makeFixture()
    const defectiveSession = session("adopted", "Adopted")
    Object.defineProperty(defectiveSession, "title", {
      get: () => {
        throw new Error("transition projection defect")
      },
    })
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
      const acknowledgment = yield* Deferred.make<void, unknown>()
      const accepted = yield* runtime.handleTerminalSessionChanged({
        ownerId: "owner-1",
        sequenceId: 1,
        previousSessionId: ROOT,
        session: defectiveSession,
        kind: "native-fork",
        adoptionToken: "defective-projection",
        wasActive: true,
        acknowledgment,
      })
      const barrier = yield* Effect.exit(Deferred.await(acknowledgment))
      const later = yield* runtime.handleTerminalActivity(activity("owner-1", 2, ROOT, "blocked"))
      return { accepted, barrier, later, state: yield* runtime.getState }
    })))

    expect(result.accepted).toBeFalse()
    expect(Exit.isFailure(result.barrier)).toBeTrue()
    expect(result.later).toBeTrue()
    expect(result.state.terminals.get(ROOT)?.activity).toBe("blocked")
    expect(result.state.terminals.has("adopted")).toBeFalse()
    expect(result.state.modal?._tag === "Error" ? result.state.modal.message : "").toContain("transition projection defect")
  })

  test("fails stale transition barriers and settles direct replies", async () => {
    const fixture = makeFixture()
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
      const acknowledgment = yield* Deferred.make<void, unknown>()
      const accepted = yield* runtime.handleTerminalSessionChanged({
        ownerId: "stale-owner",
        sequenceId: 1,
        previousSessionId: ROOT,
        session: session("adopted", "Adopted"),
        kind: "native-fork",
        adoptionToken: "stale-adoption",
        wasActive: false,
        acknowledgment,
      })
      return { accepted, barrier: yield* Effect.exit(Deferred.await(acknowledgment)) }
    })))
    expect(result.accepted).toBeFalse()
    expect(Exit.isFailure(result.barrier)).toBeTrue()
  })

  test("settles transition barriers submitted after shutdown", async () => {
    const fixture = makeFixture()
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.shutdown
      const acknowledgment = yield* Deferred.make<void, unknown>()
      const accepted = yield* runtime.handleTerminalSessionChanged({
        ownerId: "owner-after-shutdown",
        sequenceId: 1,
        previousSessionId: ROOT,
        session: session("adopted", "Adopted"),
        kind: "native-fork",
        adoptionToken: "after-shutdown",
        wasActive: false,
        acknowledgment,
      })
      return { accepted, barrier: yield* Effect.exit(Deferred.await(acknowledgment)) }
    })))
    expect(result.accepted).toBeFalse()
    expect(Exit.isFailure(result.barrier)).toBeTrue()
  })

  test("applies a queued identity acknowledgment completion before shutdown", async () => {
    const fixture = makeFixture()
    const acknowledgment = Deferred.makeUnsafe<void, unknown>()
    const metadataAcknowledged = Deferred.makeUnsafe<void>()
    let journalPresent = true
    let terminalReleased = false
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      ack: () => Effect.gen(function*() {
        journalPresent = false
        yield* Deferred.succeed(metadataAcknowledged, undefined)
      }),
    }
    const terminals: TerminalSupervisorApi = {
      ...fixture.options.terminals,
      shutdown: () => Effect.gen(function*() {
        fixture.shutdowns += 1
        yield* Deferred.await(acknowledgment).pipe(Effect.orDie)
        if (journalPresent) return yield* Effect.die("identity journal was not removed")
        terminalReleased = true
      }),
    }

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata, terminals })
      yield* runtime.resumeSession(ROOT)
      const accepted = yield* runtime.handleTerminalSessionChanged({
        ownerId: "owner-1",
        sequenceId: 1,
        previousSessionId: ROOT,
        session: session("adopted", "Adopted"),
        kind: "native-fork",
        adoptionToken: "adoption",
        wasActive: true,
        acknowledgment,
      })
      yield* Deferred.await(metadataAcknowledged)
      expect(journalPresent).toBeFalse()
      expect(Option.isNone(yield* Deferred.poll(acknowledgment))).toBeTrue()

      const shutdown = yield* Effect.exit(runtime.shutdown)
      return {
        accepted,
        shutdown,
        barrier: yield* Effect.exit(Deferred.await(acknowledgment)),
        state: yield* runtime.getState,
      }
    })))

    expect(result.accepted).toBeTrue()
    expect(Exit.isSuccess(result.shutdown)).toBeTrue()
    expect(Exit.isSuccess(result.barrier)).toBeTrue()
    expect(terminalReleased).toBeTrue()
    expect(result.state.shutdown).toBe("stopped")
    expect(fixture.shutdowns).toBe(1)
  })

  test("waits for a blocked identity acknowledgment before terminal shutdown", async () => {
    const fixture = makeFixture()
    const acknowledgment = Deferred.makeUnsafe<void, unknown>()
    const acknowledgmentStarted = Deferred.makeUnsafe<void>()
    const releaseAcknowledgment = Deferred.makeUnsafe<void>()
    const terminalShutdownStarted = Deferred.makeUnsafe<void>()
    const order: string[] = []
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      ack: () => Effect.gen(function*() {
        yield* Deferred.succeed(acknowledgmentStarted, undefined)
        yield* Deferred.await(releaseAcknowledgment)
        order.push("acknowledged")
      }),
    }
    const terminals: TerminalSupervisorApi = {
      ...fixture.options.terminals,
      shutdown: () => Effect.gen(function*() {
        fixture.shutdowns += 1
        yield* Deferred.succeed(terminalShutdownStarted, undefined)
        yield* Deferred.await(acknowledgment).pipe(Effect.orDie)
        order.push("terminals-shut-down")
      }),
    }

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata, terminals })
      yield* runtime.resumeSession(ROOT)
      fixture.adoptOwner(ROOT, "adopted")
      expect(yield* runtime.handleTerminalSessionChanged({
        ownerId: "owner-1",
        sequenceId: 1,
        previousSessionId: ROOT,
        session: session("adopted", "Adopted"),
        kind: "native-fork",
        adoptionToken: "blocked-during-shutdown",
        wasActive: true,
        acknowledgment,
        relation: {
          ...relation("adopted", ROOT),
          sharedMessages: [{ parentMessageId: "q", childMessageId: "cq" }],
        },
      })).toBeTrue()
      yield* Deferred.await(acknowledgmentStarted)

      const shuttingDown = yield* Effect.forkScoped(Effect.exit(runtime.shutdown))
      for (let index = 0; index < 4; index += 1) yield* Effect.yieldNow
      expect(Option.isNone(yield* Deferred.poll(terminalShutdownStarted))).toBeTrue()
      expect(Option.isNone(yield* Deferred.poll(acknowledgment))).toBeTrue()
      expect(shuttingDown.pollUnsafe()).toBeUndefined()

      yield* Deferred.succeed(releaseAcknowledgment, undefined)
      return {
        shutdown: yield* Fiber.join(shuttingDown),
        barrier: yield* Effect.exit(Deferred.await(acknowledgment)),
        state: yield* runtime.getState,
      }
    })))

    expect(Exit.isSuccess(result.shutdown)).toBeTrue()
    expect(Exit.isSuccess(result.barrier)).toBeTrue()
    expect(order).toEqual(["acknowledged", "terminals-shut-down"])
    expect(result.state.shutdown).toBe("stopped")
    expect(fixture.shutdowns).toBe(1)
  })

  test("drains a transition callback admitted immediately before shutdown", async () => {
    const fixture = makeFixture()
    const acknowledgment = Deferred.makeUnsafe<void, unknown>()
    const acknowledgmentStarted = Deferred.makeUnsafe<void>()
    const releaseAcknowledgment = Deferred.makeUnsafe<void>()
    const terminalShutdownStarted = Deferred.makeUnsafe<void>()
    const order: string[] = []
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      ack: () => Effect.gen(function*() {
        order.push("ack-started")
        yield* Deferred.succeed(acknowledgmentStarted, undefined)
        yield* Deferred.await(releaseAcknowledgment)
        order.push("acknowledged")
      }),
    }
    const terminals: TerminalSupervisorApi = {
      ...fixture.options.terminals,
      shutdown: () => Effect.gen(function*() {
        fixture.shutdowns += 1
        order.push("terminals-shut-down")
        yield* Deferred.succeed(terminalShutdownStarted, undefined)
      }),
    }

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata, terminals })
      yield* runtime.resumeSession(ROOT)
      fixture.adoptOwner(ROOT, "adopted")
      const activityObserved = yield* Effect.forkScoped(
        runtime.handleTerminalActivity(activity("owner-1", 1, ROOT, "working", true)),
        { startImmediately: true },
      )
      const changing = yield* Effect.forkScoped(runtime.handleTerminalSessionChanged({
        ownerId: "owner-1",
        sequenceId: 2,
        previousSessionId: ROOT,
        session: session("adopted", "Adopted"),
        kind: "native-fork",
        adoptionToken: "queued-before-shutdown",
        wasActive: true,
        acknowledgment,
        relation: {
          ...relation("adopted", ROOT),
          sharedMessages: [{ parentMessageId: "q", childMessageId: "cq" }],
        },
      }), { startImmediately: true })
      const shuttingDown = yield* Effect.forkScoped(Effect.exit(runtime.shutdown), {
        startImmediately: true,
      })

      yield* Deferred.await(acknowledgmentStarted)
      expect(Option.isNone(yield* Deferred.poll(terminalShutdownStarted))).toBeTrue()
      yield* Deferred.succeed(releaseAcknowledgment, undefined)
      return {
        activityAccepted: yield* Fiber.join(activityObserved),
        accepted: yield* Fiber.join(changing),
        shutdown: yield* Fiber.join(shuttingDown),
        barrier: yield* Effect.exit(Deferred.await(acknowledgment)),
        state: yield* runtime.getState,
      }
    })))

    expect(result.activityAccepted).toBeTrue()
    expect(result.accepted).toBeTrue()
    expect(Exit.isSuccess(result.shutdown)).toBeTrue()
    expect(Exit.isSuccess(result.barrier)).toBeTrue()
    expect(order).toEqual(["ack-started", "acknowledged", "terminals-shut-down"])
    expect(result.state.local.sessions.has("adopted")).toBeTrue()
    expect(result.state.shutdown).toBe("stopped")
    expect(fixture.shutdowns).toBe(1)
  })

  test("bounds a stuck identity acknowledgment and fails shutdown closed", async () => {
    const fixture = makeFixture()
    const acknowledgment = Deferred.makeUnsafe<void, unknown>()
    const acknowledgmentStarted = Deferred.makeUnsafe<void>()
    const terminalShutdownStarted = Deferred.makeUnsafe<void>()
    let terminalObservedFailedBarrier = false
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      ack: () => Effect.gen(function*() {
        yield* Deferred.succeed(acknowledgmentStarted, undefined)
        yield* Effect.never
      }),
    }
    const terminals: TerminalSupervisorApi = {
      ...fixture.options.terminals,
      shutdown: () => Effect.gen(function*() {
        fixture.shutdowns += 1
        yield* Deferred.succeed(terminalShutdownStarted, undefined)
        terminalObservedFailedBarrier = Exit.isFailure(yield* Effect.exit(Deferred.await(acknowledgment)))
      }),
    }
    let shutdownExit: Exit.Exit<void, ApplicationShutdownError> | undefined
    let shutdownState: ApplicationState | undefined
    let barrierExit: Exit.Exit<void, unknown> | undefined

    const scopedExit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({
        ...fixture.options,
        metadata,
        terminals,
        shutdownTransitionTimeoutMs: 100,
      })
      yield* runtime.resumeSession(ROOT)
      fixture.adoptOwner(ROOT, "adopted")
      const changing = yield* Effect.forkScoped(runtime.handleTerminalSessionChanged({
        ownerId: "owner-1",
        sequenceId: 1,
        previousSessionId: ROOT,
        session: session("adopted", "Adopted"),
        kind: "native-fork",
        adoptionToken: "stuck-during-shutdown",
        wasActive: true,
        acknowledgment,
        relation: {
          ...relation("adopted", ROOT),
          sharedMessages: [{ parentMessageId: "q", childMessageId: "cq" }],
        },
      }), { startImmediately: true })
      const shuttingDown = yield* Effect.forkScoped(runtime.shutdown, { startImmediately: true })
      expect(yield* Fiber.join(changing)).toBeTrue()
      yield* Deferred.await(acknowledgmentStarted)
      yield* waitForState(runtime, (state) => state.shutdown === "shutting-down")
      expect(Option.isNone(yield* Deferred.poll(terminalShutdownStarted))).toBeTrue()
      yield* TestClock.adjust(100)
      shutdownExit = yield* Fiber.await(shuttingDown)
      barrierExit = yield* Effect.exit(Deferred.await(acknowledgment))
      shutdownState = yield* runtime.getState
    }).pipe(Effect.provide(TestClock.layer()))))

    expect(Exit.isFailure(scopedExit)).toBeTrue()
    expect(shutdownExit && Exit.isFailure(shutdownExit)).toBeTrue()
    expect(barrierExit && Exit.isFailure(barrierExit)).toBeTrue()
    expect(terminalObservedFailedBarrier).toBeTrue()
    expect(shutdownState?.shutdown).toBe("cleanup-incomplete")
    expect(fixture.shutdowns).toBe(1)
  })

  test("supersedes an in-flight manual refresh and resolves both replies", async () => {
    const fixture = makeFixture()
    const first = Deferred.makeUnsafe<AgentSessionSnapshot>()

    const results = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      let manualCalls = 0
      fixture.fullSnapshot = () => {
        manualCalls += 1
        return manualCalls === 1 ? Deferred.await(first) : Effect.succeed(fixture.snapshot)
      }
      const old = yield* Effect.forkScoped(Effect.exit(runtime.refresh()))
      yield* Effect.yieldNow
      const latest = yield* Effect.exit(runtime.refresh())
      const superseded = yield* Fiber.join(old)
      return { superseded, latest }
    })))
    expect(Exit.isFailure(results.superseded)).toBeTrue()
    if (Exit.isFailure(results.superseded)) {
      const error = Exit.findErrorOption(results.superseded).pipe(Option.getOrThrow)
      expect(error).toBeInstanceOf(IntentRejectedError)
      expect((error as IntentRejectedError).reason).toBe("superseded")
    }
    expect(Exit.isSuccess(results.latest)).toBeTrue()
  })

  test("uses keyed completion timers and required incremental snapshots", async () => {
    const fixture = makeFixture()
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, completionDelaysMs: [100] })
      yield* runtime.resumeSession(ROOT)
      fixture.snapshot = snapshot([
        session(ROOT, "Updated"),
        session(CHILD, "Child"),
      ], new Map([
        [ROOT, [message("q", "user", "question", 0), { ...message("a", "agent", "answer", 1), turnComplete: true }]],
        [CHILD, [message("cq", "user", "child", 0)]],
      ]))
      yield* runtime.handleTerminalActivity(activity("owner-1", 1, ROOT, "working", false))
      yield* runtime.handleTerminalActivity(activity("owner-1", 2, ROOT, "idle", false))
      yield* TestClock.adjust(100)
      for (let index = 0; index < 8; index += 1) yield* Effect.yieldNow
      return yield* runtime.getState
    }).pipe(Effect.provide(TestClock.layer()))))
    expect(state.pendingCompletions.has(ROOT)).toBeFalse()
    expect(state.unviewedSessionIds.has(ROOT)).toBeTrue()
    expect(fixture.incrementalReads).toContainEqual([ROOT])
    expect(fixture.incrementalReads.some((ids) => ids.includes(CHILD))).toBeFalse()
  })

  test("automatically confirms a shortened transcript after one manual refresh", async () => {
    const fixture = makeFixture()
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.refresh()
      fixture.snapshot = snapshot([session(ROOT, "Root"), session(CHILD, "Child")], new Map([
        [ROOT, []], [CHILD, [message("cq", "user", "child question", 0)]],
      ]))
      yield* runtime.refresh()
      expect((yield* runtime.getState).replacementCandidates.has(ROOT)).toBeTrue()
      yield* TestClock.adjust(100)
      for (let index = 0; index < 12; index += 1) yield* Effect.yieldNow
      return yield* runtime.getState
    }).pipe(Effect.provide(TestClock.layer()))))
    expect(state.provider.transcripts.get(ROOT)).toEqual({ _tag: "Available", messages: [] })
    expect(state.replacementCandidates.size).toBe(0)
    expect(fixture.incrementalReads).toContainEqual([ROOT])
  })

  test("manual refresh coherently supersedes an in-flight completion refresh", async () => {
    const fixture = makeFixture()
    const incrementalStarted = Deferred.makeUnsafe<void>()
    const incrementalRelease = Deferred.makeUnsafe<void>()
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      loadSessionSnapshotFor: (sessionIds) => Effect.gen(function*() {
        fixture.incrementalReads.push([...sessionIds])
        yield* Deferred.succeed(incrementalStarted, undefined)
        yield* Deferred.await(incrementalRelease)
        return fixture.snapshot
      }),
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({
        ...fixture.options,
        provider,
        completionDelaysMs: [0],
      })
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalActivity(activity("owner-1", 1, ROOT, "working", false))
      yield* runtime.handleTerminalActivity(activity("owner-1", 2, ROOT, "idle", false))
      yield* Deferred.await(incrementalStarted)
      fixture.snapshot = snapshot(
        [session(ROOT, "Updated"), session(CHILD, "Child")],
        new Map([
          [ROOT, [
            message("q", "user", "question", 0),
            { ...message("a", "agent", "answer", 1), turnComplete: true },
          ]],
          [CHILD, [message("cq", "user", "child", 0)]],
        ]),
      )
      yield* runtime.refresh()
      return yield* runtime.getState
    })))

    expect(state.pendingCompletions.has(ROOT)).toBeFalse()
    expect(state.unviewedSessionIds.has(ROOT)).toBeTrue()
    expect(state.provider.transcripts.get(ROOT)).toMatchObject({
      _tag: "Available",
      messages: [{ id: "q" }, { id: "a" }],
    })
  })

  test("a full refresh superseding completion preserves the barrier and restarts its timer", async () => {
    const fixture = makeFixture()
    const firstIncrementalStarted = Deferred.makeUnsafe<void>()
    const retryIncrementalStarted = Deferred.makeUnsafe<void>()
    const retryIncrementalRelease = Deferred.makeUnsafe<void>()
    const initialSnapshot = fixture.snapshot
    const partialSnapshot = snapshot(
      [session(ROOT, "Partial"), session(CHILD, "Child")],
      new Map([
        [ROOT, [
          message("q", "user", "question", 0),
          { ...message("a-partial", "agent", "partial answer", 1), turnComplete: false },
        ]],
        [CHILD, [message("cq", "user", "child question", 0)]],
      ]),
    )
    const completedSnapshot = snapshot(
      [session(ROOT, "Completed"), session(CHILD, "Child")],
      new Map([
        [ROOT, [
          message("q", "user", "question", 0),
          { ...message("a", "agent", "answer", 1), turnComplete: true },
        ]],
        [CHILD, [message("cq", "user", "child question", 0)]],
      ]),
    )
    let fullLoads = 0
    let incrementalLoads = 0
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      loadSessionSnapshot: Effect.sync(() => {
        fullLoads += 1
        return fullLoads === 1 ? initialSnapshot : partialSnapshot
      }),
      loadSessionSnapshotFor: (sessionIds) => Effect.gen(function*() {
        fixture.incrementalReads.push([...sessionIds])
        incrementalLoads += 1
        if (incrementalLoads === 1) {
          yield* Deferred.succeed(firstIncrementalStarted, undefined)
          return yield* Effect.never
        }
        yield* Deferred.succeed(retryIncrementalStarted, undefined)
        yield* Deferred.await(retryIncrementalRelease)
        return completedSnapshot
      }),
    }

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({
        ...fixture.options,
        provider,
        completionDelaysMs: [0],
      })
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalActivity(activity("owner-1", 1, ROOT, "working", false))
      yield* runtime.handleTerminalActivity(activity("owner-1", 2, ROOT, "idle", false))
      yield* Deferred.await(firstIncrementalStarted)

      yield* runtime.refresh()
      yield* Deferred.await(retryIncrementalStarted)
      const barrier = yield* runtime.getState

      yield* Deferred.succeed(retryIncrementalRelease, undefined)
      for (let index = 0; index < 8; index += 1) yield* Effect.yieldNow
      return { barrier, completed: yield* runtime.getState }
    })))

    expect(result.barrier.pendingCompletions.has(ROOT)).toBeTrue()
    expect(selectSessionStatus(result.barrier, ROOT)).toBe("working")
    expect(selectProjectedTranscript(result.barrier, ROOT).map((item) => item.id)).toEqual(["q"])
    expect(result.completed.pendingCompletions.has(ROOT)).toBeFalse()
    expect(result.completed.unviewedSessionIds.has(ROOT)).toBeTrue()
    expect(selectProjectedTranscript(result.completed, ROOT).map((item) => item.id)).toEqual(["q", "a"])
    expect(fixture.incrementalReads).toEqual([[ROOT], [ROOT]])
  })

  test("returning after undoing a send cancels a scheduled completion without restoring the prompt", async () => {
    const fixture = makeFixture()
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({
        ...fixture.options,
        completionDelaysMs: [10_000],
      })
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalActivity(activity("owner-1", 1, ROOT, "working", false))
      yield* runtime.handleTerminalActivity(activity("owner-1", 2, ROOT, "idle", false))
      expect(yield* runtime.handleTerminalObservation(observation(3, {
        _tag: "Draft",
        draft: { text: "question", exact: false, rewind: true, rewindTarget: "question" },
      }))).toBeTrue()
      expect((yield* runtime.getState).pendingCompletions.size).toBe(0)
      yield* runtime.returnFromTerminal
      for (let index = 0; index < 8; index += 1) yield* Effect.yieldNow
      return yield* runtime.getState
    })))
    expect(state.pendingCompletions.size).toBe(0)
    expect(selectSessionStatus(state, ROOT)).toBe("live")
    expect(selectProjectedTranscript(state, ROOT)).toEqual([])
    expect(state.unviewedSessionIds.size).toBe(0)
    expect(state.modal).toBeNull()
  })

  test("orders semantic callbacks before terminal return without reading rewind semantics from the cache", async () => {
    const fixture = makeFixture()
    const draft = { text: "edited question", exact: false, rewind: true, rewindTarget: "question" }
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
      runtime.terminalEvents.onObservation!(observation(1, { _tag: "Draft", draft }))
      runtime.terminalEvents.onObservation!(observation(2, { _tag: "Submission", text: draft.text }))
      yield* runtime.returnFromTerminal
      return yield* runtime.getState
    })))
    expect(state.surface).toEqual({
      _tag: "Graph", familySessionId: ROOT, target: { kind: "endpoint", sessionId: ROOT },
    })
    expect(state.drafts.get(ROOT)).toEqual({ ...draft, submitted: true })
    expect(state.rewindAnchors.get(ROOT)).toMatchObject({
      targetMessageId: "q", submitted: true, submissionText: draft.text,
    })
    expect(selectProjectedTranscript(state, ROOT)).toEqual([])
    expect(state.modal).toBeNull()
  })

  test("rejects stale observation sequences and owners without changing the current draft", async () => {
    const fixture = makeFixture()
    const draft = { text: "question", exact: false, rewind: true }
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
      expect(yield* runtime.handleTerminalObservation(observation(2, { _tag: "Draft", draft }))).toBeTrue()
      expect(yield* runtime.handleTerminalObservation(observation(1, { _tag: "Draft", draft: null }))).toBeFalse()
      expect(yield* runtime.handleTerminalObservation(observation(2, { _tag: "Submission", text: "stale" }))).toBeFalse()
      expect(yield* runtime.handleTerminalObservation({
        ...observation(100, { _tag: "Draft", draft: null }), ownerId: "stale-owner",
      })).toBeFalse()
      expect((yield* runtime.getState).drafts.get(ROOT)).toEqual(draft)
      expect((yield* runtime.getState).rewindAnchors.get(ROOT)?.submitted).toBeFalse()
      expect(yield* runtime.handleTerminalObservation(observation(3, { _tag: "Submission", text: "current" }))).toBeTrue()
      expect(yield* runtime.handleTerminalActivity(activity("owner-1", 3, ROOT, "working", true))).toBeFalse()
      expect((yield* runtime.getState).rewindAnchors.get(ROOT)?.submissionText).toBe("current")
    })))
  })

  for (const rewind of [false, true]) test(`discovers a lagged ${rewind ? "replacement" : "ordinary"} user while working without idle`, async () => {
    const fixture = makeFixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
      if (rewind) {
        yield* runtime.handleTerminalObservation(observation(1, { _tag: "Draft", draft: {
          text: "replacement", exact: false, rewind: true, rewindTarget: "question",
        } }))
        yield* TestClock.adjust(100)
        yield* waitForState(runtime, (state) => state.refresh.active.size === 0)
      }
      yield* runtime.handleTerminalObservation(observation(2, { _tag: "Submission", text: "replacement" }))
      yield* runtime.handleTerminalActivity(activity("owner-1", 3, ROOT, "working", true))
      yield* TestClock.adjust(100)
      const lagged = yield* waitForState(runtime, (state) => state.refresh.active.size === 0)
      expect(lagged.terminals.get(ROOT)?.pendingSubmission?.attempt).toBe(1)
      expect(selectProjectedTranscript(lagged, ROOT).map((item) => item.id)).toEqual(rewind ? [] : ["q"])
      const prefix = rewind ? [] : [message("q", "user", "question", 0)]
      fixture.snapshot = snapshot([session(ROOT, "Root")], new Map([[ROOT, [
        ...prefix, message("new-user", "user", "provider-persisted prompt", prefix.length),
        message("streaming", "agent", "unfinished answer", prefix.length + 1),
      ]]]))
      yield* TestClock.adjust(250)
      const discovered = yield* waitForState(runtime, (state) => !state.terminals.get(ROOT)?.pendingSubmission)
      expect(selectProjectedTranscript(discovered, ROOT).map((item) => item.id)).toEqual([...prefix.map((item) => item.id), "new-user"])
      expect(selectSessionStatus(discovered, ROOT)).toBe("working")
      expect(discovered.pendingCompletions.size).toBe(0)
      expect(discovered.unviewedSessionIds.size).toBe(0)
      const reads = fixture.incrementalReads.length
      yield* TestClock.adjust(5_000)
      expect(fixture.incrementalReads).toHaveLength(reads)
      yield* runtime.returnFromTerminal
      const view = yield* runtime.getViewModel
      expect(view.surface._tag).toBe("Graph")
      if (view.surface._tag === "Graph") {
        const user = view.surface.nodes.find((node) => node._tag === "Message" && node.preview === "provider-persisted prompt")
        const endpoint = view.surface.nodes.find((node) => node._tag === "Endpoint" && node.session.id === ROOT)
        expect(user).toBeDefined()
        expect(endpoint?.parentIds).toEqual([user!.id])
        expect(endpoint?._tag === "Endpoint" && endpoint.status).toBe("working")
      }
    }).pipe(Effect.provide(TestClock.layer()))))
  })

  test("submission discovery exhausts four reads and return does not reset its budget", async () => {
    const fixture = makeFixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalObservation(observation(1, { _tag: "Submission" }))
      yield* runtime.handleTerminalActivity(activity("owner-1", 2, ROOT, "working"))
      for (const [index, delay] of [100, 250, 500, 1_000].entries()) {
        yield* TestClock.adjust(delay)
        yield* waitForState(runtime, (state) => state.refresh.active.size === 0)
        if (index === 0) {
          yield* runtime.returnFromTerminal
          const returned = yield* waitForState(runtime, (state) => state.refresh.active.size === 0)
          expect(returned.terminals.get(ROOT)?.pendingSubmission?.attempt).toBe(1)
        }
      }
      const exhausted = yield* runtime.getState
      expect(exhausted.terminals.get(ROOT)?.pendingSubmission).toBeUndefined()
      expect(exhausted.modal).toBeNull()
      expect(selectProjectedTranscript(exhausted, ROOT).map((item) => item.id)).toEqual(["q"])
      expect(fixture.incrementalReads).toHaveLength(5)
      yield* TestClock.adjust(10_000)
      expect(fixture.incrementalReads).toHaveLength(5)
    }).pipe(Effect.provide(TestClock.layer()))))
  })

  for (const read of ["manual", "return"] as const) test(`${read} reads satisfy submission discovery and cancel its timer`, async () => {
    const fixture = makeFixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalObservation(observation(1, { _tag: "Submission" }))
      yield* runtime.handleTerminalActivity(activity("owner-1", 2, ROOT, "working"))
      if (read === "manual") {
        yield* runtime.refresh()
        expect((yield* runtime.getState).terminals.get(ROOT)?.pendingSubmission?.attempt).toBe(0)
      }
      fixture.snapshot = snapshot([session(ROOT, "Root")], new Map([[ROOT, [
        message("q", "user", "question", 0), message("new-user", "user", "persisted", 1),
      ]]]))
      if (read === "manual") yield* runtime.refresh()
      else yield* runtime.returnFromTerminal
      yield* waitForState(runtime, (state) => !state.terminals.get(ROOT)?.pendingSubmission)
      const reads = fixture.incrementalReads.length
      yield* TestClock.adjust(5_000)
      expect(fixture.incrementalReads).toHaveLength(reads)
    }).pipe(Effect.provide(TestClock.layer()))))
  })

  for (const cancel of ["undo", "stop", "shutdown", "submission", "idle"] as const) test(`${cancel} cancels the old submission timer`, async () => {
    const fixture = makeFixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalObservation(observation(1, { _tag: "Submission" }))
      yield* runtime.handleTerminalActivity(activity("owner-1", 2, ROOT, "working"))
      yield* TestClock.adjust(50)
      if (cancel === "undo") yield* runtime.handleTerminalObservation(observation(3, { _tag: "Draft", draft: {
        text: "question", exact: false, rewind: true,
      } }))
      if (cancel === "stop") {
        yield* runtime.stopSession(ROOT)
        yield* runtime.resumeSession(ROOT)
        expect(yield* runtime.handleTerminalObservation(observation(3, { _tag: "Submission" }))).toBeFalse()
      }
      if (cancel === "shutdown") yield* runtime.shutdown
      if (cancel === "submission") yield* runtime.handleTerminalObservation(observation(3, { _tag: "Submission" }))
      if (cancel === "idle") yield* runtime.handleTerminalActivity(activity("owner-1", 3, ROOT, "idle"))
      const reads = fixture.incrementalReads.length
      yield* TestClock.adjust(50)
      expect(fixture.incrementalReads).toHaveLength(reads)
      const state = yield* runtime.getState
      if (cancel === "submission") {
        expect(state.terminals.get(ROOT)?.pendingSubmission?.attempt).toBe(0)
        yield* TestClock.adjust(50)
        yield* waitForState(runtime, (candidate) => candidate.refresh.active.size === 0)
        expect(fixture.incrementalReads).toHaveLength(reads + 1)
      } else expect(state.terminals.get(ROOT)?.pendingSubmission).toBeUndefined()
      if (cancel === "idle") expect(state.pendingCompletions.has(ROOT)).toBeTrue()
    }).pipe(Effect.provide(TestClock.layer()))))
  })

  test("idle hands user-prefix discovery to completion without exposing an unfinished answer", async () => {
    const fixture = makeFixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalObservation(observation(1, { _tag: "Submission" }))
      yield* runtime.handleTerminalActivity(activity("owner-1", 2, ROOT, "working"))
      yield* runtime.handleTerminalActivity(activity("owner-1", 3, ROOT, "idle"))
      const users = [message("q", "user", "question", 0), message("new-user", "user", "persisted", 1)]
      fixture.snapshot = snapshot([session(ROOT, "Root")], new Map([[ROOT, [
        ...users, { ...message("answer", "agent", "streaming", 2), turnComplete: false },
      ]]]))
      yield* TestClock.adjust(100)
      const pending = yield* waitForState(runtime, (state) => state.refresh.active.size === 0)
      expect(pending.terminals.get(ROOT)?.pendingSubmission).toBeUndefined()
      expect(pending.pendingCompletions.has(ROOT)).toBeTrue()
      expect(selectProjectedTranscript(pending, ROOT).map((item) => item.id)).toEqual(["q", "new-user"])
      fixture.snapshot = snapshot([session(ROOT, "Root")], new Map([[ROOT, [
        ...users, { ...message("answer", "agent", "finished", 2), turnComplete: true },
      ]]]))
      yield* TestClock.adjust(250)
      const completed = yield* waitForState(runtime, (state) => !state.pendingCompletions.has(ROOT))
      expect(selectProjectedTranscript(completed, ROOT).map((item) => item.id)).toEqual(["q", "new-user", "answer"])
      expect(fixture.incrementalReads).toHaveLength(2)
    }).pipe(Effect.provide(TestClock.layer()))))
  })

  test("a superseded in-flight submission read cannot satisfy a newer revision", async () => {
    const fixture = makeFixture()
    const started = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const old = snapshot([session(ROOT, "Root")], new Map([[ROOT, [
      message("q", "user", "question", 0), message("stale-user", "user", "stale submission", 1),
    ]]]))
    const load = fixture.options.provider.loadSessionSnapshotFor
    let reads = 0
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      loadSessionSnapshotFor: (ids) => ++reads === 1
        ? Effect.uninterruptible(Effect.gen(function*() {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return old
          }))
        : load(ids),
    }
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider })
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalObservation(observation(1, { _tag: "Submission" }))
      yield* runtime.handleTerminalActivity(activity("owner-1", 2, ROOT, "working"))
      yield* TestClock.adjust(100)
      yield* Deferred.await(started)
      yield* runtime.handleTerminalObservation(observation(3, { _tag: "Submission" }))
      yield* Deferred.succeed(release, undefined)
      yield* TestClock.adjust(0)
      const newer = yield* runtime.getState
      expect(newer.terminals.get(ROOT)?.pendingSubmission?.attempt).toBe(0)
      expect(selectProjectedTranscript(newer, ROOT).map((item) => item.id)).toEqual(["q"])
      yield* TestClock.adjust(100)
      yield* waitForState(runtime, (state) => state.refresh.active.size === 0)
      expect(reads).toBe(2)
      expect((yield* runtime.getState).terminals.get(ROOT)?.pendingSubmission?.attempt).toBe(1)
    }).pipe(Effect.provide(TestClock.layer()))))
  })

  test("manual refresh cancels and resumes a submission timer without resetting attempts", async () => {
    const fixture = makeFixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalObservation(observation(1, { _tag: "Submission" }))
      yield* runtime.handleTerminalActivity(activity("owner-1", 2, ROOT, "working"))
      yield* TestClock.adjust(100)
      yield* waitForState(runtime, (state) => state.refresh.active.size === 0)
      yield* TestClock.adjust(50)
      yield* runtime.refresh()
      expect((yield* runtime.getState).terminals.get(ROOT)?.pendingSubmission?.attempt).toBe(1)
      yield* TestClock.adjust(200)
      expect(fixture.incrementalReads).toHaveLength(1)
      yield* TestClock.adjust(50)
      yield* waitForState(runtime, (state) => state.refresh.active.size === 0)
      expect(fixture.incrementalReads).toHaveLength(2)
      expect((yield* runtime.getState).terminals.get(ROOT)?.pendingSubmission?.attempt).toBe(2)
    }).pipe(Effect.provide(TestClock.layer()))))
  })

  test("a completed replacement consumes its submitted draft even when the composer remains unknown on return", async () => {
    const fixture = makeFixture()
    const draft = { text: "replacement", exact: false, rewind: true, rewindTarget: "question" }
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({
        ...fixture.options,
        terminals: { ...fixture.options.terminals, draftPreviews: Effect.succeed(new Map([[ROOT, draft]])) },
        completionDelaysMs: [0],
      })
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalObservation(observation(1, { _tag: "Draft", draft }))
      yield* runtime.handleTerminalObservation(observation(2, { _tag: "Submission", text: draft.text }))
      yield* runtime.handleTerminalActivity(activity("owner-1", 3, ROOT, "working", true))
      fixture.snapshot = snapshot([session(ROOT, "Root"), session(CHILD, "Child")], new Map([
        [ROOT, [message("replacement-q", "user", draft.text, 0), {
          ...message("replacement-a", "agent", "replacement answer", 1), turnComplete: true,
        }]],
        [CHILD, [message("cq", "user", "child question", 0)]],
      ]))
      // An unknown composer emits no Draft observation, including no explicit null.
      yield* runtime.handleTerminalActivity(activity("owner-1", 4, ROOT, "idle", true))
      yield* TestClock.adjust(0)
      const completed = yield* waitForState(runtime, (candidate) => !candidate.pendingCompletions.has(ROOT))
      expect(selectProjectedTranscript(completed, ROOT).map((item) => item.id)).toEqual(["replacement-q", "replacement-a"])
      expect(completed.rewindAnchors.has(ROOT)).toBeFalse()
      expect(completed.drafts.has(ROOT)).toBeFalse()
      // Drain the initial rewind's invalidated read and its fresh reconciliation.
      yield* TestClock.adjust(100)
      yield* TestClock.adjust(100)
      yield* waitForState(runtime, (candidate) => candidate.refresh.active.size === 0)
      yield* runtime.returnFromTerminal
      return yield* waitForState(runtime, (candidate) => candidate.refresh.active.size === 0)
    }).pipe(Effect.provide(TestClock.layer()))))
    expect(state.surface._tag).toBe("Graph")
    expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["replacement-q", "replacement-a"])
    expect(state.drafts.has(ROOT)).toBeFalse()
    expect(state.rewindAnchors.has(ROOT)).toBeFalse()
    expect(state.unviewedSessionIds.has(ROOT)).toBeFalse()
    expect(state.modal).toBeNull()
  })

  test("reundoing an edited replacement retains its boundary while provider history is still cached", async () => {
    const fixture = makeFixture()
    const restored = { text: "question", exact: false, rewind: true, rewindTarget: "question" }
    const edited = { ...restored, text: "edited replacement" }
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, completionDelaysMs: [100] })
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalObservation(observation(1, { _tag: "Draft", draft: restored }))
      yield* runtime.handleTerminalObservation(observation(2, { _tag: "Draft", draft: edited }))
      yield* runtime.handleTerminalObservation(observation(3, { _tag: "Submission", text: edited.text }))
      yield* runtime.handleTerminalActivity(activity("owner-1", 4, ROOT, "working", true))
      yield* runtime.handleTerminalActivity(activity("owner-1", 5, ROOT, "idle", true))
      expect((yield* runtime.getState).pendingCompletions.has(ROOT)).toBeTrue()
      const reundo = { ...edited, rewindTarget: edited.text }
      yield* runtime.handleTerminalObservation(observation(6, { _tag: "Draft", draft: reundo }))
      const undone = yield* runtime.getState
      expect(undone.provider.transcripts.get(ROOT)).toEqual(fixture.snapshot.transcripts.get(ROOT))
      expect(undone.drafts.get(ROOT)).toEqual(reundo)
      expect(undone.rewindAnchors.get(ROOT)).toMatchObject({ targetMessageId: "q", submitted: false })
      expect(selectProjectedTranscript(undone, ROOT)).toEqual([])
      yield* TestClock.adjust(100)
      yield* waitForState(runtime, (candidate) => candidate.refresh.active.size === 0)
      expect(fixture.incrementalReads).toEqual([[ROOT]])
      yield* runtime.returnFromTerminal
      return yield* waitForState(runtime, (candidate) => candidate.refresh.active.size === 0)
    }).pipe(Effect.provide(TestClock.layer()))))
    expect(selectProjectedTranscript(state, ROOT)).toEqual([])
    expect(state.pendingCompletions.size).toBe(0)
    expect(selectSessionStatus(state, ROOT)).toBe("live")
    expect(state.modal).toBeNull()
  })

  test("a completion read started before reundo cannot restore the replacement and triggers fresh prefix reconciliation", async () => {
    const fixture = makeFixture()
    const prefix = [message("first-q", "user", "first question", 0), message("first-a", "agent", "first answer", 1)]
    const original = [...prefix, message("q", "user", "question", 2)]
    fixture.snapshot = snapshot([session(ROOT, "Root")], new Map([[ROOT, original]]))
    const draft = { text: "edited replacement", exact: false, rewind: true, rewindTarget: "question" }
    const reundo = { ...draft, rewindTarget: draft.text }
    const replacement = snapshot([session(ROOT, "Stale replacement")], new Map([[ROOT, [
      ...prefix, message("replacement-q", "user", draft.text, 2),
      { ...message("replacement-a", "agent", "replacement answer", 3), turnComplete: true },
    ]]]))
    const completionStarted = Deferred.makeUnsafe<void>()
    const releaseCompletion = Deferred.makeUnsafe<void>()
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      loadSessionSnapshotFor: (sessionIds) => Effect.gen(function*() {
        fixture.incrementalReads.push([...sessionIds])
        if (fixture.incrementalReads.length === 1) {
          yield* Deferred.succeed(completionStarted, undefined)
          yield* Deferred.await(releaseCompletion)
          return replacement
        }
        return fixture.snapshot
      }),
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider, completionDelaysMs: [0] })
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalObservation(observation(1, { _tag: "Draft", draft }))
      yield* runtime.handleTerminalObservation(observation(2, { _tag: "Submission", text: draft.text }))
      yield* runtime.handleTerminalActivity(activity("owner-1", 3, ROOT, "working", true))
      yield* runtime.handleTerminalActivity(activity("owner-1", 4, ROOT, "idle", true))
      yield* TestClock.adjust(0)
      yield* Deferred.await(completionStarted)
      expect((yield* runtime.getState).pendingCompletions.has(ROOT)).toBeTrue()

      yield* runtime.handleTerminalObservation(observation(5, { _tag: "Draft", draft: reundo }))
      expect(selectProjectedTranscript(yield* runtime.getState, ROOT)).toEqual(prefix)
      // Let rewind reconciliation finish first, while provider persistence still lags.
      yield* TestClock.adjust(100)
      yield* waitForState(runtime, (candidate) => !candidate.refresh.active.has("refresh:reconciliation"))
      expect(fixture.incrementalReads).toEqual([[ROOT], [ROOT]])
      expect((yield* runtime.getState).provider.transcripts.get(ROOT)).toEqual({ _tag: "Available", messages: original })

      fixture.snapshot = snapshot([session(ROOT, "Confirmed prefix")], new Map([[ROOT, prefix]]))
      yield* Deferred.succeed(releaseCompletion, undefined)
      const rejected = yield* waitForState(runtime, (candidate) =>
        !candidate.refresh.active.has("refresh:owner:owner-1") && candidate.refresh.active.has("refresh:reconciliation"))
      expect(rejected.provider.transcripts.get(ROOT)).toEqual({ _tag: "Available", messages: original })
      expect(rejected.provider.sessions.get(ROOT)?.title).toBe("Root")
      expect(selectProjectedTranscript(rejected, ROOT)).toEqual(prefix)
      expect(rejected.rewindAnchors.get(ROOT)).toMatchObject({ targetMessageId: "q", submitted: false })
      expect(rejected.drafts.get(ROOT)).toEqual(reundo)
      expect(rejected.pendingCompletions.has(ROOT)).toBeFalse()
      expect(rejected.unviewedSessionIds.has(ROOT)).toBeFalse()

      yield* TestClock.adjust(100)
      return yield* waitForState(runtime, (candidate) => candidate.refresh.active.size === 0)
    }).pipe(Effect.provide(TestClock.layer()))))
    expect(fixture.incrementalReads).toEqual([[ROOT], [ROOT], [ROOT]])
    expect(state.provider.transcripts.get(ROOT)).toEqual({ _tag: "Available", messages: prefix })
    expect(selectProjectedTranscript(state, ROOT)).toEqual(prefix)
    expect(state.rewindAnchors.has(ROOT)).toBeFalse()
    expect(state.drafts.get(ROOT)).toEqual({ text: draft.text, exact: false })
    expect(state.pendingCompletions.has(ROOT)).toBeFalse()
    expect(state.unviewedSessionIds.has(ROOT)).toBeFalse()
    expect(state.modal).toBeNull()
  })

  test("a failed rewind read invalidated by a same-target edit preserves state and schedules fresh reconciliation", async () => {
    const fixture = makeFixture()
    const prefix = [message("first-q", "user", "first question", 0), message("first-a", "agent", "first answer", 1)]
    const original = [...prefix, message("q", "user", "question", 2)]
    fixture.snapshot = snapshot([session(ROOT, "Root")], new Map([[ROOT, original]]))
    const draft = { text: "question", exact: false, rewind: true, rewindTarget: "question" }
    const edited = { ...draft, text: "edited question" }
    const readStarted = Deferred.makeUnsafe<void>()
    const releaseFailure = Deferred.makeUnsafe<void>()
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      loadSessionSnapshotFor: (sessionIds) => Effect.gen(function*() {
        fixture.incrementalReads.push([...sessionIds])
        if (fixture.incrementalReads.length === 1) {
          yield* Deferred.succeed(readStarted, undefined)
          yield* Deferred.await(releaseFailure)
          return yield* Effect.fail(new ProviderError({
            providerId: "test", operation: "snapshot", message: "obsolete rewind read failed",
          }))
        }
        return fixture.snapshot
      }),
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider })
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalObservation(observation(1, { _tag: "Draft", draft }))
      yield* TestClock.adjust(100)
      yield* Deferred.await(readStarted)
      const reading = yield* runtime.getState
      const refresh = reading.refresh.active.get("refresh:reconciliation")!
      expect(refresh.historyRevisions?.get(ROOT)).toEqual({ ownerId: "owner-1", revision: 1 })

      yield* runtime.handleTerminalObservation(observation(2, { _tag: "Draft", draft: edited }))
      const editing = yield* runtime.getState
      expect(editing.terminals.get(ROOT)?.historyRevision).toBe(2)
      expect(editing.refresh.generation).toBe(reading.refresh.generation)
      expect(editing.refresh.active.get(refresh.key)).toEqual(refresh)
      fixture.snapshot = snapshot([session(ROOT, "Root")], new Map([[ROOT, prefix]]))
      yield* Deferred.succeed(releaseFailure, undefined)
      const rejected = yield* waitForState(runtime, (candidate) =>
        (candidate.refresh.active.get(refresh.key)?.generation ?? 0) > refresh.generation)
      expect(rejected.provider).toEqual(editing.provider)
      expect(rejected.drafts).toEqual(editing.drafts)
      expect(rejected.rewindAnchors).toEqual(editing.rewindAnchors)
      expect(rejected.pendingCompletions).toEqual(editing.pendingCompletions)
      expect(rejected.replacementCandidates).toEqual(editing.replacementCandidates)
      expect(selectProjectedTranscript(rejected, ROOT)).toEqual(prefix)
      expect(rejected.modal).toBeNull()
      expect(fixture.incrementalReads).toEqual([[ROOT]])

      yield* TestClock.adjust(100)
      return yield* waitForState(runtime, (candidate) => candidate.refresh.active.size === 0)
    }).pipe(Effect.provide(TestClock.layer()))))
    expect(fixture.incrementalReads).toEqual([[ROOT], [ROOT]])
    expect(state.provider.transcripts.get(ROOT)).toEqual({ _tag: "Available", messages: prefix })
    expect(selectProjectedTranscript(state, ROOT)).toEqual(prefix)
    expect(state.rewindAnchors.has(ROOT)).toBeFalse()
    expect(state.drafts.get(ROOT)).toEqual({ text: edited.text, exact: false })
    expect(state.pendingCompletions.size).toBe(0)
    expect(state.unviewedSessionIds.size).toBe(0)
    expect(state.modal).toBeNull()
  })

  test("an old-owner manual read cannot complete a reopened session at the same history revision", async () => {
    const fixture = makeFixture()
    const question = message("q", "user", "question", 0)
    fixture.snapshot = snapshot([session(ROOT, "Root")], new Map([[ROOT, [question]]]))
    const oldSnapshot = snapshot([session(ROOT, "Old owner answer")], new Map([[ROOT, [
      question, { ...message("old-a", "agent", "old answer", 1), turnComplete: true },
    ]]]))
    const manualStarted = Deferred.makeUnsafe<void>()
    const releaseManual = Deferred.makeUnsafe<void>()
    const stopReadStarted = Deferred.makeUnsafe<void>()
    const releaseStopRead = Deferred.makeUnsafe<void>()
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      loadSessionSnapshotFor: (sessionIds) => Effect.gen(function*() {
        fixture.incrementalReads.push([...sessionIds])
        if (fixture.incrementalReads.length === 1) {
          yield* Deferred.succeed(stopReadStarted, undefined)
          // Keep the stop read from advancing the applied generation before the old manual result.
          yield* Deferred.await(releaseStopRead)
        }
        return fixture.snapshot
      }),
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider, completionDelaysMs: [10_000] })
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalObservation(observation(1, { _tag: "Submission", text: question.preview }))
      fixture.fullSnapshot = () => Effect.gen(function*() {
        yield* Deferred.succeed(manualStarted, undefined)
        yield* Deferred.await(releaseManual)
        return oldSnapshot
      })
      const manual = yield* Effect.forkScoped(runtime.refresh())
      yield* Deferred.await(manualStarted)
      const reading = yield* runtime.getState
      expect(reading.refresh.active.get("refresh:full")?.historyRevisions?.get(ROOT)).toEqual({
        ownerId: "owner-1", revision: 1,
      })

      yield* runtime.stopSession(ROOT)
      yield* Deferred.await(stopReadStarted)
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalObservation({
        ...observation(1, { _tag: "Submission", text: question.preview }), ownerId: "owner-2",
      })
      yield* runtime.handleTerminalActivity(activity("owner-2", 2, ROOT, "working", true))
      yield* runtime.handleTerminalActivity(activity("owner-2", 3, ROOT, "idle", true))
      const reopened = yield* runtime.getState
      expect(reopened.terminals.get(ROOT)).toMatchObject({ ownerId: "owner-2", historyRevision: 1 })
      expect(reopened.refresh.appliedGenerationBySession.get(ROOT)).toBe(reading.refresh.appliedGenerationBySession.get(ROOT))
      expect(reopened.pendingCompletions.get(ROOT)?.ownerId).toBe("owner-2")

      yield* Deferred.succeed(releaseManual, undefined)
      yield* Fiber.join(manual)
      const rejected = yield* runtime.getState
      expect(rejected.pendingCompletions.get(ROOT)).toEqual(reopened.pendingCompletions.get(ROOT))
      expect(rejected.provider).toEqual(reopened.provider)
      expect(selectProjectedTranscript(rejected, ROOT)).toEqual([question])
      expect(rejected.refresh.active.get("refresh:reconciliation")?.sessionIds.has(ROOT)).toBeTrue()
      expect(rejected.unviewedSessionIds.has(ROOT)).toBeFalse()
      expect(rejected.modal).toBeNull()

      fixture.snapshot = snapshot([session(ROOT, "New owner answer")], new Map([[ROOT, [
        question, { ...message("new-a", "agent", "new answer", 1), turnComplete: true },
      ]]]))
      yield* TestClock.adjust(100)
      return yield* waitForState(runtime, (candidate) => !candidate.pendingCompletions.has(ROOT))
    }).pipe(Effect.provide(TestClock.layer()))))
    expect(fixture.incrementalReads).toEqual([[ROOT], [ROOT]])
    expect(state.terminals.get(ROOT)?.ownerId).toBe("owner-2")
    expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q", "new-a"])
    expect(state.provider.sessions.get(ROOT)?.title).toBe("New owner answer")
    expect(state.unviewedSessionIds.has(ROOT)).toBeFalse()
    expect(state.modal).toBeNull()
  })

  test("concurrent unsubmitted rewinds reconcile both sessions after the confirmation delay", async () => {
    const fixture = makeFixture()
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.resumeSession(ROOT)
      yield* runtime.resumeSession(CHILD)
      yield* runtime.handleTerminalObservation({
        ...observation(1, { _tag: "Draft", draft: { text: "question", exact: false, rewind: true } }),
        wasActive: false,
      })
      yield* runtime.handleTerminalObservation({
        ...observation(1, { _tag: "Draft", draft: { text: "child question", exact: false, rewind: true } }),
        ownerId: "owner-2", sessionId: CHILD,
      })
      fixture.snapshot = snapshot([session(ROOT, "Root"), session(CHILD, "Child")], new Map([
        [ROOT, []], [CHILD, []],
      ]))
      yield* TestClock.adjust(99)
      expect(fixture.incrementalReads).toEqual([])
      yield* TestClock.adjust(1)
      return yield* waitForState(runtime, (candidate) => candidate.refresh.active.size === 0)
    }).pipe(Effect.provide(TestClock.layer()))))
    expect(fixture.incrementalReads).toHaveLength(1)
    expect(new Set(fixture.incrementalReads[0])).toEqual(new Set([ROOT, CHILD]))
    for (const sessionId of [ROOT, CHILD]) {
      expect(state.provider.transcripts.get(sessionId)).toEqual({ _tag: "Available", messages: [] })
      expect(selectProjectedTranscript(state, sessionId)).toEqual([])
      expect(state.rewindAnchors.has(sessionId)).toBeFalse()
      expect(state.pendingCompletions.has(sessionId)).toBeFalse()
      expect(state.unviewedSessionIds.has(sessionId)).toBeFalse()
    }
    expect(state.modal).toBeNull()
  })

  for (const empty of [false, true]) {
    test(`${empty ? "an explicitly empty composer clears" : "an unknown composer preserves"} the draft across return`, async () => {
      const fixture = makeFixture()
      const draft = { text: "current draft", exact: false }
      const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const runtime = yield* makeAppRuntime({
          ...fixture.options,
          terminals: { ...fixture.options.terminals, draftPreviews: Effect.succeed(new Map([[ROOT, {
            text: "question", exact: false, rewind: true, rewindTarget: "question",
          }]])) },
        })
        yield* runtime.resumeSession(ROOT)
        yield* runtime.handleTerminalObservation(observation(1, { _tag: "Draft", draft }))
        // Unknown screens emit no observation; null is positive evidence of an empty composer.
        if (empty) yield* runtime.handleTerminalObservation(observation(2, { _tag: "Draft", draft: null }))
        yield* runtime.returnFromTerminal
        return yield* runtime.getState
      })))
      expect(state.drafts.get(ROOT)).toEqual(empty ? undefined : draft)
      expect(state.rewindAnchors.has(ROOT)).toBeFalse()
      expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q"])
      expect(state.modal).toBeNull()
    })
  }

  test("a completed Claude screen triggers completion refresh without an idle title", async () => {
    const fixture = makeFixture()
    const observer = new ClaudeTerminalObserver()
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, completionDelaysMs: [0] })
      yield* runtime.resumeSession(ROOT)
      const working = observer.observeOutput(new TextEncoder().encode("\u001b]0;⠋ Claude Code\u0007"))[0]!
      yield* runtime.handleTerminalActivity(activity("owner-1", 1, ROOT, working, false))
      observer.observeScreen({ lines: ["✻ Cogitating… (12s · esc to interrupt)"], cursor: { x: 0, y: 0, visible: false } })
      fixture.snapshot = snapshot([session(ROOT, "Root"), session(CHILD, "Child")], new Map([
        [ROOT, [message("q", "user", "question", 0), { ...message("a", "agent", "answer", 1), turnComplete: true }]],
        [CHILD, [message("cq", "user", "child question", 0)]],
      ]))
      const idle = observer.observeScreen({ lines: ["answer", "❯ ", "────────────────"], cursor: { x: 2, y: 1, visible: true } })
      expect(idle).toBe("idle")
      yield* runtime.handleTerminalActivity(activity("owner-1", 2, ROOT, idle!, false))
      return yield* waitForState(runtime, (candidate) => candidate.pendingCompletions.size === 0 && candidate.unviewedSessionIds.has(ROOT))
    })))
    expect(selectSessionStatus(state, ROOT)).toBe("unviewed")
    expect(selectProjectedTranscript(state, ROOT).map((message) => message.id)).toEqual(["q", "a"])
    expect(state.modal).toBeNull()
  })

  for (const issue of ["unrecognized-screen", "observer-failed"] as const) {
    test(`manual refresh explains ${issue} without claiming working history is complete`, async () => {
      const fixture = makeFixture()
      let probes = 0
      const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const runtime = yield* makeAppRuntime({ ...fixture.options, terminals: {
          ...fixture.options.terminals,
          reconcileActivity: Effect.sync(() => {
            probes += 1
            return [{ ownerId: "owner-1", sessionId: ROOT, sequenceId: 1, issue }]
          }),
        } })
        yield* runtime.resumeSession(ROOT)
        yield* runtime.handleTerminalActivity(activity("owner-1", 1, ROOT, "working", false))
        fixture.snapshot = snapshot([session(ROOT, "Root"), session(CHILD, "Child")], new Map([
          [ROOT, [message("q", "user", "question", 0), { ...message("a", "agent", "answer", 1), turnComplete: true }]],
          [CHILD, [message("cq", "user", "updated unrelated question", 0)]],
        ]))
        yield* runtime.refresh()
        return yield* runtime.getState
      })))
      expect(probes).toBe(1)
      expect(state.modal?._tag).toBe("Error")
      expect(state.modal?._tag === "Error" && state.modal.message).toContain("Activity could not be verified")
      expect(selectSessionStatus(state, ROOT)).toBe("working")
      expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q"])
      expect(state.unviewedSessionIds.has(ROOT)).toBeFalse()
    })
  }

  test("a newer activity event suppresses obsolete manual probe diagnostics", async () => {
    const fixture = makeFixture()
    let runtime: AppRuntime
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      runtime = yield* makeAppRuntime({ ...fixture.options, terminals: {
        ...fixture.options.terminals,
        reconcileActivity: Effect.gen(function*() {
          yield* runtime.handleTerminalActivity(activity("owner-1", 2, ROOT, "working", false))
          return [{ ownerId: "owner-1", sessionId: ROOT, sequenceId: 1, issue: "observer-failed" as const }]
        }),
      } })
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalActivity(activity("owner-1", 1, ROOT, "working", false))
      yield* runtime.refresh()
      expect((yield* runtime.getState).modal).toBeNull()
    })))
  })

  test("terminal-return refresh can atomically satisfy a pending completion", async () => {
    const fixture = makeFixture()
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({
        ...fixture.options,
        completionDelaysMs: [10_000],
      })
      yield* runtime.resumeSession(ROOT)
      yield* runtime.handleTerminalActivity(activity("owner-1", 1, ROOT, "working", false))
      yield* runtime.handleTerminalActivity(activity("owner-1", 2, ROOT, "idle", false))
      fixture.snapshot = snapshot(
        [session(ROOT, "Completed"), session(CHILD, "Child")],
        new Map([
          [ROOT, [
            message("q", "user", "question", 0),
            { ...message("a", "agent", "answer", 1), turnComplete: true },
          ]],
          [CHILD, [message("cq", "user", "child question", 0)]],
        ]),
      )
      yield* runtime.returnFromTerminal
      for (let index = 0; index < 8; index += 1) yield* Effect.yieldNow
      return yield* runtime.getState
    })))

    expect(state.pendingCompletions.has(ROOT)).toBeFalse()
    expect(state.unviewedSessionIds.has(ROOT)).toBeTrue()
    expect(selectSessionStatus(state, ROOT)).toBe("unviewed")
    expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q", "a"])
    expect(fixture.incrementalReads).toContainEqual([ROOT])
  })

  test("replays the current view model to late subscribers", async () => {
    const fixture = makeFixture()
    const title = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.selectRoot(ROOT)
      const replay = yield* Stream.runHead(runtime.viewModels)
      const view = Option.getOrThrow(replay)
      return view.surface._tag === "Roots"
        ? view.surface.roots.find((root) => root.selected)?.title
        : undefined
    })))
    expect(title).toBe("Root")
  })

  test("shutdown is direct, idempotent, and rejects later intents", async () => {
    const fixture = makeFixture()
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      const first = yield* Effect.forkScoped(runtime.shutdown)
      const second = yield* Effect.forkScoped(runtime.shutdown)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      const postShutdown = yield* Effect.exit(runtime.refresh())
      return { postShutdown, state: yield* runtime.getState }
    })))
    expect(fixture.shutdowns).toBe(1)
    expect(result.state.shutdown).toBe("stopped")
    expect(Exit.isFailure(result.postShutdown)).toBeTrue()
  })

  test("starts terminal cleanup before draining queued ordinary intents", async () => {
    const fixture = makeFixture()
    const terminalStarted = Deferred.makeUnsafe<void>()
    const releaseTerminal = Deferred.makeUnsafe<void>()
    let preparations = 0
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      prepareNewSession: Effect.sync(() => {
        preparations += 1
      }).pipe(Effect.andThen(Effect.never)),
    }
    const terminals: TerminalSupervisorApi = {
      ...fixture.options.terminals,
      shutdown: () => Effect.gen(function*() {
        fixture.shutdowns += 1
        yield* Deferred.succeed(terminalStarted, undefined)
        yield* Deferred.await(releaseTerminal)
      }),
    }

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider, terminals })
      const requests = yield* Effect.sync(() => Array.from(
        { length: 64 },
        () => Effect.runFork(Effect.exit(runtime.newSession)),
      ))
      const shutdown = yield* Effect.forkScoped(runtime.shutdown)
      yield* Deferred.await(terminalStarted)
      const preparationsWhenCleanupStarted = preparations
      yield* Deferred.succeed(releaseTerminal, undefined)
      yield* Fiber.join(shutdown)
      const requestExits = yield* Effect.all(requests.map(Fiber.join))
      return { preparationsWhenCleanupStarted, requestExits }
    })))

    expect(result.preparationsWhenCleanupStarted).toBe(0)
    expect(result.requestExits.every(Exit.isFailure)).toBeTrue()
    const reasons: IntentRejectedError["reason"][] = []
    for (const exit of result.requestExits) {
      if (Exit.isFailure(exit)) {
        const error = Exit.findErrorOption(exit).pipe(Option.getOrThrow)
        expect(error).toBeInstanceOf(IntentRejectedError)
        reasons.push((error as IntentRejectedError).reason)
      }
    }
    expect(reasons).toContain("shutting-down")
    expect(reasons.every((reason) => reason === "shutting-down" || reason === "superseded")).toBeTrue()
  })

  test("shutdown does not wait for an uninterruptible command fiber", async () => {
    const fixture = makeFixture()
    const commandStarted = Deferred.makeUnsafe<void, never>()
    const releaseCommand = Deferred.makeUnsafe<void, never>()
    let loads = 0
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      loadSessionSnapshot: Effect.suspend(() => {
        loads += 1
        if (loads === 1) return Effect.succeed(fixture.snapshot)
        return Effect.uninterruptible(Effect.gen(function*() {
          yield* Deferred.succeed(commandStarted, undefined)
          yield* Deferred.await(releaseCommand)
          return fixture.snapshot
        }))
      }),
    }
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider })
      const refresh = yield* Effect.forkScoped(runtime.refresh())
      yield* Deferred.await(commandStarted)
      const shutdown = yield* Effect.forkScoped(runtime.shutdown)
      yield* Effect.yieldNow
      yield* TestClock.adjust(100)
      yield* Fiber.join(shutdown)
      const refreshExit = yield* Fiber.await(refresh)
      return { refreshExit, state: yield* runtime.getState }
    }).pipe(Effect.provide(TestClock.layer()))))
    expect(Exit.isFailure(result.refreshExit)).toBeTrue()
    expect(result.state.shutdown).toBe("stopped")
    expect(fixture.shutdowns).toBe(1)
  })

  test("scope finalization shuts the actor down exactly once", async () => {
    const fixture = makeFixture()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* makeAppRuntime(fixture.options)
    })))
    expect(fixture.shutdowns).toBe(1)
  })

  test("projects current-instance pending adoptions before acknowledging startup", async () => {
    const fixture = makeFixture()
    const adopted = "adopted"
    const adoptedRelation = relation(adopted, ROOT)
    const adoption = pendingAdoption("startup-adoption", ROOT, adopted, adoptedRelation)
    const order: string[] = []
    const projectState: ProjectState = {
      relations: [adoptedRelation],
      removals: [],
      navigation: {
        view: "graph",
        familySessionId: adopted,
        target: { kind: "endpoint", sessionId: adopted },
      },
    }
    fixture.snapshot = snapshot(
      [session(ROOT, "Root"), session(adopted, "Adopted")],
      new Map([[ROOT, []], [adopted, []]]),
    )
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      loadSessionSnapshot: Effect.sync(() => {
        order.push("snapshot")
        return fixture.snapshot
      }),
    }
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      loadMetadata: Effect.succeed(projectState),
      pendingAdoptions: Effect.succeed([adoption]),
      ack: (token) => Effect.sync(() => order.push(`ack:${token}`)),
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider, metadata })
      return yield* runtime.getState
    })))

    expect(order).toEqual(["snapshot", "ack:startup-adoption"])
    expect(state.provider.sessions.has(adopted)).toBeTrue()
    expect(state.relations).toContainEqual(adoptedRelation)
    expect(state.surface).toMatchObject({
      _tag: "Graph",
      target: { kind: "endpoint", sessionId: adopted },
    })
  })

  test("shows a concise modal and persists graph fallback when terminal restoration fails", async () => {
    const fixture = makeFixture()
    let metadataState: ProjectState = {
      relations: [],
      removals: [],
      navigation: { view: "terminal", sessionId: ROOT },
    }
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      loadMetadata: Effect.sync(() => metadataState),
      updateMetadata: (transform) => Effect.sync(() => {
        metadataState = transform(metadataState)
        return metadataState
      }),
    }
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      prepareResume: () => Effect.fail(new ProviderError({
        providerId: "test",
        operation: "resume",
        message: "resume unavailable",
      })),
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata, provider })
      return yield* waitForState(runtime, (candidate) =>
        candidate.modal?._tag === "Error" && candidate.modal.message.includes("resume unavailable") &&
        metadataState.navigation?.view === "graph")
    })))

    expect(state.modal).toEqual({ _tag: "Error", message: "Resume session: resume unavailable" })
    expect(state.surface).toMatchObject({
      _tag: "Graph",
      familySessionId: ROOT,
    })
    expect(metadataState.navigation).toMatchObject({ view: "graph", familySessionId: ROOT })
  })

  test("reports and preserves a pending adoption absent from the startup snapshot", async () => {
    const fixture = makeFixture()
    const acked: string[] = []
    const adoption = pendingAdoption("missing-adoption", ROOT, "missing")
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      pendingAdoptions: Effect.succeed([adoption]),
      ack: (token) => Effect.sync(() => acked.push(token)),
    }
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata })
      return yield* waitForState(runtime, (candidate) => candidate.modal?._tag === "Error")
    })))
    expect(acked).toEqual([])
    expect(state.modal?._tag === "Error" ? state.modal.message : "").toContain(
      "absent from the provider snapshot",
    )
  })

  test("surfaces current-instance startup acknowledgment failures in actor state", async () => {
    const fixture = makeFixture()
    const adopted = "adopted"
    const adoption = pendingAdoption("failing-adoption", ROOT, adopted)
    fixture.snapshot = snapshot(
      [session(ROOT, "Root"), session(adopted, "Adopted")],
      new Map([[ROOT, []], [adopted, []]]),
    )
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      pendingAdoptions: Effect.succeed([adoption]),
      ack: () => Effect.fail(persistenceFailure("startup ack failed")),
    }
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata })
      return yield* waitForState(runtime, (candidate) =>
        candidate.modal?._tag === "Error" && candidate.modal.message.includes("startup ack failed"))
    })))
    expect(state.modal?._tag === "Error" ? state.modal.message : "").toContain("startup ack failed")
  })

  test("reconciles reported foreign orphan journals before provider startup", async () => {
    const fixture = makeFixture()
    const orphan = pendingAdoption("orphan", ROOT, CHILD)
    const order: string[] = []
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      orphanedAdoptions: Effect.sync(() => {
        order.push("list-orphans")
        return [orphan]
      }),
      reconcileOrphanedAdoption: (token) => Effect.sync(() => {
        order.push(`reconcile:${token}`)
      }),
    }
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      loadSessionSnapshot: Effect.sync(() => {
        order.push("snapshot")
        return fixture.snapshot
      }),
    }
    await Effect.runPromise(Effect.scoped(
      makeAppRuntime({ ...fixture.options, metadata, provider }),
    ))
    expect(order.slice(0, 3)).toEqual(["list-orphans", "reconcile:orphan", "snapshot"])
  })

  test("subtree removal selects and persists the nearest surviving parent", async () => {
    const fixture = makeFixture()
    const branch = {
      ...relation(CHILD, ROOT),
      sharedMessages: [{ parentMessageId: "q", childMessageId: "cq" }],
    }
    fixture.snapshot = snapshot(
      [session(ROOT, "Root"), session(CHILD, "Child")],
      new Map([
        [ROOT, [message("q", "user", "question", 0)]],
        [CHILD, [
          message("cq", "user", "question", 0),
          message("child-agent", "agent", "child answer", 1),
        ]],
      ]),
    )
    let metadataState: ProjectState = { relations: [branch], removals: [] }
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      loadMetadata: Effect.sync(() => metadataState),
      updateMetadata: (transform) => Effect.sync(() => {
        metadataState = transform(metadataState)
        return metadataState
      }),
      commitRemoval: (removal) => Effect.sync(() => {
        metadataState = { ...metadataState, removals: [...metadataState.removals, removal] }
        return removal
      }),
    }
    const removal = {
      kind: "subtree" as const,
      target: {
        kind: "message" as const,
        aliases: [{ sessionId: CHILD, messageId: "child-agent" }],
      },
      createdAt: "2026-09-02T00:00:00.000Z",
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata })
      yield* waitForState(runtime, (candidate) => !candidate.refresh.initialPending)
      yield* runtime.selectGraph(ROOT, {
        kind: "message",
        preferred: removal.target.aliases[0]!,
        aliases: removal.target.aliases,
      })
      yield* runtime.remove(removal, [CHILD])
      return yield* runtime.getState
    })))

    expect(state.surface).toMatchObject({
      _tag: "Graph",
      familySessionId: ROOT,
      target: { kind: "message", preferred: { sessionId: ROOT, messageId: "q" } },
    })
    expect(metadataState.navigation).toMatchObject({
      view: "graph",
      familySessionId: ROOT,
      target: { kind: "message", preferred: { sessionId: ROOT, messageId: "q" } },
    })
  })

  test("root removal selects and persists the neighboring surviving root", async () => {
    const fixture = makeFixture()
    let metadataState: ProjectState = { relations: [], removals: [] }
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      loadMetadata: Effect.sync(() => metadataState),
      updateMetadata: (transform) => Effect.sync(() => {
        metadataState = transform(metadataState)
        return metadataState
      }),
      commitRemoval: (removal) => Effect.sync(() => {
        metadataState = { ...metadataState, removals: [...metadataState.removals, removal] }
        return removal
      }),
    }
    const removal = {
      kind: "tree" as const,
      rootSessionId: CHILD,
      memberSessionIds: [CHILD],
      createdAt: "2026-09-02T00:00:00.000Z",
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata })
      yield* waitForState(runtime, (candidate) => !candidate.refresh.initialPending)
      yield* runtime.selectRoot(CHILD)
      yield* runtime.remove(removal, [])
      return yield* runtime.getState
    })))

    expect(state.surface).toEqual({ _tag: "Roots", selectedSessionId: ROOT })
    expect(metadataState.navigation).toEqual({ view: "roots", selectedSessionId: ROOT })
  })

  test("re-canonicalizes an accepted removal after temporary adoption is acknowledged", async () => {
    const fixture = makeFixture()
    const staleStopStarted = Deferred.makeUnsafe<void>()
    const releaseStaleStop = Deferred.makeUnsafe<void>()
    const acknowledgmentStarted = Deferred.makeUnsafe<void>()
    const releaseAcknowledgment = Deferred.makeUnsafe<void>()
    const persisted = "persisted"
    const order: string[] = []
    let committedRemoval: ProjectState["removals"][number] | undefined
    const terminals: TerminalSupervisorApi = {
      ...fixture.options.terminals,
      stopSession: (sessionId) => {
        fixture.calls.push(`stop:${sessionId}`)
        if (sessionId === "temporary") {
          return Effect.gen(function*() {
            yield* Deferred.succeed(staleStopStarted, undefined)
            yield* Deferred.await(releaseStaleStop)
            return false
          })
        }
        return Effect.sync(() => {
          order.push(`stop:${sessionId}`)
          return sessionId === persisted
        })
      },
    }
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      ack: () => Effect.gen(function*() {
        yield* Deferred.succeed(acknowledgmentStarted, undefined)
        yield* Deferred.await(releaseAcknowledgment)
        order.push("acknowledged")
      }),
      commitRemoval: (removal, affectedSessionIds) => Effect.sync(() => {
        order.push("committed")
        committedRemoval = removal
        expect(affectedSessionIds).toEqual([persisted])
        return removal
      }),
    }
    const removal = {
      kind: "subtree" as const,
      target: { kind: "endpoint" as const, sessionId: "temporary", afterMessageId: null },
      createdAt: "2026-09-02T00:00:00.000Z",
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata, terminals })
      yield* runtime.newSession
      const removing = yield* Effect.forkScoped(runtime.remove(removal, ["temporary"]))
      yield* Deferred.await(staleStopStarted)

      const acknowledgment = yield* Deferred.make<void, unknown>()
      expect(yield* runtime.handleTerminalSessionChanged({
        ownerId: "owner-1",
        sequenceId: 1,
        previousSessionId: "temporary",
        session: session(persisted, "Persisted"),
        kind: "temporary-adoption",
        adoptionToken: "adopt-before-remove",
        wasActive: true,
        acknowledgment,
      })).toBeTrue()
      yield* Deferred.await(acknowledgmentStarted)
      yield* Deferred.succeed(releaseStaleStop, undefined)
      for (let index = 0; index < 4; index += 1) yield* Effect.yieldNow
      expect(order).toEqual([])

      yield* Deferred.succeed(releaseAcknowledgment, undefined)
      yield* Deferred.await(acknowledgment)
      yield* Fiber.join(removing)
      return yield* runtime.getState
    })))

    expect(order).toEqual(["acknowledged", `stop:${persisted}`, "committed"])
    expect(fixture.calls).toEqual(expect.arrayContaining(["stop:temporary", `stop:${persisted}`]))
    expect(committedRemoval).toEqual({
      ...removal,
      target: { ...removal.target, sessionId: persisted },
    })
    expect(state.removals).toContainEqual(committedRemoval!)
    expect(state.terminals.has(persisted)).toBeFalse()
  })

  test("projects partial removal stops, refreshes them, and does not persist removal", async () => {
    const fixture = makeFixture()
    const refreshStarted = Deferred.makeUnsafe<void>()
    const baseStop = fixture.options.terminals.stopSession
    const terminals: TerminalSupervisorApi = {
      ...fixture.options.terminals,
      stopSession: (sessionId) => sessionId === CHILD
        ? Effect.fail(new TerminalCleanupError({
            operation: "stop",
            issues: [{
              ownerId: "owner-2",
              sessionId,
              stage: "verify",
              message: "cleanup failed",
            }],
          }))
        : baseStop(sessionId),
    }
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      loadSessionSnapshotFor: (sessionIds) => Effect.gen(function*() {
        fixture.incrementalReads.push([...sessionIds])
        yield* Deferred.succeed(refreshStarted, undefined)
        return snapshot([], new Map())
      }),
    }
    const removal = {
      kind: "tree" as const,
      rootSessionId: ROOT,
      memberSessionIds: [ROOT, CHILD],
      createdAt: "2026-09-01T00:00:00.000Z",
    }
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider, terminals })
      yield* runtime.resumeSession(ROOT)
      yield* runtime.returnFromTerminal
      yield* runtime.resumeSession(CHILD)
      yield* runtime.returnFromTerminal
      const exit = yield* Effect.exit(runtime.remove(removal, [ROOT, CHILD]))
      yield* Deferred.await(refreshStarted)
      return { exit, state: yield* runtime.getState }
    })))
    expect(Exit.isFailure(result.exit)).toBeTrue()
    if (Exit.isFailure(result.exit)) {
      const error = Exit.findErrorOption(result.exit).pipe(Option.getOrThrow)
      expect(error).toBeInstanceOf(RemovalOperationError)
      expect((error as RemovalOperationError).stoppedSessionIds).toEqual([ROOT])
    }
    expect(result.state.terminals.has(ROOT)).toBeFalse()
    expect(result.state.terminals.get(CHILD)?.phase).toBe("cleanup-incomplete")
    expect(result.state.removals).toEqual([])
    expect(fixture.incrementalReads).toContainEqual([ROOT])
  })

  test("rejects an atomic removal when a foreign owner appears after local stops", async () => {
    const fixture = makeFixture()
    const removal = {
      kind: "tree" as const,
      rootSessionId: ROOT,
      memberSessionIds: [ROOT, CHILD],
      createdAt: "2026-09-01T00:00:00.000Z",
    }
    const mutationTokens: string[] = []
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      commitRemoval: (_removal, affectedSessionIds, mutationToken) => {
        mutationTokens.push(mutationToken ?? "")
        expect(affectedSessionIds).toEqual([ROOT, CHILD])
        expect(fixture.calls).toContain("stop:root")
        return Effect.fail(new SessionOwnedError({
          providerId: "test",
          sessionId: CHILD,
          ownerPid: 202,
        }))
      },
    }

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata })
      yield* runtime.resumeSession(ROOT)
      yield* runtime.returnFromTerminal
      const exit = yield* Effect.exit(runtime.remove(removal, [ROOT, CHILD]))
      for (let index = 0; index < 4; index += 1) yield* Effect.yieldNow
      return { exit, state: yield* runtime.getState }
    })))

    expect(Exit.isFailure(result.exit)).toBeTrue()
    if (Exit.isFailure(result.exit)) {
      const error = Exit.findErrorOption(result.exit).pipe(Option.getOrThrow)
      expect(error).toBeInstanceOf(RemovalOperationError)
      expect((error as RemovalOperationError).stoppedSessionIds).toEqual([ROOT])
      expect((error as RemovalOperationError).cause).toBeInstanceOf(SessionOwnedError)
    }
    expect(mutationTokens).toHaveLength(1)
    expect(mutationTokens[0]).not.toBe("")
    expect(result.state.removals).toEqual([])
    expect(result.state.terminals.has(ROOT)).toBeFalse()
    expect(fixture.incrementalReads).toContainEqual([ROOT])
  })

  test("immediately rejects duplicate explicit removal request IDs", async () => {
    const fixture = makeFixture()
    const started = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const removal = {
      kind: "tree" as const,
      rootSessionId: ROOT,
      memberSessionIds: [ROOT],
      createdAt: "2026-09-01T00:00:00.000Z",
    }
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      commitRemoval: (value) => Effect.gen(function*() {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return value
      }),
    }

    const exits = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata })
      const first = yield* Effect.forkScoped(Effect.exit(runtime.remove(removal, [ROOT], "same-request")))
      yield* Deferred.await(started)
      const duplicate = yield* Effect.exit(runtime.remove(removal, [ROOT], "same-request"))
      yield* Deferred.succeed(release, undefined)
      return { first: yield* Fiber.join(first), duplicate }
    })))

    expect(Exit.isSuccess(exits.first)).toBeTrue()
    expect(Exit.isFailure(exits.duplicate)).toBeTrue()
    if (Exit.isFailure(exits.duplicate)) {
      const error = Exit.findErrorOption(exits.duplicate).pipe(Option.getOrThrow)
      expect(error).toBeInstanceOf(IntentRejectedError)
      expect((error as IntentRejectedError).reason).toBe("busy")
      expect((error as IntentRejectedError).intent).toBe("Remove")
    }
  })

  test("an interrupted navigation caller does not strand writer flush", async () => {
    let state: ProjectState = { relations: [], removals: [] }
    const started = Deferred.makeUnsafe<void, never>()
    const release = Deferred.makeUnsafe<void, never>()
    const metadata = metadataFacet(() => state, (transform) => Effect.gen(function*() {
      yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(release)
      state = transform(state)
      return state
    }))
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const writer = yield* makeNavigationWriter(metadata)
      const write = yield* Effect.forkScoped(
        writer.write({ view: "roots", selectedSessionId: ROOT }),
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(write)
      const flush = yield* Effect.forkScoped(writer.flush)
      expect(flush.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(flush)
    })))
    expect(state.navigation).toEqual({ view: "roots", selectedSessionId: ROOT })
  })

  test("starts terminal cleanup while navigation is blocked and bounds shutdown", async () => {
    const fixture = makeFixture()
    const navigationStarted = Deferred.makeUnsafe<void, never>()
    const releaseNavigation = Deferred.makeUnsafe<void, never>()
    const terminalStarted = Deferred.makeUnsafe<void, never>()
    let metadataState: ProjectState = { relations: [], removals: [] }
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      loadMetadata: Effect.sync(() => metadataState),
      updateMetadata: (transform) => Effect.gen(function*() {
        yield* Deferred.succeed(navigationStarted, undefined)
        yield* Deferred.await(releaseNavigation)
        metadataState = transform(metadataState)
        return metadataState
      }),
    }
    const terminals: TerminalSupervisorApi = {
      ...fixture.options.terminals,
      shutdown: () => Effect.gen(function*() {
        fixture.shutdowns += 1
        yield* Deferred.succeed(terminalStarted, undefined)
      }),
    }
    let shutdownExit: Exit.Exit<void, ApplicationShutdownError> | undefined
    let shutdownState: ApplicationState | undefined
    const scopedExit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({
        ...fixture.options,
        metadata,
        terminals,
        shutdownNavigationTimeoutMs: 100,
      })
      const navigation = yield* Effect.forkScoped(runtime.selectRoot(ROOT))
      yield* Deferred.await(navigationStarted)
      const shutdown = yield* Effect.forkScoped(runtime.shutdown)
      yield* Deferred.await(terminalStarted)
      expect(shutdown.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(100)
      shutdownExit = yield* Fiber.await(shutdown)
      shutdownState = yield* runtime.getState
      yield* Deferred.succeed(releaseNavigation, undefined)
      yield* Fiber.await(navigation)
    }).pipe(Effect.provide(TestClock.layer()))))
    expect(Exit.isFailure(scopedExit)).toBeTrue()
    expect(shutdownExit && Exit.isFailure(shutdownExit)).toBeTrue()
    expect(shutdownState?.shutdown).toBe("cleanup-incomplete")
    expect(fixture.shutdowns).toBe(1)
  })

  test("reconciles ambiguous navigation mutations and reports definite flush failures", async () => {
    let state: ProjectState = { relations: [], removals: [] }
    let commitThenFail = true
    const metadata = metadataFacet(() => state, (transform) => {
      state = transform(state)
      if (commitThenFail) {
        commitThenFail = false
        return Effect.fail(persistenceFailure("ambiguous write"))
      }
      return Effect.succeed(state)
    })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const writer = yield* makeNavigationWriter(metadata)
      yield* writer.write({ view: "roots", selectedSessionId: ROOT })
    })))
    expect(state.navigation).toEqual({ view: "roots", selectedSessionId: ROOT })

    const failing = metadataFacet(() => ({ relations: [], removals: [] }), () =>
      Effect.fail(persistenceFailure("definite write failure")))
    const failures = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const failedWriter = yield* makeNavigationWriter(failing)
      return {
        write: yield* Effect.exit(failedWriter.write({ view: "roots", selectedSessionId: CHILD })),
        flush: yield* Effect.exit(failedWriter.flush),
      }
    })))
    expect(Exit.isFailure(failures.write)).toBeTrue()
    expect(Exit.isFailure(failures.flush)).toBeTrue()
  })

  test("forces a full snapshot after an ambiguous provider mutation", async () => {
    const fixture = makeFixture()
    fixture.branchOutcome = {
      _tag: "AmbiguousBranchMutation",
      providerId: "test",
      parentSessionId: ROOT,
      sourceMessageId: "q",
      reason: "fork response was lost",
      reconciliation: "full-snapshot",
    }
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      const exit = yield* Effect.exit(runtime.branchFrom({ sessionId: ROOT, messageId: "q" }))
      return { exit, state: yield* runtime.getState }
    })))
    expect(Exit.isFailure(result.exit)).toBeTrue()
    expect(result.state.modal).toEqual({ _tag: "Error", message: "fork response was lost" })
    expect(fixture.fullLoads).toBe(2)
  })

  test("preserves ambiguity when its forced reconciliation snapshot fails", async () => {
    const fixture = makeFixture()
    fixture.branchOutcome = {
      _tag: "AmbiguousBranchMutation",
      providerId: "test",
      parentSessionId: ROOT,
      sourceMessageId: "q",
      reason: "fork response was lost",
      reconciliation: "full-snapshot",
    }
    let loads = 0
    fixture.fullSnapshot = () => {
      loads += 1
      return loads === 1
        ? Effect.succeed(fixture.snapshot)
        : Effect.fail(new ProviderError({
            providerId: "test",
            operation: "snapshot",
            message: "snapshot unavailable",
          }))
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* Effect.exit(runtime.branchFrom({ sessionId: ROOT, messageId: "q" }))
      for (let index = 0; index < 8; index += 1) yield* Effect.yieldNow
      return yield* runtime.getState
    })))

    expect(state.modal?._tag).toBe("Error")
    expect(state.modal?._tag === "Error" ? state.modal.message : "").toContain("fork response was lost")
    expect(state.modal?._tag === "Error" ? state.modal.message : "").toContain("snapshot unavailable")
  })

  test("consumes provider reconciliation signals and forces a full refresh", async () => {
    const fixture = makeFixture()
    const reconciliations = makeBranchMutationReconciliationSignal()
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      takeBranchMutationReconciliation: reconciliations.take,
    }
    const outcome = {
      _tag: "AmbiguousBranchMutation" as const,
      providerId: "test",
      parentSessionId: ROOT,
      sourceMessageId: "q",
      reason: "interrupted fork may have committed",
      reconciliation: "full-snapshot" as const,
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider })
      yield* Effect.sync(() => reconciliations.offer(outcome))
      while (fixture.fullLoads < 2) yield* Effect.yieldNow
      for (let index = 0; index < 4; index += 1) yield* Effect.yieldNow
      return yield* runtime.getState
    })))

    expect(fixture.fullLoads).toBe(2)
    expect(state.modal).toEqual({ _tag: "Error", message: outcome.reason })
  })

  test("backs off after a defective reconciliation take and consumes a later signal", async () => {
    const fixture = makeFixture()
    const reconciliations = makeBranchMutationReconciliationSignal()
    let takes = 0
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      takeBranchMutationReconciliation: Effect.suspend(() => {
        takes += 1
        return takes === 1
          ? Effect.die("reconciliation take defect")
          : reconciliations.take
      }),
    }
    const outcome = {
      _tag: "AmbiguousBranchMutation" as const,
      providerId: "test",
      parentSessionId: ROOT,
      sourceMessageId: "q",
      reason: "later reconciliation signal",
      reconciliation: "full-snapshot" as const,
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider })
      for (let index = 0; index < 4; index += 1) yield* Effect.yieldNow
      yield* Effect.sync(() => reconciliations.offer(outcome))
      yield* TestClock.adjust(100)
      while (fixture.fullLoads < 2) yield* Effect.yieldNow
      return yield* runtime.getState
    }).pipe(Effect.provide(TestClock.layer()))))

    expect(takes).toBeGreaterThanOrEqual(2)
    expect(fixture.fullLoads).toBe(2)
    expect(state.modal).toEqual({ _tag: "Error", message: outcome.reason })
  })

  test("reports a persistent reconciliation take defect only once while retrying", async () => {
    const fixture = makeFixture()
    let takes = 0
    let reports = 0
    const provider: AgentProviderApi = {
      ...fixture.options.provider,
      takeBranchMutationReconciliation: Effect.suspend(() => {
        takes += 1
        return Effect.die("persistent reconciliation take defect")
      }),
    }

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, provider })
      yield* Effect.forkScoped(Stream.runForEach(runtime.viewModels, (viewModel) => Effect.sync(() => {
        if (viewModel.modal?._tag === "Error" && viewModel.modal.message.includes("Branch reconciliation")) {
          reports += 1
        }
      })))
      for (let index = 0; index < 5; index += 1) {
        yield* TestClock.adjust(1_000)
        yield* Effect.yieldNow
      }
    }).pipe(Effect.provide(TestClock.layer()))))

    expect(takes).toBeGreaterThan(2)
    expect(reports).toBe(1)
  })

  test("opens a provider-created independent child when ancestry persistence fails", async () => {
    const fixture = makeFixture()
    const child = prepared("zero-prefix-child", "Zero prefix child")
    fixture.branchOutcome = {
      _tag: "ValidatedBranch",
      ...child,
      derivation: {
        childSessionId: child.session.id,
        parentSessionId: ROOT,
        sourceMessageId: "q",
        sharedMessages: [],
      },
    }
    const updateMetadata = fixture.options.metadata.updateMetadata
    let failAncestry = true
    const metadata: ApplicationMetadataFacet = {
      ...fixture.options.metadata,
      updateMetadata: (transform) => {
        if (failAncestry) {
          failAncestry = false
          return Effect.fail(persistenceFailure("ancestry write failed"))
        }
        return updateMetadata(transform)
      },
    }

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({ ...fixture.options, metadata })
      const exit = yield* Effect.exit(runtime.branchFrom({ sessionId: ROOT, messageId: "q" }))
      return { exit, state: yield* runtime.getState }
    })))

    expect(Exit.isSuccess(result.exit)).toBeTrue()
    expect(fixture.calls).toContain("show:zero-prefix-child")
    expect(result.state.local.sessions.has("zero-prefix-child")).toBeTrue()
    expect(result.state.modal?._tag === "Error" ? result.state.modal.message : "").toContain(
      "ancestry could not be saved",
    )
  })
})

interface Fixture {
  options: Parameters<typeof makeAppRuntime>[0]
  readonly calls: string[]
  readonly incrementalReads: string[][]
  readonly acked: string[]
  snapshot: AgentSessionSnapshot
  branchOutcome: BranchOutcome
  fullSnapshot: () => Effect.Effect<AgentSessionSnapshot, ProviderError>
  fullLoads: number
  shutdowns: number
  readonly adoptOwner: (previousSessionId: string, sessionId: string) => void
  prepareResumeReceiver?: AgentProviderApi
}

function makeFixture(): Fixture {
  const calls: string[] = []
  const incrementalReads: string[][] = []
  const acked: string[] = []
  const owned = new Map<string, string>()
  let activeSessionId: string | null = null
  let state: ProjectState = { relations: [], removals: [] }
  let nextOwner = 1
  const fixture = {
    options: undefined as never,
    calls,
    incrementalReads,
    acked,
    snapshot: snapshot(
      [session(ROOT, "Root"), session(CHILD, "Child")],
      new Map([
        [ROOT, [message("q", "user", "question", 0)]],
        [CHILD, [message("cq", "user", "child question", 0)]],
      ]),
    ),
    branchOutcome: {
      _tag: "CreatedIndependentSession",
      session: session("independent", "Independent"),
      transcript: { _tag: "Available", messages: [] },
      reason: "not configured",
    } as BranchOutcome,
    fullSnapshot: undefined as never,
    fullLoads: 0,
    shutdowns: 0,
    adoptOwner: (previousSessionId: string, sessionId: string) => {
      const ownerId = owned.get(previousSessionId)
      if (!ownerId) throw new Error(`Cannot adopt missing fixture owner ${previousSessionId}`)
      owned.delete(previousSessionId)
      owned.set(sessionId, ownerId)
      if (activeSessionId === previousSessionId) activeSessionId = sessionId
    },
  } as Fixture
  fixture.fullSnapshot = () => Effect.sync(() => {
    fixture.fullLoads += 1
    return fixture.snapshot
  })

  const metadata: ApplicationMetadataFacet = {
    instanceId: "instance",
    loadMetadata: Effect.sync(() => state),
    updateMetadata: (transform) => Effect.sync(() => {
      state = transform(state)
      return state
    }),
    commitRemoval: (removal) => Effect.sync(() => {
      if (!state.removals.some((candidate) => JSON.stringify(candidate) === JSON.stringify(removal))) {
        state = { ...state, removals: [...state.removals, removal] }
      }
      return removal
    }),
    pendingAdoptions: Effect.succeed([]),
    orphanedAdoptions: Effect.succeed([]),
    reconcileOrphanedAdoption: () => Effect.void,
    ack: (token) => Effect.sync(() => {
      acked.push(token)
    }),
  }
  const provider: AgentProviderApi = {
    id: "test",
    displayName: "Test",
    capabilities: {
      historicalBranching: true,
      exactMessageForks: true,
      completedTurnForks: true,
      userMessageReplay: true,
      temporarySessionIds: true,
      nativeSessionSwitching: true,
    },
    loadSessionSnapshot: Effect.suspend(() => fixture.fullSnapshot()),
    loadSessionSnapshotFor: (sessionIds) => Effect.sync(() => {
      incrementalReads.push([...sessionIds])
      return {
        sessions: fixture.snapshot.sessions.filter((candidate) => sessionIds.includes(candidate.id)),
        transcripts: new Map([...fixture.snapshot.transcripts].filter(([sessionId]) => sessionIds.includes(sessionId))),
      }
    }),
    readTranscripts: (sessionIds) => Effect.succeed(new Map(
      sessionIds.map((sessionId) => [
        sessionId,
        fixture.snapshot.transcripts.get(sessionId) ?? { _tag: "Missing" as const },
      ]),
    )),
    prepareNewSession: Effect.succeed(prepared("temporary", "New", true)),
    prepareResume(resumed) {
      fixture.prepareResumeReceiver = this
      return Effect.succeed(prepared(resumed.id, resumed.title))
    },
    branchFrom: () => Effect.succeed(fixture.branchOutcome),
  }
  const terminals: TerminalSupervisorApi = {
    show: (terminal) => Effect.sync(() => {
      calls.push(`show:${terminal.session.id}`)
      const existing = owned.get(terminal.session.id)
      if (existing) {
        activeSessionId = terminal.session.id
        return existing
      }
      const ownerId = `owner-${nextOwner++}`
      owned.set(terminal.session.id, ownerId)
      activeSessionId = terminal.session.id
      return ownerId
    }),
    hideActive: Effect.sync(() => {
      const hidden = activeSessionId
      activeSessionId = null
      return hidden
    }),
    stopSession: (sessionId) => Effect.sync(() => {
      calls.push(`stop:${sessionId}`)
      if (activeSessionId === sessionId) activeSessionId = null
      return owned.delete(sessionId)
    }),
    shutdown: () => Effect.sync(() => {
      fixture.shutdowns += 1
      owned.clear()
      activeSessionId = null
    }),
    activeSessionId: Effect.sync(() => activeSessionId),
    ownsInput: Effect.sync(() => activeSessionId !== null),
    runningSessionIds: Effect.sync(() => new Set(owned.keys())),
    ownedSessionIds: Effect.sync(() => new Set(owned.keys())),
    nonIdleSessionIds: Effect.succeed(new Set()),
    activitySessionIds: () => Effect.succeed(new Set()),
    draftPreviews: Effect.succeed(new Map()),
    ownershipSnapshot: Effect.succeed([]),
    reconcileActivity: Effect.succeed([]),
  }
  fixture.options = { provider, metadata, terminals }
  return fixture
}

function metadataFacet(
  load: () => ProjectState,
  update: ApplicationMetadataFacet["updateMetadata"],
): ApplicationMetadataFacet {
  return {
    instanceId: "instance",
    loadMetadata: Effect.sync(load),
    updateMetadata: update,
    commitRemoval: (removal) => Effect.succeed(removal),
    pendingAdoptions: Effect.succeed([]),
    orphanedAdoptions: Effect.succeed([]),
    reconcileOrphanedAdoption: () => Effect.void,
    ack: () => Effect.void,
  }
}

function prepared(id: string, title: string, transient = false): PreparedTerminal {
  const value = session(id, title, transient)
  return {
    session: value,
    acquireLaunch: Effect.succeed({
      launch: {
        sessionId: id,
        command: ["agent"],
        cwd: "/project",
        observer: new NullTerminalObserver(),
      },
      close: Effect.void,
    }),
  }
}

function activity(
  ownerId: string,
  sequenceId: number,
  sessionId: string,
  value: "working" | "blocked" | "idle",
  wasActive = false,
) {
  return { ownerId, sequenceId, sessionId, activity: value, wasActive } as const
}

function observation(sequenceId: number, value: TerminalObservation) {
  return { ownerId: "owner-1", sequenceId, sessionId: ROOT, wasActive: true, observation: value }
}

function snapshot(
  sessions: readonly AgentSession[],
  transcripts: ReadonlyMap<string, readonly AgentMessage[]>,
): AgentSessionSnapshot {
  return {
    sessions,
    transcripts: new Map([...transcripts].map(([sessionId, messages]) => [
      sessionId,
      { _tag: "Available" as const, messages },
    ])),
  }
}

function session(id: string, title: string, transient = false): AgentSession {
  return { id, title, lastModified: 1, ...(transient ? { transient: true } : {}) }
}

function message(
  id: string,
  role: AgentMessage["role"],
  preview: string,
  ordinal: number,
): AgentMessage {
  return { id, role, preview, ordinal, visible: true }
}

function persistenceFailure(message: string): PersistenceError {
  return new PersistenceError({ operation: "test", path: "/state", message })
}

function relation(childSessionId: string, parentSessionId: string): BranchRelation {
  return {
    childSessionId,
    parentSessionId,
    sourceMessageId: "q",
    sharedMessages: [],
    createdAt: "2026-09-01T00:00:00.000Z",
  }
}

function pendingAdoption(
  adoptionToken: string,
  previousSessionId: string,
  sessionId: string,
  adoptionRelation?: BranchRelation,
): PendingIdentityAdoption {
  return {
    adoptionToken,
    kind: "native-fork",
    instanceId: "instance",
    ownerToken: `owner:${adoptionToken}`,
    ownerPid: 1,
    processGroupId: 1,
    previousSessionId,
    sessionId,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...(adoptionRelation === undefined ? {} : { relation: adoptionRelation }),
  }
}

function sdkWorkflowEntry(
  sessionId: string,
  uuid: string,
  parentUuid: string | null,
  type: "user" | "assistant",
  text: string,
  stopReason: string | null = "end_turn",
): SessionStoreEntry {
  return {
    type, uuid, parentUuid, sessionId, cwd: process.cwd(), timestamp: "2026-09-05T12:00:00.000Z",
    message: type === "user" ? { role: "user", content: text } : {
      id: `msg_${uuid}`, type: "message", role: "assistant", model: "test",
      content: [{ type: "text", text }], stop_reason: stopReason, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}

function waitForState(
  runtime: AppRuntime,
  predicate: (state: ApplicationState) => boolean,
): Effect.Effect<ApplicationState> {
  return Effect.gen(function*() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = yield* runtime.getState
      if (predicate(state)) return state
      yield* Effect.yieldNow
    }
    return yield* Effect.die("Timed out waiting for application state")
  })
}
