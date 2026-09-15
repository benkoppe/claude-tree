import { expect, test } from "bun:test"

import { selectHistoryStatus } from "../../src/application/catalogue"
import { reduceApplicationState } from "../../src/application/reducer"
import { selectConversationForest, selectRootActivation } from "../../src/application/selectors"
import { available, makeInitialApplicationState, type ApplicationState } from "../../src/application/state"
import { projectRootsViewModel } from "../../src/application/view-model"
import type { AgentMessage, AgentSessionSnapshot, TranscriptRead } from "../../src/domain/model"
import { renderRoots } from "../../src/presentation/render"

const parent = { id: "parent", title: "Recent fork family", lastModified: 100 }
const child = { id: "child", title: "Recent child", lastModified: 90 }
const other = { id: "other", title: "Older small session", lastModified: 1 }
const sessions = [parent, child, other]
const message = (id: string, role: "user" | "agent", preview: string, ordinal: number): AgentMessage => ({
  id, role, preview, ordinal, visible: true, copyIdentity: preview,
})
const parentRead = available([message("q", "user", "question", 0), message("a", "agent", "parent answer", 1)])
const childRead = available([message("cq", "user", "question", 0), message("ca", "agent", "child answer", 1)])
const otherRead = available([message("oq", "user", "older question", 0)])
const relation = { parentSessionId: parent.id, childSessionId: child.id, sourceMessageId: "q",
  sharedMessages: [{ parentMessageId: "q", childMessageId: "cq" }], createdAt: "2026-09-11T00:00:00.000Z" }

function initial(): ApplicationState {
  return progress(reduceApplicationState(makeInitialApplicationState({ relations: [relation] }), {
    _tag: "RefreshStarted", refresh: { key: "initial", generation: 1, mode: "full", reason: "initial", sessionIds: new Set() },
  }), new Map(), sessions)
}

function progress(state: ApplicationState, transcripts: ReadonlyMap<string, TranscriptRead>, catalogue: AgentSessionSnapshot["sessions"] = []): ApplicationState {
  return reduceApplicationState(state, { _tag: "RefreshProgress", key: "initial", generation: 1, snapshot: { sessions: catalogue, transcripts } })
}

function finish(state: ApplicationState, transcripts: ReadonlyMap<string, TranscriptRead>): ApplicationState {
  return reduceApplicationState(state, { _tag: "RefreshSucceeded", key: "initial", generation: 1, snapshot: { sessions, transcripts } })
}

test("an early child batch cannot publish an orphan graph or move selection to a faster unrelated root", () => {
  let state = initial()
  expect(projectRootsViewModel(state).map((root) => root.sessionId)).toEqual([parent.id, other.id])
  state = progress(state, new Map([[child.id, childRead], [other.id, otherRead]]))
  expect(state.surface).toEqual({ _tag: "Roots", selectedSessionId: null })
  expect(state.provider.transcripts.has(child.id)).toBeFalse()
  expect(selectConversationForest(state).graphBySessionId.has(child.id)).toBeFalse()
  expect(projectRootsViewModel(state).map((root) => [root.sessionId, root.history._tag])).toEqual([
    [parent.id, "Loading"], [other.id, "Ready"],
  ])
  state = reduceApplicationState(state, { _tag: "Navigated", surface: { _tag: "Roots", selectedSessionId: parent.id }, selectionId: "cursor" })
  state = progress(state, new Map([[parent.id, parentRead]]))
  expect(selectConversationForest(state).graphBySessionId.get(child.id)?.rootSessionId).toBe(parent.id)
  expect(state.surface).toEqual({ _tag: "Roots", selectedSessionId: parent.id })
  expect(state.selectionId).toBe("cursor")
  expect(projectRootsViewModel(state)[0]?.history._tag).toBe("Ready")
  expect(projectRootsViewModel(state)[0]?.activation).toBe("open")
})

