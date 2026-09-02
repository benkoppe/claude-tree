import type {
  AgentSession,
  AgentSessionSnapshot,
  BranchDerivation,
  DraftPreview,
  NavigationState,
  NavigationTarget,
  TranscriptRead,
} from "../domain/model"
import type { BranchRelation, ConversationRemoval } from "../domain/persistence"
import type { ApplicationModal, NavigatorSurface } from "./state"

export type RefreshReason = "initial" | "manual" | "terminal-return" | "completion" | "stop"

export type AppEvent =
  | {
      readonly _tag: "RefreshRequested"
      readonly reason: RefreshReason
      readonly focusSessionId?: string
      readonly sessionIds?: ReadonlySet<string>
    }
  | {
      readonly _tag: "RefreshSucceeded"
      readonly generation: number
      readonly snapshot: AgentSessionSnapshot
    }
  | { readonly _tag: "RefreshFailed"; readonly generation: number; readonly message: string }
  | {
      readonly _tag: "LocalSessionProjected"
      readonly session: AgentSession
      readonly transcript?: TranscriptRead
      readonly derivation?: BranchDerivation
      readonly temporary?: boolean
    }
  | {
      readonly _tag: "PersistedBranchProjected"
      readonly session: AgentSession
      readonly relation: BranchRelation
      readonly transcript?: TranscriptRead
      readonly temporary?: boolean
    }
  | { readonly _tag: "RelationStaged"; readonly derivation: BranchDerivation }
  | {
      readonly _tag: "SessionIdentityAdoptionRequested"
      readonly temporarySessionId: string
      readonly session: AgentSession
      readonly derivation?: BranchDerivation
    }
  | {
      readonly _tag: "SessionIdentityAdopted"
      readonly temporarySessionId: string
      readonly session: AgentSession
      readonly relation?: BranchRelation
    }
  | {
      readonly _tag: "SessionIdentityAdoptionFailed"
      readonly temporarySessionId: string
      readonly message: string
    }
  | { readonly _tag: "RootsSelected"; readonly sessionId: string | null }
  | {
      readonly _tag: "GraphSelected"
      readonly familySessionId: string
      readonly target: NavigationTarget
    }
  | {
      readonly _tag: "TerminalShowRequested"
      readonly sessionId: string
      readonly reportFailure: boolean
    }
  | { readonly _tag: "TerminalShowSucceeded"; readonly sessionId: string }
  | { readonly _tag: "TerminalShowFailed"; readonly sessionId: string; readonly message: string }
  | {
      readonly _tag: "TransientTerminalShowRolledBack"
      readonly sessionId: string
      readonly restoreTo: NavigatorSurface
    }
  | {
      readonly _tag: "TerminalSessionTransitioned"
      readonly previousSessionId: string
      readonly session: AgentSession
      readonly wasVisible: boolean
      readonly relation?: BranchRelation
    }
  | { readonly _tag: "TerminalReturned"; readonly sessionId: string; readonly draft?: DraftPreview }
  | {
      readonly _tag: "TerminalExited"
      readonly sessionId: string
      readonly exitCode: number
      readonly cleanupIncomplete?: boolean
    }
  | {
      readonly _tag: "TerminalActivityChanged"
      readonly sessionId: string
      readonly activity: import("../domain/model").AgentActivity
      readonly wasVisible: boolean
    }
  | { readonly _tag: "TerminalDraftObserved"; readonly sessionId: string; readonly draft?: DraftPreview }
  | { readonly _tag: "CompletionRefreshDue"; readonly sessionId: string; readonly version: number }
  | {
      readonly _tag: "CompletionRefreshFailed"
      readonly sessionId: string
      readonly version: number
      readonly message: string
    }
  | { readonly _tag: "TerminalStopped"; readonly sessionId: string }
  | { readonly _tag: "TerminalStopRequested"; readonly sessionId: string }
  | { readonly _tag: "TerminalStopFailed"; readonly sessionId: string; readonly message: string }
  | {
      readonly _tag: "RemovalRequested"
      readonly requestId: string
      readonly removal: ConversationRemoval
      readonly affectedSessionIds: readonly string[]
    }
  | { readonly _tag: "RemovalPersisted"; readonly requestId: string }
  | { readonly _tag: "RemovalFailed"; readonly requestId: string; readonly message: string }
  | { readonly _tag: "RelationPersisted"; readonly derivation: BranchDerivation; readonly createdAt: string }
  | { readonly _tag: "RelationPersistenceFailed"; readonly derivation: BranchDerivation; readonly message: string }
  | { readonly _tag: "ModalOpened"; readonly modal: ApplicationModal }
  | { readonly _tag: "ModalClosed" }
  | { readonly _tag: "UnviewedCleared"; readonly sessionId: string }
  | { readonly _tag: "ShutdownRequested" }
  | { readonly _tag: "ShutdownCompleted" }
  | { readonly _tag: "ShutdownFailed"; readonly message: string }
  | { readonly _tag: "CommandFailed"; readonly command: AppCommand; readonly message: string }

export type AppCommand =
  | {
      readonly _tag: "RefreshProvider"
      readonly generation: number
      readonly mode: "full" | "incremental"
      readonly reason: RefreshReason
      readonly focusSessionId?: string
      readonly sessionIds?: ReadonlySet<string>
    }
  | {
      readonly _tag: "ScheduleCompletionRefresh"
      readonly sessionId: string
      readonly version: number
      readonly attempt: number
    }
  | { readonly _tag: "ShowTerminal"; readonly sessionId: string }
  | { readonly _tag: "StopSession"; readonly sessionId: string }
  | { readonly _tag: "PersistRemoval"; readonly requestId: string; readonly removal: ConversationRemoval }
  | { readonly _tag: "PersistRelation"; readonly derivation: BranchDerivation }
  | {
      readonly _tag: "AdoptSessionIdentity"
      readonly temporarySessionId: string
      readonly session: AgentSession
      readonly derivation?: BranchDerivation
    }
  | { readonly _tag: "PersistNavigation"; readonly navigation: NavigationState }
  | { readonly _tag: "Shutdown" }

export interface ReduceResult {
  readonly state: import("./state").ApplicationState
  readonly commands: readonly AppCommand[]
}
