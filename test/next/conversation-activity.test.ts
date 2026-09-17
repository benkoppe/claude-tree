import { expect, test } from "bun:test"

import {
  available, makeInitialApplicationState, projectRootsViewModel, reduceApplicationState,
  type ActiveRefresh, type ApplicationState,
} from "../../src/application"
import type { AgentMessage, AgentSessionSnapshot, TranscriptRead } from "../../src/domain/model"

const older = { id: "older", title: "Older", lastModified: 10 }
const newer = { id: "newer", title: "Newer", lastModified: 20 }
const child = { id: "child", title: "Child", lastModified: 11 }
const question: AgentMessage = { id: "q", role: "user", preview: "Question", text: "Question", ordinal: 0, visible: true }
const answer: AgentMessage = { id: "a", role: "agent", preview: "Answer", text: "Answer", ordinal: 1, visible: true }
const history = available([question])

function refresh(state: ApplicationState, snapshot: AgentSessionSnapshot, reason: ActiveRefresh["reason"] = "manual", mode: ActiveRefresh["mode"] = "incremental"): ApplicationState {
  const generation = state.refresh.generation + 1
  state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh: {
    key: "read", generation, reason, mode, sessionIds: new Set(snapshot.sessions.map((session) => session.id)),
  } })
  return reduceApplicationState(state, { _tag: "RefreshSucceeded", key: "read", generation, snapshot })
}

function initial(withChild = false): ApplicationState {
  const sessions = withChild ? [older, newer, child] : [older, newer]
  return refresh(makeInitialApplicationState({
    surface: { _tag: "Roots", selectedSessionId: older.id },
    relations: withChild ? [{ parentSessionId: older.id, childSessionId: child.id, sourceMessageId: question.id,
      sharedMessages: [{ parentMessageId: question.id, childMessageId: question.id }], createdAt: "2026-09-17T00:00:00.000Z" }] : [],
  }), { sessions, transcripts: new Map(sessions.map((session) => [session.id, history])) }, "initial", "full")
}

function order(state: ApplicationState): readonly string[] {
  return projectRootsViewModel(state).map((root) => root.sessionId)
}

test.each([older, child])("stopping $id preserves root order through subsequent manual refreshes", (session) => {
  let state = initial(true)
  state = { ...state, terminals: new Map([[session.id, { phase: "running", activity: "idle", ownerId: "owner" }]]) }
  expect(order(state)).toEqual([newer.id, older.id])
  state = reduceApplicationState(state, { _tag: "TerminalStopping", sessionId: session.id })
  state = reduceApplicationState(state, { _tag: "TerminalStopped", sessionId: session.id })
  const modified = { ...session, title: "Updated metadata", lastModified: 100 }
  state = refresh(state, { sessions: [modified], transcripts: new Map([[session.id, history]]) }, "stop")
  expect(order(state)).toEqual([newer.id, older.id])
  expect(state.terminals.has(session.id)).toBeFalse()
  expect(state.provider.sessions.get(session.id)).toEqual(modified)
  state = refresh(state, { sessions: [...state.provider.sessions.values()], transcripts: state.provider.transcripts }, "manual", "full")
  expect(order(state)).toEqual([newer.id, older.id])
  expect(state.surface).toEqual({ _tag: "Roots", selectedSessionId: older.id })
})

test.each([older, child])("new persisted messages in $id move the family up, including on stop", (session) => {
  const state = refresh(initial(true), { sessions: [{ ...session, lastModified: 100 }],
    transcripts: new Map([[session.id, available([question, answer])]]) }, "stop")
  expect(order(state)).toEqual([older.id, newer.id])
  expect(projectRootsViewModel(state)[0]?.lastModified).toBe(100)
})

test("metadata-only resume and compaction classification preserve order", () => {
  let state = refresh(initial(), { sessions: [{ ...older, lastModified: 100 }],
    transcripts: new Map([[older.id, history]]) }, "terminal-return")
  state = refresh(state, { sessions: [{ ...older, lastModified: 101 }],
    transcripts: new Map([[older.id, available([{ ...question, historical: true, ordinal: 2 }])]]) })
  expect(order(state)).toEqual([newer.id, older.id])
  expect(state.conversationActivity.get(older.id)).toBe(10)
})