test("failed recent history stays visible after startup, with its reason and retry action", () => {
  let state = initial()
  state = reduceApplicationState(state, { _tag: "Navigated", surface: { _tag: "Roots", selectedSessionId: parent.id } })
  state = progress(state, new Map([[child.id, childRead], [other.id, otherRead]]))
  const failure: TranscriptRead = { _tag: "Unavailable", reason: "compaction history validation failed" }
  state = progress(state, new Map([[parent.id, failure]]))
  state = finish(state, new Map([[parent.id, failure], [child.id, childRead], [other.id, otherRead]]))
  const roots = projectRootsViewModel(state)
  expect(roots.map((root) => root.sessionId)).toEqual([parent.id, other.id])
  expect(state.surface).toEqual({ _tag: "Roots", selectedSessionId: parent.id })
  expect(roots[0]?.history).toEqual({ _tag: "Unavailable", issues: [
    { sessionId: parent.id, reason: failure.reason, kind: "unavailable" },
  ] })
  expect(renderRoots(roots, parent.id, 5, 100).text).toContain("Enter to retry")
  expect(selectHistoryStatus(state, parent.id)._tag).toBe("Unavailable")
  expect(roots[0]?.activation).toBe("retry")
  expect(state.refresh.initialPending).toBeFalse()
})

test("a failed family refresh retains accepted topology and a successful retry clears the error", () => {
  let state = finish(initial(), new Map([[parent.id, parentRead], [child.id, childRead], [other.id, otherRead]]))
  const forest = selectConversationForest(state)
  state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh: {
    key: "retry", generation: 2, mode: "incremental", reason: "terminal-return", sessionIds: new Set([child.id]),
  } })
  state = reduceApplicationState(state, { _tag: "RefreshSucceeded", key: "retry", generation: 2, snapshot: {
    sessions: [], transcripts: new Map([[child.id, { _tag: "Unavailable", reason: "temporarily unreadable" }]]),
  } })
  expect(state.provider.transcripts.get(child.id)).toBe(childRead)
  expect(selectConversationForest(state).graphBySessionId.get(parent.id)).toBe(forest.graphBySessionId.get(parent.id))
  expect(projectRootsViewModel(state)[0]?.history._tag).toBe("Unavailable")
  expect(projectRootsViewModel(state)[0]?.activation).toBe("open")
  state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh: {
    key: "retry", generation: 3, mode: "incremental", reason: "terminal-return", sessionIds: new Set([child.id]),
  } })
  state = reduceApplicationState(state, { _tag: "RefreshSucceeded", key: "retry", generation: 3, snapshot: { sessions: [], transcripts: new Map([[child.id, childRead]]) } })
  expect(projectRootsViewModel(state)[0]?.history._tag).toBe("Ready")
})

test("mixed failures and pending family members stay loading while diagnostics remain available", () => {
  const state = { ...initial(), historyStatus: new Map([
    [parent.id, { _tag: "Unavailable" as const, reason: "read failed" }],
  ]) }
  const root = projectRootsViewModel(state)[0]!
  expect(root.history._tag).toBe("Unavailable")
  expect(root.activation).toBe("loading")
  expect(root.warnings?.join("\n")).toContain("read failed")
  expect(renderRoots([root], root.sessionId, 1, 100).text).toContain("⠋ Loading")
})

test.each(["RefreshFailed", "RefreshSuperseded"] as const)("%s releases retry admission without replacing history diagnostics", (_tag) => {
  let state = finish(initial(), new Map([[parent.id, { _tag: "Unavailable", reason: "read failed" }], [child.id, childRead], [other.id, otherRead]]))
  const ids = [parent.id, child.id]
  expect(selectRootActivation(state, ids)).toBe("retry")
  state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh: {
    key: "retry", generation: 2, mode: "incremental", reason: "terminal-return", sessionIds: new Set(ids),
  } })
  expect(selectRootActivation(state, ids)).toBe("loading")
  expect(projectRootsViewModel(state)[0]?.activation).toBe("loading")
  state = reduceApplicationState(state, { _tag, key: "retry", generation: 2, message: "transport failed" })
  expect(selectRootActivation(state, ids)).toBe("retry")
  expect(projectRootsViewModel(state)[0]?.activation).toBe("retry")
})

