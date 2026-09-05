import { isDeepStrictEqual } from "node:util"

import { Context, Effect, Layer, Schema } from "effect"

import {
  PersistenceError,
  SessionOwnedError,
  SessionRemovedError,
} from "../domain/errors"
import type { NavigationState } from "../domain/model"
import type {
  BranchRelation,
  ConversationRemoval,
  IdentityTransitionKind,
  PendingIdentityAdoption,
  ProjectState,
  ProviderState,
  TerminalOwner,
  TerminalOwnerStatus,
} from "../domain/persistence"
import {
  PersistencePlatform,
  PersistencePlatformLive,
  type PersistencePlatformApi,
  type ProcessLiveness,
} from "../infrastructure/metadata/platform"
import {
  PERSISTENCE_SCHEMA_VERSION,
  decodeStrict,
  prepareProjectStorage,
  readJsonIfPresent,
  requireSchemaVersion,
  withTransactionLock,
  writeJsonAtomically,
  type ProjectStoragePaths,
} from "../infrastructure/metadata/storage"

const MessageRefSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  messageId: Schema.NonEmptyString,
})

const BranchRelationSchema = Schema.Struct({
  childSessionId: Schema.NonEmptyString,
  parentSessionId: Schema.NonEmptyString,
  sourceMessageId: Schema.NonEmptyString,
  sharedMessages: Schema.Array(Schema.Struct({
    parentMessageId: Schema.NonEmptyString,
    childMessageId: Schema.NonEmptyString,
  })),
  createdAt: Schema.NonEmptyString,
})

const RemovalSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tree"),
    rootSessionId: Schema.NonEmptyString,
    memberSessionIds: Schema.Array(Schema.NonEmptyString),
    createdAt: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("subtree"),
    target: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("message"),
        aliases: Schema.Array(MessageRefSchema),
      }),
      Schema.Struct({
        kind: Schema.Literal("endpoint"),
        sessionId: Schema.NonEmptyString,
        afterMessageId: Schema.Union([Schema.NonEmptyString, Schema.Null]),
      }),
    ]),
    createdAt: Schema.NonEmptyString,
  }),
])

const NavigationSchema = Schema.Union([
  Schema.Struct({
    view: Schema.Literal("roots"),
    selectedSessionId: Schema.Union([Schema.NonEmptyString, Schema.Null]),
  }),
  Schema.Struct({
    view: Schema.Literal("graph"),
    familySessionId: Schema.NonEmptyString,
    target: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("message"),
        preferred: MessageRefSchema,
        aliases: Schema.Array(MessageRefSchema),
      }),
      Schema.Struct({
        kind: Schema.Literal("endpoint"),
        sessionId: Schema.NonEmptyString,
      }),
    ]),
  }),
  Schema.Struct({
    view: Schema.Literal("terminal"),
    sessionId: Schema.NonEmptyString,
  }),
])

const TerminalOwnerSchema = Schema.Struct({
  instanceId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  ownerToken: Schema.NonEmptyString,
  lastMutationToken: Schema.NonEmptyString,
  ownerPid: Schema.Int,
  status: Schema.Literals(["reserved", "running", "stopping", "cleanup-incomplete"]),
  processGroupId: Schema.optionalKey(Schema.Int),
  reservedAt: Schema.NonEmptyString,
  updatedAt: Schema.NonEmptyString,
})

const PendingIdentityAdoptionSchema = Schema.Struct({
  adoptionToken: Schema.NonEmptyString,
  kind: Schema.Literals(["temporary-adoption", "native-fork"]),
  instanceId: Schema.NonEmptyString,
  ownerToken: Schema.NonEmptyString,
  ownerPid: Schema.Int,
  processGroupId: Schema.Int,
  previousSessionId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  createdAt: Schema.NonEmptyString,
  relation: Schema.optionalKey(BranchRelationSchema),
})

const PersistedProviderStateSchema = Schema.Struct({
  schemaVersion: Schema.Literal(PERSISTENCE_SCHEMA_VERSION),
  relations: Schema.Array(BranchRelationSchema),
  removals: Schema.Array(RemovalSchema),
  navigations: Schema.Array(Schema.Struct({
    instanceId: Schema.NonEmptyString,
    navigation: NavigationSchema,
  })),
  terminalOwners: Schema.Array(TerminalOwnerSchema),
  pendingIdentityAdoptions: Schema.Array(PendingIdentityAdoptionSchema),
})

const LIVENESS_TIMEOUT_MILLISECONDS = 250

interface PersistedProviderState extends ProviderState {
  readonly schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION
}

export interface ProviderStateRepositoryOptions {
  readonly projectDirectory: string
  readonly providerId: string
  readonly stateHome?: string
  readonly instanceId?: string
}

interface CommitIdentityBase {
  readonly owner: TerminalOwner
  readonly sessionId: string
  readonly mutationToken?: string
}

export type CommitIdentityOptions = CommitIdentityBase & (
  | {
      readonly kind: Extract<IdentityTransitionKind, "temporary-adoption">
      readonly relation?: BranchRelation
    }
  | {
      readonly kind: Extract<IdentityTransitionKind, "native-fork">
      readonly relation?: BranchRelation
    }
)

export interface MutationOptions {
  readonly mutationToken?: string
}

export interface MarkTerminalOwnerOptions extends MutationOptions {
  readonly processGroupId?: number | null
}

export interface CommittedIdentity {
  readonly owner: TerminalOwner
  readonly adoption: PendingIdentityAdoption
  readonly metadata: ProjectState
}

export interface ReplaceSessionIdentityOptions {
  readonly kind: IdentityTransitionKind
  readonly relation?: BranchRelation
}

export interface ProviderStateRepositoryApi {
  readonly projectPath: string
  readonly statePath: string
  readonly instanceId: string
  readonly load: Effect.Effect<ProviderState, PersistenceError>
  readonly loadMetadata: Effect.Effect<ProjectState, PersistenceError>
  readonly updateMetadata: (
    transform: (state: ProjectState) => ProjectState,
  ) => Effect.Effect<ProjectState, PersistenceError>
  readonly commitRemoval: (
    removal: ConversationRemoval,
    affectedSessionIds: readonly string[],
    mutationToken?: string,
  ) => Effect.Effect<
    ConversationRemoval,
    PersistenceError | SessionOwnedError | SessionRemovedError
  >
  readonly reserve: (
    sessionId: string,
    options?: MutationOptions,
  ) => Effect.Effect<TerminalOwner, PersistenceError | SessionOwnedError | SessionRemovedError>
  readonly attach: (
    owner: TerminalOwner,
    processGroupId: number,
    options?: MutationOptions,
  ) => Effect.Effect<TerminalOwner, PersistenceError>
  readonly mark: (
    owner: TerminalOwner,
    status: TerminalOwnerStatus,
    options?: MarkTerminalOwnerOptions,
  ) => Effect.Effect<TerminalOwner, PersistenceError>
  readonly release: (
    owner: TerminalOwner,
    options?: MutationOptions,
  ) => Effect.Effect<void, PersistenceError>
  readonly commitIdentity: (
    options: CommitIdentityOptions,
  ) => Effect.Effect<
    CommittedIdentity,
    PersistenceError | SessionOwnedError | SessionRemovedError
  >
  readonly ack: (adoptionToken: string) => Effect.Effect<void, PersistenceError>
  readonly pendingAdoptions: Effect.Effect<readonly PendingIdentityAdoption[], PersistenceError>
  readonly orphanedAdoptions: Effect.Effect<readonly PendingIdentityAdoption[], PersistenceError>
  readonly reconcileOrphanedAdoption: (
    adoptionToken: string,
  ) => Effect.Effect<void, PersistenceError>
}