test("accepted content changes at an existing message identity update recency", () => {
  let state = initial()
  const snapshot = { sessions: [{ ...older, lastModified: 100 }], transcripts: new Map([
    [older.id, available([{ ...question, preview: "Replaced", text: "Replaced" }])],
  ]) }
  state = refresh(state, snapshot)
  expect(order(state)).toEqual([newer.id, older.id])
  state = refresh(state, snapshot)
  expect(order(state)).toEqual([older.id, newer.id])
})

test.each<TranscriptRead>([
  { _tag: "Unavailable", reason: "read failed" },
  { _tag: "Missing" },
  { _tag: "Available", messages: [question, answer], coverage: {
    _tag: "Limited", boundaryId: "boundary", reason: "historical-parent-unproven",
  } },
])("unverified history does not count as conversation activity: $_tag", (read) => {
  const state = refresh(initial(), { sessions: [{ ...older, lastModified: 100 }], transcripts: new Map([[older.id, read]]) })
  expect(order(state)).toEqual([newer.id, older.id])
  expect(state.conversationActivity.get(older.id)).toBe(10)
})

test("stale reads cannot advance recency", () => {
  let state = reduceApplicationState(initial(), { _tag: "RefreshStarted", refresh: {
    key: "stale", generation: 2, reason: "manual", mode: "incremental", sessionIds: new Set([older.id]),
  } })
  state = refresh(state, { sessions: [{ ...older, lastModified: 50 }], transcripts: new Map([[older.id, history]]) })
  state = reduceApplicationState(state, { _tag: "RefreshSucceeded", key: "stale", generation: 2, snapshot: {
    sessions: [{ ...older, lastModified: 100 }], transcripts: new Map([[older.id, available([question, answer])]]),
  } })
  expect(order(state)).toEqual([newer.id, older.id])
})

test("expanding limited history does not promote old conversation content", () => {
  const limited: TranscriptRead = { _tag: "Available", messages: [answer], coverage: {
    _tag: "Limited", boundaryId: "boundary", reason: "historical-parent-unproven",
  } }
  let state = refresh(makeInitialApplicationState(), { sessions: [older, newer],
    transcripts: new Map([[older.id, limited], [newer.id, history]]) }, "initial", "full")
  const snapshot = { sessions: [{ ...older, lastModified: 100 }],
    transcripts: new Map([[older.id, available([question, answer])]]) }
  state = refresh(state, snapshot)
  state = refresh(state, snapshot)
  expect(state.provider.transcripts.get(older.id)).toEqual(available([question, answer]))
  expect(order(state)).toEqual([newer.id, older.id])
  state = refresh(state, snapshot)
  expect(order(state)).toEqual([newer.id, older.id])
})

test("working assistant tails do not promote a family until accepted after stopping", () => {
  let state: ApplicationState = { ...initial(), terminals: new Map([
    [older.id, { phase: "running", activity: "working", ownerId: "owner" }],
  ]) }
  const snapshot = { sessions: [{ ...older, lastModified: 100 }],
    transcripts: new Map([[older.id, available([question, answer])]]) }
  state = refresh(state, snapshot)
  expect(order(state)).toEqual([newer.id, older.id])
  state = reduceApplicationState(state, { _tag: "TerminalStopped", sessionId: older.id })
  state = refresh(state, snapshot, "stop")
  expect(order(state)).toEqual([older.id, newer.id])
})

test("catalogue hydration establishes a baseline without promoting a newly readable conversation", () => {
  let state = reduceApplicationState(makeInitialApplicationState(), { _tag: "RefreshStarted", refresh: {
    key: "initial", generation: 1, reason: "initial", mode: "full", sessionIds: new Set(),
  } })
  state = reduceApplicationState(state, { _tag: "RefreshProgress", key: "initial", generation: 1,
    snapshot: { sessions: [older, newer], transcripts: new Map() } })
  expect(order(state)).toEqual([newer.id, older.id])
  state = reduceApplicationState(state, { _tag: "RefreshProgress", key: "initial", generation: 1,
    snapshot: { sessions: [{ ...older, lastModified: 100 }], transcripts: new Map([[older.id, history]]) } })
  expect(order(state)).toEqual([newer.id, older.id])
})

test("identity adoption carries ordering activity across a provider metadata change", () => {
  let state = initial()
  state = reduceApplicationState(state, { _tag: "SessionIdentityAdopted", previousSessionId: older.id,
    session: { ...older, id: "adopted", lastModified: 100 }, kind: "temporary-adoption" })
  expect(state.conversationActivity.has(older.id)).toBeFalse()
  expect(state.conversationActivity.get("adopted")).toBe(10)
  expect(order(state)).toEqual([newer.id, "adopted"])
})
