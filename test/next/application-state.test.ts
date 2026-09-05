import { describe, expect, test } from "bun:test"

import {
  available,
  makeInitialApplicationState,
  projectApplicationViewModel,
  reduceApplicationState,
  selectProjectedTranscript,
  selectConversationForest,
  selectSessionStatus,
  selectAggregateStatus,
  projectRootsViewModel,
  projectGraphViewModel,
  type ActiveRefresh,
  type ApplicationState,
} from "../../src/application"
import type {
  AgentMessage,
  AgentSession,
  AgentSessionSnapshot,
  TranscriptRead,
} from "../../src/domain/model"

const ROOT = "root"

describe("application state reducer", () => {
  test("standardizes live state and priority across sessions, roots, and trees", () => {
    for (const activity of ["idle", "working", "blocked"] as const) {
      const state: ApplicationState = {
        ...loadedState(), terminals: new Map([[ROOT, { ownerId: "owner", phase: "running", activity }]]),
        unviewedSessionIds: new Set([ROOT]),
      }
      const expected = activity === "idle" ? "unviewed" : activity
      expect(selectSessionStatus(state, ROOT)).toBe(expected)
      expect(projectRootsViewModel(state)[0]?.status).toBe(expected)
      expect(projectGraphViewModel(state, ROOT).status).toBe(expected)
      expect(selectSessionStatus({ ...state, terminals: new Map() }, ROOT)).toBe("idle")
      expect(selectSessionStatus({ ...state, unviewedSessionIds: new Set() }, ROOT)).toBe(activity === "idle" ? "live" : activity)
    }
    const state: ApplicationState = { ...loadedState(), terminals: new Map([
      ["live", { ownerId: "1", phase: "running", activity: "idle" }],
      ["update", { ownerId: "2", phase: "running", activity: "idle" }],
      ["work", { ownerId: "3", phase: "running", activity: "working" }],
      ["need", { ownerId: "4", phase: "running", activity: "blocked" }],
    ]), unviewedSessionIds: new Set(["update"]) }
    expect(selectAggregateStatus(state, ["live", "update", "work", "need"])).toBe("blocked")
    expect(selectAggregateStatus(state, ["update", "work", "live"])).toBe("working")
    expect(selectAggregateStatus(state, ["live", "update"])).toBe("unviewed")
    expect(selectAggregateStatus(state, ["live", "stopped"])).toBe("live")
  })
  test("reuses the forest for UI-only changes but invalidates every graph input", () => {
    const state = loadedState()
    const forest = selectConversationForest(state)
    const refreshing = reduceApplicationState(state, { _tag: "RefreshStarted", refresh: activeRefresh("refresh:full", 1, "manual", "full") })
    expect(selectConversationForest(refreshing)).toBe(forest)
    expect(selectConversationForest({ ...refreshing, modal: { _tag: "About" } })).toBe(forest)
    for (const changed of [
      { ...state, provider: { ...state.provider } },
      { ...state, local: { ...state.local } },
      { ...state, terminals: new Map(state.terminals) },
      { ...state, rewindAnchors: new Map(state.rewindAnchors) },
      { ...state, relations: [...state.relations] },
      { ...state, removals: [...state.removals] },
    ]) {
      const before = selectConversationForest(state)
      expect(selectConversationForest(changed)).not.toBe(before)
    }
  })
  const original = [message("q", "user", "question", 0), message("a", "agent", "answer", 1), message("q2", "user", "later", 2)]
  function readReplacement(state: ApplicationState, messages: readonly AgentMessage[]): ApplicationState {
    const refresh = activeRefresh("refresh:full", state.refresh.generation + 1, "manual", "full")
    return reduceApplicationState(reduceApplicationState(state, { _tag: "RefreshStarted", refresh }), {
      _tag: "RefreshSucceeded", key: refresh.key, generation: refresh.generation,
      snapshot: snapshot(session(ROOT, "Root"), messages),
    })
  }

  test("confirms external rewinds including rewinds to an empty conversation", () => {
    for (const shortened of [original.slice(0, 2), []]) {
      const suspected = readReplacement(loadedState(original), shortened)
      expect(suspected.provider.transcripts.get(ROOT)).toEqual(available(original))
      expect(suspected.replacementCandidates.has(ROOT)).toBeTrue()
      const confirmed = readReplacement(suspected, shortened)
      expect(confirmed.provider.transcripts.get(ROOT)).toEqual(available(shortened))
      expect(confirmed.replacementCandidates.size).toBe(0)
    }
  })

  test("a transient shortened read does not truncate history", () => {
    const suspected = readReplacement(loadedState(original), original.slice(0, 1))
    const recovered = readReplacement(suspected, original)
    expect(recovered.provider.transcripts.get(ROOT)).toEqual(available(original))
    expect(recovered.replacementCandidates.size).toBe(0)
  })

  test("a failed confirmation read requires fresh evidence", () => {
    const shorter = original.slice(0, 1)
    let state = readReplacement(loadedState(original), shorter)
    const refresh = activeRefresh("refresh:full", state.refresh.generation + 1, "manual", "full")
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
    state = reduceApplicationState(state, { _tag: "RefreshFailed", key: refresh.key, generation: refresh.generation, message: "read failed" })
    expect(state.replacementCandidates.size).toBe(0)
    state = readReplacement(state, shorter)
    expect(state.provider.transcripts.get(ROOT)).toEqual(available(original))
  })

  test("a prefix-only rewind reconciles after completion retries without fabricating an update", () => {
    let state: ApplicationState = { ...loadedState(original), terminals: new Map([[ROOT, { ownerId: "owner", activity: "working", phase: "running" }]]) }
    state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner", activity: "idle", wasVisible: false })
    const shortened = original.slice(0, 2)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const refresh: ActiveRefresh = {
        ...activeRefresh("refresh:owner", state.refresh.generation + 1, "completion", "incremental"),
        sessionIds: new Set([ROOT]), completionVersion: state.pendingCompletions.get(ROOT)!.version,
      }
      state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
      state = reduceApplicationState(state, { _tag: "RefreshSucceeded", key: refresh.key, generation: refresh.generation, snapshot: snapshot(session(ROOT, "Root"), shortened) })
      expect(state.provider.transcripts.get(ROOT)).toEqual(available(original))
    }
    expect(state.pendingCompletions.size).toBe(0)
    expect(state.replacementCandidates.has(ROOT)).toBeTrue()
    state = readReplacement(state, shortened)
    expect(state.provider.transcripts.get(ROOT)).toEqual(available(shortened))
    expect(state.unviewedSessionIds.has(ROOT)).toBeFalse()
  })

  test("replacement confirmation is bounded when history keeps changing", () => {
    let state = loadedState(original)
    for (const length of [2, 1, 0]) state = readReplacement(state, original.slice(0, length))
    expect(state.provider.transcripts.get(ROOT)).toEqual(available(original))
    expect(state.replacementCandidates.size).toBe(0)
    expect(state.modal).toMatchObject({ _tag: "Error" })
  })

  test("working activity invalidates a suspected rewind", () => {
    let state: ApplicationState = {
      ...readReplacement(loadedState(original), original.slice(0, 1)),
      terminals: new Map([[ROOT, { ownerId: "owner", activity: "idle", phase: "running" }]]),
    }
    state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner", activity: "working", wasVisible: false })
    expect(state.replacementCandidates.size).toBe(0)
    state = readReplacement(state, original.slice(0, 1))
    expect(state.provider.transcripts.get(ROOT)).toEqual(available(original))
    expect(state.replacementCandidates.size).toBe(0)
  })

  test("confirms completed replacement turns when composer rewind detection was missed", () => {
    let state: ApplicationState = { ...loadedState(original), terminals: new Map([[ROOT, { ownerId: "owner", activity: "working", phase: "running" }]]) }
    state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner", activity: "idle", wasVisible: false })
    const replacement = [original[0]!, { ...message("new", "agent", "replacement answer", 1), turnComplete: true }]
    state = readReplacement(state, replacement)
    expect(state.pendingCompletions.has(ROOT)).toBeTrue()
    state = readReplacement(state, replacement)
    expect(state.provider.transcripts.get(ROOT)).toEqual(available(replacement))
    expect(state.pendingCompletions.size).toBe(0)
    expect(state.unviewedSessionIds.has(ROOT)).toBeTrue()
  })

  test("a late full snapshot cannot overwrite a newer incremental session read", () => {
    const full = activeRefresh("refresh:full", 1, "manual", "full")
    const incremental = activeRefresh("refresh:owner:one", 2, "terminal-return", "incremental")
    let state = reduceApplicationState(loadedState(), { _tag: "RefreshStarted", refresh: full })
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh: incremental })
    const latest = [message("q", "user", "question", 0), message("new", "agent", "new answer", 1)]
    state = reduceApplicationState(state, {
      _tag: "RefreshSucceeded", key: incremental.key, generation: 2,
      snapshot: snapshot(session(ROOT, "New title"), latest),
    })
    state = reduceApplicationState(state, {
      _tag: "RefreshSucceeded", key: full.key, generation: 1,
      snapshot: snapshot(session(ROOT, "Old title"), [message("q", "user", "question", 0), message("old", "agent", "old answer", 1)]),
    })
    expect(state.provider.sessions.get(ROOT)?.title).toBe("New title")
    expect(state.provider.transcripts.get(ROOT)).toEqual(available(latest))
    expect(state.refresh.active.size).toBe(0)
  })

  test("a late full snapshot preserves sessions discovered by a newer incremental read", () => {
    const full = activeRefresh("refresh:full", 1, "manual", "full")
    const incremental = activeRefresh("refresh:owner:one", 2, "terminal-return", "incremental")
    let state = reduceApplicationState(loadedState(), { _tag: "RefreshStarted", refresh: full })
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh: incremental })
    const newer = session("new-session", "New session")
    const messages = [message("new-question", "user", "hello", 0)]
    state = reduceApplicationState(state, {
      _tag: "RefreshSucceeded", key: incremental.key, generation: 2,
      snapshot: snapshot(newer, messages),
    })
    state = reduceApplicationState(state, {
      _tag: "RefreshSucceeded", key: full.key, generation: 1,
      snapshot: snapshot(session(ROOT, "Root"), []),
    })
    expect(state.provider.sessions.get(newer.id)).toEqual(newer)
    expect(state.provider.transcripts.get(newer.id)).toEqual(available(messages))
  })

  test("accepts only the matching keyed refresh generation", () => {
    const refresh = activeRefresh("refresh:full", 2, "manual", "full")
    let state = reduceApplicationState(loadedState(), { _tag: "RefreshStarted", refresh })
    const stale = reduceApplicationState(state, {
      _tag: "RefreshSucceeded",
      key: refresh.key,
      generation: 1,
      snapshot: snapshot(session("stale", "Stale"), []),
    })
    expect(stale).toBe(state)

    state = reduceApplicationState(state, {
      _tag: "RefreshSucceeded",
      key: refresh.key,
      generation: refresh.generation,
      snapshot: snapshot(session(ROOT, "Latest"), [message("q", "user", "question", 0)]),
    })
    expect(state.provider.sessions.get(ROOT)?.title).toBe("Latest")
    expect(state.refresh.active.size).toBe(0)
  })

  test("tracks completion independently by terminal owner", () => {
    let state: ApplicationState = {
      ...loadedState(),
      terminals: new Map([[ROOT, {
        ownerId: "owner-1",
        activity: "working",
        phase: "running",
      }]]),
    }
    state = reduceApplicationState(state, {
      _tag: "TerminalActivityObserved",
      sessionId: ROOT,
      ownerId: "owner-1",
      activity: "idle",
      wasVisible: false,
    })
    const completion = state.pendingCompletions.get(ROOT)
    expect(completion?.ownerId).toBe("owner-1")
    expect(selectSessionStatus(state, ROOT)).toBe("working")

    const refresh: ActiveRefresh = {
      ...activeRefresh("refresh:owner:owner-1", 1, "completion", "incremental"),
      sessionIds: new Set([ROOT]),
      completionVersion: completion!.version,
    }
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
    state = reduceApplicationState(state, {
      _tag: "RefreshSucceeded",
      key: refresh.key,
      generation: refresh.generation,
      snapshot: snapshot(session(ROOT, "Root"), [
        message("q", "user", "question", 0),
        { ...message("a", "agent", "answer", 1), turnComplete: true },
      ]),
    })
    expect(state.pendingCompletions.has(ROOT)).toBeFalse()
    expect(state.unviewedSessionIds.has(ROOT)).toBeTrue()
  })

  test("clears pending completion when a manual refresh confirms the completed transcript", () => {
    let state: ApplicationState = {
      ...loadedState(),
      terminals: new Map([[ROOT, {
        ownerId: "owner-1",
        activity: "working",
        phase: "running",
      }]]),
    }
    state = reduceApplicationState(state, {
      _tag: "TerminalActivityObserved",
      sessionId: ROOT,
      ownerId: "owner-1",
      activity: "idle",
      wasVisible: false,
    })
    const refresh = activeRefresh("refresh:full", 1, "manual", "full")
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh, replaceAll: true })
    state = reduceApplicationState(state, {
      _tag: "RefreshSucceeded",
      key: refresh.key,
      generation: refresh.generation,
      snapshot: snapshot(session(ROOT, "Root"), [
        message("q", "user", "question", 0),
        { ...message("a", "agent", "answer", 1), turnComplete: true },
      ]),
    })

    expect(state.pendingCompletions.has(ROOT)).toBeFalse()
    expect(state.unviewedSessionIds.has(ROOT)).toBeTrue()
    expect(selectSessionStatus(state, ROOT)).toBe("unviewed")
    expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q", "a"])
  })

  test("preserves the completion baseline for partial Available reads from every refresh mode", () => {
    expectCompletionBarrier({
      _tag: "Available",
      messages: [
        message("q", "user", "question", 0),
        { ...message("a", "agent", "partial answer", 1), turnComplete: false },
      ],
    })
  })

  test("preserves the completion baseline for Missing reads from every refresh mode", () => {
    expectCompletionBarrier({ _tag: "Missing" })
  })

  test("preserves the completion baseline for Unavailable reads from every refresh mode", () => {
    expectCompletionBarrier({ _tag: "Unavailable", reason: "still being persisted" })
  })

  test("preserves a pending baseline when a stale shorter transcript ends in an older completion", () => {
    const baseline = [
      message("q1", "user", "first question", 0),
      { ...message("a1", "agent", "first answer", 1), turnComplete: true },
      message("q2", "user", "next question", 2),
    ]
    let state: ApplicationState = {
      ...loadedState(baseline),
      terminals: new Map([[ROOT, {
        ownerId: "owner-1",
        activity: "working",
        phase: "running",
      }]]),
    }
    state = reduceApplicationState(state, {
      _tag: "TerminalActivityObserved",
      sessionId: ROOT,
      ownerId: "owner-1",
      activity: "idle",
      wasVisible: false,
    })
    const refresh = activeRefresh("refresh:full", 1, "manual", "full")
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh, replaceAll: true })
    state = reduceApplicationState(state, {
      _tag: "RefreshSucceeded",
      key: refresh.key,
      generation: refresh.generation,
      snapshot: snapshot(session(ROOT, "Root"), baseline.slice(0, 2)),
    })

    expect(state.pendingCompletions.has(ROOT)).toBeTrue()
    expect(state.unviewedSessionIds.has(ROOT)).toBeFalse()
    expect(selectSessionStatus(state, ROOT)).toBe("working")
    expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q1", "a1", "q2"])
  })

  test("atomically accepts completion from unrelated full and incremental refreshes", () => {
    for (const refreshCase of [
      { reason: "manual" as const, mode: "full" as const },
      { reason: "terminal-return" as const, mode: "incremental" as const },
    ]) {
      let state = pendingCompletionState()
      const refresh = {
        ...activeRefresh(`refresh:${refreshCase.reason}`, 1, refreshCase.reason, refreshCase.mode),
        sessionIds: new Set([ROOT]),
      }
      state = reduceApplicationState(state, {
        _tag: "RefreshStarted",
        refresh,
        ...(refresh.mode === "full" ? { replaceAll: true } : {}),
      })
      state = reduceApplicationState(state, {
        _tag: "RefreshSucceeded",
        key: refresh.key,
        generation: refresh.generation,
        snapshot: snapshot(session(ROOT, "Root"), [
          message("q", "user", "question", 0),
          { ...message("a", "agent", "answer", 1), turnComplete: true },
        ]),
      })

      expect(state.pendingCompletions.has(ROOT)).toBeFalse()
      expect(state.unviewedSessionIds.has(ROOT)).toBeTrue()
      expect(selectSessionStatus(state, ROOT)).toBe("unviewed")
      expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q", "a"])
    }
  })

  test("ignores activity from a different owner", () => {
    const state: ApplicationState = {
      ...loadedState(),
      terminals: new Map([[ROOT, {
        ownerId: "current-owner",
        activity: "idle",
        phase: "running",
      }]]),
    }
    const stale = reduceApplicationState(state, {
      _tag: "TerminalActivityObserved",
      sessionId: ROOT,
      ownerId: "stale-owner",
      activity: "working",
      wasVisible: false,
    })
    expect(stale).toBe(state)
  })

  test("projects rewinds immediately and clears them after provider confirmation", () => {
    const transcript = [
      message("q1", "user", "first", 0),
      message("a1", "agent", "answer", 1),
      message("q2", "user", "rewind here", 2),
      message("a2", "agent", "old answer", 3),
    ]
    let state = loadedState(transcript)
    state = reduceApplicationState(state, {
      _tag: "TerminalDraftObserved",
      sessionId: ROOT,
      draft: { text: "replacement", exact: false, rewind: true, rewindTarget: "rewind here" },
    })
    expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q1", "a1"])

    const refresh: ActiveRefresh = {
      ...activeRefresh("refresh:owner:owner", 1, "terminal-return", "incremental"),
      sessionIds: new Set([ROOT]),
    }
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
    state = reduceApplicationState(state, {
      _tag: "RefreshSucceeded",
      key: refresh.key,
      generation: refresh.generation,
      snapshot: snapshot(session(ROOT, "Root"), [message("new", "user", "new path", 0)]),
    })
    expect(state.rewindAnchors.has(ROOT)).toBeFalse()
    expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["new"])
  })

  test("accepts a submitted rewind completion without requiring the old baseline prefix", () => {
    const baseline = [
      message("q1", "user", "first", 0),
      message("a1", "agent", "first answer", 1),
      message("q2", "user", "rewind here", 2),
      message("a2", "agent", "old answer", 3),
    ]
    let state: ApplicationState = {
      ...loadedState(baseline),
      terminals: new Map([[ROOT, {
        ownerId: "owner-1",
        activity: "working",
        phase: "running",
      }]]),
    }
    state = reduceApplicationState(state, {
      _tag: "TerminalDraftObserved",
      sessionId: ROOT,
      draft: {
        text: "replacement",
        exact: false,
        rewind: true,
        rewindTarget: "rewind here",
        submitted: true,
      },
    })
    state = reduceApplicationState(state, {
      _tag: "TerminalActivityObserved",
      sessionId: ROOT,
      ownerId: "owner-1",
      activity: "idle",
      wasVisible: false,
    })
    const completion = state.pendingCompletions.get(ROOT)!
    const refresh: ActiveRefresh = {
      ...activeRefresh("refresh:owner:owner-1", 1, "completion", "incremental"),
      sessionIds: new Set([ROOT]),
      completionVersion: completion.version,
    }
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
    state = reduceApplicationState(state, {
      _tag: "RefreshSucceeded",
      key: refresh.key,
      generation: refresh.generation,
      snapshot: snapshot(session(ROOT, "Root"), [
        message("q1", "user", "first", 0),
        message("a1", "agent", "first answer", 1),
        message("replacement-q", "user", "replacement", 2),
        { ...message("replacement-a", "agent", "new answer", 3), turnComplete: true },
      ]),
    })

    expect(state.pendingCompletions.has(ROOT)).toBeFalse()
    expect(state.rewindAnchors.has(ROOT)).toBeFalse()
    expect(state.unviewedSessionIds.has(ROOT)).toBeTrue()
    expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual([
      "q1",
      "a1",
      "replacement-q",
      "replacement-a",
    ])
  })

  test("migrates every ephemeral collection after repository-owned identity adoption", () => {
    const temporary = "temporary"
    const persisted = "persisted"
    const temporarySession = session(temporary, "Temporary", true)
    let state: ApplicationState = {
      ...makeInitialApplicationState({
        surface: {
          _tag: "Terminal",
          sessionId: temporary,
          returnTo: {
            _tag: "Graph",
            familySessionId: temporary,
            target: {
              kind: "message",
              preferred: { sessionId: temporary, messageId: "temporary-message" },
              aliases: [{ sessionId: temporary, messageId: "temporary-message" }],
            },
          },
        },
      }),
      local: {
        sessions: new Map([[temporary, temporarySession]]),
        transcripts: new Map([[temporary, available([])]]),
        temporarySessionIds: new Set([temporary]),
      },
      terminals: new Map([[temporary, {
        ownerId: "owner",
        activity: "blocked",
        phase: "running",
      }]]),
      drafts: new Map([[temporary, { text: "draft", exact: false }]]),
      unviewedSessionIds: new Set([temporary]),
    }
    state = reduceApplicationState(state, {
      _tag: "SessionIdentityAdopted",
      previousSessionId: temporary,
      session: session(persisted, "Persisted"),
      kind: "temporary-adoption",
    })
    expect(state.local.sessions.has(temporary)).toBeFalse()
    expect(state.local.sessions.has(persisted)).toBeTrue()
    expect(state.local.temporarySessionIds).toEqual(new Set([persisted]))
    expect(state.terminals.has(persisted)).toBeTrue()
    expect(state.drafts.has(persisted)).toBeTrue()
    expect(state.unviewedSessionIds).toEqual(new Set([persisted]))
    expect(state.surface).toMatchObject({ _tag: "Terminal", sessionId: persisted })
    const returnTo = state.surface._tag === "Terminal" ? state.surface.returnTo : undefined
    expect(returnTo?._tag === "Graph" ? returnTo.target : undefined).toEqual({
      kind: "message",
      preferred: { sessionId: persisted, messageId: "temporary-message" },
      aliases: [{ sessionId: persisted, messageId: "temporary-message" }],
    })
  })

  test("translates hidden native-fork graph message targets through shared mappings", () => {
    const relation = {
      childSessionId: "native-child",
      parentSessionId: ROOT,
      sourceMessageId: "parent-message",
      sharedMessages: [{
        parentMessageId: "parent-message",
        childMessageId: "child-message",
      }],
      createdAt: "2026-09-01T00:00:00.000Z",
    }
    let state: ApplicationState = {
      ...loadedState(),
      surface: {
        _tag: "Terminal",
        sessionId: ROOT,
        returnTo: {
          _tag: "Graph",
          familySessionId: ROOT,
          target: {
            kind: "message",
            preferred: { sessionId: ROOT, messageId: "parent-message" },
            aliases: [
              { sessionId: ROOT, messageId: "parent-message" },
              { sessionId: ROOT, messageId: "unmapped-message" },
            ],
          },
        },
      },
      terminals: new Map([[ROOT, {
        ownerId: "owner",
        activity: "idle",
        phase: "running",
      }]]),
    }

    state = reduceApplicationState(state, {
      _tag: "SessionIdentityAdopted",
      previousSessionId: ROOT,
      session: session("native-child", "Native child"),
      kind: "native-fork",
      relation,
    })

    expect(state.provider.sessions.has(ROOT)).toBeTrue()
    expect(state.local.sessions.has("native-child")).toBeTrue()
    expect(state.surface._tag === "Terminal" ? state.surface.sessionId : undefined).toBe("native-child")
    expect(state.surface._tag === "Terminal" ? state.surface.returnTo : undefined).toEqual({
      _tag: "Graph",
      familySessionId: "native-child",
      target: {
        kind: "message",
        preferred: { sessionId: "native-child", messageId: "child-message" },
        aliases: [
          { sessionId: "native-child", messageId: "child-message" },
          { sessionId: ROOT, messageId: "unmapped-message" },
        ],
      },
    })
  })

  test("rewrites every temporary-adoption removal confirmation field", () => {
    const temporary = "temporary"
    const persisted = "persisted"
    const removal = {
      kind: "subtree" as const,
      target: { kind: "endpoint" as const, sessionId: temporary, afterMessageId: null },
      createdAt: "2026-09-02T00:00:00.000Z",
    }
    let state: ApplicationState = {
      ...makeInitialApplicationState(),
      local: {
        sessions: new Map([[temporary, session(temporary, "Temporary", true)]]),
        transcripts: new Map([[temporary, available([])]]),
        temporarySessionIds: new Set([temporary]),
      },
      modal: {
        _tag: "ConfirmRemoval",
        requestId: "remove-temporary",
        removal,
        affectedSessionIds: [temporary, "other", temporary],
      },
    }

    state = reduceApplicationState(state, {
      _tag: "SessionIdentityAdopted",
      previousSessionId: temporary,
      session: session(persisted, "Persisted"),
      kind: "temporary-adoption",
    })

    expect(state.modal).toEqual({
      _tag: "ConfirmRemoval",
      requestId: "remove-temporary",
      removal: {
        ...removal,
        target: { kind: "endpoint", sessionId: persisted, afterMessageId: null },
      },
      affectedSessionIds: [persisted, "other"],
    })
  })

  test("updates native-fork stop confirmations and cancels stale removal confirmations", () => {
    const terminal = { ownerId: "owner", activity: "idle" as const, phase: "running" as const }
    let stopState: ApplicationState = {
      ...loadedState(),
      terminals: new Map([[ROOT, terminal]]),
      modal: { _tag: "ConfirmStop", sessionId: ROOT, activity: "idle" },
    }
    stopState = reduceApplicationState(stopState, {
      _tag: "SessionIdentityAdopted",
      previousSessionId: ROOT,
      session: session("native-child", "Native child"),
      kind: "native-fork",
    })
    expect(stopState.modal).toEqual({
      _tag: "ConfirmStop",
      sessionId: "native-child",
      activity: "idle",
    })

    let removalState: ApplicationState = {
      ...loadedState(),
      terminals: new Map([[ROOT, terminal]]),
      modal: {
        _tag: "ConfirmRemoval",
        requestId: "remove-root",
        removal: {
          kind: "tree",
          rootSessionId: ROOT,
          memberSessionIds: [ROOT],
          createdAt: "2026-09-02T00:00:00.000Z",
        },
        affectedSessionIds: [ROOT],
      },
    }
    removalState = reduceApplicationState(removalState, {
      _tag: "SessionIdentityAdopted",
      previousSessionId: ROOT,
      session: session("native-child", "Native child"),
      kind: "native-fork",
    })
    expect(removalState.modal).toBeNull()
  })

  test("drops only undiscovered unowned temporary sessions after stop reconciliation", () => {
    const temporary = session("temporary", "Blank Codex", true)
    const validatedLocal = session("validated-local", "Validated local")
    let state: ApplicationState = {
      ...loadedState(),
      local: {
        sessions: new Map([
          [temporary.id, temporary],
          [validatedLocal.id, validatedLocal],
        ]),
        transcripts: new Map([
          [temporary.id, available([])],
          [validatedLocal.id, available([message("local-q", "user", "local", 0)])],
        ]),
        temporarySessionIds: new Set([temporary.id]),
      },
    }
    const refresh: ActiveRefresh = {
      ...activeRefresh("refresh:owner:temporary", 1, "stop", "incremental"),
      sessionIds: new Set([temporary.id]),
    }
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
    state = reduceApplicationState(state, {
      _tag: "RefreshSucceeded",
      key: refresh.key,
      generation: refresh.generation,
      snapshot: { sessions: [], transcripts: new Map() },
    })

    expect(state.local.sessions.has(temporary.id)).toBeFalse()
    expect(state.local.transcripts.has(temporary.id)).toBeFalse()
    expect(state.local.temporarySessionIds.has(temporary.id)).toBeFalse()
    expect(state.local.sessions.get(validatedLocal.id)).toEqual(validatedLocal)
    expect(state.provider.sessions.has(ROOT)).toBeTrue()
  })

  test("releases ephemeral state at shutdown and rejects later transforms", () => {
    const seeded: ApplicationState = {
      ...loadedState(),
      terminals: new Map([[ROOT, { ownerId: "owner", activity: "working", phase: "running" }]]),
      drafts: new Map([[ROOT, { text: "draft", exact: false }]]),
    }
    const stopping = reduceApplicationState(seeded, { _tag: "ShutdownStarted" })
    const ignored = reduceApplicationState(stopping, {
      _tag: "Navigated",
      surface: { _tag: "Roots", selectedSessionId: ROOT },
    })
    expect(ignored).toBe(stopping)
    const stopped = reduceApplicationState(ignored, { _tag: "ShutdownCompleted" })
    expect(stopped.shutdown).toBe("stopped")
    expect(stopped.terminals.size).toBe(0)
    expect(stopped.drafts.size).toBe(0)
    expect(projectApplicationViewModel(stopped).shuttingDown).toBeTrue()
  })

  test("can project successful stops without persisting a failed removal", () => {
    let state: ApplicationState = {
      ...loadedState(),
      terminals: new Map([
        [ROOT, { ownerId: "owner-1", activity: "idle", phase: "running" }],
        ["child", { ownerId: "owner-2", activity: "working", phase: "running" }],
      ]),
    }
    state = reduceApplicationState(state, { _tag: "TerminalStopped", sessionId: ROOT })
    state = reduceApplicationState(state, {
      _tag: "TerminalStopped",
      sessionId: "child",
      cleanupIncomplete: true,
    })
    expect(state.terminals.has(ROOT)).toBeFalse()
    expect(state.terminals.get("child")?.phase).toBe("cleanup-incomplete")
    expect(state.removals).toEqual([])
  })

  test("projects every stopped empty fork as a numbered leaf", () => {
    const firstChild = "fork-one"
    const secondChild = "fork-two"
    const source = message("source", "user", "fork source", 0)
    const firstCopy = message("first-copy", "user", "fork source", 0)
    const secondCopy = message("second-copy", "user", "fork source", 0)
    const relations: ApplicationState["relations"] = [
      {
        childSessionId: firstChild,
        parentSessionId: ROOT,
        sourceMessageId: source.id,
        sharedMessages: [{ parentMessageId: source.id, childMessageId: firstCopy.id }],
        createdAt: "2026-09-01T12:00:01.000Z",
      },
      {
        childSessionId: secondChild,
        parentSessionId: ROOT,
        sourceMessageId: source.id,
        sharedMessages: [{ parentMessageId: source.id, childMessageId: secondCopy.id }],
        createdAt: "2026-09-01T12:00:02.000Z",
      },
    ]
    const state: ApplicationState = {
      ...makeInitialApplicationState({
        relations,
        surface: {
          _tag: "Graph",
          familySessionId: ROOT,
          target: {
            kind: "message",
            preferred: { sessionId: ROOT, messageId: source.id },
            aliases: [{ sessionId: ROOT, messageId: source.id }],
          },
        },
      }),
      provider: {
        sessions: new Map([
          [ROOT, session(ROOT, "Root")],
          [firstChild, session(firstChild, "First fork")],
          [secondChild, session(secondChild, "Second fork")],
        ]),
        transcripts: new Map([
          [ROOT, available([source])],
          [firstChild, available([firstCopy])],
          [secondChild, available([secondCopy])],
        ]),
      },
      refresh: { generation: 0, active: new Map(), initialPending: false, appliedGenerationBySession: new Map() },
    }

    const surface = projectApplicationViewModel(state).surface
    expect(surface._tag).toBe("Graph")
    if (surface._tag !== "Graph") throw new Error("Expected graph surface")
    const sourceNode = surface.nodes.find((node) => node._tag === "Message")
    const forks = surface.nodes.filter((node) => node._tag === "Endpoint")
    expect(sourceNode).toBeDefined()
    expect(forks.map((node) => ({
      sessionId: node._tag === "Endpoint" ? node.session.id : "",
      parentIds: node.parentIds,
      empty: node._tag === "Endpoint" ? node.fork?.empty : undefined,
      number: node._tag === "Endpoint" ? node.fork?.number : undefined,
    }))).toEqual([
      { sessionId: firstChild, parentIds: [sourceNode!.id], empty: true, number: 1 },
      { sessionId: secondChild, parentIds: [sourceNode!.id], empty: true, number: 2 },
    ])
  })
})

