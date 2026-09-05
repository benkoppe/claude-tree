import { describe, expect, test } from "bun:test"
import { ClaudeTerminalObserver } from "../../src/infrastructure/providers/claude/terminal-observer"

import {
  available,
  makeInitialApplicationState,
  invalidatedRefreshSessionIds,
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
  TerminalObservation,
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
    expect(state.modal).toBeNull()
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

  for (const draftFirst of [false, true]) {
    test(`undoing a send clears the completion wait (draft first: ${draftFirst})`, () => {
      const transcript = [message("q1", "user", "first", 0), message("a1", "agent", "answer", 1), message("q2", "user", "undo me", 2)]
      let state: ApplicationState = {
        ...loadedState(transcript),
        terminals: new Map([[ROOT, { ownerId: "owner", activity: "working", phase: "running" }]]),
      }
      const draft = { _tag: "TerminalDraftObserved" as const, sessionId: ROOT,
        draft: { text: "undo me", exact: false, rewind: true, rewindTarget: "undo me" } }
      const idle = { _tag: "TerminalActivityObserved" as const, sessionId: ROOT, ownerId: "owner", activity: "idle" as const, wasVisible: false }
      for (const event of draftFirst ? [draft, idle] : [idle, draft]) state = reduceApplicationState(state, event)
      expect(state.pendingCompletions.size).toBe(0)
      expect(selectSessionStatus(state, ROOT)).toBe("live")
      expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q1", "a1"])
      state = readReplacement(state, transcript)
      expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q1", "a1"])
      state = readReplacement(state, transcript.slice(0, 2))
      expect(state.unviewedSessionIds.size).toBe(0)
      expect(state.modal).toBeNull()
      // Submitting again starts a new completion cycle, even if the old draft was cached.
      state = reduceApplicationState(state, { ...idle, activity: "working" })
      state = reduceApplicationState(state, idle)
      expect(state.pendingCompletions.size).toBe(1)
    })
  }

  test("a native rewind picker projects its selected boundary even while provider reads retain the old tail", () => {
    const observer = new ClaudeTerminalObserver()
    const encoder = new TextEncoder()
    const transcript = [message("q1", "user", "first", 0), message("a1", "agent", "answer", 1),
      message("q2", "user", "restore here", 2), message("a2", "agent", "discarded answer", 3)]
    let state: ApplicationState = {
      ...loadedState(transcript),
      terminals: new Map([[ROOT, { ownerId: "owner", activity: "idle", phase: "running" }]]),
    }
    observer.observeInput(encoder.encode("/rewind\r"))
    observer.observeScreen({ lines: ["│ Rewind │", "│ Restore and fork the conversation to the point before… │"], cursor: { x: 0, y: 0, visible: false } })
    observer.observeInput(encoder.encode("\r"))
    observer.observeScreen({ lines: ["│ Confirm you want to restore the conversation │", "│ to the point before you sent this message: │"], cursor: { x: 0, y: 0, visible: false } })
    observer.observeInput(encoder.encode("\r"))
    observer.observeScreen({ lines: ["Confirm you want to restore the conversation", "❯ Restore conversation"], cursor: { x: 0, y: 1, visible: false } })
    const restored = { lines: ["❯ restore here", "────────────────"], cursor: { x: 5, y: 0, visible: true } }
    observer.observeScreen(restored)
    const draft = observer.observeDraft(restored)!
    expect(draft.rewind).toBeTrue()
    state = observe(state, { _tag: "Draft", draft })
    expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q1", "a1"])
    state = readReplacement(state, transcript)
    expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q1", "a1"])
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
      snapshot: snapshot(session(ROOT, "Root"), transcript.slice(0, 2)),
    })
    expect(state.rewindAnchors.has(ROOT)).toBeFalse()
    expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q1", "a1"])
  })

  test("releases provisional placement at prefix confirmation without moving the accepted endpoint", () => {
    let state = reduceApplicationState(loadedState(original), {
      _tag: "TerminalDraftObserved", sessionId: ROOT,
      draft: { text: "later", exact: false, rewind: true, rewindTarget: "later" },
    })
    for (let index = 0; index < 3; index += 1) {
      state = readReplacement(state, original.slice(0, 2))
      state = reduceApplicationState(state, {
        _tag: "TerminalDraftObserved", sessionId: ROOT,
        draft: { text: "later", exact: false, rewind: true, rewindTarget: "later" },
      })
      expect(state.rewindAnchors.has(ROOT)).toBeFalse()
      expect(selectProjectedTranscript(state, ROOT).map((entry) => entry.id)).toEqual(["q", "a"])
    }
    state = readReplacement(state, [...original.slice(0, 2), message("new", "user", "replacement", 2)])
    expect(state.rewindAnchors.has(ROOT)).toBeFalse()
    expect(selectProjectedTranscript(state, ROOT).at(-1)?.id).toBe("new")
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

  function observe(state: ApplicationState, observation: TerminalObservation, ownerId = "owner"): ApplicationState {
    return reduceApplicationState(state, { _tag: "TerminalObservationObserved", sessionId: ROOT, ownerId, observation })
  }

  function liveRewindState(): ApplicationState {
    return observe({
      ...loadedState(original),
      terminals: new Map([[ROOT, { ownerId: "owner", activity: "idle", phase: "running" }]]),
    }, { _tag: "Draft", draft: { text: "later", exact: false, rewind: true } })
  }

  test("an unreadable rewind occurrence invalidates reads without fabricating placement", () => {
    let state = observe(liveRewindState(), { _tag: "Submission", text: "edited" })
    state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
      ownerId: "owner", activity: "idle", wasVisible: false })
    const refresh = activeRefresh("before-rewind", 1, "manual", "full")
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
    const captured = state.refresh.active.get(refresh.key)!
    expect(observe(state, { _tag: "Rewind" }, "stale")).toBe(state)
    state = observe(state, { _tag: "Rewind" })
    expect(state.terminals.get(ROOT)).toMatchObject({ unresolvedRewind: true, activity: "idle", historyRevision: 3 })
    expect(state.terminals.get(ROOT)?.replacement).toBeUndefined()
    expect(state.terminals.get(ROOT)?.pendingSubmission).toBeUndefined()
    expect(state.pendingCompletions.size).toBe(0)
    expect(state.rewindAnchors.size).toBe(0)
    expect(state.drafts.size).toBe(0)
    expect(selectProjectedTranscript(state, ROOT)).toEqual(original)
    expect(invalidatedRefreshSessionIds(state, captured)).toEqual(new Set([ROOT]))
    state = observe(state, { _tag: "Draft", draft: null })
    expect(state.terminals.get(ROOT)?.unresolvedRewind).toBeTrue()
    state = readReplacement(state, original.slice(0, 2))
    expect(selectProjectedTranscript(state, ROOT)).toEqual(original)
    state = readReplacement(state, original.slice(0, 2))
    expect(selectProjectedTranscript(state, ROOT)).toEqual(original.slice(0, 2))
    expect(state.terminals.get(ROOT)?.unresolvedRewind).toBeFalse()
    expect(state.unviewedSessionIds.size).toBe(0)
  })

  test("explicit re-undo can recover only its matching tracked replacement boundary", () => {
    let state = observe(liveRewindState(), { _tag: "Submission", text: "edited" })
    state = observe(state, { _tag: "Rewind" })
    expect(state.rewindAnchors.size).toBe(0)
    state = observe(state, { _tag: "Draft", draft: { text: "edited", exact: false, rewind: true } })
    expect(state.rewindAnchors.get(ROOT)?.targetMessageId).toBe("q2")
    expect(selectProjectedTranscript(state, ROOT)).toEqual(original.slice(0, 2))
  })

  test("rewind matching joins only evidenced terminal row boundaries and escapes regex syntax", () => {
    const text = "use veryLongIdentifier [x]+ with care"
    for (const [preview, rows, matches] of [
      [text, ["use veryLongIdenti", "  fier [x]+ with  care"], true],
      [text, undefined, false],
      ["prefix " + text, ["use veryLongIdenti", "fier [x]+ with care"], false],
      ["useveryLongIdentifier [x]+ with care", ["use veryLongIdenti", "fier [x]+ with care"], false],
      ["use veryLongIdentifier xxx with care", ["use veryLongIdenti", "fier [x]+ with care"], false],
    ] as const) {
      let state: ApplicationState = { ...loadedState([message("target", "user", preview, 0)]),
        terminals: new Map([[ROOT, { ownerId: "owner", activity: "idle", phase: "running" }]]) }
      state = observe(state, { _tag: "Rewind" })
      state = observe(state, { _tag: "Draft", draft: { text: "edited", exact: false, rewind: true,
        rewindTarget: "use veryLongIdenti\nfier [x]+ with care", ...(rows ? { rewindTargetLines: [...rows] } : {}) } })
      expect(state.rewindAnchors.has(ROOT)).toBe(matches)
    }
    let state: ApplicationState = { ...loadedState([message("one", "user", text, 0), message("two", "user", text, 1)]),
      terminals: new Map([[ROOT, { ownerId: "owner", activity: "idle", phase: "running" }]]) }
    state = observe(state, { _tag: "Draft", draft: { text, exact: false, rewind: true,
      rewindTargetLines: ["use veryLongIdenti", "fier [x]+ with care"] } })
    expect(state.rewindAnchors.size).toBe(0)
    expect(state.terminals.get(ROOT)?.unresolvedRewind).toBeTrue()
  })

  for (const occurrence of [false, true]) {
    for (const activity of ["working", "blocked", "idle"] as const) {
      test(`unanchored replacement confirms user prefix independently of assistant streaming (${occurrence}, ${activity})`, () => {
        let state: ApplicationState = { ...loadedState(original),
          terminals: new Map([[ROOT, { ownerId: "owner", activity: "idle", phase: "running" }]]) }
        if (occurrence) state = observe(state, { _tag: "Rewind" })
        state = observe(state, { _tag: "Submission", text: "edited" })
        state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
          ownerId: "owner", activity, wasVisible: false })
        const prefix = [...original.slice(0, 2), message("novel", "user", "edited", 2)]
        for (const attempt of [1, 2]) {
          state = readReplacement(state, [...prefix, { ...message("answer", "agent", `stream ${attempt}`, 3), turnComplete: false }])
          expect(selectProjectedTranscript(state, ROOT)).toEqual(attempt === 1 ? original : prefix)
          expect(state.replacementCandidates.get(ROOT)?.attempts).toBe(attempt === 1 ? 1 : undefined)
          expect(state.unviewedSessionIds.size).toBe(0)
        }
        expect(state.terminals.get(ROOT)?.pendingSubmission).toBeUndefined()
        if (activity === "idle") expect(state.pendingCompletions.get(ROOT)?.baseline).toEqual(prefix)
        for (const stale of [original, original.slice(0, 2), [{ ...original[0]!, preview: "mutated" }, ...prefix.slice(1)]]) {
          state = readReplacement(state, stale)
          expect(selectProjectedTranscript(state, ROOT)).toEqual(prefix)
        }
        state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
          ownerId: "owner", activity: "idle", wasVisible: false })
        state = readReplacement(state, [...prefix, { ...message("answer", "agent", "complete", 3), turnComplete: true }])
        expect(state.pendingCompletions.size).toBe(0)
        expect(state.unviewedSessionIds.has(ROOT)).toBeTrue()
        state = readReplacement(state, original)
        expect(selectProjectedTranscript(state, ROOT).at(-1)?.id).toBe("answer")
      })
    }
  }

  test("unresolved occurrence recovers while blocked without a readable submission and preserves forks", () => {
    const copies = original.map((entry) => ({ ...entry, id: `child-${entry.id}` }))
    let state = reduceApplicationState(liveRewindState(), { _tag: "PersistedBranchProjected",
      session: session("child", "Child"), transcript: available(copies),
      relation: { childSessionId: "child", parentSessionId: ROOT, sourceMessageId: "q2",
        sharedMessages: original.map((entry, index) => ({ parentMessageId: entry.id, childMessageId: copies[index]!.id })),
        createdAt: "2026-09-01T00:00:00.000Z" } })
    state = observe(state, { _tag: "Rewind" })
    state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
      ownerId: "owner", activity: "blocked", wasVisible: false })
    const prefix = [...original.slice(0, 2), message("new", "user", "edited", 2)]
    state = readReplacement(readReplacement(state, prefix), prefix)
    expect(selectProjectedTranscript(state, ROOT)).toEqual(prefix)
    expect(selectProjectedTranscript(state, "child")).toEqual(copies)
    const graph = projectGraphViewModel(state, ROOT)
    const edited = graph.nodes.find((node) => node._tag === "Message" && node.preview === "edited")!
    const copied = graph.nodes.find((node) => node._tag === "Message" && node.preview === "later")!
    expect(edited.parentIds).toEqual(copied.parentIds)
  })

  test("unanchored recovery rejects old identities outside the longest common prefix", () => {
    let state: ApplicationState = { ...loadedState(original),
      terminals: new Map([[ROOT, { ownerId: "owner", activity: "working", phase: "running" }]]) }
    state = observe(state, { _tag: "Submission" })
    const novel = message("new", "user", "edited", 2)
    for (const invalid of [
      [{ ...original[0]!, copyIdentity: "mutated" }, original[1]!, novel],
      [original[1]!, novel],
      [original[0]!, novel, original[2]!],
    ]) {
      state = readReplacement(readReplacement(state, invalid), invalid)
      expect(selectProjectedTranscript(state, ROOT)).toEqual(original)
      expect(state.replacementCandidates.size).toBe(0)
      expect(state.terminals.get(ROOT)?.pendingSubmission).toBeDefined()
    }
    const prefix = [...original.slice(0, 2), novel]
    state = readReplacement(state, prefix)
    const refresh = activeRefresh("failed-prefix", state.refresh.generation + 1, "submission", "full")
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
    state = reduceApplicationState(state, { _tag: "RefreshFailed", key: refresh.key, generation: refresh.generation, message: "failed" })
    state = readReplacement(state, prefix)
    expect(state.replacementCandidates.get(ROOT)?.attempts).toBe(1)
    expect(selectProjectedTranscript(state, ROOT)).toEqual(original)
    state = readReplacement(state, prefix)
    expect(selectProjectedTranscript(state, ROOT)).toEqual(prefix)
  })

  test("unknown working replacements fail closed and tracked candidates have a bounded budget", () => {
    let state: ApplicationState = { ...loadedState(original),
      terminals: new Map([[ROOT, { ownerId: "owner", activity: "working", phase: "running" }]]) }
    const replacement = [...original.slice(0, 2), message("new", "user", "edited", 2)]
    state = readReplacement(readReplacement(state, replacement), replacement)
    expect(selectProjectedTranscript(state, ROOT)).toEqual(original)
    expect(state.replacementCandidates.size).toBe(0)
    state = observe(state, { _tag: "Submission" })
    for (const attempt of [1, 2, 3]) {
      state = readReplacement(state, [...original.slice(0, 2), message(`new-${attempt}`, "user", "edited", 2)])
      expect(state.replacementCandidates.get(ROOT)?.attempts).toBe(attempt < 3 ? attempt : undefined)
      expect(selectProjectedTranscript(state, ROOT)).toEqual(original)
    }
    expect(state.modal?._tag).toBe("Error")
    expect(state.terminals.get(ROOT)?.pendingSubmission).toBeDefined()
  })

  test("shortening rebases discovery without satisfying it until a novel user persists", () => {
    let state = observe(liveRewindState(), { _tag: "Rewind" })
    state = observe(state, { _tag: "Submission" })
    state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
      ownerId: "owner", activity: "working", wasVisible: false })
    const prefix = original.slice(0, 2)
    state = readReplacement(readReplacement(state, prefix), prefix)
    expect(state.terminals.get(ROOT)?.pendingSubmission).toEqual({ baseline: prefix, attempt: 0 })
    expect(state.unviewedSessionIds.size).toBe(0)
    state = readReplacement(state, [...prefix, message("new", "user", "edited", 2)])
    expect(state.terminals.get(ROOT)?.pendingSubmission).toBeUndefined()
    expect(state.unviewedSessionIds.size).toBe(0)
  })

  for (const recovery of ["idle-prefix", "idle-replacement", "working-replacement"] as const) {
    test(`a completed rewind permits a second missed rewind (${recovery})`, () => {
      const prefix = original.slice(0, 2)
      const first = [...prefix, message("first-replacement", "user", "first edit", 2),
        { ...message("first-answer", "agent", "first complete", 3), turnComplete: true }]
      let state = observe(liveRewindState(), { _tag: "Submission", text: "first edit" })
      state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
        ownerId: "owner", activity: "idle", wasVisible: false })
      state = readReplacement(state, first)
      expect(selectProjectedTranscript(state, ROOT)).toEqual(first)
      expect(state.terminals.get(ROOT)?.replacement?.settled).toBeTrue()
      expect(state.pendingCompletions.size).toBe(0)
      expect(state.rewindAnchors.size).toBe(0)
      state = reduceApplicationState(state, { _tag: "TerminalShown", sessionId: ROOT, ownerId: "owner",
        returnTo: { _tag: "Roots", selectedSessionId: ROOT } })

      // Completion releases only the old prefix constraint, not the discarded UUIDs.
      state = readReplacement(readReplacement(state, original), original)
      expect(selectProjectedTranscript(state, ROOT)).toEqual(first)
      expect(state.replacementCandidates.size).toBe(0)
      if (recovery === "idle-prefix") {
        state = readReplacement(state, prefix)
        expect(state.replacementCandidates.get(ROOT)?.attempts).toBe(1)
        expect(selectProjectedTranscript(state, ROOT)).toEqual(first)
        state = readReplacement(state, prefix)
        expect(selectProjectedTranscript(state, ROOT)).toEqual(prefix)
        expect(state.replacementCandidates.size).toBe(0)
        expect(state.unviewedSessionIds.size).toBe(0)
        state = readReplacement(readReplacement(state, first), first)
        expect(selectProjectedTranscript(state, ROOT)).toEqual(prefix)
      }

      const second = [...prefix, message("second-replacement", "user", "second edit", 2)]
      if (recovery !== "idle-replacement") {
        state = observe(state, { _tag: "Submission", text: "second edit" })
        state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
          ownerId: "owner", activity: "working", wasVisible: false })
      }
      for (const attempt of [1, 2]) {
        state = readReplacement(state, recovery === "idle-replacement" ? second : [...second,
          { ...message("second-answer", "agent", `stream ${attempt}`, 3), turnComplete: false }])
        expect(selectProjectedTranscript(state, ROOT)).toEqual(
          attempt === 1 && recovery !== "idle-prefix" ? first : second)
        if (attempt === 1 && recovery !== "idle-prefix") expect(state.replacementCandidates.get(ROOT)?.attempts).toBe(1)
      }
      expect(state.terminals.get(ROOT)?.pendingSubmission).toBeUndefined()
      expect(state.replacementCandidates.size).toBe(0)
      expect(state.rewindAnchors.size).toBe(0)
      expect(state.unviewedSessionIds.size).toBe(0)
      expect(state.terminals.get(ROOT)?.replacement?.discardedMessageIds).toEqual(
        new Set(["q2", "first-replacement", "first-answer"]))
      state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
        ownerId: "owner", activity: "idle", wasVisible: false })
      const completed = [...second, { ...message("second-answer", "agent", "second complete", 3), turnComplete: true }]
      state = readReplacement(state, completed)
      expect(selectProjectedTranscript(state, ROOT)).toEqual(completed)
      expect(state.terminals.get(ROOT)?.replacement?.settled).toBeTrue()
      expect(state.pendingCompletions.size).toBe(0)
      for (const abandoned of [original, first]) {
        state = readReplacement(readReplacement(state, abandoned), abandoned)
        expect(selectProjectedTranscript(state, ROOT)).toEqual(completed)
        expect(state.replacementCandidates.size).toBe(0)
      }
      expect(state.modal).toBeNull()
    })
  }

  test("unavailable prefix confirmation preserves content but discards its candidate", () => {
    let state = observe(liveRewindState(), { _tag: "Rewind" })
    const prefix = original.slice(0, 2)
    state = readReplacement(state, prefix)
    const refresh = activeRefresh("unavailable", state.refresh.generation + 1, "manual", "full")
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
    state = reduceApplicationState(state, { _tag: "RefreshSucceeded", key: refresh.key, generation: refresh.generation,
      snapshot: { sessions: [session(ROOT, "Root")], transcripts: new Map([[ROOT, { _tag: "Unavailable", reason: "busy" }]]) } })
    expect(selectProjectedTranscript(state, ROOT)).toEqual(original)
    expect(state.replacementCandidates.size).toBe(0)
    state = readReplacement(state, prefix)
    expect(selectProjectedTranscript(state, ROOT)).toEqual(original)
    expect(state.replacementCandidates.get(ROOT)?.attempts).toBe(1)
  })

  test("an obsolete failure cannot erase newer prefix confirmation evidence", () => {
    let state = observe(liveRewindState(), { _tag: "Rewind" })
    const refresh = activeRefresh("old-failure", 1, "manual", "full")
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
    state = readReplacement(state, original.slice(0, 2))
    const candidate = state.replacementCandidates.get(ROOT)
    state = reduceApplicationState(state, { _tag: "RefreshFailed", key: refresh.key, generation: 1, message: "obsolete" })
    expect(state.replacementCandidates.get(ROOT)).toBe(candidate)
    expect(state.modal).toBeNull()
    state = readReplacement(state, original.slice(0, 2))
    expect(selectProjectedTranscript(state, ROOT)).toEqual(original.slice(0, 2))
  })

  for (const confirmedPrefix of [false, true]) {
    for (const activity of ["working", "blocked", "idle"] as const) {
      test(`replacement user precedes the pending endpoint (${activity}, confirmed prefix: ${confirmedPrefix})`, () => {
        const prefix = original.slice(0, 2)
        let state = liveRewindState()
        if (confirmedPrefix) state = readReplacement(state, prefix)
        state = observe(state, { _tag: "Submission", text: "edited" })
        state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
          ownerId: "owner", activity, wasVisible: false })
        const submitted = [...prefix, message("edited", "user", "persisted edited prompt", 2)]
        const partial = [...submitted, { ...message("answer", "agent", "partial", 3), turnComplete: false }]
        // Even a fresh read can still contain the provider's abandoned old path.
        state = readReplacement(state, original)
        expect(selectProjectedTranscript(state, ROOT)).toEqual(prefix)
        expect(state.unviewedSessionIds.size).toBe(0)
        state = readReplacement(state, partial)
        expect(selectProjectedTranscript(state, ROOT)).toEqual(submitted)
        expect(state.rewindAnchors.size).toBe(0)
        const graph = projectGraphViewModel(state, ROOT)
        expect(graph.nodes.map((node) => node._tag === "Message" ? node.role : node.status))
          .toEqual(["user", "agent", "user", activity === "blocked" ? "blocked" : "working"])
        expect(graph.nodes.at(-1)?.parentIds).toEqual([graph.nodes.at(-2)!.id])
        if (activity === "idle") expect(state.pendingCompletions.get(ROOT)?.baseline).toEqual(submitted)
        for (const stale of [original, prefix, partial]) {
          state = readReplacement(state, stale)
          expect(selectProjectedTranscript(state, ROOT)).toEqual(submitted)
          expect(state.unviewedSessionIds.size).toBe(0)
        }
        state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
          ownerId: "owner", activity: "idle", wasVisible: false })
        state = readReplacement(state, partial)
        expect(state.pendingCompletions.has(ROOT)).toBeTrue()
        const completed = [...submitted, { ...partial.at(-1)!, preview: "complete", turnComplete: true }]
        state = readReplacement(state, completed)
        expect(state.pendingCompletions.size).toBe(0)
        expect(state.unviewedSessionIds.has(ROOT)).toBeTrue()
        expect(projectGraphViewModel(state, ROOT).nodes.map((node) => node._tag === "Message" ? node.role : node.status))
          .toEqual(["user", "agent", "user", "agent", "unviewed"])
      })
    }
  }

  for (const activity of ["working", "blocked", "idle"] as const) {
    for (const userAccepted of [false, true]) {
      test(`compaction updates replacement prefix metadata (${activity}, user accepted: ${userAccepted})`, () => {
        let state = observe(liveRewindState(), { _tag: "Submission", text: "later" })
        state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
          ownerId: "owner", activity, wasVisible: false })
        const submitted = [...original.slice(0, 2), message("replacement", "user", "later", 2)]
        if (userAccepted) state = readReplacement(state, submitted)
        const historical = submitted.map((entry) => ({ ...entry, historical: true as const }))
        const partial = [...historical, { ...message("answer", "agent", "partial", 3), turnComplete: false }]
        state = readReplacement(state, partial)
        expect(selectProjectedTranscript(state, ROOT)).toEqual(historical)
        expect(state.rewindAnchors.size).toBe(0)
        expect(state.unviewedSessionIds.size).toBe(0)
        expect(projectGraphViewModel(state, ROOT).nodes.map((node) => node._tag === "Message" ? node.role : node.status))
          .toEqual(["user", "agent", "user", activity === "blocked" ? "blocked" : "working"])
        if (activity === "idle") expect(state.pendingCompletions.get(ROOT)?.baseline).toEqual(historical)
        else state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
          ownerId: "owner", activity: "idle", wasVisible: false })
        const version = state.pendingCompletions.get(ROOT)!.version
        const refresh: ActiveRefresh = {
          ...activeRefresh("completion", state.refresh.generation + 1, "completion", "incremental"),
          sessionIds: new Set([ROOT]), completionVersion: version,
        }
        state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
        // Context classification may change again without changing the logical user prefix.
        const pending = [...submitted, partial.at(-1)!]
        state = reduceApplicationState(state, { _tag: "RefreshSucceeded", key: refresh.key, generation: refresh.generation,
          snapshot: snapshot(session(ROOT, "Root"), pending) })
        expect(state.pendingCompletions.get(ROOT)).toMatchObject({ version, attempt: 1, baseline: submitted })
        expect(selectProjectedTranscript(state, ROOT)).toEqual(submitted)
        const completed = [...historical, { ...partial.at(-1)!, preview: "complete", turnComplete: true }]
        state = readReplacement(state, completed)
        expect(selectProjectedTranscript(state, ROOT)).toEqual(completed)
        expect(state.pendingCompletions.size).toBe(0)
        expect(state.unviewedSessionIds.has(ROOT)).toBeTrue()
        expect(state.modal).toBeNull()
      })
    }
  }

  test("historical reclassification alone does not complete an older turn", () => {
    const baseline = original.slice(0, 2)
    let state: ApplicationState = { ...loadedState(baseline),
      terminals: new Map([[ROOT, { ownerId: "owner", activity: "working", phase: "running" }]]) }
    state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
      ownerId: "owner", activity: "idle", wasVisible: false })
    const historical = baseline.map((entry) => ({ ...entry, historical: true as const }))
    state = readReplacement(state, historical)
    expect(state.pendingCompletions.get(ROOT)?.baseline).toEqual(historical)
    expect(selectProjectedTranscript(state, ROOT)).toEqual(historical)
    expect(state.replacementCandidates.size).toBe(0)
    expect(state.unviewedSessionIds.size).toBe(0)
    expect(selectSessionStatus(state, ROOT)).toBe("working")
  })

  test("rewind replacement rejects changed retained identities and compaction omissions", () => {
    let state = observe(liveRewindState(), { _tag: "Submission", text: "edited" })
    state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
      ownerId: "owner", activity: "working", wasVisible: false })
    const replacement = message("edited", "user", "edited", 2)
    for (const invalid of [
      [{ ...original[0]!, id: "different-identity" }, original[1]!, replacement],
      [original[1]!, replacement],
      [{ ...original[0]!, copyIdentity: "changed-payload" }, original[1]!, replacement],
    ]) {
      state = readReplacement(state, invalid)
      expect(state.provider.transcripts.get(ROOT)).toEqual(available(original))
      expect(state.rewindAnchors.get(ROOT)?.targetMessageId).toBe("q2")
      expect(selectProjectedTranscript(state, ROOT)).toEqual(original.slice(0, 2))
    }
    state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
      ownerId: "owner", activity: "idle", wasVisible: false })
    const historical = original.slice(0, 2).map((entry) => ({ ...entry, historical: true as const }))
    const answer = { ...message("answer", "agent", "complete", 3), turnComplete: true }
    for (const invalid of [
      [{ ...historical[0]!, preview: "different content" }, historical[1]!, replacement, answer],
      [{ ...historical[0]!, copyIdentity: "different payload" }, historical[1]!, replacement, answer],
      [{ ...historical[0]!, id: "different identity" }, historical[1]!, replacement, answer],
      [...historical, { ...original[2]!, historical: true as const }, answer],
    ]) {
      state = readReplacement(state, invalid)
      expect(selectProjectedTranscript(state, ROOT)).toEqual(original.slice(0, 2))
      expect(state.pendingCompletions.has(ROOT)).toBeTrue()
      expect(state.rewindAnchors.get(ROOT)?.targetMessageId).toBe("q2")
      expect(state.unviewedSessionIds.size).toBe(0)
    }
  })

  test("accepting a replacement user retains independently copied fork history", () => {
    const copies = original.map((entry) => ({ ...entry, id: `child-${entry.id}` }))
    let state = reduceApplicationState(liveRewindState(), {
      _tag: "PersistedBranchProjected", session: session("child", "Child"), transcript: available(copies),
      relation: { childSessionId: "child", parentSessionId: ROOT, sourceMessageId: "q2",
        sharedMessages: original.map((entry, index) => ({ parentMessageId: entry.id, childMessageId: copies[index]!.id })),
        createdAt: "2026-09-01T00:00:00.000Z" },
    })
    state = observe(state, { _tag: "Submission", text: "edited" })
    state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT,
      ownerId: "owner", activity: "working", wasVisible: false })
    state = readReplacement(state, [...original.slice(0, 2), message("edited", "user", "edited", 2)])
    const graph = projectGraphViewModel(state, ROOT)
    const edited = graph.nodes.find((node) => node._tag === "Message" && node.preview === "edited")!
    const copied = graph.nodes.find((node) => node._tag === "Message" && node.preview === "later")!
    const endpoint = graph.nodes.find((node) => node._tag === "Endpoint" && node.session.id === ROOT)!
    expect(edited.parentIds).toEqual(copied.parentIds)
    expect(endpoint.parentIds).toEqual([edited.id])
    expect(selectProjectedTranscript(state, "child")).toEqual(copies)
  })

  test("owner-checked observations distinguish unknown screens, empty composers, and submissions", () => {
    let state = liveRewindState()
    const stale = observe(state, { _tag: "Submission", text: "stale" }, "old-owner")
    expect(stale).toBe(state)
    const observer = new ClaudeTerminalObserver()
    const unknown = observer.observeDraft({ lines: ["unrecognized screen"], cursor: { x: 0, y: 0, visible: false } })
    expect(unknown).toBeUndefined()
    // Unknown screens emit no observation; a positively empty composer clears only its preview.
    state = observe(state, { _tag: "Draft", draft: null })
    expect(state.drafts.has(ROOT)).toBeFalse()
    expect(state.rewindAnchors.get(ROOT)?.submitted).toBeFalse()
    state = observe(state, { _tag: "Submission", text: "edited" })
    expect(state.rewindAnchors.get(ROOT)).toMatchObject({ submitted: true, submissionText: "edited" })
    state = observe(state, { _tag: "Submission", text: "" })
    expect(state.rewindAnchors.get(ROOT)?.submissionText).toBe("")
    state = observe(state, { _tag: "Submission" })
    expect(state.rewindAnchors.get(ROOT)?.submissionText).toBeUndefined()
    expect(state.rewindAnchors.size).toBe(1)
    state = reduceApplicationState(state, {
      _tag: "TerminalReturned", sessionId: ROOT,
      draft: { text: "stale return", exact: false, rewind: true },
    })
    expect(state.drafts.has(ROOT)).toBeFalse()
    expect(state.rewindAnchors.get(ROOT)?.submitted).toBeTrue()
  })

  test("terminal return cannot replace a newer semantic draft or create rewind evidence", () => {
    let state = liveRewindState()
    const draft = state.drafts.get(ROOT)
    state = reduceApplicationState(state, {
      _tag: "TerminalReturned", sessionId: ROOT, draft: { text: "stale", exact: false },
    })
    expect(state.drafts.get(ROOT)).toBe(draft)
    const presentationOnly = reduceApplicationState(loadedState(original), {
      _tag: "TerminalReturned", sessionId: ROOT, draft: { text: "later", exact: false, rewind: true },
    })
    expect(presentationOnly.rewindAnchors.size).toBe(0)
    expect(selectProjectedTranscript(presentationOnly, ROOT)).toEqual(original)
  })

  test("accepted working user prefixes can be undone before response completion", () => {
    let state = observe(liveRewindState(), { _tag: "Submission", text: "edited" })
    state = reduceApplicationState(state, {
      _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner", activity: "working", wasVisible: false,
    })
    const replacement = [...original.slice(0, 2), message("edited", "user", "edited", 2)]
    state = readReplacement(state, replacement)
    expect(state.provider.transcripts.get(ROOT)).toEqual(available(replacement))
    expect(state.rewindAnchors.has(ROOT)).toBeFalse()
    expect(selectProjectedTranscript(state, ROOT)).toEqual(replacement)
    state = observe(state, { _tag: "Draft", draft: { text: "edited", exact: false, rewind: true } })
    expect(state.pendingCompletions.size).toBe(0)
    expect(state.terminals.get(ROOT)?.activity).toBe("idle")
    expect(state.rewindAnchors.get(ROOT)).toMatchObject({ targetMessageId: "edited", submitted: false })
    expect(selectProjectedTranscript(state, ROOT)).toEqual(original.slice(0, 2))
  })

  for (const mode of ["full", "incremental"] as const) {
    test(`a deferred ${mode} read cannot resurrect a replacement after re-undo`, () => {
      let state = observe(liveRewindState(), { _tag: "Submission", text: "edited" })
      state = reduceApplicationState(state, {
        _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner", activity: "idle", wasVisible: false,
      })
      const refresh: ActiveRefresh = {
        ...activeRefresh("deferred", 1, "completion", mode), sessionIds: new Set([ROOT, "other"]),
        completionVersion: state.pendingCompletions.get(ROOT)!.version,
      }
      state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
      const captured = state.refresh.active.get(refresh.key)!
      expect(captured.historyRevisions?.get(ROOT)).toEqual({ ownerId: "owner", revision: 2 })
      expect(refresh.historyRevisions).toBeUndefined()
      expect(invalidatedRefreshSessionIds(state, captured).size).toBe(0)
      state = observe(state, { _tag: "Draft", draft: { text: "edited", exact: false, rewind: true } })
      expect(state.pendingCompletions.size).toBe(0)
      expect(invalidatedRefreshSessionIds(state, captured)).toEqual(new Set([ROOT]))
      const before = state
      const replacement = [...original.slice(0, 2), message("edited", "user", "edited", 2),
        { ...message("answer", "agent", "stale answer", 3), turnComplete: true }]
      state = reduceApplicationState(state, {
        _tag: "RefreshSucceeded", key: refresh.key, generation: refresh.generation,
        snapshot: {
          sessions: [session(ROOT, "Stale title"), session("other", "Fresh unrelated session")],
          transcripts: new Map([[ROOT, available(replacement)], ["other", available([])]]),
        },
      })
      expect(state.provider.sessions.get(ROOT)).toBe(before.provider.sessions.get(ROOT))
      expect(state.provider.transcripts.get(ROOT)).toBe(before.provider.transcripts.get(ROOT))
      expect(state.rewindAnchors.get(ROOT)).toBe(before.rewindAnchors.get(ROOT))
      expect(state.drafts.get(ROOT)).toBe(before.drafts.get(ROOT))
      expect(selectProjectedTranscript(state, ROOT)).toEqual(original.slice(0, 2))
      expect(state.refresh.appliedGenerationBySession.has(ROOT)).toBeFalse()
      expect(state.provider.sessions.get("other")?.title).toBe("Fresh unrelated session")
      expect(state.refresh.appliedGenerationBySession.get("other")).toBe(1)
      expect(state.pendingCompletions.size).toBe(0)
      expect(state.unviewedSessionIds.size).toBe(0)
      expect(state.refresh.active.size).toBe(0)
      state = readReplacement(state, original.slice(0, 2))
      expect(state.provider.transcripts.get(ROOT)).toEqual(available(original.slice(0, 2)))
      expect(state.rewindAnchors.size).toBe(0)
      expect(state.drafts.get(ROOT)?.text).toBe("edited")
    })
  }

  test("only submissions and unsubmitted rewind drafts advance history revisions", () => {
    let state = liveRewindState()
    expect(state.terminals.get(ROOT)?.historyRevision).toBe(1)
    const refresh = activeRefresh("read", 1, "manual", "full")
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
    const captured = state.refresh.active.get(refresh.key)!
    for (const draft of [null, { text: "typing", exact: false }, { text: "sent", exact: false, rewind: true, submitted: true }]) {
      state = observe(state, { _tag: "Draft", draft })
      expect(state.terminals.get(ROOT)?.historyRevision).toBe(1)
      expect(invalidatedRefreshSessionIds(state, captured).size).toBe(0)
    }
    expect(observe(state, { _tag: "Submission" }, "stale-owner")).toBe(state)
    state = observe(state, { _tag: "Submission" })
    expect(state.terminals.get(ROOT)?.historyRevision).toBe(2)
    expect(invalidatedRefreshSessionIds(state, captured)).toEqual(new Set([ROOT]))
  })

  test("an old owner read cannot complete a replacement owner's equally numbered revision", () => {
    let state = observe({
      ...loadedState(),
      terminals: new Map([[ROOT, { ownerId: "owner", activity: "idle", phase: "running" }]]),
    }, { _tag: "Submission", text: "first send" })
    state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner",
      activity: "idle", wasVisible: false })
    const refresh: ActiveRefresh = {
      ...activeRefresh("old-owner", 1, "completion", "incremental"), sessionIds: new Set([ROOT]),
      completionVersion: state.pendingCompletions.get(ROOT)!.version,
    }
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
    const captured = state.refresh.active.get(refresh.key)!
    state = reduceApplicationState(state, { _tag: "TerminalStopped", sessionId: ROOT })
    state = reduceApplicationState(state, { _tag: "TerminalShown", sessionId: ROOT, ownerId: "replacement-owner",
      returnTo: { _tag: "Roots", selectedSessionId: ROOT } })
    state = observe(state, { _tag: "Submission", text: "second send" }, "replacement-owner")
    state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "replacement-owner",
      activity: "idle", wasVisible: false })
    expect(state.terminals.get(ROOT)?.historyRevision).toBe(captured.historyRevisions?.get(ROOT)?.revision)
    expect(invalidatedRefreshSessionIds(state, captured)).toEqual(new Set([ROOT]))
    const completion = state.pendingCompletions.get(ROOT)
    const transcript = state.provider.transcripts.get(ROOT)
    state = reduceApplicationState(state, { _tag: "RefreshSucceeded", key: refresh.key, generation: 1,
      snapshot: snapshot(session(ROOT, "Old owner title"), [message("q", "user", "question", 0),
        { ...message("a", "agent", "old answer", 1), turnComplete: true }]) })
    expect(state.pendingCompletions.get(ROOT)).toBe(completion)
    expect(state.pendingCompletions.get(ROOT)?.attempt).toBe(0)
    expect(state.provider.transcripts.get(ROOT)).toBe(transcript)
    expect(state.provider.sessions.get(ROOT)?.title).toBe("Root")
    expect(state.unviewedSessionIds.size).toBe(0)
  })

  for (const mode of ["full", "incremental"] as const) {
    test(`a wholly invalidated ${mode} failure only removes its refresh`, () => {
      for (const completionRead of [false, true]) {
        let state = observe(liveRewindState(), { _tag: "Submission", text: "edited" })
        state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner",
          activity: "idle", wasVisible: false })
        const refresh: ActiveRefresh = {
          ...activeRefresh("failed", 1, completionRead ? "completion" : "manual", mode), sessionIds: new Set([ROOT]),
          ...(completionRead ? { completionVersion: state.pendingCompletions.get(ROOT)!.version } : {}),
        }
        state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
        state = observe(state, { _tag: "Draft", draft: { text: "edited", exact: false, rewind: true } })
        state = observe(state, { _tag: "Submission", text: "new edit" })
        state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner",
          activity: "idle", wasVisible: false })
        state = { ...state, replacementCandidates: new Map([[ROOT, { messages: original.slice(0, 2), attempts: 1 }]]) }
        const before = state
        state = reduceApplicationState(state, { _tag: "RefreshFailed", key: refresh.key, generation: 1, message: "obsolete read failure" })
        expect(state.refresh.active.size).toBe(0)
        expect(state.rewindAnchors).toBe(before.rewindAnchors)
        expect(state.drafts).toBe(before.drafts)
        expect(state.replacementCandidates).toBe(before.replacementCandidates)
        expect(state.pendingCompletions).toBe(before.pendingCompletions)
        expect(state.provider).toBe(before.provider)
        expect(state.modal).toBeNull()
      }
    })
  }

  test("a partially invalidated full failure still reports unaffected session errors", () => {
    for (const completionRead of [false, true]) {
      let state = observe(liveRewindState(), { _tag: "Submission", text: "edited" })
      state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner",
        activity: "idle", wasVisible: false })
      state = { ...state, provider: { ...state.provider,
        sessions: new Map(state.provider.sessions).set("other", session("other", "Other")) } }
      const refresh: ActiveRefresh = {
        ...activeRefresh("full-failed", 1, completionRead ? "completion" : "manual", "full"),
        sessionIds: new Set([ROOT]),
        ...(completionRead ? { completionVersion: state.pendingCompletions.get(ROOT)!.version } : {}),
      }
      state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
      expect(state.refresh.active.get(refresh.key)?.historyRevisions?.get("other")).toEqual({ revision: 0 })
      state = observe(state, { _tag: "Submission", text: "new edit" })
      state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner",
        activity: "idle", wasVisible: false })
      const candidate = { messages: original.slice(0, 2), attempts: 1 }
      state = { ...state, replacementCandidates: new Map([[ROOT, candidate], ["other", candidate]]) }
      const before = state
      state = reduceApplicationState(state, { _tag: "RefreshFailed", key: refresh.key, generation: 1, message: "provider unavailable" })
      expect(state.refresh.active.size).toBe(0)
      expect(state.replacementCandidates.get(ROOT)).toBe(candidate)
      expect(state.replacementCandidates.has("other")).toBeFalse()
      expect(state.pendingCompletions).toBe(before.pendingCompletions)
      expect(state.rewindAnchors).toBe(before.rewindAnchors)
      expect(state.modal).toEqual({ _tag: "Error", message: "provider unavailable" })
    }
  })

  test("unaffected completion failures still advance their bounded retry", () => {
    let state = pendingCompletionState()
    const refresh: ActiveRefresh = {
      ...activeRefresh("failed-completion", 1, "completion", "incremental"), sessionIds: new Set([ROOT]),
      completionVersion: state.pendingCompletions.get(ROOT)!.version,
    }
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
    state = reduceApplicationState(state, { _tag: "RefreshFailed", key: refresh.key, generation: 1, message: "read unavailable" })
    expect(state.pendingCompletions.get(ROOT)?.attempt).toBe(1)
    expect(state.modal).toBeNull()
  })

  test("revision invalidation includes removed and newly observed terminals within refresh scope", () => {
    let state = liveRewindState()
    const full = activeRefresh("full", 1, "manual", "full")
    const incremental = { ...activeRefresh("incremental", 2, "manual", "incremental"), sessionIds: new Set([ROOT]) }
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh: full })
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh: incremental })
    state = reduceApplicationState(state, { _tag: "TerminalStopped", sessionId: ROOT })
    state = reduceApplicationState(state, { _tag: "TerminalShown", sessionId: "new", ownerId: "new-owner",
      returnTo: { _tag: "Roots", selectedSessionId: ROOT } })
    state = reduceApplicationState(state, { _tag: "TerminalObservationObserved", sessionId: "new", ownerId: "new-owner",
      observation: { _tag: "Submission" } })
    expect(invalidatedRefreshSessionIds(state, state.refresh.active.get("full")!)).toEqual(new Set([ROOT, "new"]))
    expect(invalidatedRefreshSessionIds(state, state.refresh.active.get("incremental")!)).toEqual(new Set([ROOT]))
  })

  for (const rewind of [false, true]) {
    test(`completion consumes a submitted preview without an empty composer observation (rewind: ${rewind})`, () => {
      for (const freshDraft of [false, true]) {
        let state = rewind ? liveRewindState() : {
          ...loadedState(original),
          terminals: new Map([[ROOT, { ownerId: "owner", activity: "idle" as const, phase: "running" as const }]]),
        }
        if (!rewind) state = observe(state, { _tag: "Draft", draft: { text: "edited", exact: false } })
        state = observe(state, { _tag: "Submission", text: "edited" })
        state = reduceApplicationState(state, {
          _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner", activity: "idle", wasVisible: false,
        })
        expect(state.drafts.get(ROOT)?.submitted).toBeTrue()
        const refresh = activeRefresh("completion", 1, "manual", "full")
        state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
        const observer = new ClaudeTerminalObserver()
        expect(observer.observeDraft({ lines: ["unreadable composer"], cursor: { x: 0, y: 0, visible: false } })).toBeUndefined()
        if (freshDraft) state = observe(state, { _tag: "Draft", draft: { text: "next prompt", exact: false } })
        const prefix = rewind ? original.slice(0, 2) : original
        const completed = [...prefix, message("edited", "user", "edited", prefix.length),
          { ...message("answer", "agent", "new answer", prefix.length + 1), turnComplete: true }]
        state = reduceApplicationState(state, { _tag: "RefreshSucceeded", key: refresh.key, generation: 1,
          snapshot: snapshot(session(ROOT, "Root"), completed) })
        expect(state.pendingCompletions.size).toBe(0)
        expect(state.rewindAnchors.size).toBe(0)
        expect(state.unviewedSessionIds.has(ROOT)).toBeTrue()
        expect(state.provider.transcripts.get(ROOT)).toEqual(available(completed))
        expect(state.drafts.get(ROOT)).toEqual(freshDraft ? { text: "next prompt", exact: false } : undefined)
        state = reduceApplicationState(state, { _tag: "TerminalReturned", sessionId: ROOT,
          draft: { text: "stale submitted preview", exact: false } })
        expect(state.drafts.get(ROOT)).toEqual(freshDraft ? { text: "next prompt", exact: false } : undefined)
      }
    })
  }

  test("repeated edited resubmission undo is bounded before any provider refresh", () => {
    let state = liveRewindState()
    for (let index = 0; index < 8; index += 1) {
      const text = `edit ${index}`
      state = observe(state, { _tag: "Submission", text })
      state = observe(state, { _tag: "Draft", draft: null })
      state = reduceApplicationState(state, {
        _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner", activity: "working", wasVisible: false,
      })
      state = reduceApplicationState(state, {
        _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner", activity: "idle", wasVisible: false,
      })
      expect(state.pendingCompletions.size).toBe(1)
      state = observe(state, { _tag: "Draft", draft: { text, exact: false, rewind: true } })
      expect(state.pendingCompletions.size).toBe(0)
      expect(state.rewindAnchors.size).toBe(1)
      expect(state.rewindAnchors.get(ROOT)).toMatchObject({ targetMessageId: "q2", submitted: false, submissionText: text })
      expect(selectProjectedTranscript(state, ROOT)).toEqual(original.slice(0, 2))
    }
    state = readReplacement(state, original.slice(0, 2))
    expect(state.rewindAnchors.size).toBe(0)
    expect(state.drafts.get(ROOT)?.rewind).toBeUndefined()
    expect(state.unviewedSessionIds.size).toBe(0)
  })

  test("confirmed fork prefix has the same placement live, stopped, and after restart", () => {
    const child = "child"
    const copies = original.map((entry) => ({ ...entry, id: `child-${entry.id}` }))
    let state: ApplicationState = {
      ...loadedState(original),
      provider: {
        sessions: new Map([[ROOT, session(ROOT, "Root")], [child, session(child, "Child")]]),
        transcripts: new Map([[ROOT, available(original)], [child, available(copies)]]),
      },
      relations: [{ childSessionId: child, parentSessionId: ROOT, sourceMessageId: "q2",
        sharedMessages: original.map((entry, index) => ({ parentMessageId: entry.id, childMessageId: copies[index]!.id })),
        createdAt: "2026-09-01T00:00:00.000Z" }],
      terminals: new Map([[child, { ownerId: "owner", activity: "idle", phase: "running" }]]),
    }
    state = reduceApplicationState(state, { _tag: "TerminalObservationObserved", sessionId: child, ownerId: "owner",
      observation: { _tag: "Draft", draft: { text: "later", exact: false, rewind: true } } })
    function placement(current: ApplicationState): string | null | undefined {
      const graph = selectConversationForest(current).graphBySessionId.get(child)!
      return graph.nodes.get(graph.endpointBySessionId.get(child)!)?.parentId
    }
    const provisional = placement(state)
    expect(provisional).toBeDefined()
    const refresh = { ...activeRefresh("child", 1, "terminal-return", "incremental"), sessionIds: new Set([child]) }
    state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
    state = reduceApplicationState(state, { _tag: "RefreshSucceeded", key: refresh.key, generation: 1,
      snapshot: snapshot(session(child, "Child"), copies.slice(0, 2)) })
    expect(state.rewindAnchors.size).toBe(0)
    expect(placement(state)).toBe(provisional)
    state = reduceApplicationState(state, { _tag: "TerminalObservationObserved", sessionId: child, ownerId: "owner",
      observation: { _tag: "Submission", text: "new edited prompt" } })
    state = reduceApplicationState(state, { _tag: "TerminalObservationObserved", sessionId: child, ownerId: "owner",
      observation: { _tag: "Draft", draft: null } })
    state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: child, ownerId: "owner",
      activity: "working", wasVisible: false })
    state = reduceApplicationState(state, { _tag: "TerminalActivityObserved", sessionId: child, ownerId: "owner",
      activity: "idle", wasVisible: false })
    expect(state.pendingCompletions.has(child)).toBeTrue()
    state = reduceApplicationState(state, { _tag: "TerminalObservationObserved", sessionId: child, ownerId: "owner",
      observation: { _tag: "Draft", draft: { text: "new edited prompt", exact: false, rewind: true } } })
    expect(state.pendingCompletions.size).toBe(0)
    expect(state.rewindAnchors.size).toBe(0)
    expect(selectProjectedTranscript(state, child)).toEqual(copies.slice(0, 2))
    expect(placement(state)).toBe(provisional)
    state = reduceApplicationState(state, { _tag: "TerminalStopped", sessionId: child })
    expect(placement(state)).toBe(provisional)
    const restarted = { ...makeInitialApplicationState({ relations: state.relations }), provider: state.provider }
    expect(placement(restarted)).toBe(provisional)
  })

  test("undo after prefix confirmation anchors only a newly persisted submission", () => {
    const prefix = original.slice(0, 2)
    let state = readReplacement(liveRewindState(), prefix)
    expect(state.rewindAnchors.size).toBe(0)
    state = observe(state, { _tag: "Submission", text: "new edited prompt" })
    state = reduceApplicationState(state, {
      _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner", activity: "working", wasVisible: false,
    })
    const submitted = [...prefix, message("new-q", "user", "new edited prompt", 2)]
    state = readReplacement(state, submitted)
    expect(selectProjectedTranscript(state, ROOT)).toEqual(submitted)
    expect(state.rewindAnchors.size).toBe(0)
    state = observe(state, { _tag: "Draft", draft: { text: "new edited prompt", exact: false, rewind: true } })
    expect(state.rewindAnchors.get(ROOT)?.targetMessageId).toBe("new-q")
    expect(selectProjectedTranscript(state, ROOT)).toEqual(prefix)
    state = readReplacement(state, prefix)
    expect(state.rewindAnchors.size).toBe(0)
    expect(state.provider.transcripts.get(ROOT)).toEqual(available(prefix))
    expect(state.pendingCompletions.size).toBe(0)
    expect(state.unviewedSessionIds.size).toBe(0)
  })

  for (const native of [false, true]) {
    test(`${native ? "native" : "local"} fork distinguishes unread history from explicitly empty history`, () => {
      const child = session("child", "Child")
      const relation = {
        childSessionId: child.id, parentSessionId: ROOT, sourceMessageId: "q2",
        sharedMessages: original.map((entry) => ({ parentMessageId: entry.id, childMessageId: `child-${entry.id}` })),
        createdAt: "2026-09-01T00:00:00.000Z",
      }
      for (const transcript of [undefined, { _tag: "Missing" }, { _tag: "Unavailable", reason: "unread" }, available([])] as const) {
        let state = loadedState(original)
        if (native) {
          if (transcript !== undefined) state = reduceApplicationState(state, {
            _tag: "LocalSessionProjected", session: child, transcript,
          })
          state = reduceApplicationState(state, {
            _tag: "SessionIdentityAdopted", previousSessionId: ROOT, session: child, kind: "native-fork", relation,
          })
        } else state = reduceApplicationState(state, {
          _tag: "PersistedBranchProjected", session: child, relation,
          ...(transcript === undefined ? {} : { transcript }),
        })
        expect(state.local.transcripts.get(child.id)).toEqual(transcript)
        const graph = selectConversationForest(state).graphBySessionId.get(child.id)!
        const endpoint = graph.nodes.get(graph.endpointBySessionId.get(child.id)!)!
        const parent = graph.nodes.get(endpoint.parentId!)!
        if (transcript?._tag === "Available") expect(parent.kind).toBe("origin")
        else {
          expect(parent.kind).toBe("message")
          if (parent.kind !== "message") throw new Error("Expected recorded-source message")
          expect(parent.aliases).toContainEqual({ sessionId: ROOT, messageId: "q2" })
        }
      }
    })
  }

  test("local metadata projection preserves existing provider and local transcript evidence", () => {
    let state = reduceApplicationState(loadedState(original), { _tag: "LocalSessionProjected", session: session(ROOT, "Updated") })
    expect(state.local.transcripts.has(ROOT)).toBeFalse()
    expect(selectProjectedTranscript(state, ROOT)).toEqual(original)
    state = reduceApplicationState(state, { _tag: "LocalSessionProjected", session: session(ROOT, "Empty"), transcript: available([]) })
    state = reduceApplicationState(state, { _tag: "LocalSessionProjected", session: session(ROOT, "Updated again") })
    expect(state.local.transcripts.get(ROOT)).toEqual(available([]))
    expect(selectProjectedTranscript(state, ROOT)).toEqual([])
  })

  test("a submitted rewind confirms placement without completing the response", () => {
    let state = observe(liveRewindState(), { _tag: "Submission", text: "edited" })
    state = reduceApplicationState(state, {
      _tag: "TerminalActivityObserved", sessionId: ROOT, ownerId: "owner", activity: "idle", wasVisible: false,
    })
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const refresh: ActiveRefresh = {
        ...activeRefresh("completion", state.refresh.generation + 1, "completion", "incremental"),
        sessionIds: new Set([ROOT]), completionVersion: state.pendingCompletions.get(ROOT)!.version,
      }
      state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh })
      state = reduceApplicationState(state, { _tag: "RefreshSucceeded", key: refresh.key, generation: refresh.generation,
        snapshot: snapshot(session(ROOT, "Root"), original.slice(0, 2)) })
      expect(state.rewindAnchors.has(ROOT)).toBeFalse()
      expect(selectProjectedTranscript(state, ROOT)).toEqual(original.slice(0, 2))
    }
    expect(state.pendingCompletions.size).toBe(0)
    state = readReplacement(state, original.slice(0, 2))
    expect(state.rewindAnchors.size).toBe(0)
    expect(selectProjectedTranscript(state, ROOT)).toEqual(original.slice(0, 2))
    expect(state.unviewedSessionIds.size).toBe(0)
    expect(state.modal).toBeNull()
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