export class ProviderStateRepository extends Context.Service<
  ProviderStateRepository,
  ProviderStateRepositoryApi
>()("claude-tree/ProviderStateRepository") {}

export function makeProviderStateRepository(
  options: ProviderStateRepositoryOptions,
): Effect.Effect<ProviderStateRepositoryApi, PersistenceError, PersistencePlatform> {
  return Effect.gen(function*() {
    const platform = yield* PersistencePlatform
    const instanceId = options.instanceId ?? platform.instanceId
    if (instanceId.length === 0) {
      return yield* Effect.fail(persistenceError(
        "open provider state",
        options.projectDirectory,
        new Error("Instance ID cannot be empty"),
      ))
    }
    const paths = yield* prepareProjectStorage(
      platform,
      options.projectDirectory,
      options.providerId,
      options.stateHome,
    ).pipe(Effect.mapError((cause) =>
      persistenceError("open provider state", options.projectDirectory, cause)))

    yield* withTransactionLock(
      platform,
      paths.stateLockPath,
      Effect.gen(function*() {
        const value = yield* readJsonIfPresent(platform, paths.statePath)
        if (value === undefined) {
          yield* writeJsonAtomically(platform, paths.statePath, persistedState(emptyProviderState()))
          return
        }
        yield* syncAttempt(() => decodeProviderState(value, paths))
      }),
    ).pipe(Effect.mapError((cause) =>
      persistenceError("initialize provider state", paths.statePath, cause)))

    return providerStateApi(platform, paths, options.providerId, instanceId)
  })
}

export function ProviderStateRepositoryLive(options: ProviderStateRepositoryOptions) {
  return Layer.effect(
    ProviderStateRepository,
    makeProviderStateRepository(options),
  ).pipe(Layer.provide(PersistencePlatformLive))
}

