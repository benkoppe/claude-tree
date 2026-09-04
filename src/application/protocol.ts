import { Data, type Deferred, type Effect } from "effect"

import type { MessageRef, NavigationTarget } from "../domain/model"
import type { ConversationRemoval } from "../domain/persistence"
import type {
  TerminalActivityEvent,
  TerminalExitEvent,
  TerminalSessionChangedEvent,
  TerminalSessionTransitionErrorEvent,
} from "../services/terminal-supervisor"
import type { ApplicationModal, ApplicationState } from "./state"

export type RefreshReason = "initial" | "manual" | "terminal-return" | "completion" | "stop" | "ambiguity"

export type ApplicationIntent =
  | { readonly _tag: "Refresh"; readonly reason: "manual" }
  | { readonly _tag: "SelectRoot"; readonly sessionId: string | null }
  | { readonly _tag: "EnterRoot"; readonly sessionId: string }
  | {
      readonly _tag: "SelectGraph"
      readonly familySessionId: string
      readonly target: NavigationTarget
    }
  | { readonly _tag: "NewSession" }
  | { readonly _tag: "ResumeSession"; readonly sessionId: string; readonly reportFailure: boolean }
  | { readonly _tag: "OpenEndpoint"; readonly sessionId: string }
  | { readonly _tag: "BranchFrom"; readonly target: MessageRef }
  | { readonly _tag: "ReturnFromTerminal" }
  | { readonly _tag: "StopSession"; readonly sessionId: string }
  | {
      readonly _tag: "Remove"
      readonly requestId: string
      readonly removal: ConversationRemoval
      readonly affectedSessionIds: readonly string[]
    }
  | { readonly _tag: "OpenModal"; readonly modal: ApplicationModal }
  | { readonly _tag: "CloseModal" }

export type ApplicationIntentTag = ApplicationIntent["_tag"]

export class IntentRejectedError extends Data.TaggedError("IntentRejectedError")<{
  readonly intent: ApplicationIntentTag
  readonly reason: "invalid" | "busy" | "superseded" | "shutting-down"
  readonly message: string
}> {}

export class ApplicationOperationError extends Data.TaggedError("ApplicationOperationError")<{
  readonly intent: ApplicationIntentTag
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class RemovalOperationError extends Data.TaggedError("RemovalOperationError")<{
  readonly intent: "Remove"
  readonly operation: "Remove conversation"
  readonly message: string
  readonly stoppedSessionIds: readonly string[]
  readonly failedSessionId?: string
  readonly cause?: unknown
}> {}

export class ApplicationShutdownError extends Data.TaggedError("ApplicationShutdownError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type ApplicationIntentError = IntentRejectedError | ApplicationOperationError | RemovalOperationError
export type ApplicationIntentEffect = Effect.Effect<void, ApplicationIntentError>

export interface IntentEnvelope {
  readonly _tag: "Intent"
  readonly correlationId: number
  readonly intent: ApplicationIntent
  readonly reply: Deferred.Deferred<void, ApplicationIntentError>
}

export type TerminalActorEvent =
  | { readonly _tag: "TerminalActivity"; readonly event: TerminalActivityEvent }
  | { readonly _tag: "TerminalExit"; readonly event: TerminalExitEvent }
  | { readonly _tag: "TerminalSessionChanged"; readonly event: TerminalSessionChangedEvent }
  | { readonly _tag: "TerminalTransitionError"; readonly event: TerminalSessionTransitionErrorEvent }

export interface StateQueryEnvelope {
  readonly _tag: "StateQuery"
  readonly reply: Deferred.Deferred<ApplicationState>
}
