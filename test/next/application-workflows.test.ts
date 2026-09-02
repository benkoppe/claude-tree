import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Scope } from "effect"

import {
  available,
  makeAppRuntime,
  makeNavigationPersistence,
  selectProjectedTranscript,
  type AppRuntime,
} from "../../src/application"
import {
  PersistenceError,
  ProviderError,
  SessionOwnedError,
  TerminalError,
} from "../../src/domain/errors"
import {
  NullTerminalObserver,
  type AgentMessage,
  type AgentSession,
  type AgentSessionSnapshot,
} from "../../src/domain/model"
import type { BranchRelation, ProjectState } from "../../src/domain/persistence"
import type { MetadataRepositoryApi } from "../../src/services/metadata-repository"
import type {
  AgentProviderApi,
  BranchOutcome,
  PreparedTerminal,
} from "../../src/services/provider"
import type { TerminalSupervisorApi } from "../../src/services/terminal-supervisor"
import { TerminalCleanupError } from "../../src/services/terminal-supervisor"
import { TestClock } from "effect/testing"

const ROOT = "root"
const CHILD = "child"
const NOW = "2026-09-01T00:00:00.000Z"

describe("application workflows", () => {
  test("restores a persisted terminal semantically and resumes it", async () => {
    const fixture = makeFixture({
      projectState: {
        relations: [],
        removals: [],
        navigation: { view: "terminal", sessionId: ROOT },
      },
    })

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      return yield* runtime.getState
    })))

    expect(fixture.calls).toContain("prepare-resume:root")
    expect(fixture.calls).toContain("show:root")
    expect(state.surface._tag).toBe("Terminal")
    expect(state.surface._tag === "Terminal" ? state.surface.sessionId : undefined).toBe(ROOT)
  })

  test("falls back quietly when another process owns the persisted terminal", async () => {
    const fixture = makeFixture({
      projectState: {
        relations: [],
        removals: [],
        navigation: { view: "terminal", sessionId: ROOT },
      },
    })
    fixture.showFailure = new SessionOwnedError({
      providerId: "test",
      sessionId: ROOT,
      ownerPid: 1234,
    })

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      return yield* runtime.getState
    })))

    expect(fixture.calls).toContain("show:root")
    expect(state.surface).toMatchObject({
      _tag: "Graph",
      familySessionId: ROOT,
      target: { kind: "endpoint", sessionId: ROOT },
    })
    expect(state.terminals.has(ROOT)).toBeFalse()
    expect(state.modal).toBeNull()
  })

  test("projects a new session before showing its lazy terminal", async () => {
    const fixture = makeFixture()
    let runtime!: AppRuntime
    fixture.onShow = (prepared) => Effect.gen(function*() {
      const state = yield* runtime.getState
      expect(state.local.sessions.has(prepared.session.id)).toBeTrue()
      expect(state.surface).toMatchObject({
        _tag: "Terminal",
        sessionId: prepared.session.id,
        returnTo: { _tag: "Graph", target: { kind: "endpoint", sessionId: prepared.session.id } },
      })
    })

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      runtime = yield* makeAppRuntime(fixture.options)
      const opened = yield* runtime.newSession
      return { opened, state: yield* runtime.getState }
    })))

    expect(result.opened).toBeTrue()
    expect(result.state.surface._tag).toBe("Terminal")
    expect(result.state.local.temporarySessionIds.has("temporary")).toBeTrue()
    expect(runtime.preparedTerminals.has("temporary")).toBeTrue()
  })

  test("reopens a hidden live transient terminal through its existing owner", async () => {
    const fixture = makeFixture()

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      expect(yield* runtime.newSession).toBeTrue()
      expect(yield* runtime.returnFromTerminal).toBeTrue()
      const reopened = yield* runtime.openEndpoint("temporary")
      return { reopened, state: yield* runtime.getState }
    })))

    expect(result.reopened).toBeTrue()
    expect(result.state.surface).toMatchObject({ _tag: "Terminal", sessionId: "temporary" })
    expect(fixture.calls.filter((call) => call === "show:temporary")).toHaveLength(2)
    expect(fixture.calls).not.toContain("prepare-resume:temporary")
  })

  test("rolls back a failed new-session show and restores roots selection", async () => {
    const fixture = makeFixture()
    fixture.failShow = true

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.selectRoot(ROOT)
      const opened = yield* runtime.newSession
      return { runtime, opened, state: yield* runtime.getState }
    })))

    expect(result.opened).toBeFalse()
    expect(result.state.surface).toEqual({ _tag: "Roots", selectedSessionId: ROOT })
    expect(result.state.local.sessions.has("temporary")).toBeFalse()
    expect(result.state.local.temporarySessionIds.has("temporary")).toBeFalse()
    expect(result.runtime.preparedTerminals.has("temporary")).toBeFalse()
  })

  test("rolls back a failed fresh branch show, ancestry, and graph selection", async () => {
    const fixture = makeFixture()
    fixture.failShow = true
    fixture.branchOutcome = {
      _tag: "ValidatedBranch",
      session: session("temporary-child", "Fresh branch", true),
      derivation: {
        childSessionId: "temporary-child",
        parentSessionId: ROOT,
        sourceMessageId: "q",
        sharedMessages: [],
      },
      acquireLaunch: launch("temporary-child"),
    }
    const originalTarget = {
      kind: "message" as const,
      preferred: { sessionId: ROOT, messageId: "q" },
      aliases: [{ sessionId: ROOT, messageId: "q" }],
    }

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.selectGraph(ROOT, originalTarget)
      const opened = yield* runtime.branchFrom({ sessionId: ROOT, messageId: "q" })
      return { runtime, opened, state: yield* runtime.getState }
    })))

    expect(result.opened).toBeFalse()
    expect(result.state.surface).toEqual({
      _tag: "Graph",
      familySessionId: ROOT,
      target: originalTarget,
    })
    expect(result.state.local.sessions.has("temporary-child")).toBeFalse()
    expect(result.state.relations).toEqual([])
    expect(result.runtime.preparedTerminals.has("temporary-child")).toBeFalse()
    expect(fixture.calls).toContain("save-relation:temporary-child")
    expect(fixture.calls).toContain("remove-relation:temporary-child")
  })

  test("persists validated ancestry before projecting and opening a child", async () => {
    const fixture = makeFixture()
    fixture.branchOutcome = {
      _tag: "ValidatedBranch",
      session: session(CHILD, "Child"),
      derivation: {
        childSessionId: CHILD,
        parentSessionId: ROOT,
        sourceMessageId: "q",
        sharedMessages: [{ parentMessageId: "q", childMessageId: "cq" }],
      },
      acquireLaunch: launch(CHILD),
    }

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      const opened = yield* runtime.branchFrom({ sessionId: ROOT, messageId: "q" })
      return { opened, state: yield* runtime.getState }
    })))

    expect(result.opened).toBeTrue()
    expect(fixture.calls.indexOf("save-relation:child")).toBeLessThan(
      fixture.calls.indexOf("show:child"),
    )
    expect(result.state.relations[0]).toMatchObject({
      childSessionId: CHILD,
      parentSessionId: ROOT,
    })
    expect(result.state.surface._tag).toBe("Terminal")
  })

  test("keeps a provider-created unlaunchable child as an independent exact root", async () => {
    const fixture = makeFixture()
    const exactRead = { _tag: "Unavailable", reason: "validation timed out" } as const
    fixture.branchOutcome = {
      _tag: "CreatedIndependentSession",
      session: session(CHILD, "Created child"),
      transcript: exactRead,
      reason: "Child was created but ancestry could not be validated",
    }

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      const opened = yield* runtime.branchFrom({ sessionId: ROOT, messageId: "q" })
      return { opened, state: yield* runtime.getState }
    })))

    expect(result.opened).toBeFalse()
    expect(result.state.local.transcripts.get(CHILD)).toBe(exactRead)
    expect(result.state.relations).toEqual([])
    expect(result.state.modal).toEqual({
      _tag: "Error",
      message: "Child was created but ancestry could not be validated",
    })
    expect(fixture.calls).not.toContain("show:child")
  })

  test("rolls terminal identity back when metadata adoption fails", async () => {
    const fixture = makeFixture()
    fixture.failIdentityReplacement = true

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      expect(yield* runtime.newSession).toBeTrue()
      fixture.owned.delete("temporary")
      fixture.owned.add("real")
      const adopted = yield* runtime.handleTerminalSessionChanged({
        previousSessionId: "temporary",
        session: session("real", "Real"),
        wasActive: true,
      })
      return { adopted, state: yield* runtime.getState }
    })))

    expect(result.adopted).toBeFalse()
    expect(fixture.calls).toContain("replace-metadata:temporary:real")
    expect(fixture.calls).toContain("replace-terminal:real:temporary")
    expect(fixture.owned).toEqual(new Set(["temporary"]))
    expect(result.state.local.sessions.has("temporary")).toBeTrue()
    expect(result.state.local.sessions.has("real")).toBeFalse()
    expect(result.state.modal?._tag).toBe("Error")
  })

  test("adopts a temporary identity when ancestry derivation fails", async () => {
    const fixture = makeFixture()

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      expect(yield* runtime.newSession).toBeTrue()
      fixture.owned.delete("temporary")
      fixture.owned.add("real")
      const adopted = yield* runtime.handleTerminalSessionChanged({
        previousSessionId: "temporary",
        session: session("real", "Real"),
        wasActive: true,
        derivation: Effect.fail(new ProviderError({
          providerId: "test",
          operation: "derive ancestry",
          message: "ancestry unavailable",
        })),
      })
      return { adopted, state: yield* runtime.getState }
    })))

    expect(result.adopted).toBeTrue()
    expect(result.state.terminals.has("temporary")).toBeFalse()
    expect(result.state.terminals.has("real")).toBeTrue()
    expect(result.state.local.sessions.has("real")).toBeTrue()
    expect(result.state.relations).toEqual([])
    expect(fixture.calls.some((call) => call.startsWith("save-relation:"))).toBeFalse()
    expect(result.state.modal).toMatchObject({ _tag: "Error" })
  })

  test("adopts a temporary identity but rejects mismatched ancestry", async () => {
    const fixture = makeFixture()

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      expect(yield* runtime.newSession).toBeTrue()
      fixture.owned.delete("temporary")
      fixture.owned.add("real")
      const adopted = yield* runtime.handleTerminalSessionChanged({
        previousSessionId: "temporary",
        session: session("real", "Real"),
        wasActive: true,
        derivation: Effect.succeed({
          childSessionId: "different-child",
          parentSessionId: ROOT,
          sourceMessageId: "q",
          sharedMessages: [],
        }),
      })
      return { adopted, state: yield* runtime.getState }
    })))

    expect(result.adopted).toBeTrue()
    expect(result.state.surface).toMatchObject({ _tag: "Terminal", sessionId: "real" })
    expect(result.state.terminals.has("temporary")).toBeFalse()
    expect(result.state.terminals.has("real")).toBeTrue()
    expect(result.state.relations).toEqual([])
    expect(fixture.calls).not.toContain("save-relation:different-child")
    expect(result.state.modal).toEqual({
      _tag: "Error",
      message: "Derive switched session: Provider returned ancestry for a different child session",
    })
  })

  test("persists native fork derivation before acknowledging the terminal transition", async () => {
    const fixture = makeFixture()

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      expect(yield* runtime.resumeSession(ROOT)).toBeTrue()
      fixture.owned.delete(ROOT)
      fixture.owned.add(CHILD)
      expect(yield* runtime.handleTerminalSessionChanged({
        previousSessionId: ROOT,
        session: session(CHILD, "Native fork"),
        wasActive: true,
        derivation: Effect.succeed({
          childSessionId: CHILD,
          parentSessionId: ROOT,
          sourceMessageId: "q",
          sharedMessages: [],
        }),
      })).toBeTrue()
      return yield* runtime.getState
    })))

    expect(fixture.calls).toContain("save-relation:child")
    expect(state.provider.sessions.has(ROOT)).toBeTrue()
    expect(state.local.sessions.has(CHILD)).toBeTrue()
    expect(state.terminals.has(ROOT)).toBeFalse()
    expect(state.terminals.has(CHILD)).toBeTrue()
    expect(state.relations[0]).toMatchObject({ childSessionId: CHILD, parentSessionId: ROOT })
  })

  test("preserves a physical child independently when relation persistence fails", async () => {
    const fixture = makeFixture()
    fixture.failRelation = true
    fixture.branchOutcome = {
      _tag: "ValidatedBranch",
      session: session(CHILD, "Physical child"),
      derivation: {
        childSessionId: CHILD,
        parentSessionId: ROOT,
        sourceMessageId: "q",
        sharedMessages: [],
      },
      acquireLaunch: launch(CHILD),
    }

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      expect(yield* runtime.branchFrom({ sessionId: ROOT, messageId: "q" })).toBeFalse()
      return yield* runtime.getState
    })))

    expect(state.local.sessions.has(CHILD)).toBeTrue()
    expect(state.local.transcripts.get(CHILD)).toEqual(available([]))
    expect(state.relations).toEqual([])
    expect(state.modal?._tag).toBe("Error")
    expect(fixture.calls).not.toContain("show:child")
  })

  test("refreshes the stopped session after intentional process cleanup", async () => {
    const fixture = makeFixture()

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      expect(yield* runtime.resumeSession(ROOT)).toBeTrue()
      yield* runtime.dispatch({
        _tag: "TerminalDraftObserved",
        sessionId: ROOT,
        draft: { text: "partial", exact: false },
      })
      fixture.snapshot = {
        sessions: [session(ROOT, "Stopped root")],
        transcripts: new Map([[ROOT, available([
          message("q", "user", "Question", 0),
          message("partial", "agent", "Persisted partial", 1),
        ])]]),
      }
      expect(yield* runtime.stopSession(ROOT)).toBeTrue()
      yield* Effect.sleep(20)
      return yield* runtime.getState
    })))

    expect(state.drafts.has(ROOT)).toBeFalse()
    expect(state.provider.transcripts.get(ROOT)).toEqual(fixture.snapshot.transcripts.get(ROOT))
    expect(fixture.calls.indexOf("stop:root")).toBeLessThan(
      fixture.calls.indexOf("read-transcripts:root"),
    )
  })

  test("reconciles a local transcript after an incremental provider read", async () => {
    const fixture = makeFixture()

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.dispatch({
        _tag: "LocalSessionProjected",
        session: session(CHILD, "Local child", true),
        transcript: available([]),
      })
      fixture.snapshot = {
        sessions: [session(ROOT, "Root"), session(CHILD, "Persisted child")],
        transcripts: new Map([
          [ROOT, available([message("q", "user", "Question", 0)])],
          [CHILD, { _tag: "Unavailable", reason: "provider still writing" }],
        ]),
      }
      expect(yield* runtime.refresh("manual")).toBeTrue()

      fixture.snapshot = {
        ...fixture.snapshot,
        transcripts: new Map([
          [ROOT, available([message("q", "user", "Question", 0)])],
          [CHILD, available([
            message("child-q", "user", "Child question", 0),
            message("child-a", "agent", "Child answer", 1),
          ])],
        ]),
      }
      yield* runtime.dispatch({
        _tag: "RefreshRequested",
        reason: "terminal-return",
        focusSessionId: CHILD,
        sessionIds: new Set([CHILD]),
      })
      yield* Effect.sleep(20)
      return yield* runtime.getState
    })))

    expect(fixture.calls.filter((call) => call === "load-snapshot")).toHaveLength(2)
    expect(fixture.calls).toContain("read-transcripts:child")
    expect(state.local.sessions.has(CHILD)).toBeFalse()
    expect(state.local.transcripts.has(CHILD)).toBeFalse()
    expect(state.provider.transcripts.get(CHILD)).toEqual(fixture.snapshot.transcripts.get(CHILD))
  })

  test("shows incremental messages before local session metadata is discovered", async () => {
    const fixture = makeFixture()

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      yield* runtime.dispatch({
        _tag: "LocalSessionProjected",
        session: session(CHILD, "Local child", true),
        transcript: available([]),
      })
      fixture.snapshot = {
        sessions: [session(ROOT, "Root")],
        transcripts: new Map([
          [ROOT, available([message("q", "user", "Question", 0)])],
          [CHILD, available([
            message("child-q", "user", "Child question", 0),
            message("child-a", "agent", "Child answer", 1),
          ])],
        ]),
      }
      yield* runtime.dispatch({
        _tag: "RefreshRequested",
        reason: "terminal-return",
        focusSessionId: CHILD,
        sessionIds: new Set([CHILD]),
      })
      yield* Effect.sleep(20)
      return yield* runtime.getState
    })))

    expect(fixture.calls.filter((call) => call === "load-snapshot")).toHaveLength(1)
    expect(fixture.calls).toContain("read-transcripts:child")
    expect(state.local.sessions.has(CHILD)).toBeTrue()
    expect(state.local.transcripts.has(CHILD)).toBeFalse()
    expect(selectProjectedTranscript(state, CHILD).map((entry) => entry.id)).toEqual([
      "child-q",
      "child-a",
    ])
  })

  test("keeps natural-exit cleanup failure owned by the application", async () => {
    const fixture = makeFixture()

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      expect(yield* runtime.resumeSession(ROOT)).toBeTrue()
      yield* runtime.handleTerminalExit({
        sessionId: ROOT,
        exitCode: 0,
        wasActive: true,
        cleanupError: new TerminalCleanupError({
          operation: "natural-exit",
          issues: [{
            ownerId: "owner",
            sessionId: ROOT,
            stage: "verify",
            message: "cleanup could not be verified",
          }],
        }),
      })
      return yield* runtime.getState
    })))

    expect(state.terminals.get(ROOT)?.phase).toBe("cleanup-incomplete")
    expect(state.surface._tag).toBe("Graph")
  })

  test("adopts an identity that exits immediately without temporary state", async () => {
    const fixture = makeFixture()
    fixture.snapshot = {
      sessions: [session(ROOT, "Root"), session("real", "Real")],
      transcripts: new Map([
        [ROOT, available([message("q", "user", "Question", 0)])],
        ["real", available([])],
      ]),
    }

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      expect(yield* runtime.newSession).toBeTrue()
      fixture.owned.delete("temporary")
      fixture.completedTransitions.set("temporary", "real")
      runtime.terminalEvents.onSessionChanged?.({
        previousSessionId: "temporary",
        session: session("real", "Real"),
        wasActive: true,
      })
      runtime.terminalEvents.onProcessExited?.({
        sessionId: "real",
        exitCode: 0,
        wasActive: true,
      })
      yield* Effect.sleep(30)
      return { runtime, state: yield* runtime.getState }
    })))

    expect(result.state.local.sessions.has("temporary")).toBeFalse()
    expect(result.state.local.temporarySessionIds.has("temporary")).toBeFalse()
    expect(result.state.terminals.has("temporary")).toBeFalse()
    expect(result.state.terminals.has("real")).toBeFalse()
    expect(result.runtime.preparedTerminals.has("temporary")).toBeFalse()
    expect(result.runtime.preparedTerminals.has("real")).toBeFalse()
  })

  test("coalesces navigation writes without reordering an in-flight write", async () => {
    const writes: string[] = []
    const firstWrite = Deferred.makeUnsafe<void>()
    let calls = 0
    const metadata = makeMetadata({ relations: [], removals: [] }, [], {
      saveNavigationState: (navigation) => Effect.gen(function*() {
        writes.push(JSON.stringify(navigation))
        calls += 1
        if (calls === 1) yield* Deferred.await(firstWrite)
      }),
    })

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const persistence = yield* makeNavigationPersistence(metadata)
      const first = yield* Effect.forkScoped(persistence.save({
        view: "roots",
        selectedSessionId: "first",
      }))
      yield* Effect.yieldNow
      const second = yield* Effect.forkScoped(persistence.save({
        view: "roots",
        selectedSessionId: "second",
      }))
      const third = yield* Effect.forkScoped(persistence.save({
        view: "roots",
        selectedSessionId: "third",
      }))
      yield* Effect.yieldNow
      yield* Deferred.succeed(firstWrite, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      yield* Fiber.join(third)
      yield* persistence.flush
    })))

    expect(writes).toEqual([
      JSON.stringify({ view: "roots", selectedSessionId: "first" }),
      JSON.stringify({ view: "roots", selectedSessionId: "third" }),
    ])
  })

  test("does not complete shutdown until terminal cleanup finishes", async () => {
    const fixture = makeFixture()
    const cleanup = Deferred.makeUnsafe<void>()
    fixture.shutdown = Deferred.await(cleanup)
    let completed = false

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime(fixture.options)
      const shutdown = yield* Effect.forkScoped(runtime.shutdown.pipe(
        Effect.tap(() => Effect.sync(() => { completed = true })),
      ))
      yield* Effect.yieldNow
      expect(completed).toBeFalse()
      yield* Deferred.succeed(cleanup, undefined)
      expect(yield* Fiber.join(shutdown)).toBeTrue()
    })))

    expect(completed).toBeTrue()
  })

  test("uses the Effect clock for completion refresh schedules", async () => {
    const fixture = makeFixture()

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({
        ...fixture.options,
        completionDelaysMs: [100],
      })
      expect(yield* runtime.resumeSession(ROOT)).toBeTrue()
      fixture.snapshot = {
        sessions: [session(ROOT, "Updated root"), session("unrelated", "Unrelated")],
        transcripts: new Map([
          [ROOT, available([
            message("q", "user", "Question", 0),
            { ...message("a", "agent", "Answer", 1), turnComplete: true },
          ])],
          ["unrelated", available([message("other", "user", "Other", 0)])],
        ]),
      }
      yield* runtime.handleTerminalActivity({
        sessionId: ROOT,
        activity: "working",
        wasActive: false,
      })
      yield* runtime.handleTerminalActivity({
        sessionId: ROOT,
        activity: "idle",
        wasActive: false,
      })
      expect((yield* runtime.getState).pendingCompletions.has(ROOT)).toBeTrue()
      yield* TestClock.adjust(100)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      return yield* runtime.getState
    }).pipe(Effect.provide(TestClock.layer()))))

    expect(state.pendingCompletions.has(ROOT)).toBeFalse()
    expect(state.unviewedSessionIds.has(ROOT)).toBeTrue()
    expect(fixture.calls.filter((call) => call === "load-snapshot")).toHaveLength(1)
    expect(fixture.calls).toContain("read-transcripts:root")
    expect(fixture.calls.some((call) => call.includes("unrelated"))).toBeFalse()
  })

  test("processes queued completion activity before returning to the tree", async () => {
    const fixture = makeFixture()

    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* makeAppRuntime({
        ...fixture.options,
        completionDelaysMs: [100],
      })
      expect(yield* runtime.resumeSession(ROOT)).toBeTrue()
      fixture.snapshot = {
        sessions: [session(ROOT, "Updated root")],
        transcripts: new Map([[ROOT, available([
          message("q", "user", "Question", 0),
          { ...message("a", "agent", "Answer", 1), turnComplete: true },
        ])]]),
      }
      runtime.terminalEvents.onActivityChanged?.({
        sessionId: ROOT,
        activity: "working",
        wasActive: true,
      })
      runtime.terminalEvents.onActivityChanged?.({
        sessionId: ROOT,
        activity: "idle",
        wasActive: true,
      })
      expect(yield* runtime.returnFromTerminal).toBeTrue()
      expect((yield* runtime.getState).nextCompletionVersion).toBe(1)
      for (let attempt = 0; attempt < 8; attempt += 1) yield* Effect.yieldNow
      yield* TestClock.adjust(1_000)
      for (let attempt = 0; attempt < 8; attempt += 1) yield* Effect.yieldNow
      return yield* runtime.getState
    }).pipe(Effect.provide(TestClock.layer()))))

    expect(state.pendingCompletions.has(ROOT)).toBeFalse()
    expect(state.modal).toBeNull()
    expect(state.provider.transcripts.get(ROOT)).toEqual(fixture.snapshot.transcripts.get(ROOT))
  })
})

