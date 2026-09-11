import type { AgentSession, TranscriptRead } from "../domain/model"
import { groupSessionFamilies } from "./forest-projection"
import type { ApplicationState, SessionHistoryStatus } from "./state"

export interface HistoryIssue {
  readonly sessionId: string
  readonly reason: string
  readonly kind: "unavailable" | "missing"
}

export type FamilyHistoryStatus =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Unavailable"; readonly issues: readonly HistoryIssue[] }

const pending: SessionHistoryStatus = { _tag: "Pending" }
const ready: SessionHistoryStatus = { _tag: "Ready" }

export function historyStatusForRead(read: TranscriptRead): SessionHistoryStatus {
  return read._tag === "Available" ? ready : read
}

export function selectHistoryStatus(state: ApplicationState, sessionId: string): SessionHistoryStatus {
  if (state.local.temporarySessionIds.has(sessionId)) return ready
  const status = state.historyStatus.get(sessionId)
  if (status) return status
  const read = state.local.transcripts.get(sessionId) ?? state.provider.transcripts.get(sessionId)
  if (read) return historyStatusForRead(read)
  return state.local.sessions.has(sessionId) ? ready : pending
}

export function selectFamilyHistoryStatus(state: ApplicationState, sessionIds: Iterable<string>): FamilyHistoryStatus {
  const issues: HistoryIssue[] = []
  let loading = false
  for (const id of sessionIds) {
    const status = selectHistoryStatus(state, id)
    if (status._tag === "Pending") loading = true
    if (status._tag === "Unavailable" || status._tag === "Missing") issues.push({
      sessionId: id,
      reason: status._tag === "Missing" ? "Session history was not found" : status.reason,
      kind: status._tag === "Missing" ? "missing" : "unavailable",
    })
  }
  return issues.length ? { _tag: "Unavailable", issues } : loading ? { _tag: "Loading" } : { _tag: "Ready" }
}

export interface CatalogueFamily {
  readonly root: AgentSession
  readonly sessionIds: ReadonlySet<string>
}

const catalogueCache = new WeakMap<ApplicationState["provider"]["sessions"], {
  local: ApplicationState["local"]["sessions"]
  relations: ApplicationState["relations"]
  families: readonly CatalogueFamily[]
}>()

export function selectCatalogueFamilies(state: ApplicationState): readonly CatalogueFamily[] {
  const cached = catalogueCache.get(state.provider.sessions)
  if (cached && cached.local === state.local.sessions && cached.relations === state.relations) return cached.families
  const sessions = new Map([...state.provider.sessions, ...state.local.sessions])
  const families = [...groupSessionFamilies(sessions, state.relations).values()].map((group) => {
    const children = new Set(group.relations.map((relation) => relation.childSessionId))
    return {
      root: group.sessions.find((session) => !children.has(session.id)) ?? group.sessions[0]!,
      sessionIds: new Set(group.sessions.map((session) => session.id)),
    }
  })
  catalogueCache.set(state.provider.sessions, { local: state.local.sessions, relations: state.relations, families })
  return families
}
