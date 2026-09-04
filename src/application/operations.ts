import { isDeepStrictEqual } from "node:util"

import { Cause, Clock, Effect, Exit } from "effect"

import type { PersistenceError } from "../domain/errors"
import type { AgentSessionSnapshot } from "../domain/model"
import type {
  BranchRelation,
  ConversationRemoval,
  ProjectState,
} from "../domain/persistence"
import type { ProviderStateRepositoryApi } from "../services/provider-state-repository"
import type {
  AgentProviderApi,
  BranchOutcome,
  PreparedTerminal,
  ValidatedBranch,
} from "../services/provider"
import type { TerminalSupervisorApi } from "../services/terminal-supervisor"
export type ApplicationMetadataFacet = Pick<
  ProviderStateRepositoryApi,
  | "instanceId"
  | "loadMetadata"
  | "updateMetadata"
  | "commitRemoval"
  | "pendingAdoptions"
  | "orphanedAdoptions"
  | "reconcileOrphanedAdoption"
  | "ack"
>

export interface PersistedBranch {
  readonly prepared: PreparedTerminal
  readonly relation: BranchRelation
}

export interface IndependentBranch {
  readonly outcome: Exclude<BranchOutcome, ValidatedBranch>
}

export interface ApplicationOperations {
  readonly loadSnapshot: (
    mode: "full" | "incremental",
    sessionIds: readonly string[],
  ) => Effect.Effect<AgentSessionSnapshot, unknown>
  readonly prepareNew: Effect.Effect<PreparedTerminal, unknown>
  readonly prepareResume: AgentProviderApi["prepareResume"]
  readonly branch: (target: Parameters<AgentProviderApi["branchFrom"]>[0]) => Effect.Effect<
    PersistedBranch | IndependentBranch,
    unknown
  >
  readonly show: TerminalSupervisorApi["show"]
  readonly hideActive: Effect.Effect<{
    readonly sessionId: string | null
    readonly drafts: ReadonlyMap<string, import("../domain/model").DraftPreview>
  }>
  readonly stop: TerminalSupervisorApi["stopSession"]
  readonly commitRemoval: (
    removal: ConversationRemoval,
    affectedSessionIds: readonly string[],
    mutationToken: string,
  ) => Effect.Effect<ConversationRemoval, unknown>
}

export function makeApplicationOperations(options: {
  readonly provider: AgentProviderApi
  readonly metadata: ApplicationMetadataFacet
  readonly terminals: TerminalSupervisorApi
}): ApplicationOperations {
  const loadSnapshot = (mode: "full" | "incremental", sessionIds: readonly string[]) =>
    Effect.suspend(() => mode === "full"
      ? options.provider.loadSessionSnapshot
      : options.provider.loadSessionSnapshotFor(sessionIds))

  const saveRelation = (relation: BranchRelation): Effect.Effect<BranchRelation, PersistenceError> =>
    Effect.suspend(() =>
      reconcileMutation(
        options.metadata,
        Effect.suspend(() => options.metadata.updateMetadata((state) => {
          const existing = state.relations.find((candidate) => candidate.childSessionId === relation.childSessionId)
          if (existing) {
            if (!isDeepStrictEqual(existing, relation)) {
              throw new Error(`Session ${relation.childSessionId} already has different branch metadata`)
            }
            return state
          }
          return { ...state, relations: [...state.relations, relation] }
        })).pipe(Effect.as(relation)),
        (state) => state.relations.some((candidate) => isDeepStrictEqual(candidate, relation)),
        relation,
      ))

  const branch: ApplicationOperations["branch"] = (target) => Effect.suspend(() => Effect.gen(function*() {
    const outcome = yield* Effect.suspend(() => options.provider.branchFrom(target))
    if (outcome._tag === "AmbiguousBranchMutation") return { outcome }
    if (outcome._tag === "CreatedIndependentSession") return { outcome }

    const now = yield* Clock.currentTimeMillis
    const relation = { ...outcome.derivation, createdAt: new Date(now).toISOString() }
    const persisted = yield* Effect.exit(saveRelation(relation))
    if (Exit.isSuccess(persisted)) return { prepared: outcome, relation: persisted.value }

    const snapshot = yield* Effect.exit(Effect.suspend(() =>
      options.provider.loadSessionSnapshotFor([outcome.session.id])))
    return {
      outcome: {
        _tag: "CreatedIndependentSession",
        session: outcome.session,
        transcript: Exit.isSuccess(snapshot)
          ? snapshot.value.transcripts.get(outcome.session.id) ?? { _tag: "Missing" }
          : { _tag: "Unavailable", reason: errorMessage(Cause.squash(snapshot.cause)) },
        reason: `Branch was created but ancestry could not be saved: ${errorMessage(Cause.squash(persisted.cause))}`,
        acquireLaunch: outcome.acquireLaunch,
      },
    }
  }))

  return {
    loadSnapshot,
    prepareNew: Effect.suspend(() => options.provider.prepareNewSession),
    prepareResume: (session) => Effect.suspend(() => options.provider.prepareResume(session)),
    branch,
    show: (prepared) => Effect.suspend(() => options.terminals.show(prepared)),
    hideActive: Effect.suspend(() => Effect.all({
      sessionId: options.terminals.hideActive,
      drafts: options.terminals.draftPreviews,
    })),
    stop: (sessionId) => Effect.suspend(() => options.terminals.stopSession(sessionId)),
    commitRemoval: (removal, affectedSessionIds, mutationToken) => Effect.suspend(() =>
      options.metadata.commitRemoval(removal, affectedSessionIds, mutationToken)),
  }
}

export function reconcileMutation<A>(
  metadata: Pick<ApplicationMetadataFacet, "loadMetadata">,
  mutation: Effect.Effect<A, PersistenceError>,
  committed: (state: ProjectState) => boolean,
  recovered: A,
): Effect.Effect<A, PersistenceError> {
  return Effect.matchCauseEffect(mutation, {
    onFailure: (cause) => Effect.flatMap(Effect.suspend(() => metadata.loadMetadata), (state) =>
      committed(state) ? Effect.succeed(recovered) : Effect.fail(Cause.squash(cause) as PersistenceError)),
    onSuccess: Effect.succeed,
  })
}

export function rollbackPersistedBranch(
  metadata: ApplicationMetadataFacet,
  relation: BranchRelation,
): Effect.Effect<void, PersistenceError> {
  return Effect.suspend(() => reconcileMutation(
    metadata,
    Effect.suspend(() => metadata.updateMetadata((state) => ({
      ...state,
      relations: state.relations.filter((candidate) => !isDeepStrictEqual(candidate, relation)),
    }))).pipe(Effect.asVoid),
    (state) => !state.relations.some((candidate) => isDeepStrictEqual(candidate, relation)),
    undefined,
  ))
}

function errorMessage(error: unknown): string {
  try {
    return typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error)
  } catch {
    return "Unknown application error"
  }
}