function providerStateApi(
  platform: PersistencePlatformApi,
  paths: ProjectStoragePaths,
  providerId: string,
  instanceId: string,
): ProviderStateRepositoryApi {
  const readStateUnlocked = Effect.gen(function*() {
    const value = yield* readJsonIfPresent(platform, paths.statePath)
    if (value === undefined) return yield* Effect.fail(new Error("Provider state is missing"))
    return yield* syncAttempt(() => decodeProviderState(value, paths))
  })

  const readState = (operation: string): Effect.Effect<ProviderState, PersistenceError> =>
    withTransactionLock(
      platform,
      paths.stateLockPath,
      readStateUnlocked.pipe(Effect.map(domainState)),
      { interruptibleUse: true },
    ).pipe(Effect.mapError((cause) => persistenceError(operation, paths.statePath, cause)))

  const load = readState("load provider state")

  const transaction = <A>(
    operation: string,
    transform: (state: ProviderState) => Effect.Effect<readonly [ProviderState, A], unknown>,
  ): Effect.Effect<A, PersistenceError | SessionOwnedError | SessionRemovedError> =>
    withTransactionLock(
      platform,
      paths.stateLockPath,
      Effect.gen(function*() {
        const current = domainState(yield* readStateUnlocked)
        const [candidate, result] = yield* transform(current)
        const next = yield* syncAttempt(() => canonicalizeAndValidate(candidate))
        if (!jsonEqual(current, next)) {
          yield* writeJsonAtomically(platform, paths.statePath, persistedState(next))
        }
        return result
      }),
    ).pipe(Effect.mapError((cause) =>
      cause instanceof SessionOwnedError ||
          cause instanceof SessionRemovedError ||
          cause instanceof PersistenceError
        ? cause
        : persistenceError(operation, paths.statePath, cause)))

  const persistenceTransaction = <A>(
    operation: string,
    transform: (state: ProviderState) => Effect.Effect<readonly [ProviderState, A], unknown>,
  ): Effect.Effect<A, PersistenceError> =>
    transaction(operation, transform).pipe(Effect.mapError((cause) =>
      cause instanceof PersistenceError
        ? cause
        : persistenceError(operation, paths.statePath, cause)))

  const reconcileWrite = <
    A,
    E extends PersistenceError | SessionOwnedError | SessionRemovedError,
  >(
    operation: string,
    attempted: Effect.Effect<A, E>,
    recover: (state: ProviderState) => A | undefined,
  ): Effect.Effect<A, E> => attempted.pipe(Effect.catch((error) =>
    readState(`reconcile ${operation}`).pipe(
      Effect.flatMap((state) => syncAttempt(() => recover(state))),
      Effect.flatMap((recovered) => recovered === undefined
        ? Effect.fail(error)
        : Effect.succeed(recovered)),
      Effect.catch(() => Effect.fail(error)),
    ))) as Effect.Effect<A, E>

  const updateMetadata: ProviderStateRepositoryApi["updateMetadata"] = (transform) =>
    persistenceTransaction("update project metadata", (state) =>
      syncAttempt(() => {
        const current = projectStateForInstance(state, instanceId)
        const nextMetadata = transform(current)
        const next = replaceMetadataForInstance(state, instanceId, nextMetadata)
        return [next, projectStateForInstance(canonicalizeAndValidate(next), instanceId)] as const
      }))

  const commitRemoval: ProviderStateRepositoryApi["commitRemoval"] = (
    removal,
    affectedSessionIds,
    providedMutationToken,
  ) => {
    const mutationToken = providedMutationToken ?? platform.randomToken()
    const attempted = transaction("commit conversation removal", (state) =>
      syncAttempt(() => {
        requireNonEmpty(mutationToken, "Mutation token")
        for (const sessionId of affectedSessionIds) {
          requireNonEmpty(sessionId, "Affected session ID")
        }
        requireUnique(affectedSessionIds, "Affected session IDs")

        const canonicalRemoval = canonicalizeRemoval(
          applyPendingTemporaryAdoptionsToRemoval(state, removal),
        )
        const committed = state.removals.find((candidate) => sameRemoval(candidate, canonicalRemoval))
        if (committed !== undefined) return [state, committed] as const

        const affected = affectedSessionIdsForRemoval(state, canonicalRemoval, affectedSessionIds)
        const owner = state.terminalOwners.find((candidate) => affected.has(candidate.sessionId))
        if (owner !== undefined) {
          throw new SessionOwnedError({
            providerId,
            sessionId: owner.sessionId,
            ownerPid: owner.ownerPid,
          })
        }
        return [{ ...state, removals: [...state.removals, canonicalRemoval] }, canonicalRemoval] as const
      }))
    return reconcileWrite("commit conversation removal", attempted, (state) =>
      state.removals.find((candidate) => sameRemoval(
        candidate,
        applyPendingTemporaryAdoptionsToRemoval(state, removal),
      )))
  }

  const reserve: ProviderStateRepositoryApi["reserve"] = (sessionId, options) => {
    const mutationToken = options?.mutationToken ?? platform.randomToken()
    const attempted = transaction("reserve terminal owner", (state) =>
      Effect.gen(function*() {
        yield* syncAttempt(() => requireNonEmpty(sessionId, "Session ID"))
        yield* syncAttempt(() => requireNonEmpty(mutationToken, "Mutation token"))
        if (isSessionRemoved(state, sessionId)) {
          return yield* Effect.fail(sessionRemovedError(providerId, sessionId))
        }
        let owners = state.terminalOwners
        const existing = owners.find((owner) => owner.sessionId === sessionId)
        if (existing !== undefined) {
          if (isCommittedReserve(existing, instanceId, platform.pid, mutationToken)) {
            return [state, existing] as const
          }
          if (!(yield* ownerCanBeAutomaticallyReclaimed(platform, state, existing))) {
            return yield* Effect.fail(new SessionOwnedError({
              providerId,
              sessionId,
              ownerPid: existing.ownerPid,
            }))
          }
          owners = owners.filter((owner) => owner.sessionId !== sessionId)
        }

        const now = platform.now()
        const owner: TerminalOwner = {
          instanceId,
          sessionId,
          ownerToken: mutationToken,
          lastMutationToken: mutationToken,
          ownerPid: platform.pid,
          status: "reserved",
          reservedAt: now,
          updatedAt: now,
        }
        return [{ ...state, terminalOwners: [...owners, owner] }, owner] as const
      }))
    return reconcileWrite("reserve terminal owner", attempted, (state) =>
      state.terminalOwners.find((owner) =>
        owner.sessionId === sessionId &&
        owner.ownerToken === mutationToken &&
        owner.lastMutationToken === mutationToken &&
        owner.instanceId === instanceId &&
        owner.ownerPid === platform.pid))
  }

  const mutateOwner = (
    operation: string,
    owner: TerminalOwner,
    mutationToken: string,
    mutate: (current: TerminalOwner, state: ProviderState) => TerminalOwner,
    matches: (current: TerminalOwner) => boolean,
  ): Effect.Effect<TerminalOwner, PersistenceError> =>
    reconcileWrite(operation, persistenceTransaction(operation, (state) =>
      syncAttempt(() => {
        validatePublicOwner(owner)
        requireNonEmpty(mutationToken, "Mutation token")
        const current = requireOwnedTerminal(state, owner)
        const updated = { ...mutate(current, state), lastMutationToken: mutationToken }
        return [
          {
            ...state,
            terminalOwners: state.terminalOwners.map((candidate) =>
              candidate.sessionId === current.sessionId ? updated : candidate),
          },
          updated,
        ] as const
      })), (state) => state.terminalOwners.find((candidate) =>
        candidate.ownerToken === owner.ownerToken &&
        candidate.lastMutationToken === mutationToken &&
        matches(candidate)))

  return {
    projectPath: paths.projectPath,
    statePath: paths.statePath,
    instanceId,
    load,
    loadMetadata: load.pipe(Effect.map((state) => projectStateForInstance(state, instanceId))),
    updateMetadata,
    commitRemoval,
    reserve,
    attach: (owner, processGroupId, options) => {
      const mutationToken = options?.mutationToken ?? platform.randomToken()
      return mutateOwner("attach terminal process", owner, mutationToken, (current, state) => {
        requireProcessGroup(processGroupId)
        const adoption = state.pendingIdentityAdoptions.find((candidate) =>
          candidate.ownerToken === current.ownerToken)
        if (adoption !== undefined && adoption.processGroupId !== processGroupId) {
          throw new Error("Cannot change the process group while identity adoption is pending")
        }
        return {
          ...current,
          status: "running",
          processGroupId,
          updatedAt: platform.now(),
        }
      }, (current) => current.status === "running" && current.processGroupId === processGroupId)
    },
    mark: (owner, status, options) => {
      const mutationToken = options?.mutationToken ?? platform.randomToken()
      return mutateOwner("mark terminal owner", owner, mutationToken, (current, state) => {
        requireProcessGroup(options?.processGroupId ?? undefined)
        requirePendingAdoptionProcessGroup(state, current, options)
        const base = options?.processGroupId === null
          ? withoutProcessGroup(current)
          : current
        const updated = {
          ...base,
          ...(options?.processGroupId === undefined || options.processGroupId === null
            ? {}
            : { processGroupId: options.processGroupId }),
          status,
          updatedAt: platform.now(),
        }
        if (status === "running" && updated.processGroupId === undefined) {
          throw new Error("A running terminal owner must have a process group")
        }
        return updated
      }, (current) =>
        current.status === status &&
        (options?.processGroupId === undefined ||
          current.processGroupId === (options.processGroupId === null
            ? undefined
            : options.processGroupId)))
    },
    release: (owner, options) => {
      const mutationToken = options?.mutationToken ?? platform.randomToken()
      const attempted = persistenceTransaction("release terminal owner", (state) =>
        syncAttempt(() => {
          validatePublicOwner(owner)
          requireNonEmpty(mutationToken, "Mutation token")
          const current = requireOwnedTerminal(state, owner)
          if (state.pendingIdentityAdoptions.some((adoption) =>
            adoption.ownerToken === current.ownerToken)) {
            throw new Error("Terminal owner has an unacknowledged identity adoption")
          }
          return [{
            ...state,
            terminalOwners: state.terminalOwners.filter((candidate) =>
              candidate.sessionId !== current.sessionId),
          }, mutationToken] as const
        }))
      return Effect.asVoid(reconcileWrite("release terminal owner", attempted, (state) =>
        state.terminalOwners.some((candidate) =>
          candidate.ownerToken === owner.ownerToken || candidate.sessionId === owner.sessionId)
          ? undefined
          : mutationToken))
    },
    commitIdentity: (options) => {
      const kind = options.kind
      const mutationToken = options.mutationToken ?? platform.randomToken()
      const attempted = transaction("commit session identity", (state) =>
        Effect.gen(function*() {
          yield* syncAttempt(() => {
            validatePublicOwner(options.owner)
            if (kind !== "temporary-adoption" && kind !== "native-fork") {
              throw new Error("Identity transition kind must be explicit")
            }
            requireNonEmpty(options.sessionId, "New session ID")
            requireNonEmpty(mutationToken, "Mutation token")
            if (options.owner.sessionId === options.sessionId) {
              throw new Error("Replacement session ID must be different")
            }
            if (
              options.relation !== undefined &&
              options.relation.childSessionId !== options.sessionId
            ) {
              throw new Error("Committed branch relation must belong to the new session ID")
            }
            if (
              options.kind === "native-fork" &&
              options.relation !== undefined &&
              options.relation.parentSessionId !== options.owner.sessionId
            ) {
              throw new Error("Native fork relation must descend from the previous session ID")
            }
            if (
              options.kind === "native-fork" &&
              options.relation !== undefined &&
              options.relation.sharedMessages.length === 0
            ) {
              throw new Error("Native fork relation must contain shared message mappings")
            }
          })

          const recovered = yield* syncAttempt(() =>
            findCommittedIdentity(state, options, kind, mutationToken))
          if (recovered !== undefined) {
            return [state, {
              owner: recovered.owner,
              adoption: recovered.adoption,
              metadata: projectStateForInstance(state, instanceId),
            }] as const
          }

          const source = yield* syncAttempt(() => requireOwnedTerminal(state, options.owner))
          const processGroupId = source.processGroupId
          if (processGroupId === undefined) {
            return yield* Effect.fail(new Error(
              "Identity adoption requires a registered process group",
            ))
          }
          yield* syncAttempt(() => {
            if (state.pendingIdentityAdoptions.some((adoption) =>
              adoption.ownerToken === source.ownerToken)) {
              throw new Error("Terminal owner already has an unacknowledged identity adoption")
            }
          })
          let owners = state.terminalOwners
          const destination = owners.find((owner) => owner.sessionId === options.sessionId)
          if (destination !== undefined && destination.ownerToken !== source.ownerToken) {
            if (!(yield* ownerCanBeAutomaticallyReclaimed(platform, state, destination))) {
              return yield* Effect.fail(new SessionOwnedError({
                providerId,
                sessionId: options.sessionId,
                ownerPid: destination.ownerPid,
              }))
            }
            owners = owners.filter((owner) => owner.sessionId !== options.sessionId)
          }

          return yield* syncAttempt(() => {
            const movedOwner: TerminalOwner = {
              ...source,
              sessionId: options.sessionId,
              lastMutationToken: mutationToken,
              updatedAt: platform.now(),
            }
            let next = kind === "temporary-adoption"
              ? replaceTemporarySessionIdInProviderState(
                  { ...state, terminalOwners: owners },
                  source.sessionId,
                  options.sessionId,
                )
              : replaceSessionIdForInstanceNavigation(
                  { ...state, terminalOwners: owners },
                  instanceId,
                  source.sessionId,
                  options.sessionId,
                  options.relation,
                )
            next = {
              ...next,
              terminalOwners: next.terminalOwners.map((owner) =>
                owner.ownerToken === source.ownerToken ? movedOwner : owner),
            }

            const relation = options.relation
            if (relation !== undefined) next = saveRelationInState(next, relation)
            const adoption: PendingIdentityAdoption = {
              adoptionToken: mutationToken,
              kind,
              instanceId,
              ownerToken: source.ownerToken,
              ownerPid: source.ownerPid,
              processGroupId,
              previousSessionId: source.sessionId,
              sessionId: options.sessionId,
              createdAt: platform.now(),
              ...(relation === undefined ? {} : { relation }),
            }
            next = {
              ...next,
              pendingIdentityAdoptions: [...next.pendingIdentityAdoptions, adoption],
            }
            const removalConflict = identityRemovalConflict(
              state,
              next,
              source.sessionId,
              options.sessionId,
            )
            if (removalConflict !== undefined) {
              throw sessionRemovedError(providerId, removalConflict)
            }
            return [next, {
              owner: movedOwner,
              adoption,
              metadata: projectStateForInstance(canonicalizeAndValidate(next), instanceId),
            }] as const
          })
        }))
      return reconcileWrite("commit session identity", attempted, (state) => {
        const recovered = findCommittedIdentity(state, options, kind, mutationToken)
        return recovered === undefined
          ? undefined
          : {
              owner: recovered.owner,
              adoption: recovered.adoption,
              metadata: projectStateForInstance(state, instanceId),
            }
      })
    },
    ack: (adoptionToken) => {
      const attempted = persistenceTransaction("acknowledge session identity", (state) =>
        syncAttempt(() => {
          requireNonEmpty(adoptionToken, "Adoption token")
          const adoption = state.pendingIdentityAdoptions.find((candidate) =>
            candidate.adoptionToken === adoptionToken)
          if (adoption !== undefined && adoption.instanceId !== instanceId) {
            throw new Error("Identity adoption belongs to a different application instance")
          }
          return [{
            ...state,
            pendingIdentityAdoptions: state.pendingIdentityAdoptions.filter((adoption) =>
              adoption.adoptionToken !== adoptionToken),
          }, adoptionToken] as const
        }))
      return Effect.asVoid(reconcileWrite("acknowledge session identity", attempted, (state) =>
        state.pendingIdentityAdoptions.some((adoption) => adoption.adoptionToken === adoptionToken)
          ? undefined
          : adoptionToken))
    },
    pendingAdoptions: load.pipe(Effect.map((state) =>
      state.pendingIdentityAdoptions.filter((adoption) => adoption.instanceId === instanceId))),
    orphanedAdoptions: orphanedAdoptions(platform, paths, instanceId),
    reconcileOrphanedAdoption: (adoptionToken) => {
      const attempted = persistenceTransaction("reconcile orphaned identity adoption", (state) =>
        Effect.gen(function*() {
          yield* syncAttempt(() => requireNonEmpty(adoptionToken, "Adoption token"))
          const adoption = state.pendingIdentityAdoptions.find((candidate) =>
            candidate.adoptionToken === adoptionToken)
          if (adoption === undefined) return [state, adoptionToken] as const
          if (adoption.instanceId === instanceId) {
            return yield* Effect.fail(new Error(
              "Current-instance identity adoption requires application acknowledgment",
            ))
          }
          const owner = yield* syncAttempt(() => requireAdoptionOwner(state, adoption))
          if (!(yield* ownerIsDefinitelyAbsent(platform, owner, adoption.processGroupId))) {
            return yield* Effect.fail(new Error(
              "Identity adoption origin is not definitely absent",
            ))
          }
          return [{
            ...state,
            pendingIdentityAdoptions: state.pendingIdentityAdoptions.filter((candidate) =>
              candidate.adoptionToken !== adoptionToken),
          }, adoptionToken] as const
        }))
      return Effect.asVoid(reconcileWrite(
        "reconcile orphaned identity adoption",
        attempted,
        (state) => state.pendingIdentityAdoptions.some((adoption) =>
          adoption.adoptionToken === adoptionToken)
          ? undefined
          : adoptionToken,
      ))
    },
  }
}

