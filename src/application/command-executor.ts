import { Cause, Clock, Effect, Exit } from "effect"

import { ApplicationError } from "../domain/errors"
import type { AgentSessionSnapshot } from "../domain/model"
import type { BranchRelation } from "../domain/persistence"
import type { MetadataRepositoryApi } from "../services/metadata-repository"
import type { AgentProviderApi, PreparedTerminal } from "../services/provider"
import type { TerminalSupervisorApi } from "../services/terminal-supervisor"
import type { AppCommandExecutor, CommandCompletion } from "./coordinator"
import type { AppCommand } from "./events"
import type { NavigationPersistence } from "./navigation-persistence"

const DEFAULT_COMPLETION_DELAYS_MS = [100, 250, 500, 1_000] as const

export interface AppCommandExecutorOptions {
  readonly provider: AgentProviderApi
  readonly metadata: MetadataRepositoryApi
  readonly terminals: TerminalSupervisorApi
  readonly preparedTerminals: Map<string, PreparedTerminal>
  readonly navigation: NavigationPersistence
  readonly completionDelaysMs?: readonly number[]
  readonly knownSessionIds?: Effect.Effect<ReadonlySet<string>>
}

interface IncrementalSnapshotProvider {
  readonly loadSessionSnapshotFor: (
    sessionIds: readonly string[],
  ) => Effect.Effect<AgentSessionSnapshot, unknown>
}

export function makeAppCommandExecutor(
  options: AppCommandExecutorOptions,
): AppCommandExecutor<unknown> {
  const completionDelays = options.completionDelaysMs ?? DEFAULT_COMPLETION_DELAYS_MS

  return (command): Effect.Effect<CommandCompletion, unknown> => {
    switch (command._tag) {
      case "RefreshProvider":
        return Effect.gen(function*() {
          if (command.mode === "full") {
            const snapshot = yield* options.provider.loadSessionSnapshot
            return {
              _tag: "RefreshSucceeded" as const,
              generation: command.generation,
              snapshot,
            }
          }
          const transcriptSessionIds = new Set(command.sessionIds ?? [])
          if (command.focusSessionId) transcriptSessionIds.add(command.focusSessionId)
          const sessionIds = [...transcriptSessionIds]
          const incrementalProvider = options.provider as AgentProviderApi &
            Partial<IncrementalSnapshotProvider>
          const snapshot = incrementalProvider.loadSessionSnapshotFor
            ? yield* incrementalProvider.loadSessionSnapshotFor(sessionIds)
            : yield* loadIncrementalSnapshot(options, sessionIds, transcriptSessionIds)
          return {
            _tag: "RefreshSucceeded" as const,
            generation: command.generation,
            snapshot,
          }
        })
      case "ScheduleCompletionRefresh":
        return Effect.sleep(completionDelays[Math.min(command.attempt, completionDelays.length - 1)] ?? 0).pipe(
          Effect.as({
            _tag: "CompletionRefreshDue" as const,
            sessionId: command.sessionId,
            version: command.version,
          }),
        )
      case "ShowTerminal": {
        const prepared = options.preparedTerminals.get(command.sessionId)
        if (!prepared) {
          return Effect.fail(new ApplicationError({
            operation: "show terminal",
            message: `No prepared terminal is available for session ${command.sessionId}`,
          }))
        }
        return options.terminals.show(prepared).pipe(
          Effect.as({ _tag: "TerminalShowSucceeded" as const, sessionId: command.sessionId }),
        )
      }
      case "StopSession":
        return options.terminals.stopSession(command.sessionId).pipe(
          Effect.as({ _tag: "TerminalStopped" as const, sessionId: command.sessionId }),
        )
      case "PersistRemoval":
        return options.metadata.saveRemoval(command.removal).pipe(
          Effect.as({ _tag: "RemovalPersisted" as const, requestId: command.requestId }),
        )
      case "PersistRelation":
        return persistRelation(options.metadata, command).pipe(
          Effect.map((relation) => ({
            _tag: "RelationPersisted" as const,
            derivation: command.derivation,
            createdAt: relation.createdAt,
          })),
        )
      case "AdoptSessionIdentity":
        return adoptSessionIdentity(options, command)
      case "PersistNavigation":
        return options.navigation.save(command.navigation)
      case "Shutdown":
        return Effect.gen(function*() {
          const [navigationExit, terminalExit] = yield* Effect.all([
            Effect.exit(options.navigation.flush),
            Effect.exit(options.terminals.shutdown()),
          ], { concurrency: "unbounded" })
          if (Exit.isFailure(navigationExit) || Exit.isFailure(terminalExit)) {
            const messages = [navigationExit, terminalExit].flatMap((exit) =>
              Exit.isFailure(exit) ? [errorMessage(Cause.squash(exit.cause))] : [])
            return yield* Effect.fail(new ApplicationError({
              operation: "shutdown",
              message: messages.join("; "),
            }))
          }
          return { _tag: "ShutdownCompleted" as const }
        })
    }
  }
}

