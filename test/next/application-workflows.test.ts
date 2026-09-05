import { describe, expect, test } from "bun:test"
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"

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
