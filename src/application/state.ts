import type {
  AgentActivity,
  AgentMessage,
  AgentSession,
  DraftPreview,
  NavigationTarget,
  TranscriptRead,
} from "../domain/model"
import type { BranchRelation, ConversationRemoval } from "../domain/persistence"

export type NavigatorSurface =
  | {
      readonly _tag: "Roots"
      readonly selectedSessionId: string | null
    }
  | {
      readonly _tag: "Graph"
      readonly familySessionId: string
      readonly target: NavigationTarget
    }

export type ApplicationSurface =
  | NavigatorSurface
  | {
      readonly _tag: "Terminal"
      readonly sessionId: string
      readonly returnTo: NavigatorSurface
    }

export type ApplicationModal =
  | { readonly _tag: "About" }
  | { readonly _tag: "Error"; readonly message: string }
  | {
      readonly _tag: "ConfirmRemoval"
      readonly requestId: string
      readonly removal: ConversationRemoval
      readonly affectedSessionIds: readonly string[]
    }
  | {
      readonly _tag: "ConfirmStop"
      readonly sessionId: string
      readonly activity: AgentActivity
    }

export interface TerminalState {
  readonly ownerId?: string
  /** Includes empty composer observations so return snapshots cannot resurrect a draft. */
  readonly observationReceived?: boolean
  readonly historyRevision?: number
  readonly activity: AgentActivity
  readonly phase: "showing" | "running" | "stopping" | "cleanup-incomplete"
}

export interface RewindAnchor {
  /** One provisional boundary per session, discarded when accepted history no longer contains it. */
  readonly targetMessageId: string
  readonly submitted: boolean
  readonly targetText?: string
  readonly submissionText?: string | undefined
}

export interface PendingCompletion {
  readonly ownerId: string
  readonly version: number
  readonly baseline: readonly AgentMessage[]
  readonly markUnviewed: boolean
  readonly attempt: number
}

export interface ActiveRefresh {
  readonly key: string
  readonly generation: number
  readonly reason: "initial" | "manual" | "terminal-return" | "completion" | "stop" | "ambiguity" | "reconciliation"
  readonly mode: "full" | "incremental"
  readonly sessionIds: ReadonlySet<string>
  readonly historyRevisions?: ReadonlyMap<string, { readonly ownerId?: string; readonly revision: number }>
  readonly completionVersion?: number
  readonly ambiguityReason?: string
}

export interface ProviderSnapshotState {
  readonly sessions: ReadonlyMap<string, AgentSession>
  readonly transcripts: ReadonlyMap<string, TranscriptRead>
}

export interface LocalOverlayState {
  readonly sessions: ReadonlyMap<string, AgentSession>
  readonly transcripts: ReadonlyMap<string, TranscriptRead>
  readonly temporarySessionIds: ReadonlySet<string>
}

export interface ApplicationState {
  readonly provider: ProviderSnapshotState
  readonly local: LocalOverlayState
  readonly relations: readonly BranchRelation[]
  readonly removals: readonly ConversationRemoval[]
  readonly surface: ApplicationSurface
  readonly modal: ApplicationModal | null
  readonly terminals: ReadonlyMap<string, TerminalState>
  readonly drafts: ReadonlyMap<string, DraftPreview>
  readonly rewindAnchors: ReadonlyMap<string, RewindAnchor>
  readonly pendingCompletions: ReadonlyMap<string, PendingCompletion>
  readonly replacementCandidates: ReadonlyMap<string, {
    readonly messages: readonly AgentMessage[]
    readonly attempts: number
  }>
  readonly unviewedSessionIds: ReadonlySet<string>
  readonly refresh: {
    readonly generation: number
    readonly active: ReadonlyMap<string, ActiveRefresh>
    readonly initialPending: boolean
    readonly appliedGenerationBySession: ReadonlyMap<string, number>
  }
  readonly nextCompletionVersion: number
  readonly shutdown: "running" | "shutting-down" | "stopped" | "cleanup-incomplete"
}

export interface InitialApplicationState {
  readonly relations?: readonly BranchRelation[]
  readonly removals?: readonly ConversationRemoval[]
  readonly surface?: ApplicationSurface
}

export function makeInitialApplicationState(
  initial: InitialApplicationState = {},
): ApplicationState {
  return {
    provider: { sessions: new Map(), transcripts: new Map() },
    local: { sessions: new Map(), transcripts: new Map(), temporarySessionIds: new Set() },
    relations: initial.relations ?? [],
    removals: initial.removals ?? [],
    surface: initial.surface ?? { _tag: "Roots", selectedSessionId: null },
    modal: null,
    terminals: new Map(),
    drafts: new Map(),
    rewindAnchors: new Map(),
    pendingCompletions: new Map(),
    replacementCandidates: new Map(),
    unviewedSessionIds: new Set(),
    refresh: { generation: 0, active: new Map(), initialPending: true, appliedGenerationBySession: new Map() },
    nextCompletionVersion: 0,
    shutdown: "running",
  }
}

export function available(messages: readonly AgentMessage[]): TranscriptRead {
  return { _tag: "Available", messages }
}

/** Compare against the enriched refresh stored by RefreshStarted, before publishing its result. */
export function invalidatedRefreshSessionIds(state: ApplicationState, refresh: ActiveRefresh): ReadonlySet<string> {
  const sessionIds = new Set([
    ...refresh.sessionIds,
    ...(refresh.historyRevisions?.keys() ?? []),
    ...state.terminals.keys(),
  ])
  const invalidated = new Set<string>()
  for (const sessionId of sessionIds) {
    if (refresh.mode !== "full" && !refresh.sessionIds.has(sessionId)) continue
    const terminal = state.terminals.get(sessionId)
    const captured = refresh.historyRevisions?.get(sessionId)
    if (terminal?.ownerId !== captured?.ownerId || (terminal?.historyRevision ?? 0) !== (captured?.revision ?? 0)) {
      invalidated.add(sessionId)
    }
  }
  return invalidated
}