function loadIncrementalSnapshot(
  options: AppCommandExecutorOptions,
  sessionIds: readonly string[],
  transcriptSessionIds: ReadonlySet<string>,
): Effect.Effect<AgentSessionSnapshot, unknown> {
  return Effect.gen(function*() {
    const knownSessionIds = options.knownSessionIds
      ? yield* options.knownSessionIds
      : new Set<string>()
    if (sessionIds.some((sessionId) => !knownSessionIds.has(sessionId))) {
      return filterSnapshotTranscripts(
        yield* options.provider.loadSessionSnapshot,
        transcriptSessionIds,
      )
    }
    const transcripts = sessionIds.length === 0
      ? new Map()
      : yield* options.provider.readTranscripts(sessionIds)
    return { sessions: [], transcripts }
  })
}

function filterSnapshotTranscripts(
  snapshot: AgentSessionSnapshot,
  sessionIds: ReadonlySet<string>,
): AgentSessionSnapshot {
  return {
    sessions: snapshot.sessions,
    transcripts: new Map(
      [...snapshot.transcripts].filter(([sessionId]) => sessionIds.has(sessionId)),
    ),
  }
}

function persistRelation(
  metadata: MetadataRepositoryApi,
  command: Extract<AppCommand, { readonly _tag: "PersistRelation" }>,
): Effect.Effect<BranchRelation, unknown> {
  return Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    return yield* metadata.saveRelation({
      ...command.derivation,
      createdAt: new Date(now).toISOString(),
    })
  })
}

function adoptSessionIdentity(
  options: AppCommandExecutorOptions,
  command: Extract<AppCommand, { readonly _tag: "AdoptSessionIdentity" }>,
): Effect.Effect<CommandCompletion, unknown> {
  return Effect.gen(function*() {
    const previousSessionId = command.temporarySessionId
    const sessionId = command.session.id
    const moved = yield* options.terminals.replaceSessionId(previousSessionId, sessionId)
    if (!moved) {
      const owned = yield* options.terminals.ownedSessionIds
      if (!owned.has(sessionId) || owned.has(previousSessionId)) {
        return yield* Effect.fail(new ApplicationError({
          operation: "adopt session identity",
          message: `Terminal ownership could not move from ${previousSessionId} to ${sessionId}`,
        }))
      }
    }

    let relation: BranchRelation | undefined
    if (command.derivation) {
      const relationExit = yield* Effect.exit(persistRelation(options.metadata, {
        _tag: "PersistRelation",
        derivation: command.derivation,
      }))
      if (Exit.isFailure(relationExit)) {
        const rolledBack = yield* rollbackTerminalIdentity(
          options.terminals,
          previousSessionId,
          sessionId,
        )
        if (!rolledBack) {
          return yield* Effect.fail(new ApplicationError({
            operation: "adopt session identity",
            message: `${errorMessage(Cause.squash(relationExit.cause))}; terminal ownership was stopped because rollback could not be proven`,
          }))
        }
        return yield* Effect.fail(Cause.squash(relationExit.cause))
      }
      relation = relationExit.value
    }

    const metadataExit = yield* Effect.exit(
      options.metadata.replaceSessionId(previousSessionId, sessionId),
    )
    if (Exit.isFailure(metadataExit)) {
      const relationRollback = relation
        ? yield* Effect.exit(options.metadata.removeRelation(relation))
        : Exit.void
      const terminalRolledBack = yield* rollbackTerminalIdentity(
        options.terminals,
        previousSessionId,
        sessionId,
      )
      if (Exit.isFailure(relationRollback) || !terminalRolledBack) {
        yield* stopUncertainIdentity(options.terminals, previousSessionId, sessionId)
        return yield* Effect.fail(new ApplicationError({
          operation: "adopt session identity",
          message: `${errorMessage(Cause.squash(metadataExit.cause))}; rollback could not be proven, so terminal ownership was stopped`,
        }))
      }
      return yield* Effect.fail(Cause.squash(metadataExit.cause))
    }

    const prepared = options.preparedTerminals.get(previousSessionId)
    options.preparedTerminals.delete(previousSessionId)
    if (prepared) options.preparedTerminals.set(sessionId, { ...prepared, session: command.session })
    return {
      _tag: "SessionIdentityAdopted" as const,
      temporarySessionId: previousSessionId,
      session: command.session,
      ...(relation === undefined ? {} : { relation }),
    }
  })
}

function rollbackTerminalIdentity(
  terminals: TerminalSupervisorApi,
  previousSessionId: string,
  sessionId: string,
): Effect.Effect<boolean> {
  return Effect.gen(function*() {
    const rollback = yield* Effect.exit(terminals.replaceSessionId(sessionId, previousSessionId))
    if (Exit.isSuccess(rollback) && rollback.value) return true
    const owned = yield* terminals.ownedSessionIds
    if (owned.has(previousSessionId) && !owned.has(sessionId)) return true
    yield* stopUncertainIdentity(terminals, previousSessionId, sessionId)
    return false
  })
}

function stopUncertainIdentity(
  terminals: TerminalSupervisorApi,
  previousSessionId: string,
  sessionId: string,
): Effect.Effect<void> {
  return Effect.gen(function*() {
    const owned = yield* terminals.ownedSessionIds
    for (const candidate of [previousSessionId, sessionId]) {
      if (owned.has(candidate)) yield* Effect.exit(terminals.stopSession(candidate))
    }
  })
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message)
  }
  return String(error)
}