function loadedState(messages: readonly AgentMessage[] = [message("q", "user", "question", 0)]): ApplicationState {
  return {
    ...makeInitialApplicationState(),
    provider: {
      sessions: new Map([[ROOT, session(ROOT, "Root")]]),
      transcripts: new Map([[ROOT, available(messages)]]),
    },
    refresh: { generation: 0, active: new Map(), initialPending: false, appliedGenerationBySession: new Map() },
  }
}

function pendingCompletionState(): ApplicationState {
  let state: ApplicationState = {
    ...loadedState(),
    terminals: new Map([[ROOT, {
      ownerId: "owner-1",
      activity: "working",
      phase: "running",
    }]]),
  }
  state = reduceApplicationState(state, {
    _tag: "TerminalActivityObserved",
    sessionId: ROOT,
    ownerId: "owner-1",
    activity: "idle",
    wasVisible: false,
  })
  return state
}

function expectCompletionBarrier(incoming: TranscriptRead): void {
  for (const refreshCase of [
    { reason: "manual" as const, mode: "full" as const },
    { reason: "ambiguity" as const, mode: "full" as const },
    { reason: "terminal-return" as const, mode: "incremental" as const },
    { reason: "completion" as const, mode: "incremental" as const },
  ]) {
    let state = pendingCompletionState()
    const completion = state.pendingCompletions.get(ROOT)!
    const refresh: ActiveRefresh = {
      ...activeRefresh(`refresh:${refreshCase.reason}`, 1, refreshCase.reason, refreshCase.mode),
      sessionIds: new Set([ROOT]),
      ...(refreshCase.reason === "completion" ? { completionVersion: completion.version } : {}),
    }
    state = reduceApplicationState(state, {
      _tag: "RefreshStarted",
      refresh,
      ...(refresh.mode === "full" ? { replaceAll: true } : {}),
    })
    state = reduceApplicationState(state, {
      _tag: "RefreshSucceeded",
      key: refresh.key,
      generation: refresh.generation,
      snapshot: snapshotRead(session(ROOT, "Root"), incoming),
    })

    expect(state.pendingCompletions.has(ROOT)).toBeTrue()
    expect(state.unviewedSessionIds.has(ROOT)).toBeFalse()
    expect(selectSessionStatus(state, ROOT)).toBe("working")
    expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q"])
    expect(state.provider.transcripts.get(ROOT)).toEqual(available([
      message("q", "user", "question", 0),
    ]))
  }
}

function activeRefresh(
  key: string,
  generation: number,
  reason: ActiveRefresh["reason"],
  mode: ActiveRefresh["mode"],
): ActiveRefresh {
  return { key, generation, reason, mode, sessionIds: new Set() }
}

function snapshot(sessionValue: AgentSession, messages: readonly AgentMessage[]): AgentSessionSnapshot {
  return { sessions: [sessionValue], transcripts: new Map([[sessionValue.id, available(messages)]]) }
}

function snapshotRead(sessionValue: AgentSession, transcript: TranscriptRead): AgentSessionSnapshot {
  return { sessions: [sessionValue], transcripts: new Map([[sessionValue.id, transcript]]) }
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