function decodeProviderState(input: unknown, paths: ProjectStoragePaths): PersistedProviderState {
  requireSchemaVersion(input, "provider state", paths.projectDirectory)
  const decoded = decodeStrict(PersistedProviderStateSchema, input) as PersistedProviderState
  const state = domainState(decoded)
  validateProviderState(state)
  if (!jsonEqual(decoded, persistedState(canonicalizeProviderState(state)))) {
    throw new Error("Provider state is not canonically ordered")
  }
  return decoded
}

function canonicalizeAndValidate(state: ProviderState): ProviderState {
  const canonical = canonicalizeProviderState(state)
  const decoded = decodeStrict(PersistedProviderStateSchema, persistedState(canonical)) as PersistedProviderState
  const domain = domainState(decoded)
  validateProviderState(domain)
  return domain
}

function validateProviderState(state: ProviderState): void {
  validateProjectState({ relations: state.relations, removals: state.removals })
  requireUnique(state.navigations.map((entry) => entry.instanceId), "Navigation instance IDs")
  for (const entry of state.navigations) validateNavigation(entry.navigation)
  requireUnique(state.terminalOwners.map((owner) => owner.sessionId), "Terminal owner sessions")
  requireUnique(state.terminalOwners.map((owner) => owner.ownerToken), "Terminal owner tokens")
  requireUnique(
    state.terminalOwners.map((owner) => owner.lastMutationToken ?? ""),
    "Terminal owner mutation tokens",
  )
  const ownerPidByInstance = new Map<string, number>()
  for (const owner of state.terminalOwners) {
    validatePublicOwner(owner)
    const ownerPid = ownerPidByInstance.get(owner.instanceId)
    if (ownerPid !== undefined && ownerPid !== owner.ownerPid) {
      throw new Error("Terminal owners for one instance must have the same owner PID")
    }
    ownerPidByInstance.set(owner.instanceId, owner.ownerPid)
  }
  requireUnique(
    state.pendingIdentityAdoptions.map((adoption) => adoption.adoptionToken),
    "Identity adoption tokens",
  )
  requireUnique(
    state.pendingIdentityAdoptions.map((adoption) => adoption.ownerToken),
    "Identity adoption owner tokens",
  )
  requireUnique(
    state.pendingIdentityAdoptions.map((adoption) => adoption.previousSessionId),
    "Identity adoption previous session IDs",
  )
  requireUnique(
    state.pendingIdentityAdoptions.map((adoption) => adoption.sessionId),
    "Identity adoption session IDs",
  )
  for (const adoption of state.pendingIdentityAdoptions) {
    requireCanonicalDate(adoption.createdAt)
    if (!Number.isSafeInteger(adoption.ownerPid) || adoption.ownerPid <= 0) {
      throw new Error("Identity adoption owner PID must be a positive integer")
    }
    requireProcessGroup(adoption.processGroupId)
    if (adoption.previousSessionId === adoption.sessionId) {
      throw new Error("Identity adoption must change the session ID")
    }
    if (
      adoption.kind === "native-fork" &&
      adoption.relation !== undefined &&
      adoption.relation.parentSessionId !== adoption.previousSessionId
    ) {
      throw new Error("Native fork relation does not match its previous session ID")
    }
    if (
      adoption.kind === "native-fork" &&
      adoption.relation !== undefined &&
      adoption.relation.sharedMessages.length === 0
    ) {
      throw new Error("Native fork relation must contain shared message mappings")
    }
    const owner = requireAdoptionOwner(state, adoption)
    if (
      owner.instanceId !== adoption.instanceId ||
      owner.ownerPid !== adoption.ownerPid ||
      owner.processGroupId !== adoption.processGroupId ||
      owner.sessionId !== adoption.sessionId
    ) {
      throw new Error("Identity adoption does not exactly match its terminal owner")
    }
    if (state.terminalOwners.some((candidate) =>
      candidate.ownerToken !== adoption.ownerToken &&
      candidate.sessionId === adoption.previousSessionId)) {
      throw new Error("Identity adoption previous session is owned by another terminal")
    }
    if (adoption.relation !== undefined) {
      validateProjectState({ relations: [adoption.relation], removals: [] })
      if (adoption.relation.childSessionId !== adoption.sessionId) {
        throw new Error("Identity adoption relation belongs to a different child session")
      }
      const relation = state.relations.find((candidate) =>
        candidate.childSessionId === adoption.relation!.childSessionId)
      if (!jsonEqual(relation, adoption.relation)) {
        throw new Error("Identity adoption relation does not match persisted branch metadata")
      }
    }
  }
}

