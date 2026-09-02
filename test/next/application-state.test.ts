import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import type { AgentMessage, AgentSession, AgentSessionSnapshot } from "../../src/domain/model"
import type { ConversationRemoval } from "../../src/domain/persistence"
import {
  available,
  makeApplicationCoordinator,
  makeInitialApplicationState,
  projectApplicationViewModel,
  projectGraphViewModel,
  projectRootsViewModel,
  reduceApplicationState,
  selectProjectedTranscript,
  selectSessionStatus,
  selectTranscriptRead,
  type ApplicationState,
  type AppEvent,
} from "../../src/application"

const ROOT = "root"
const CHILD = "child"

describe("application reducer", () => {
  test("ignores stale refresh results and accepts only the latest generation", () => {
    const initial = makeInitialApplicationState()
    const first = reduceApplicationState(initial, { _tag: "RefreshRequested", reason: "initial" })
    const second = reduceApplicationState(first.state, { _tag: "RefreshRequested", reason: "manual" })

    const stale = reduceApplicationState(second.state, {
      _tag: "RefreshSucceeded",
      generation: 1,
      snapshot: snapshot(session("stale", "Stale"), [message("stale-message", "user", "stale", 0)]),
    })
    expect(stale.state).toBe(second.state)
    expect(stale.state.provider.sessions.has("stale")).toBeFalse()

    const latest = reduceApplicationState(stale.state, {
      _tag: "RefreshSucceeded",
      generation: 2,
      snapshot: snapshot(session(ROOT, "Latest"), [message("question", "user", "latest", 0)]),
    })
    expect(latest.state.provider.sessions.get(ROOT)?.title).toBe("Latest")
    expect(latest.state.refresh.active).toBeNull()
  })

  test("adopts a temporary identity atomically across every session-keyed collection", () => {
    const temporaryId = "temporary"
    const realId = "provider-id"
    const removal: ConversationRemoval = {
      kind: "subtree",
      target: { kind: "endpoint", sessionId: temporaryId, afterMessageId: null },
      createdAt: "now",
    }
    const base = makeInitialApplicationState({
      relations: [{
        childSessionId: temporaryId,
        parentSessionId: ROOT,
        sourceMessageId: "source",
        sharedMessages: [],
        createdAt: "now",
      }],
      removals: [removal],
      surface: {
        _tag: "Terminal",
        sessionId: temporaryId,
        returnTo: {
          _tag: "Graph",
          familySessionId: ROOT,
          target: { kind: "endpoint", sessionId: temporaryId },
        },
      },
    })
    const temporary = session(temporaryId, "Temporary", true)
    const seeded: ApplicationState = {
      ...base,
      provider: {
        sessions: new Map([[temporaryId, temporary]]),
        transcripts: new Map([[temporaryId, available([message("m", "user", "draft", 0)])]]),
      },
      local: {
        sessions: new Map([[temporaryId, temporary]]),
        transcripts: new Map([[temporaryId, available([])]]),
        temporarySessionIds: new Set([temporaryId]),
      },
      modal: {
        _tag: "ConfirmRemoval",
        requestId: "remove",
        removal,
        affectedSessionIds: [temporaryId],
      },
      terminals: new Map([[temporaryId, { activity: "blocked", phase: "running" }]]),
      drafts: new Map([[temporaryId, { text: "draft", exact: false }]]),
      rewindAnchors: new Map([[temporaryId, { targetMessageId: "m", submitted: true }]]),
      pendingCompletions: new Map([[
        temporaryId,
        { version: 4, baseline: [], markUnviewed: true, attempt: 1 },
      ]]),
      unviewedSessionIds: new Set([temporaryId]),
      pendingRemovals: new Map([[
        "remove",
        { removal, waitingForSessionIds: new Set([temporaryId]) },
      ]]),
      refresh: {
        generation: 3,
        initialPending: false,
        active: {
          generation: 3,
          reason: "completion",
          mode: "incremental",
          focusSessionId: temporaryId,
          sessionIds: new Set([temporaryId]),
          completionVersions: new Map([[temporaryId, 4]]),
        },
      },
    }

    const requested = reduceApplicationState(seeded, {
      _tag: "SessionIdentityAdoptionRequested",
      temporarySessionId: temporaryId,
      session: session(realId, "Persisted"),
    })
    expect(requested.state.local.sessions.has(temporaryId)).toBeTrue()
    expect(requested.commands).toEqual([{
      _tag: "AdoptSessionIdentity",
      temporarySessionId: temporaryId,
      session: session(realId, "Persisted"),
    }])
    const adopted = reduceApplicationState(requested.state, {
      _tag: "SessionIdentityAdopted",
      temporarySessionId: temporaryId,
      session: session(realId, "Persisted"),
    })
    const state = adopted.state
    for (const collection of [
      state.provider.sessions,
      state.provider.transcripts,
      state.local.sessions,
      state.local.transcripts,
      state.terminals,
      state.drafts,
      state.rewindAnchors,
      state.pendingCompletions,
    ]) {
      expect(collection.has(temporaryId)).toBeFalse()
      expect(collection.has(realId)).toBeTrue()
    }
    expect(state.local.temporarySessionIds).toEqual(new Set())
    expect(state.unviewedSessionIds).toEqual(new Set([realId]))
    expect(state.relations[0]?.childSessionId).toBe(realId)
    expect(state.removals[0]?.kind === "subtree" && state.removals[0].target.kind === "endpoint"
      ? state.removals[0].target.sessionId
      : undefined).toBe(realId)
    expect(state.surface._tag === "Terminal" ? state.surface.sessionId : undefined).toBe(realId)
    expect(state.refresh.active?.focusSessionId).toBe(realId)
    expect(state.refresh.active?.sessionIds).toEqual(new Set([realId]))
    expect(state.refresh.active?.completionVersions.has(realId)).toBeTrue()
    expect(state.pendingRemovals.get("remove")?.waitingForSessionIds).toEqual(new Set([realId]))
    expect(adopted.commands[0]?._tag).toBe("PersistNavigation")
    expect(adopted.commands[1]).toMatchObject({
      _tag: "RefreshProvider",
      generation: 4,
      focusSessionId: realId,
    })
    const stale = reduceApplicationState(adopted.state, {
      _tag: "RefreshSucceeded",
      generation: 3,
      snapshot: snapshot(temporary, []),
    })
    expect(stale.state).toBe(adopted.state)
  })

  test("stabilizes each completed session until a completed transcript advances", () => {
    const question = message("q", "user", "question", 0)
    let state = loadedState(session(ROOT, "Root"), [question])
    state = reduceApplicationState(state, {
      _tag: "TerminalActivityChanged",
      sessionId: ROOT,
      activity: "idle",
      wasVisible: false,
    }).state
    const pending = state.pendingCompletions.get(ROOT)!
    expect(selectSessionStatus(state, ROOT)).toBe("working")

    let due = reduceApplicationState(state, {
      _tag: "CompletionRefreshDue",
      sessionId: ROOT,
      version: pending.version,
    })
    let unchanged = reduceApplicationState(due.state, {
      _tag: "RefreshSucceeded",
      generation: due.state.refresh.generation,
      snapshot: snapshot(session(ROOT, "Root"), [question]),
    })
    expect(unchanged.state.pendingCompletions.get(ROOT)?.attempt).toBe(1)
    expect(unchanged.commands[0]?._tag).toBe("ScheduleCompletionRefresh")
    expect(unchanged.state.unviewedSessionIds.has(ROOT)).toBeFalse()

    due = reduceApplicationState(unchanged.state, {
      _tag: "CompletionRefreshDue",
      sessionId: ROOT,
      version: pending.version,
    })
    const completed = reduceApplicationState(due.state, {
      _tag: "RefreshSucceeded",
      generation: due.state.refresh.generation,
      snapshot: snapshot(session(ROOT, "Root"), [
        question,
        message("a", "agent", "answer", 1, true),
      ]),
    })
    expect(completed.state.pendingCompletions.has(ROOT)).toBeFalse()
    expect(completed.state.unviewedSessionIds.has(ROOT)).toBeTrue()
    expect(selectSessionStatus(completed.state, ROOT)).toBe("unviewed")
  })

  test("projects a captured rewind immediately and clears it after provider confirmation", () => {
    const transcript = [
      message("q1", "user", "first", 0),
      message("a1", "agent", "first answer", 1, true),
      message("q2", "user", "rewind here", 2),
      message("a2", "agent", "old answer", 3, true),
    ]
    let state = loadedState(session(ROOT, "Root"), transcript)
    state = reduceApplicationState(state, {
      _tag: "TerminalDraftObserved",
      sessionId: ROOT,
      draft: {
        text: "edited prompt",
        exact: false,
        rewind: true,
        rewindTarget: "rewind here",
      },
    }).state
    expect(state.rewindAnchors.get(ROOT)?.targetMessageId).toBe("q2")
    expect(selectProjectedTranscript(state, ROOT).map((item) => item.id)).toEqual(["q1", "a1"])

    const refresh = reduceApplicationState(state, {
      _tag: "RefreshRequested",
      reason: "terminal-return",
      sessionIds: new Set([ROOT]),
    })
    const confirmed = reduceApplicationState(refresh.state, {
      _tag: "RefreshSucceeded",
      generation: refresh.state.refresh.generation,
      snapshot: snapshot(session(ROOT, "Root"), [message("new", "user", "new path", 0)]),
    })
    expect(confirmed.state.rewindAnchors.has(ROOT)).toBeFalse()
    expect(selectProjectedTranscript(confirmed.state, ROOT).map((item) => item.id)).toEqual(["new"])
  })

  test("does not apply a removal until every affected live terminal has stopped", () => {
    const removal: ConversationRemoval = {
      kind: "tree",
      rootSessionId: ROOT,
      memberSessionIds: [ROOT, CHILD],
      createdAt: "now",
    }
    const seeded: ApplicationState = {
      ...makeInitialApplicationState(),
      terminals: new Map([
        [ROOT, { activity: "idle", phase: "running" }],
        [CHILD, { activity: "working", phase: "running" }],
      ]),
    }
    const requested = reduceApplicationState(seeded, {
      _tag: "RemovalRequested",
      requestId: "remove",
      removal,
      affectedSessionIds: [ROOT, CHILD],
    })
    expect(requested.state.removals).toEqual([])
    expect(requested.commands.map((command) => command._tag)).toEqual(["StopSession", "StopSession"])

    const firstStopped = reduceApplicationState(requested.state, {
      _tag: "TerminalStopped",
      sessionId: ROOT,
    })
    expect(firstStopped.commands).toEqual([{
      _tag: "RefreshProvider",
      generation: 1,
      mode: "incremental",
      reason: "stop",
      focusSessionId: ROOT,
      sessionIds: new Set([ROOT]),
    }])
    expect(firstStopped.state.removals).toEqual([])

    const allStopped = reduceApplicationState(firstStopped.state, {
      _tag: "TerminalStopped",
      sessionId: CHILD,
    })
    expect(allStopped.commands[0]).toEqual({ _tag: "PersistRemoval", requestId: "remove", removal })
    expect(allStopped.commands[1]).toMatchObject({
      _tag: "RefreshProvider",
      reason: "stop",
      focusSessionId: CHILD,
    })
    expect(allStopped.state.removals).toEqual([])

    const persisted = reduceApplicationState(allStopped.state, {
      _tag: "RemovalPersisted",
      requestId: "remove",
    })
    expect(persisted.state.removals).toEqual([removal])
  })

  test("reveals the locally projected graph before requesting return refresh", () => {
    const temporary = session("temporary", "New session", true)
    let state = reduceApplicationState(makeInitialApplicationState(), {
      _tag: "LocalSessionProjected",
      session: temporary,
      temporary: true,
    }).state
    const showing = reduceApplicationState(state, {
      _tag: "TerminalShowRequested",
      sessionId: temporary.id,
      reportFailure: true,
    })
    expect(showing.state.surface).toMatchObject({
      _tag: "Terminal",
      sessionId: temporary.id,
    })
    expect(showing.commands).toEqual([{ _tag: "ShowTerminal", sessionId: temporary.id }])
    state = reduceApplicationState(showing.state, {
      _tag: "TerminalShowSucceeded",
      sessionId: temporary.id,
    }).state

    const returned = reduceApplicationState(state, {
      _tag: "TerminalReturned",
      sessionId: temporary.id,
      draft: { text: "local draft", exact: false },
    })
    expect(returned.state.surface._tag).toBe("Graph")
    const graph = projectApplicationViewModel(returned.state).surface
    expect(graph._tag).toBe("Graph")
    expect(graph._tag === "Graph" ? graph.nodes.some(
      (node) => node._tag === "Endpoint" && node.session.id === temporary.id,
    ) : false).toBeTrue()
    expect(returned.commands.map((command) => command._tag)).toEqual([
      "PersistNavigation",
      "RefreshProvider",
    ])
    expect(returned.commands[1]).toMatchObject({
      _tag: "RefreshProvider",
      reason: "terminal-return",
      focusSessionId: temporary.id,
    })
  })

  test("projects graph nodes and layout from the canonical conversation graph", () => {
    const relation = {
      childSessionId: CHILD,
      parentSessionId: ROOT,
      sourceMessageId: "q",
      sharedMessages: [],
      createdAt: "now",
    }
    const loaded = loadedState(
      [session(ROOT, "Root"), session(CHILD, "Fork")],
      new Map([
        [ROOT, [message("q", "user", "source", 0)]],
        [CHILD, []],
      ]),
      [relation],
    )
    const state: ApplicationState = {
      ...loaded,
      terminals: new Map([[CHILD, { activity: "idle", phase: "running" }]]),
    }
    const graph = projectGraphViewModel(state, ROOT)
    const source = graph.nodes.find((node) => node._tag === "Message")
    const endpoint = graph.nodes.find(
      (node) => node._tag === "Endpoint" && node.session.id === CHILD,
    )
    expect(source).toBeDefined()
    expect(endpoint).toBeDefined()
    if (!source || !endpoint) throw new Error("Expected fork source and endpoint")
    expect(endpoint.parentIds).toEqual([])
    expect(endpoint.x).toBeNumber()
    expect(endpoint.y).toBeNumber()
  })

  test("keeps saved endpoints canonically reachable while hiding them from graph layout", () => {
    const state: ApplicationState = {
      ...loadedState(session(ROOT, "Saved"), [message("q", "user", "question", 0)]),
      surface: {
        _tag: "Graph",
        familySessionId: ROOT,
        target: {
          kind: "message",
          preferred: { sessionId: ROOT, messageId: "q" },
          aliases: [],
        },
      },
    }
    const graph = projectGraphViewModel(state, ROOT)
    const question = graph.nodes.find((node) => node._tag === "Message")
    if (!question) throw new Error("Expected projected question")

    expect(graph.nodes.some((node) => node._tag === "Endpoint")).toBeFalse()
    expect(question?.reachableEndpoints.map((endpoint) => ({
      sessionId: endpoint.session.id,
      distance: endpoint.distance,
      visibleNodeId: endpoint.visibleNodeId,
    }))).toEqual([{
      sessionId: ROOT,
      distance: 1,
      visibleNodeId: question.id,
    }])
  })

  test("prioritizes blocked over unviewed over working for sessions and roots", () => {
    const relation = {
      childSessionId: CHILD,
      parentSessionId: ROOT,
      sourceMessageId: "q",
      sharedMessages: [],
      createdAt: "now",
    }
    let state = loadedState(
      [session(ROOT, "Root"), session(CHILD, "Child")],
      new Map([
        [ROOT, [message("q", "user", "question", 0)]],
        [CHILD, [message("cq", "user", "child", 0)]],
      ]),
      [relation],
    )
    state = {
      ...state,
      terminals: new Map([
        [ROOT, { activity: "working", phase: "running" }],
        [CHILD, { activity: "blocked", phase: "running" }],
      ]),
      unviewedSessionIds: new Set([ROOT]),
    }
    expect(selectSessionStatus(state, ROOT)).toBe("unviewed")
    expect(selectSessionStatus(state, CHILD)).toBe("blocked")
    expect(projectRootsViewModel(state)[0]?.status).toBe("blocked")

    state = { ...state, terminals: new Map([[ROOT, { activity: "working", phase: "running" }]]) }
    expect(projectGraphViewModel(state, ROOT).status).toBe("unviewed")
  })

  test("keeps staged ancestry hidden and rolls it back when persistence fails", () => {
    const derivation = {
      childSessionId: CHILD,
      parentSessionId: ROOT,
      sourceMessageId: "q",
      sharedMessages: [],
    }
    const initial = loadedState(
      [session(ROOT, "Root"), session(CHILD, "Child")],
      new Map([
        [ROOT, [message("q", "user", "root", 0)]],
        [CHILD, [message("child-q", "user", "child", 0)]],
      ]),
    )
    const staged = reduceApplicationState(initial, { _tag: "RelationStaged", derivation })
    expect(staged.state.relations).toEqual([])
    expect(staged.state.pendingRelations.get(CHILD)).toEqual(derivation)
    expect(projectRootsViewModel(staged.state).map((root) => root.sessionId).sort()).toEqual([CHILD, ROOT])
    expect(staged.commands).toEqual([{ _tag: "PersistRelation", derivation }])

    const failed = reduceApplicationState(staged.state, {
      _tag: "RelationPersistenceFailed",
      derivation,
      message: "write failed",
    })
    expect(failed.state.pendingRelations.has(CHILD)).toBeFalse()
    expect(failed.state.relations).toEqual([])
    expect(projectRootsViewModel(failed.state).map((root) => root.sessionId).sort()).toEqual([CHILD, ROOT])

    const restaged = reduceApplicationState(failed.state, { _tag: "RelationStaged", derivation })
    const persisted = reduceApplicationState(restaged.state, {
      _tag: "RelationPersisted",
      derivation,
      createdAt: "now",
    })
    expect(persisted.state.relations).toHaveLength(1)
    expect(projectRootsViewModel(persisted.state).map((root) => root.sessionId)).toEqual([ROOT])
  })

  test("preserves complete local transcript reads", () => {
    const unavailable = { _tag: "Unavailable", reason: "provider busy" } as const
    const projected = reduceApplicationState(makeInitialApplicationState(), {
      _tag: "LocalSessionProjected",
      session: session(ROOT, "Root", true),
      transcript: unavailable,
    })
    expect(selectTranscriptRead(projected.state, ROOT)).toEqual(unavailable)
  })

  test("clears unviewed updates only after a terminal is successfully shown", () => {
    const seeded: ApplicationState = {
      ...loadedState(session(ROOT, "Root"), [message("q", "user", "question", 0)]),
      unviewedSessionIds: new Set([ROOT]),
      pendingCompletions: new Map([[
        ROOT,
        { version: 1, baseline: [], markUnviewed: true, attempt: 0 },
      ]]),
    }
    const requested = reduceApplicationState(seeded, {
      _tag: "TerminalShowRequested",
      sessionId: ROOT,
      reportFailure: true,
    })
    expect(requested.state.surface).toMatchObject({ _tag: "Terminal", sessionId: ROOT })
    expect(requested.state.unviewedSessionIds.has(ROOT)).toBeTrue()

    const failed = reduceApplicationState(requested.state, {
      _tag: "TerminalShowFailed",
      sessionId: ROOT,
      message: "cannot show",
    })
    expect(failed.state.surface).toEqual({
      _tag: "Graph",
      familySessionId: ROOT,
      target: { kind: "endpoint", sessionId: ROOT },
    })
    expect(failed.state.unviewedSessionIds.has(ROOT)).toBeTrue()
    expect(failed.state.terminals.has(ROOT)).toBeFalse()
    expect(failed.state.modal).toEqual({ _tag: "Error", message: "cannot show" })

    const retried = reduceApplicationState(failed.state, {
      _tag: "TerminalShowRequested",
      sessionId: ROOT,
      reportFailure: true,
    })
    const shown = reduceApplicationState(retried.state, {
      _tag: "TerminalShowSucceeded",
      sessionId: ROOT,
    })
    expect(shown.state.surface._tag).toBe("Terminal")
    expect(shown.state.unviewedSessionIds.has(ROOT)).toBeFalse()
    expect(shown.state.pendingCompletions.get(ROOT)?.markUnviewed).toBeFalse()
    expect(shown.commands[0]).toEqual({
      _tag: "PersistNavigation",
      navigation: { view: "terminal", sessionId: ROOT },
    })
  })

  test("returns a visibly exited terminal to the navigator and refreshes its stopped session", () => {
    const graph = {
      _tag: "Graph" as const,
      familySessionId: ROOT,
      target: { kind: "endpoint" as const, sessionId: ROOT },
    }
    const seeded: ApplicationState = {
      ...loadedState(session(ROOT, "Root"), [message("q", "user", "question", 0)]),
      surface: { _tag: "Terminal", sessionId: ROOT, returnTo: graph },
      terminals: new Map([[ROOT, { activity: "idle", phase: "running" }]]),
    }
    const exited = reduceApplicationState(seeded, {
      _tag: "TerminalExited",
      sessionId: ROOT,
      exitCode: 0,
    })
    expect(exited.state.surface).toEqual(graph)
    expect(exited.state.terminals.has(ROOT)).toBeFalse()
    expect(exited.commands[0]).toEqual({
      _tag: "PersistNavigation",
      navigation: { view: "graph", familySessionId: ROOT, target: graph.target },
    })
    expect(exited.commands[1]).toMatchObject({
      _tag: "RefreshProvider",
      reason: "stop",
      focusSessionId: ROOT,
    })
  })

  test("retains ownership as cleanup-incomplete when stopping fails", () => {
    const seeded: ApplicationState = {
      ...makeInitialApplicationState(),
      terminals: new Map([[ROOT, { activity: "working", phase: "stopping" }]]),
      unviewedSessionIds: new Set([ROOT]),
    }
    const failed = reduceApplicationState(seeded, {
      _tag: "TerminalStopFailed",
      sessionId: ROOT,
      message: "process survived",
    })
    expect(failed.state.terminals.get(ROOT)?.phase).toBe("cleanup-incomplete")
    expect(failed.state.unviewedSessionIds.has(ROOT)).toBeTrue()
  })

  test("cancels a pending removal when a required terminal stop fails", () => {
    const removal: ConversationRemoval = {
      kind: "tree",
      rootSessionId: ROOT,
      memberSessionIds: [ROOT],
      createdAt: "now",
    }
    const seeded: ApplicationState = {
      ...makeInitialApplicationState(),
      terminals: new Map([[ROOT, { activity: "working", phase: "running" }]]),
    }
    const requested = reduceApplicationState(seeded, {
      _tag: "RemovalRequested",
      requestId: "remove",
      removal,
      affectedSessionIds: [ROOT],
    })
    const failed = reduceApplicationState(requested.state, {
      _tag: "TerminalStopFailed",
      sessionId: ROOT,
      message: "process survived",
    })
    expect(failed.state.pendingRemovals.has("remove")).toBeFalse()

    const laterStopped = reduceApplicationState(failed.state, {
      _tag: "TerminalStopped",
      sessionId: ROOT,
    })
    expect(laterStopped.commands.some((command) => command._tag === "PersistRemoval")).toBeFalse()
    expect(laterStopped.state.removals).toEqual([])
  })

  test("retries stop requests already stopping or cleanup-incomplete", () => {
    for (const phase of ["stopping", "cleanup-incomplete"] as const) {
      const seeded: ApplicationState = {
        ...makeInitialApplicationState(),
        terminals: new Map([[ROOT, { activity: "idle", phase }]]),
      }
      const requested = reduceApplicationState(seeded, {
        _tag: "TerminalStopRequested",
        sessionId: ROOT,
      })
      expect(requested.commands).toEqual([{ _tag: "StopSession", sessionId: ROOT }])
      expect(requested.state.terminals.get(ROOT)?.phase).toBe(phase)
    }
  })

  test("keeps natural-exit cleanup failure as application-owned", () => {
    const graph = {
      _tag: "Graph" as const,
      familySessionId: ROOT,
      target: { kind: "endpoint" as const, sessionId: ROOT },
    }
    const seeded: ApplicationState = {
      ...loadedState(session(ROOT, "Root"), [message("q", "user", "question", 0)]),
      surface: { _tag: "Terminal", sessionId: ROOT, returnTo: graph },
      terminals: new Map([[ROOT, { activity: "idle", phase: "running" }]]),
      drafts: new Map([[ROOT, { text: "partial", exact: false }]]),
    }
    const exited = reduceApplicationState(seeded, {
      _tag: "TerminalExited",
      sessionId: ROOT,
      exitCode: 0,
      cleanupIncomplete: true,
    })
    expect(exited.state.surface).toEqual(graph)
    expect(exited.state.terminals.get(ROOT)?.phase).toBe("cleanup-incomplete")
    expect(exited.state.drafts.has(ROOT)).toBeFalse()
    expect(exited.commands[0]?._tag).toBe("PersistNavigation")
    expect(exited.commands[1]).toMatchObject({
      _tag: "RefreshProvider",
      reason: "stop",
      focusSessionId: ROOT,
    })
  })

  test("rolls a failed transient show back to the exact navigator selection", () => {
    const restoreTo = { _tag: "Roots" as const, selectedSessionId: ROOT }
    const temporary = session("temporary", "Temporary", true)
    const relation = {
      childSessionId: temporary.id,
      parentSessionId: ROOT,
      sourceMessageId: "q",
      sharedMessages: [],
      createdAt: "now",
    }
    const seeded: ApplicationState = {
      ...makeInitialApplicationState({ relations: [relation], surface: restoreTo }),
      local: {
        sessions: new Map([[temporary.id, temporary]]),
        transcripts: new Map([[temporary.id, available([])]]),
        temporarySessionIds: new Set([temporary.id]),
      },
      surface: {
        _tag: "Graph",
        familySessionId: ROOT,
        target: { kind: "endpoint", sessionId: temporary.id },
      },
      pendingRelations: new Map([[temporary.id, {
        childSessionId: temporary.id,
        parentSessionId: ROOT,
        sourceMessageId: "q",
        sharedMessages: [],
      }]]),
    }
    const rolledBack = reduceApplicationState(seeded, {
      _tag: "TransientTerminalShowRolledBack",
      sessionId: temporary.id,
      restoreTo,
    })
    expect(rolledBack.state.surface).toEqual(restoreTo)
    expect(rolledBack.state.local.sessions.has(temporary.id)).toBeFalse()
    expect(rolledBack.state.local.transcripts.has(temporary.id)).toBeFalse()
    expect(rolledBack.state.local.temporarySessionIds.has(temporary.id)).toBeFalse()
    expect(rolledBack.state.relations).toEqual([])
    expect(rolledBack.state.pendingRelations.has(temporary.id)).toBeFalse()
    expect(rolledBack.commands).toEqual([{
      _tag: "PersistNavigation",
      navigation: { view: "roots", selectedSessionId: ROOT },
    }])
  })

  test("preserves provider data for owned sessions omitted from a full snapshot", () => {
    const seeded: ApplicationState = {
      ...loadedState(session(ROOT, "Owned"), [message("q", "user", "question", 0)]),
      terminals: new Map([[ROOT, { activity: "idle", phase: "running" }]]),
    }
    const refreshing = reduceApplicationState(seeded, { _tag: "RefreshRequested", reason: "manual" })
    const refreshed = reduceApplicationState(refreshing.state, {
      _tag: "RefreshSucceeded",
      generation: refreshing.state.refresh.generation,
      snapshot: { sessions: [], transcripts: new Map() },
    })
    expect(refreshed.state.provider.sessions.get(ROOT)?.title).toBe("Owned")
    expect(selectProjectedTranscript(refreshed.state, ROOT).map((entry) => entry.id)).toEqual(["q"])
  })

  test("does not let one completion refresh strand another", () => {
    let state = loadedState(
      [session(ROOT, "Root"), session(CHILD, "Child")],
      new Map([
        [ROOT, [message("rq", "user", "root", 0)]],
        [CHILD, [message("cq", "user", "child", 0)]],
      ]),
    )
    state = reduceApplicationState(state, {
      _tag: "TerminalActivityChanged",
      sessionId: ROOT,
      activity: "idle",
      wasVisible: false,
    }).state
    state = reduceApplicationState(state, {
      _tag: "TerminalActivityChanged",
      sessionId: CHILD,
      activity: "idle",
      wasVisible: false,
    }).state
    const rootVersion = state.pendingCompletions.get(ROOT)!.version
    const childVersion = state.pendingCompletions.get(CHILD)!.version
    const rootDue = reduceApplicationState(state, {
      _tag: "CompletionRefreshDue",
      sessionId: ROOT,
      version: rootVersion,
    })
    const childDue = reduceApplicationState(rootDue.state, {
      _tag: "CompletionRefreshDue",
      sessionId: CHILD,
      version: childVersion,
    })
    expect(childDue.state.refresh.generation).toBe(rootDue.state.refresh.generation)
    expect(childDue.commands).toEqual([{
      _tag: "ScheduleCompletionRefresh",
      sessionId: CHILD,
      version: childVersion,
      attempt: 0,
    }])
  })

  test("reschedules failed completion refreshes only up to the bound", () => {
    let state = loadedState(session(ROOT, "Root"), [message("q", "user", "question", 0)])
    state = reduceApplicationState(state, {
      _tag: "TerminalActivityChanged",
      sessionId: ROOT,
      activity: "idle",
      wasVisible: false,
    }).state
    const version = state.pendingCompletions.get(ROOT)!.version
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const due = reduceApplicationState(state, {
        _tag: "CompletionRefreshDue",
        sessionId: ROOT,
        version,
      })
      const failed = reduceApplicationState(due.state, {
        _tag: "RefreshFailed",
        generation: due.state.refresh.generation,
        message: "temporary read failure",
      })
      state = failed.state
      if (attempt < 4) {
        expect(failed.commands[0]?._tag).toBe("ScheduleCompletionRefresh")
        expect(state.pendingCompletions.get(ROOT)?.attempt).toBe(attempt)
      }
    }
    expect(state.pendingCompletions.has(ROOT)).toBeFalse()
    expect(state.modal?._tag).toBe("Error")
  })

  test("emits persistence commands for navigator selection changes", () => {
    const roots = reduceApplicationState(makeInitialApplicationState(), {
      _tag: "RootsSelected",
      sessionId: ROOT,
    })
    expect(roots.commands).toEqual([{
      _tag: "PersistNavigation",
      navigation: { view: "roots", selectedSessionId: ROOT },
    }])
    const target = { kind: "endpoint" as const, sessionId: ROOT }
    const graph = reduceApplicationState(roots.state, {
      _tag: "GraphSelected",
      familySessionId: ROOT,
      target,
    })
    expect(graph.commands).toEqual([{
      _tag: "PersistNavigation",
      navigation: { view: "graph", familySessionId: ROOT, target },
    }])
  })

  test("shutdown rejects later state transitions and releases ephemeral state", () => {
    const seeded: ApplicationState = {
      ...makeInitialApplicationState(),
      terminals: new Map([[ROOT, { activity: "working", phase: "running" }]]),
      drafts: new Map([[ROOT, { text: "draft", exact: false }]]),
    }
    const requested = reduceApplicationState(seeded, { _tag: "ShutdownRequested" })
    expect(requested.state.shutdown).toBe("shutting-down")
    expect(requested.commands).toEqual([{ _tag: "Shutdown" }])
    const ignored = reduceApplicationState(requested.state, {
      _tag: "RootsSelected",
      sessionId: ROOT,
    })
    expect(ignored.state).toBe(requested.state)
    const stopped = reduceApplicationState(ignored.state, { _tag: "ShutdownCompleted" })
    expect(stopped.state.shutdown).toBe("stopped")
    expect(stopped.state.terminals.size).toBe(0)
    expect(stopped.state.drafts.size).toBe(0)
  })

  test("marks failed shutdown cleanup as incomplete without discarding ownership", () => {
    const seeded: ApplicationState = {
      ...makeInitialApplicationState(),
      terminals: new Map([[ROOT, { activity: "working", phase: "running" }]]),
    }
    const requested = reduceApplicationState(seeded, { _tag: "ShutdownRequested" })
    const failed = reduceApplicationState(requested.state, {
      _tag: "ShutdownFailed",
      message: "cleanup timed out",
    })
    expect(failed.state.shutdown).toBe("cleanup-incomplete")
    expect(failed.state.terminals.get(ROOT)?.phase).toBe("cleanup-incomplete")
  })

  test("serializes events and enqueues command completions through the Effect coordinator", async () => {
    const state = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const coordinator = yield* makeApplicationCoordinator({
        initialState: makeInitialApplicationState(),
        execute: (command): Effect.Effect<AppEvent | void> => {
          if (command._tag !== "RefreshProvider") return Effect.void
          return Effect.succeed({
            _tag: "RefreshSucceeded",
            generation: command.generation,
            snapshot: snapshot(session(ROOT, "Loaded"), [message("q", "user", "question", 0)]),
          })
        },
      })
      yield* coordinator.dispatch({ _tag: "RootsSelected", sessionId: "first" })
      yield* coordinator.dispatch({ _tag: "RootsSelected", sessionId: "second" })
      yield* coordinator.dispatch({ _tag: "RefreshRequested", reason: "initial" })
      yield* Effect.sleep("10 millis")
      return yield* coordinator.getState
    })))

    expect(state.surface).toEqual({ _tag: "Roots", selectedSessionId: "second" })
    expect(state.provider.sessions.get(ROOT)?.title).toBe("Loaded")
    expect(state.refresh.active).toBeNull()
  })

  test("acknowledges dispatch only after reduction and survives transition observer exceptions", async () => {
    const selected = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      let transitions = 0
      const coordinator = yield* makeApplicationCoordinator({
        initialState: makeInitialApplicationState(),
        execute: (): Effect.Effect<void> => Effect.void,
        onTransition: () => {
          transitions += 1
          throw new Error("observer failed")
        },
      })
      expect(yield* coordinator.dispatch({ _tag: "RootsSelected", sessionId: "first" })).toBeTrue()
      expect((yield* coordinator.getState).surface).toEqual({
        _tag: "Roots",
        selectedSessionId: "first",
      })
      yield* coordinator.dispatch({ _tag: "RootsSelected", sessionId: "second" })
      expect(transitions).toBe(2)
      return (yield* coordinator.getState).surface
    })))
    expect(selected).toEqual({ _tag: "Roots", selectedSessionId: "second" })
  })

  test("awaits shutdown command completion before resolving coordinator shutdown", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      let cleanupCompleted = false
      const coordinator = yield* makeApplicationCoordinator({
        initialState: makeInitialApplicationState(),
        execute: (command): Effect.Effect<AppEvent | void> => {
          if (command._tag !== "Shutdown") return Effect.void
          return Effect.sleep("20 millis").pipe(
            Effect.tap(() => Effect.sync(() => { cleanupCompleted = true })),
            Effect.as({ _tag: "ShutdownCompleted" as const }),
          )
        },
      })
      const succeeded = yield* coordinator.shutdown
      return { succeeded, cleanupCompleted, state: yield* coordinator.getState }
    })))
    expect(result.succeeded).toBeTrue()
    expect(result.cleanupCompleted).toBeTrue()
    expect(result.state.shutdown).toBe("stopped")
  })
})