test("a published family failure can retry before unrelated initial hydration finishes", () => {
  const state = progress(initial(), new Map([[parent.id, { _tag: "Unavailable", reason: "read failed" }], [child.id, childRead]]))
  expect(state.refresh.initialPending).toBeTrue()
  expect(selectRootActivation(state, [parent.id, child.id])).toBe("retry")
  expect(selectRootActivation(state, [other.id])).toBe("loading")
})

test("transport failure settles incomplete families without discarding their staged successful reads", () => {
  let state = progress(initial(), new Map([[child.id, childRead]]))
  state = reduceApplicationState(state, { _tag: "RefreshFailed", key: "initial", generation: 1, message: "transport closed" })
  expect(state.provider.transcripts.get(child.id)).toBe(childRead)
  expect(projectRootsViewModel(state).map((root) => root.history._tag)).toEqual(["Unavailable", "Unavailable"])
  expect(state.refresh.active.size).toBe(0)
  expect(state.refresh.initialPending).toBeFalse()
})

test("missing, empty, and intentionally removed sessions are distinct from loading or read failure", () => {
  const missing = finish(initial(), new Map([[parent.id, { _tag: "Missing" }], [child.id, childRead], [other.id, available([])]]))
  expect(selectHistoryStatus(missing, parent.id)._tag).toBe("Missing")
  expect(selectHistoryStatus(missing, other.id)._tag).toBe("Ready")
  expect(projectRootsViewModel(missing).map((root) => root.sessionId)).toEqual([parent.id])
  const removed = { ...missing, removals: [{ kind: "tree" as const, rootSessionId: parent.id,
    memberSessionIds: [parent.id, child.id], createdAt: "2026-09-11T00:00:00.000Z" }] }
  expect(projectRootsViewModel(removed)).toEqual([])
})

test.each(["staged", "published"])("a newer targeted read wins over %s and final initial history", (phase) => {
  let state = initial()
  state = reduceApplicationState(state, { _tag: "Navigated", surface: { _tag: "Roots", selectedSessionId: other.id } })
  state = progress(state, phase === "staged"
    ? new Map([[child.id, { _tag: "Unavailable", reason: "old failure" }]])
    : new Map([[parent.id, parentRead], [child.id, childRead]]))
  expect(state.surface).toEqual({ _tag: "Roots", selectedSessionId: other.id })
  expect(state.refresh.initialPending).toBeTrue()
  const newerChildRead = available([message("cq", "user", "question", 0), message("ca", "agent", "child answer", 1),
    message("new-user", "user", "new question", 2)])
  state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh: {
    key: "targeted", generation: 2, mode: "incremental", reason: "terminal-return", sessionIds: new Set([parent.id, child.id]),
  } })
  state = reduceApplicationState(state, { _tag: "RefreshSucceeded", key: "targeted", generation: 2,
    snapshot: { sessions: [], transcripts: new Map([[parent.id, parentRead], [child.id, newerChildRead]]) } })
  state = progress(state, new Map([[parent.id, { _tag: "Unavailable", reason: "old parent failure" }]]))
  state = finish(state, new Map([[parent.id, { _tag: "Unavailable", reason: "old parent failure" }],
    [child.id, { _tag: "Unavailable", reason: "old failure" }], [other.id, otherRead]]))
  expect(selectHistoryStatus(state, parent.id)._tag).toBe("Ready")
  expect(selectHistoryStatus(state, child.id)._tag).toBe("Ready")
  expect(state.provider.transcripts.get(child.id)).toBe(newerChildRead)
  expect(state.provider.transcripts.get(other.id)).toEqual(otherRead)
  expect(state.surface).toEqual({ _tag: "Roots", selectedSessionId: other.id })
  expect(state.refresh.initialPending).toBeFalse()
  expect(state.refresh.active.size).toBe(0)
})

test("an incomplete final provider snapshot settles unread catalogue entries as errors", () => {
  const state = finish(initial(), new Map([[other.id, otherRead]]))
  expect(state.refresh.initialPending).toBeFalse()
  expect(projectRootsViewModel(state).map((root) => root.history._tag)).toEqual(["Unavailable", "Ready"])
  expect(selectHistoryStatus(state, parent.id)).toEqual({ _tag: "Unavailable", reason: "Provider did not return this session's history" })
})