function validateProjectState(state: ProjectState): void {
  const parentByChild = new Map<string, string>()
  for (const relation of state.relations) {
    requireCanonicalDate(relation.createdAt)
    if (relation.childSessionId === relation.parentSessionId) {
      throw new Error(`Session ${relation.childSessionId} cannot be its own parent`)
    }
    if (parentByChild.has(relation.childSessionId)) {
      throw new Error(`Session ${relation.childSessionId} has more than one parent`)
    }
    parentByChild.set(relation.childSessionId, relation.parentSessionId)
    requireUnique(
      relation.sharedMessages.map((mapping) => mapping.parentMessageId),
      "Shared parent message mappings",
    )
    requireUnique(
      relation.sharedMessages.map((mapping) => mapping.childMessageId),
      "Shared child message mappings",
    )
    if (
      relation.sharedMessages.length > 0 &&
      relation.sharedMessages.at(-1)?.parentMessageId !== relation.sourceMessageId
    ) {
      throw new Error("Shared message mappings must end at the source message")
    }
  }
  for (const child of parentByChild.keys()) {
    const seen = new Set<string>()
    let current: string | undefined = child
    while (current !== undefined) {
      if (seen.has(current)) throw new Error(`Branch metadata contains a cycle involving ${current}`)
      seen.add(current)
      current = parentByChild.get(current)
    }
  }

  requireUnique(state.removals.map(removalIdentity), "Removal identities")
  for (const removal of state.removals) {
    requireCanonicalDate(removal.createdAt)
    if (removal.kind === "tree") {
      if (removal.memberSessionIds.length === 0) {
        throw new Error("Tree removals must contain at least one member")
      }
      requireUnique(removal.memberSessionIds, "Tree member session IDs")
      if (!removal.memberSessionIds.includes(removal.rootSessionId)) {
        throw new Error("Tree members must include the root session")
      }
    } else if (removal.target.kind === "message") {
      if (removal.target.aliases.length === 0) {
        throw new Error("Message removals must contain at least one alias")
      }
      requireUnique(removal.target.aliases.map(messageRefIdentity), "Message aliases")
    }
  }
  if (state.navigation !== undefined) validateNavigation(state.navigation)
}

function validateNavigation(navigation: NavigationState): void {
  if (navigation.view !== "graph" || navigation.target.kind !== "message") return
  const target = navigation.target
  if (target.aliases.length === 0) {
    throw new Error("Navigation message aliases cannot be empty")
  }
  requireUnique(target.aliases.map(messageRefIdentity), "Navigation message aliases")
  if (!target.aliases.some((alias) =>
    messageRefIdentity(alias) === messageRefIdentity(target.preferred))) {
    throw new Error("Preferred navigation message must be one of its aliases")
  }
}

function validatePublicOwner(owner: TerminalOwner): void {
  requireNonEmpty(owner.instanceId, "Instance ID")
  requireNonEmpty(owner.sessionId, "Session ID")
  requireNonEmpty(owner.ownerToken, "Owner token")
  requireNonEmpty(owner.lastMutationToken ?? "", "Last mutation token")
  if (!Number.isSafeInteger(owner.ownerPid) || owner.ownerPid <= 0) {
    throw new Error("Terminal owner PID must be a positive integer")
  }
  requireProcessGroup(owner.processGroupId)
  if (owner.status === "running" && owner.processGroupId === undefined) {
    throw new Error("A running terminal owner must have a process group")
  }
  requireCanonicalDate(owner.reservedAt)
  requireCanonicalDate(owner.updatedAt)
  if (owner.updatedAt < owner.reservedAt) {
    throw new Error("Terminal owner update cannot predate its reservation")
  }
}

function canonicalizeProviderState(state: ProviderState): ProviderState {
  return {
    relations: [...state.relations].sort((a, b) => compare(a.childSessionId, b.childSessionId)),
    removals: state.removals.map(canonicalizeRemoval).sort((a, b) =>
      compare(removalIdentity(a), removalIdentity(b))),
    navigations: state.navigations.map((entry) => ({
      ...entry,
      navigation: canonicalizeNavigation(entry.navigation),
    })).sort((a, b) => compare(a.instanceId, b.instanceId)),
    terminalOwners: [...state.terminalOwners].sort((a, b) => compare(a.sessionId, b.sessionId)),
    pendingIdentityAdoptions: [...state.pendingIdentityAdoptions].sort((a, b) =>
      compare(a.adoptionToken, b.adoptionToken)),
  }
}

function emptyProviderState(): ProviderState {
  return {
    relations: [],
    removals: [],
    navigations: [],
    terminalOwners: [],
    pendingIdentityAdoptions: [],
  }
}

function persistedState(state: ProviderState): PersistedProviderState {
  return { schemaVersion: PERSISTENCE_SCHEMA_VERSION, ...state }
}

function domainState(state: PersistedProviderState): ProviderState {
  return {
    relations: state.relations,
    removals: state.removals,
    navigations: state.navigations,
    terminalOwners: state.terminalOwners,
    pendingIdentityAdoptions: state.pendingIdentityAdoptions,
  }
}

function projectStateForInstance(state: ProviderState, instanceId: string): ProjectState {
  const navigation = state.navigations.find((entry) => entry.instanceId === instanceId)?.navigation
  return navigation === undefined
    ? { relations: state.relations, removals: state.removals }
    : { relations: state.relations, removals: state.removals, navigation }
}

