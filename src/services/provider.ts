import { Context, Effect, PubSub, Scope } from "effect"

import type {
  AgentSession,
  AgentSessionSnapshot,
  BranchDerivation,
  DraftPreview,
  MessageRef,
  TerminalObserver,
  TranscriptRead,
} from "../domain/model"
import type { ProviderError, ProviderProtocolError } from "../domain/errors"

export interface ProviderCapabilities {
  readonly historicalBranching: boolean
  readonly exactMessageForks: boolean
  readonly completedTurnForks: boolean
  readonly userMessageReplay: boolean
  readonly temporarySessionIds: boolean
  readonly nativeSessionSwitching: boolean
}

export type TerminalTransitionEvent =
  | {
      readonly _tag: "SessionChanged"
      readonly session: AgentSession
      readonly derivation?: Effect.Effect<BranchDerivation | undefined, ProviderError | ProviderProtocolError>
    }
  | { readonly _tag: "TransitionFailed"; readonly error: ProviderError | ProviderProtocolError }

export interface TerminalLaunch {
  readonly sessionId: string
  readonly command: readonly [string, ...string[]]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly observer: TerminalObserver
  readonly initialDraft?: DraftPreview
  readonly transitions?: PubSub.PubSub<TerminalTransitionEvent>
}

export interface PreparedTerminal {
  readonly session: AgentSession
  readonly acquireLaunch: Effect.Effect<
    TerminalLaunch,
    ProviderError | ProviderProtocolError,
    Scope.Scope
  >
}

export interface ValidatedBranch extends PreparedTerminal {
  readonly _tag: "ValidatedBranch"
  readonly derivation: BranchDerivation
}

export interface CreatedIndependentSession {
  readonly _tag: "CreatedIndependentSession"
  readonly session: AgentSession
  readonly transcript: TranscriptRead
  readonly reason: string
  readonly acquireLaunch?: Effect.Effect<
    TerminalLaunch,
    ProviderError | ProviderProtocolError,
    Scope.Scope
  >
}

export type BranchOutcome = ValidatedBranch | CreatedIndependentSession

export interface AgentProviderApi {
  readonly id: string
  readonly displayName: string
  readonly capabilities: ProviderCapabilities
  readonly loadSessionSnapshot: Effect.Effect<
    AgentSessionSnapshot,
    ProviderError | ProviderProtocolError
  >
  readonly readTranscripts: (
    sessionIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, TranscriptRead>, ProviderError | ProviderProtocolError>
  readonly prepareNewSession: Effect.Effect<
    PreparedTerminal,
    ProviderError | ProviderProtocolError
  >
  readonly prepareResume: (
    session: AgentSession,
  ) => Effect.Effect<PreparedTerminal, ProviderError | ProviderProtocolError>
  readonly branchFrom: (
    target: MessageRef,
  ) => Effect.Effect<BranchOutcome, ProviderError | ProviderProtocolError>
}

export class AgentProvider extends Context.Service<AgentProvider, AgentProviderApi>()(
  "claude-tree/AgentProvider",
) {}
