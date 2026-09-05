import {
  buildConversationForest,
  visibleConversationForest,
  type ConversationForest,
} from "../domain/conversation-graph"
import type { AgentMessage, AgentSession, MessageRef, TranscriptRead } from "../domain/model"
import { SESSION_STATUS_PRIORITY, type SessionStatus } from "../domain/session-status"
import type { ApplicationState } from "./state"

export type { SessionStatus } from "../domain/session-status"

export interface ProjectedApplicationData {
  readonly sessions: ReadonlyMap<string, AgentSession>
  readonly transcripts: ReadonlyMap<string, readonly AgentMessage[]>
}

type ForestInputs = Pick<ApplicationState, "local" | "terminals" | "rewindAnchors" | "relations" | "removals">
const forestCache = new WeakMap<ApplicationState["provider"], ForestInputs & { readonly forest: ConversationForest }>()

export function selectProjectedData(state: ApplicationState): ProjectedApplicationData {
  const sessions = new Map(state.provider.sessions)
  const reads = new Map(state.provider.transcripts)
  for (const [sessionId, session] of state.local.sessions) sessions.set(sessionId, session)
  for (const [sessionId, transcript] of state.local.transcripts) reads.set(sessionId, transcript)

  const projectedSessions = new Map<string, AgentSession>()
  const transcripts = new Map<string, readonly AgentMessage[]>()
  for (const [sessionId, session] of sessions) {
    const read = reads.get(sessionId)
    if (read?._tag === "Available") {
      projectedSessions.set(sessionId, session)
      transcripts.set(sessionId, projectRewind(read.messages, state.rewindAnchors.get(sessionId)?.targetMessageId))
      continue
    }
    if (state.local.sessions.has(sessionId) || state.terminals.has(sessionId)) {
      projectedSessions.set(sessionId, session)
      transcripts.set(sessionId, [])
    }
  }
  return { sessions: projectedSessions, transcripts }
}

export function selectTranscriptRead(
  state: ApplicationState,
  sessionId: string,
): TranscriptRead | undefined {
  return state.local.transcripts.get(sessionId) ?? state.provider.transcripts.get(sessionId)
}

export function selectProjectedTranscript(
  state: ApplicationState,
  sessionId: string,
): readonly AgentMessage[] {
  const read = selectTranscriptRead(state, sessionId)
  if (read?._tag !== "Available") return []
  return projectRewind(read.messages, state.rewindAnchors.get(sessionId)?.targetMessageId)
}

export function selectFamilyRootSessionId(state: ApplicationState, sessionId: string): string {
  return selectConversationForest(state).graphBySessionId.get(sessionId)?.rootSessionId ?? sessionId
}

export function selectFamilySessionIds(
  state: ApplicationState,
  familySessionId: string,
): ReadonlySet<string> {
  return selectConversationForest(state).graphBySessionId.get(familySessionId)?.sessionIds ??
    new Set([familySessionId])
}

export function selectConversationForest(state: ApplicationState): ConversationForest {
  const cached = forestCache.get(state.provider)
  if (cached && cached.local === state.local && cached.terminals === state.terminals &&
    cached.rewindAnchors === state.rewindAnchors && cached.relations === state.relations &&
    cached.removals === state.removals) return cached.forest
  const data = selectProjectedData(state)
  const forest = buildConversationForest(
    [...data.sessions.values()],
    data.transcripts,
    state.relations,
    state.removals,
  )
  // Reducer collections are immutable. Navigation, modal, and refresh bookkeeping
  // changes can reuse the graph; never mutate a forest returned by this selector.
  forestCache.set(state.provider, {
    local: state.local, terminals: state.terminals, rewindAnchors: state.rewindAnchors,
    relations: state.relations, removals: state.removals, forest,
  })
  return forest
}

export function selectVisibleConversationForest(state: ApplicationState): ConversationForest {
  return visibleConversationForest(selectConversationForest(state), selectVisibleEndpointSessionIds(state))
}

export function selectVisibleEndpointSessionIds(state: ApplicationState): ReadonlySet<string> {
  return new Set([...state.local.sessions.keys(), ...state.terminals.keys()])
}

export function selectSessionStatus(state: ApplicationState, sessionId: string): SessionStatus {
  const terminal = state.terminals.get(sessionId)
  if (!terminal || terminal.phase === "showing") return "idle"
  if (terminal.activity === "blocked") return "blocked"
  if (terminal.activity === "working" || state.pendingCompletions.has(sessionId)) return "working"
  if (state.unviewedSessionIds.has(sessionId)) return "unviewed"
  return "live"
}

export function selectAggregateStatus(
  state: ApplicationState,
  sessionIds: Iterable<string>,
): SessionStatus {
  let selected: SessionStatus = "idle"
  for (const sessionId of sessionIds) {
    const status = selectSessionStatus(state, sessionId)
    if (SESSION_STATUS_PRIORITY[status] > SESSION_STATUS_PRIORITY[selected]) selected = status
  }
  return selected
}

export function replaceSessionIdInRef(
  ref: MessageRef,
  previousSessionId: string,
  sessionId: string,
): MessageRef {
  return ref.sessionId === previousSessionId ? { ...ref, sessionId } : ref
}

function projectRewind(
  messages: readonly AgentMessage[],
  targetMessageId: string | undefined,
): readonly AgentMessage[] {
  if (!targetMessageId) return messages
  const targetIndex = messages.findIndex((message) => message.id === targetMessageId)
  return targetIndex < 0 ? messages : messages.slice(0, targetIndex)
}