function replaceMetadataForInstance(
  state: ProviderState,
  instanceId: string,
  metadata: ProjectState,
): ProviderState {
  const navigations = state.navigations.filter((entry) => entry.instanceId !== instanceId)
  return {
    ...state,
    relations: metadata.relations,
    removals: metadata.removals,
    navigations: metadata.navigation === undefined
      ? navigations
      : [...navigations, { instanceId, navigation: metadata.navigation }],
  }
}

function requireOwnedTerminal(state: ProviderState, owner: TerminalOwner): TerminalOwner {
  const current = state.terminalOwners.find((candidate) => candidate.sessionId === owner.sessionId)
  if (current === undefined) throw new Error("Terminal owner is missing")
  if (current.ownerToken !== owner.ownerToken || current.instanceId !== owner.instanceId) {
    throw new Error("Terminal owner token does not match")
  }
  return current
}

function requireAdoptionOwner(
  state: ProviderState,
  adoption: PendingIdentityAdoption,
): TerminalOwner {
  const owner = state.terminalOwners.find((candidate) =>
    candidate.ownerToken === adoption.ownerToken)
  if (owner === undefined) throw new Error("Identity adoption terminal owner is missing")
  return owner
}

function requirePendingAdoptionProcessGroup(
  state: ProviderState,
  owner: TerminalOwner,
  options: MarkTerminalOwnerOptions | undefined,
): void {
  const adoption = state.pendingIdentityAdoptions.find((candidate) =>
    candidate.ownerToken === owner.ownerToken)
  if (adoption === undefined || options?.processGroupId === undefined) return
  if (options.processGroupId === null || options.processGroupId !== adoption.processGroupId) {
    throw new Error("Cannot change the process group while identity adoption is pending")
  }
}

function withoutProcessGroup(owner: TerminalOwner): Omit<TerminalOwner, "processGroupId"> {
  const { processGroupId: _, ...without } = owner
  return without
}

function ownerIsDefinitelyAbsent(
  platform: PersistencePlatformApi,
  owner: TerminalOwner,
  processGroupId: number | undefined = owner.processGroupId,
): Effect.Effect<boolean, unknown> {
  return Effect.gen(function*() {
    const ownerLiveness = yield* boundedLiveness(
      () => platform.processLiveness(owner.ownerPid),
      `check owner PID ${owner.ownerPid}`,
    )
    if (ownerLiveness !== "absent") return false
    if (processGroupId === undefined) return true
    return (yield* boundedLiveness(
      () => platform.processGroupLiveness(processGroupId),
      `check process group ${processGroupId}`,
    )) === "absent"
  })
}

function ownerCanBeAutomaticallyReclaimed(
  platform: PersistencePlatformApi,
  state: ProviderState,
  owner: TerminalOwner,
): Effect.Effect<boolean, unknown> {
  if (owner.status === "stopping" || owner.status === "cleanup-incomplete") {
    return Effect.succeed(false)
  }
  if (owner.status === "reserved" && owner.processGroupId === undefined) {
    return Effect.succeed(false)
  }
  if (state.pendingIdentityAdoptions.some((adoption) =>
    adoption.ownerToken === owner.ownerToken)) return Effect.succeed(false)
  return ownerIsDefinitelyAbsent(platform, owner)
}

function orphanedAdoptions(
  platform: PersistencePlatformApi,
  paths: ProjectStoragePaths,
  instanceId: string,
): Effect.Effect<readonly PendingIdentityAdoption[], PersistenceError> {
  return withTransactionLock(
    platform,
    paths.stateLockPath,
    Effect.gen(function*() {
      const value = yield* readJsonIfPresent(platform, paths.statePath)
      if (value === undefined) return yield* Effect.fail(new Error("Provider state is missing"))
      const state = domainState(yield* syncAttempt(() => decodeProviderState(value, paths)))
      const orphaned: PendingIdentityAdoption[] = []
      for (const adoption of state.pendingIdentityAdoptions) {
        if (adoption.instanceId === instanceId) continue
        const owner = yield* syncAttempt(() => requireAdoptionOwner(state, adoption))
        if (yield* ownerIsDefinitelyAbsent(platform, owner, adoption.processGroupId)) {
          orphaned.push(adoption)
        }
      }
      return orphaned
    }),
    { interruptibleUse: true },
  ).pipe(Effect.mapError((cause) =>
    persistenceError("load orphaned identity adoptions", paths.statePath, cause)))
}

function boundedLiveness(
  run: () => Promise<ProcessLiveness>,
  operation: string,
): Effect.Effect<ProcessLiveness, unknown> {
  return Effect.interruptible(promiseEffect(run).pipe(Effect.timeoutOrElse({
    duration: LIVENESS_TIMEOUT_MILLISECONDS,
    orElse: () => Effect.fail(new Error(`Timed out while attempting to ${operation}`)),
  })))
}

function findCommittedIdentity(
  state: ProviderState,
  options: CommitIdentityOptions,
  kind: IdentityTransitionKind,
  mutationToken: string,
): { readonly owner: TerminalOwner; readonly adoption: PendingIdentityAdoption } | undefined {
  const adoption = state.pendingIdentityAdoptions.find((candidate) =>
    candidate.adoptionToken === mutationToken &&
    candidate.kind === kind &&
    candidate.ownerToken === options.owner.ownerToken &&
    candidate.previousSessionId === options.owner.sessionId &&
    candidate.sessionId === options.sessionId)
  if (adoption === undefined) return undefined
  const owner = state.terminalOwners.find((candidate) =>
    candidate.ownerToken === options.owner.ownerToken && candidate.sessionId === options.sessionId)
  if (owner === undefined) return undefined
  if (!jsonEqual(adoption.relation, options.relation)) {
    throw new Error("Committed identity adoption has different branch metadata")
  }
  return { owner, adoption }
}

function saveRelationInState(state: ProviderState, relation: BranchRelation): ProviderState {
  const existing = state.relations.find((candidate) =>
    candidate.childSessionId === relation.childSessionId)
  if (existing !== undefined) {
    if (!jsonEqual(existing, relation)) {
      throw new Error(`Session ${relation.childSessionId} already has different branch metadata`)
    }
    return state
  }
  return { ...state, relations: [...state.relations, relation] }
}

function replaceTemporarySessionIdInProviderState(
  state: ProviderState,
  previousSessionId: string,
  sessionId: string,
): ProviderState {
  return {
    relations: state.relations.map((relation) =>
      replaceSessionIdInRelation(relation, previousSessionId, sessionId)),
    removals: state.removals.map((removal) =>
      replaceSessionIdInRemoval(removal, previousSessionId, sessionId)),
    navigations: state.navigations.map((entry) => ({
      ...entry,
      navigation: replaceSessionIdInNavigation(entry.navigation, previousSessionId, sessionId),
    })),
    terminalOwners: state.terminalOwners,
    pendingIdentityAdoptions: state.pendingIdentityAdoptions,
  }
}

function replaceSessionIdForInstanceNavigation(
  state: ProviderState,
  instanceId: string,
  previousSessionId: string,
  sessionId: string,
  relation: BranchRelation | undefined,
): ProviderState {
  return {
    ...state,
    navigations: state.navigations.map((entry) => entry.instanceId === instanceId
      ? {
          ...entry,
          navigation: replaceSessionIdInNavigation(
            entry.navigation,
            previousSessionId,
            sessionId,
            sharedMessageIds(relation, previousSessionId, sessionId),
          ),
        }
      : entry),
  }
}

