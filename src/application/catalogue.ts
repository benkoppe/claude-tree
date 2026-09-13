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
  | { readonly _tag: "Limited"; readonly contextMessageCount: number }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Unavailable"; readonly issues: readonly HistoryIssue[] }

const pending: SessionHistoryStatus = { _tag: "Pending" }
const ready: SessionHistoryStatus = { _tag: "Ready" }

export function historyStatusForRead(read: TranscriptRead): SessionHistoryStatus {
  return read._tag === "Available" ? read.coverage ? { _tag: "Limited", context: read } : ready : read
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
  let limited = false
  let contextMessageCount = 0
  for (const id of sessionIds) {
    const status = selectHistoryStatus(state, id)
    if (status._tag === "Pending") loading = true
    if (status._tag === "Limited") {
      limited = true
      contextMessageCount += status.context.messages.filter((message) => message.visible).length
    }
    if (status._tag === "Unavailable" || status._tag === "Missing") issues.push({
      sessionId: id,
      reason: status._tag === "Missing" ? "Session history was not found" : status.reason,
      kind: status._tag === "Missing" ? "missing" : "unavailable",
    })
  }
  return issues.length ? { _tag: "Unavailable", issues } : loading ? { _tag: "Loading" }
    : limited ? { _tag: "Limited", contextMessageCount } : { _tag: "Ready" }
}

export interface CatalogueFamily {
  readonly root: AgentSession
  readonly sessionIds: ReadonlySet<string>
}

export function selectHistoryDetails(state: ApplicationState, sessionIds: Iterable<string>): readonly string[] {
  return [...sessionIds].flatMap((id) => {
    const status = selectHistoryStatus(state, id)
    const reason = status._tag === "Limited"
      ? "History gap: showing the last accepted snapshot (SDK context order until history is verified). Open the session to continue; forking awaits verified history."
      : status._tag === "Unavailable" ? status.reason
      : status._tag === "Missing" ? "Session history was not found" : undefined
    return reason ? [`${describeSession(state, id)}\n${reason}`] : []
  })
}

export function describeSession(state: ApplicationState, sessionId: string): string {
  const session = state.local.sessions.get(sessionId) ?? state.provider.sessions.get(sessionId)
  const title = session?.title.trim()
  const label = title && title !== sessionId ? `${title} (${sessionId})` : sessionId
  const family = selectCatalogueFamilies(state).find((family) => family.sessionIds.has(sessionId))
  return family && family.root.id !== sessionId ? `${family.root.title} → ${label}` : label
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