function loadedState(
  sessions: AgentSession | readonly AgentSession[],
  transcripts: readonly AgentMessage[] | ReadonlyMap<string, readonly AgentMessage[]>,
  relations: ApplicationState["relations"] = [],
): ApplicationState {
  const sessionList = Array.isArray(sessions) ? sessions : [sessions]
  const transcriptMap = transcripts instanceof Map
    ? new Map([...transcripts].map(([sessionId, messages]) => [sessionId, available(messages)]))
    : new Map([[sessionList[0]!.id, available(transcripts as readonly AgentMessage[])]])
  return {
    ...makeInitialApplicationState({ relations }),
    provider: {
      sessions: new Map(sessionList.map((item) => [item.id, item])),
      transcripts: transcriptMap,
    },
    refresh: { generation: 1, active: null, initialPending: false },
  }
}

function snapshot(sessionValue: AgentSession, messages: readonly AgentMessage[]): AgentSessionSnapshot {
  return {
    sessions: [sessionValue],
    transcripts: new Map([[sessionValue.id, available(messages)]]),
  }
}

function session(id: string, title: string, transient = false): AgentSession {
  return { id, title, lastModified: id === ROOT ? 2 : 1, ...(transient ? { transient: true } : {}) }
}

function message(
  id: string,
  role: AgentMessage["role"],
  preview: string,
  ordinal: number,
  turnComplete?: boolean,
  displayGroupId?: string,
): AgentMessage {
  return {
    id,
    role,
    preview,
    ordinal,
    visible: true,
    ...(turnComplete === undefined ? {} : { turnComplete }),
    ...(displayGroupId === undefined ? {} : { displayGroupId }),
  }
}