export function replaceSessionIdInProjectState(
  state: ProjectState,
  previousSessionId: string,
  sessionId: string,
  options?: ReplaceSessionIdentityOptions,
): ProjectState {
  const nativeFork = options?.kind === "native-fork"
  const messageIds = nativeFork
    ? sharedMessageIds(options.relation, previousSessionId, sessionId)
    : undefined
  const navigation = state.navigation === undefined
    ? undefined
    : replaceSessionIdInNavigation(state.navigation, previousSessionId, sessionId, messageIds)
  const replaced = {
    relations: nativeFork
      ? state.relations
      : state.relations.map((relation) =>
          replaceSessionIdInRelation(relation, previousSessionId, sessionId)),
    removals: nativeFork
      ? state.removals
      : state.removals.map((removal) =>
          replaceSessionIdInRemoval(removal, previousSessionId, sessionId)),
  }
  return navigation === undefined ? replaced : { ...replaced, navigation }
}

function replaceSessionIdInRelation(
  relation: BranchRelation,
  previousSessionId: string,
  sessionId: string,
): BranchRelation {
  const replace = (candidate: string) => candidate === previousSessionId ? sessionId : candidate
  return {
    ...relation,
    childSessionId: replace(relation.childSessionId),
    parentSessionId: replace(relation.parentSessionId),
  }
}

function replaceSessionIdInRemoval(
  removal: ConversationRemoval,
  previousSessionId: string,
  sessionId: string,
): ConversationRemoval {
  const replace = (candidate: string) => candidate === previousSessionId ? sessionId : candidate
  if (removal.kind === "tree") {
    return {
      ...removal,
      rootSessionId: replace(removal.rootSessionId),
      memberSessionIds: [...new Set(removal.memberSessionIds.map(replace))],
    }
  }
  if (removal.target.kind === "endpoint") {
    return { ...removal, target: { ...removal.target, sessionId: replace(removal.target.sessionId) } }
  }
  return {
    ...removal,
    target: {
      ...removal.target,
      aliases: uniqueMessageRefs(removal.target.aliases.map((alias) => ({
        ...alias,
        sessionId: replace(alias.sessionId),
      }))),
    },
  }
}

function replaceSessionIdInNavigation(
  navigation: NavigationState,
  previousSessionId: string,
  sessionId: string,
  messageIds?: ReadonlyMap<string, string>,
): NavigationState {
  const replace = (candidate: string) => candidate === previousSessionId ? sessionId : candidate
  if (navigation.view === "roots") {
    return {
      ...navigation,
      selectedSessionId: navigation.selectedSessionId === null
        ? null
        : replace(navigation.selectedSessionId),
    }
  }
  if (navigation.view === "terminal") {
    return { ...navigation, sessionId: replace(navigation.sessionId) }
  }
  if (navigation.target.kind === "endpoint") {
    return {
      ...navigation,
      familySessionId: replace(navigation.familySessionId),
      target: { ...navigation.target, sessionId: replace(navigation.target.sessionId) },
    }
  }
  const replaceMessageRef = <Ref extends { readonly sessionId: string; readonly messageId: string }>(
    ref: Ref,
  ): Ref => {
    if (ref.sessionId !== previousSessionId) return ref
    if (messageIds === undefined) return { ...ref, sessionId }
    const messageId = messageIds.get(ref.messageId)
    return messageId === undefined ? ref : { ...ref, sessionId, messageId }
  }
  return {
    ...navigation,
    familySessionId: replace(navigation.familySessionId),
    target: {
      ...navigation.target,
      preferred: replaceMessageRef(navigation.target.preferred),
      aliases: uniqueMessageRefs(navigation.target.aliases.map(replaceMessageRef)),
    },
  }
}

function applyPendingTemporaryAdoptionsToRemoval(
  state: ProviderState,
  removal: ConversationRemoval,
): ConversationRemoval {
  let current = removal
  for (const adoption of state.pendingIdentityAdoptions) {
    if (adoption.kind !== "temporary-adoption") continue
    current = replaceSessionIdInRemoval(
      current,
      adoption.previousSessionId,
      adoption.sessionId,
    )
  }
  return current
}

function isSessionRemoved(state: ProviderState, sessionId: string): boolean {
  return state.removals.some((removal) =>
    affectedSessionIdsForRemoval(state, removal).has(sessionId))
}

function sessionRemovedError(providerId: string, sessionId: string): SessionRemovedError {
  return new SessionRemovedError({
    providerId,
    sessionId,
    message: `Agent session ${sessionId} is covered by a persisted navigator removal`,
  })
}

function identityRemovalConflict(
  before: ProviderState,
  after: ProviderState,
  previousSessionId: string,
  sessionId: string,
): string | undefined {
  const beforeAffected = removedSessionIds(before)
  const afterAffected = removedSessionIds(after)
  if (beforeAffected.has(previousSessionId) || afterAffected.has(previousSessionId)) {
    return previousSessionId
  }
  if (beforeAffected.has(sessionId) || afterAffected.has(sessionId)) return sessionId

  const allSessionIds = new Set([...beforeAffected, ...afterAffected])
  return [...allSessionIds].find((candidate) =>
    beforeAffected.has(candidate) !== afterAffected.has(candidate))
}

function removedSessionIds(state: ProviderState): Set<string> {
  const affected = new Set<string>()
  for (const removal of state.removals) {
    for (const sessionId of affectedSessionIdsForRemoval(state, removal)) {
      affected.add(sessionId)
    }
  }
  return affected
}

function affectedSessionIdsForRemoval(
  state: ProviderState,
  removal: ConversationRemoval,
  suppliedSessionIds: readonly string[] = [],
): Set<string> {
  const wholeSessions = new Set(suppliedSessionIds)
  if (removal.kind === "tree") {
    wholeSessions.add(removal.rootSessionId)
    for (const sessionId of removal.memberSessionIds) wholeSessions.add(sessionId)
    expandWholeSessionDescendants(state, wholeSessions)
    return wholeSessions
  }

  if (removal.target.kind === "message") {
    const messageRefs = new Map(removal.target.aliases.map((ref) => [
      messageRefIdentity(ref),
      ref,
    ]))
    let changed = true
    while (changed) {
      changed = false
      for (const relation of state.relations) {
        for (const mapping of relation.sharedMessages) {
          const parent = {
            sessionId: relation.parentSessionId,
            messageId: mapping.parentMessageId,
          }
          const child = {
            sessionId: relation.childSessionId,
            messageId: mapping.childMessageId,
          }
          if (messageRefs.has(messageRefIdentity(parent))) {
            changed = addMessageRef(messageRefs, child) || changed
          }
          if (messageRefs.has(messageRefIdentity(child))) {
            changed = addMessageRef(messageRefs, parent) || changed
          }
        }
      }
      for (const adoption of state.pendingIdentityAdoptions) {
        if (adoption.kind !== "temporary-adoption") continue
        for (const ref of [...messageRefs.values()]) {
          if (ref.sessionId === adoption.previousSessionId) {
            changed = addMessageRef(messageRefs, {
              ...ref,
              sessionId: adoption.sessionId,
            }) || changed
          }
          if (ref.sessionId === adoption.sessionId) {
            changed = addMessageRef(messageRefs, {
              ...ref,
              sessionId: adoption.previousSessionId,
            }) || changed
          }
        }
      }
    }

    const affected = new Set([...messageRefs.values()].map((ref) => ref.sessionId))
    for (const adoption of state.pendingIdentityAdoptions) {
      if (
        adoption.kind === "native-fork" &&
        adoption.relation === undefined &&
        affected.has(adoption.previousSessionId)
      ) {
        wholeSessions.add(adoption.sessionId)
      }
    }
    expandWholeSessionDescendants(state, wholeSessions)
    for (const sessionId of wholeSessions) affected.add(sessionId)
    return affected
  }

  const partialTargets = new Map<string, Set<string | null>>()
  addEndpointTarget(
    partialTargets,
    removal.target.sessionId,
    removal.target.afterMessageId,
  )
  let changed = true
  while (changed) {
    changed = expandWholeSessionDescendants(state, wholeSessions)
    for (const adoption of state.pendingIdentityAdoptions) {
      if (adoption.kind === "temporary-adoption") {
        for (const afterMessageId of partialTargets.get(adoption.previousSessionId) ?? []) {
          changed = addEndpointTarget(
            partialTargets,
            adoption.sessionId,
            afterMessageId,
          ) || changed
        }
        for (const afterMessageId of partialTargets.get(adoption.sessionId) ?? []) {
          changed = addEndpointTarget(
            partialTargets,
            adoption.previousSessionId,
            afterMessageId,
          ) || changed
        }
      } else if (
        adoption.relation === undefined &&
        (wholeSessions.has(adoption.previousSessionId) ||
          partialTargets.has(adoption.previousSessionId)) &&
        !wholeSessions.has(adoption.sessionId)
      ) {
        wholeSessions.add(adoption.sessionId)
        changed = true
      }
    }
    for (const relation of state.relations) {
      if (wholeSessions.has(relation.parentSessionId)) {
        if (!wholeSessions.has(relation.childSessionId)) {
          wholeSessions.add(relation.childSessionId)
          changed = true
        }
        continue
      }
      for (const afterMessageId of partialTargets.get(relation.parentSessionId) ?? []) {
        if (
          relationDescendsFromEndpoint(relation, afterMessageId) &&
          !wholeSessions.has(relation.childSessionId)
        ) {
          wholeSessions.add(relation.childSessionId)
          changed = true
        }
      }
    }
  }

  return new Set([...partialTargets.keys(), ...wholeSessions])
}