interface Fixture {
  options: Parameters<typeof makeAppRuntime>[0]
  readonly calls: string[]
  readonly owned: Set<string>
  readonly completedTransitions: Map<string, string>
  branchOutcome: BranchOutcome
  failShow: boolean
  showFailure?: SessionOwnedError
  failIdentityReplacement: boolean
  failRelation: boolean
  snapshot: AgentSessionSnapshot
  shutdown: Effect.Effect<void, never>
  onShow?: (prepared: PreparedTerminal) => Effect.Effect<void>
}

function makeFixture(input: { readonly projectState?: ProjectState } = {}): Fixture {
  const calls: string[] = []
  const owned = new Set<string>()
  const completedTransitions = new Map<string, string>()
  let activeSessionId: string | null = null
  const fixture = {
    options: undefined as never,
    calls,
    owned,
    completedTransitions,
    branchOutcome: {
      _tag: "CreatedIndependentSession",
      session: session(CHILD, "Child"),
      transcript: available([]),
      reason: "not configured",
    } as BranchOutcome,
    failIdentityReplacement: false,
    failRelation: false,
    failShow: false,
    snapshot: {
      sessions: [session(ROOT, "Root")],
      transcripts: new Map([[ROOT, available([message("q", "user", "Question", 0)])]]),
    },
    shutdown: Effect.void,
  } as Fixture
  const projectState = input.projectState ?? { relations: [], removals: [] }
  const metadata = makeMetadata(projectState, calls, {
    saveRelation: (relation) => {
      calls.push(`save-relation:${relation.childSessionId}`)
      return fixture.failRelation
        ? Effect.fail(new PersistenceError({
            operation: "save relation",
            path: "/state",
            message: "relation write failed",
          }))
        : Effect.succeed(relation)
    },
    replaceSessionId: (previousSessionId, sessionId) => {
      calls.push(`replace-metadata:${previousSessionId}:${sessionId}`)
      return fixture.failIdentityReplacement
        ? Effect.fail(new PersistenceError({
            operation: "replace session ID",
            path: "/state",
            message: "metadata write failed",
          }))
        : Effect.succeed(projectState)
    },
    removeRelation: (relation) => Effect.sync(() => {
      calls.push(`remove-relation:${relation.childSessionId}`)
    }),
  })
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
    loadSessionSnapshot: Effect.sync(() => {
      calls.push("load-snapshot")
      return fixture.snapshot
    }),
    readTranscripts: (sessionIds) => Effect.sync(() => {
      calls.push(`read-transcripts:${sessionIds.join(",")}`)
      return new Map(sessionIds.map((sessionId) => [
        sessionId,
        fixture.snapshot.transcripts.get(sessionId) ?? available([]),
      ]))
    }),
    prepareNewSession: Effect.succeed({
      session: session("temporary", "New", true),
      acquireLaunch: launch("temporary"),
    }),
    prepareResume: (resumed) => {
      calls.push(`prepare-resume:${resumed.id}`)
      return Effect.succeed({ session: resumed, acquireLaunch: launch(resumed.id) })
    },
    branchFrom: () => Effect.succeed(fixture.branchOutcome),
  }
  const terminals: TerminalSupervisorApi = {
    show: (prepared) => Effect.suspend(() => {
      calls.push(`show:${prepared.session.id}`)
      const showFailure: SessionOwnedError | TerminalError | undefined = fixture.showFailure ??
        (fixture.failShow
          ? new TerminalError({
          operation: "show",
          sessionId: prepared.session.id,
          message: "show failed",
          })
          : undefined)
      if (showFailure) return Effect.fail(showFailure)
      return Effect.gen(function*() {
        yield* fixture.onShow?.(prepared) ?? Effect.void
        owned.add(prepared.session.id)
        activeSessionId = prepared.session.id
      })
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
    shutdown: () => fixture.shutdown,
    replaceSessionId: (previousSessionId, sessionId) => Effect.sync(() => {
      calls.push(`replace-terminal:${previousSessionId}:${sessionId}`)
      if (!owned.delete(previousSessionId)) {
        return completedTransitions.get(previousSessionId) === sessionId
      }
      owned.add(sessionId)
      completedTransitions.set(previousSessionId, sessionId)
      if (activeSessionId === previousSessionId) activeSessionId = sessionId
      return true
    }),
    activeSessionId: Effect.sync(() => activeSessionId),
    ownsInput: Effect.sync(() => activeSessionId !== null),
    runningSessionIds: Effect.sync(() => new Set(owned)),
    ownedSessionIds: Effect.sync(() => new Set(owned)),
    nonIdleSessionIds: Effect.succeed(new Set()),
    activitySessionIds: () => Effect.succeed(new Set()),
    draftPreviews: Effect.succeed(new Map()),
    ownershipSnapshot: Effect.succeed([]),
  }
  fixture.options = { provider, metadata, terminals, projectState }
  return fixture
}

function makeMetadata(
  state: ProjectState,
  calls: string[],
  overrides: Partial<MetadataRepositoryApi> = {},
): MetadataRepositoryApi {
  return {
    projectPath: "/project",
    statePath: "/state",
    load: Effect.succeed(state),
    update: (transform) => Effect.sync(() => transform(state)),
    saveRelation: (relation) => Effect.sync(() => {
      calls.push(`save-relation:${relation.childSessionId}`)
      return relation
    }),
    removeRelation: () => Effect.void,
    saveRemoval: (removal) => Effect.succeed(removal),
    replaceSessionId: () => Effect.succeed(state),
    saveNavigationState: () => Effect.void,
    ...overrides,
  }
}

function launch(sessionId: string): PreparedTerminal["acquireLaunch"] {
  return Effect.succeed({
    sessionId,
    command: ["agent"] as const,
    cwd: "/project",
    observer: new NullTerminalObserver(),
  })
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
