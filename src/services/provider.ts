import { Context, Deferred, Effect, PubSub, Scope } from "effect"

import type {
  AgentSession,
  AgentSessionSnapshot,
  BranchDerivation,
  DraftPreview,
  MessageRef,
  TerminalObserver,
  TranscriptRead,
} from "../domain/model"
import type {
  PersistenceError,
  ProviderCleanupError,
  ProviderError,
  ProviderProtocolError,
  SessionOwnedError,
  SessionRemovedError,
  TerminalError,
} from "../domain/errors"

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

export type TerminalTransitionAcknowledgmentError =
  | ProviderError
  | ProviderProtocolError
  | TerminalError
  | PersistenceError
  | SessionOwnedError
  | SessionRemovedError

export interface TerminalTransitionRequest {
  readonly event: TerminalTransitionEvent
  readonly acknowledgment: Deferred.Deferred<void, TerminalTransitionAcknowledgmentError>
}

export interface TerminalLaunch {
  readonly sessionId: string
  readonly command: readonly [string, ...string[]]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly observer: TerminalObserver
  readonly initialDraft?: DraftPreview
  readonly transitions?: PubSub.PubSub<TerminalTransitionRequest>
}

export interface AcquiredTerminalLaunch {
  readonly launch: TerminalLaunch
  readonly close: Effect.Effect<void, ProviderCleanupError>
}

export interface PreparedTerminal {
  readonly session: AgentSession
  readonly acquireLaunch: Effect.Effect<
    AcquiredTerminalLaunch,
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
    AcquiredTerminalLaunch,
    ProviderError | ProviderProtocolError,
    Scope.Scope
  >
}

export interface AmbiguousBranchMutation {
  readonly _tag: "AmbiguousBranchMutation"
  readonly providerId: string
  readonly parentSessionId: string
  readonly sourceMessageId: string
  readonly reason: string
  readonly reconciliation: "full-snapshot"
}

export type BranchOutcome = ValidatedBranch | CreatedIndependentSession | AmbiguousBranchMutation

export interface BranchMutationReconciliationSignal {
  readonly take: Effect.Effect<AmbiguousBranchMutation>
  offer(outcome: AmbiguousBranchMutation): void
}

export function makeBranchMutationReconciliationSignal(): BranchMutationReconciliationSignal {
  const pending: AmbiguousBranchMutation[] = []
  const waiters: Array<Deferred.Deferred<AmbiguousBranchMutation>> = []
  return {
    take: Effect.suspend(() => {
      const outcome = pending.shift()
      if (outcome !== undefined) return Effect.succeed(outcome)
      const waiter = Deferred.makeUnsafe<AmbiguousBranchMutation>()
      waiters.push(waiter)
      return Deferred.await(waiter).pipe(
        Effect.onInterrupt(() => Effect.sync(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
        })),
      )
    }),
    offer(outcome) {
      while (waiters.length > 0) {
        const waiter = waiters.shift()!
        if (Deferred.doneUnsafe(waiter, Effect.succeed(outcome))) return
      }
      pending.push(outcome)
    },
  }
}

export interface AgentProviderApi {
  readonly id: string
  readonly displayName: string
  readonly capabilities: ProviderCapabilities
  readonly takeBranchMutationReconciliation?: Effect.Effect<AmbiguousBranchMutation>
  readonly loadSessionSnapshot: Effect.Effect<
    AgentSessionSnapshot,
    ProviderError | ProviderProtocolError
  >
  readonly loadSessionSnapshotFor: (
    sessionIds: readonly string[],
  ) => Effect.Effect<AgentSessionSnapshot, ProviderError | ProviderProtocolError>
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