function expandWholeSessionDescendants(
  state: ProviderState,
  sessionIds: Set<string>,
): boolean {
  let expanded = false
  let changed = true
  while (changed) {
    changed = false
    for (const relation of state.relations) {
      if (sessionIds.has(relation.parentSessionId) && !sessionIds.has(relation.childSessionId)) {
        sessionIds.add(relation.childSessionId)
        changed = true
        expanded = true
      }
    }
    for (const adoption of state.pendingIdentityAdoptions) {
      if (sessionIds.has(adoption.previousSessionId) && !sessionIds.has(adoption.sessionId)) {
        sessionIds.add(adoption.sessionId)
        changed = true
        expanded = true
      }
      if (
        adoption.kind === "temporary-adoption" &&
        sessionIds.has(adoption.sessionId) &&
        !sessionIds.has(adoption.previousSessionId)
      ) {
        sessionIds.add(adoption.previousSessionId)
        changed = true
        expanded = true
      }
    }
  }
  return expanded
}

function addMessageRef<Ref extends { readonly sessionId: string; readonly messageId: string }>(
  refs: Map<string, Ref>,
  ref: Ref,
): boolean {
  const identity = messageRefIdentity(ref)
  if (refs.has(identity)) return false
  refs.set(identity, ref)
  return true
}

function addEndpointTarget(
  targets: Map<string, Set<string | null>>,
  sessionId: string,
  afterMessageId: string | null,
): boolean {
  const sessionTargets = targets.get(sessionId) ?? new Set<string | null>()
  if (sessionTargets.has(afterMessageId)) return false
  sessionTargets.add(afterMessageId)
  targets.set(sessionId, sessionTargets)
  return true
}

function relationDescendsFromEndpoint(
  relation: BranchRelation,
  afterMessageId: string | null,
): boolean {
  if (afterMessageId === null) return relation.sharedMessages.length > 0
  const anchorIndex = relation.sharedMessages.findIndex((mapping) =>
    mapping.parentMessageId === afterMessageId)
  return anchorIndex >= 0 && anchorIndex < relation.sharedMessages.length - 1
}

function canonicalizeRemoval(removal: ConversationRemoval): ConversationRemoval {
  if (removal.kind === "tree") {
    return { ...removal, memberSessionIds: [...removal.memberSessionIds].sort(compare) }
  }
  if (removal.target.kind === "endpoint") return removal
  return {
    ...removal,
    target: { ...removal.target, aliases: [...removal.target.aliases].sort(compareMessageRefs) },
  }
}

function canonicalizeNavigation(navigation: NavigationState): NavigationState {
  if (navigation.view !== "graph" || navigation.target.kind !== "message") return navigation
  return {
    ...navigation,
    target: { ...navigation.target, aliases: [...navigation.target.aliases].sort(compareMessageRefs) },
  }
}

function removalIdentity(removal: ConversationRemoval): string {
  return JSON.stringify(removal.kind === "tree"
    ? {
        kind: removal.kind,
        rootSessionId: removal.rootSessionId,
        memberSessionIds: removal.memberSessionIds,
      }
    : { kind: removal.kind, target: removal.target })
}

function sameRemoval(left: ConversationRemoval, right: ConversationRemoval): boolean {
  return removalIdentity(canonicalizeRemoval(left)) === removalIdentity(canonicalizeRemoval(right))
}

function isCommittedReserve(
  owner: TerminalOwner,
  instanceId: string,
  ownerPid: number,
  mutationToken: string,
): boolean {
  return owner.instanceId === instanceId &&
    owner.ownerPid === ownerPid &&
    owner.ownerToken === mutationToken &&
    owner.lastMutationToken === mutationToken
}

function sharedMessageIds(
  relation: BranchRelation | undefined,
  previousSessionId: string,
  sessionId: string,
): ReadonlyMap<string, string> {
  if (
    relation === undefined ||
    relation.parentSessionId !== previousSessionId ||
    relation.childSessionId !== sessionId
  ) return new Map()
  return new Map(relation.sharedMessages.map((mapping) => [
    mapping.parentMessageId,
    mapping.childMessageId,
  ]))
}

function uniqueMessageRefs<Ref extends { readonly sessionId: string; readonly messageId: string }>(
  refs: readonly Ref[],
): readonly Ref[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const identity = messageRefIdentity(ref)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

function messageRefIdentity(ref: { readonly sessionId: string; readonly messageId: string }): string {
  return `${ref.sessionId.length}:${ref.sessionId}${ref.messageId}`
}

function compareMessageRefs(
  left: { readonly sessionId: string; readonly messageId: string },
  right: { readonly sessionId: string; readonly messageId: string },
): number {
  return compare(left.sessionId, right.sessionId) || compare(left.messageId, right.messageId)
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`)
}

function requireProcessGroup(processGroupId: number | undefined): void {
  if (
    processGroupId !== undefined &&
    (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)
  ) {
    throw new Error("Process group ID must be a positive integer")
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} cannot be empty`)
}

function requireCanonicalDate(value: string): void {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    throw new Error(`Invalid canonical timestamp: ${value}`)
  }
}

function syncAttempt<A>(run: () => A): Effect.Effect<A, unknown> {
  return Effect.try({ try: run, catch: (cause) => cause })
}

function promiseEffect<A>(run: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: run, catch: (cause) => cause })
}

function persistenceError(operation: string, path: string, cause: unknown): PersistenceError {
  return cause instanceof PersistenceError
    ? cause
    : new PersistenceError({
        operation,
        path,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      })
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right)
}
