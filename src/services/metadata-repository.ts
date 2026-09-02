import { isDeepStrictEqual } from "node:util"

import { Context, Effect, Layer, Schema } from "effect"

import { PersistenceError } from "../domain/errors"
import type {
  BranchRelation,
  ConversationRemoval,
  ProjectState,
} from "../domain/persistence"
import type { NavigationState } from "../domain/model"
import {
  PersistencePlatform,
  PersistencePlatformLive,
  type PersistencePlatformApi,
} from "../infrastructure/metadata/platform"
import {
  PERSISTENCE_SCHEMA_VERSION,
  decodeStrict,
  prepareProjectStorage,
  readJsonIfPresent,
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
  sharedMessages: Schema.Array(
    Schema.Struct({
      parentMessageId: Schema.NonEmptyString,
      childMessageId: Schema.NonEmptyString,
    }),
  ),
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

const PersistedProjectStateSchema = Schema.Struct({
  schemaVersion: Schema.Literal(PERSISTENCE_SCHEMA_VERSION),
  relations: Schema.Array(BranchRelationSchema),
  removals: Schema.Array(RemovalSchema),
  navigation: Schema.optionalKey(NavigationSchema),
})

interface PersistedProjectState extends ProjectState {
  readonly schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION
}

export interface MetadataRepositoryOptions {
  readonly projectDirectory: string
  readonly providerId: string
  readonly stateHome?: string
}

export interface MetadataRepositoryApi {
  readonly projectPath: string
  readonly statePath: string
  readonly load: Effect.Effect<ProjectState, PersistenceError>
  readonly update: (
    transform: (state: ProjectState) => ProjectState,
  ) => Effect.Effect<ProjectState, PersistenceError>
  readonly saveRelation: (
    relation: BranchRelation,
  ) => Effect.Effect<BranchRelation, PersistenceError>
  readonly removeRelation: (
    relation: BranchRelation,
  ) => Effect.Effect<void, PersistenceError>
  readonly saveRemoval: (
    removal: ConversationRemoval,
  ) => Effect.Effect<ConversationRemoval, PersistenceError>
  readonly replaceSessionId: (
    previousSessionId: string,
    newSessionId: string,
  ) => Effect.Effect<ProjectState, PersistenceError>
  readonly saveNavigationState: (
    navigation: NavigationState | undefined,
  ) => Effect.Effect<void, PersistenceError>
}

export class MetadataRepository extends Context.Service<
  MetadataRepository,
  MetadataRepositoryApi
>()("claude-tree/MetadataRepository") {}

export function makeMetadataRepository(
  options: MetadataRepositoryOptions,
): Effect.Effect<MetadataRepositoryApi, PersistenceError, PersistencePlatform> {
  return Effect.gen(function* () {
    const platform = yield* PersistencePlatform
    const paths = yield* persistenceAttempt(
      "open project metadata",
      options.projectDirectory,
      () =>
        prepareProjectStorage(
          platform,
          options.projectDirectory,
          options.providerId,
          options.stateHome,
        ),
    )

    yield* persistenceAttempt("initialize project state", paths.statePath, () =>
      withTransactionLock(platform, paths.stateLockPath, async () => {
        const value = await readJsonIfPresent(platform, paths.statePath)
        if (value === undefined) {
          await writeJsonAtomically(platform, paths.statePath, persistedState({
            relations: [],
            removals: [],
          }))
          return
        }
        decodeProjectState(value, true)
      }),
    )

    return repositoryApi(platform, paths)
  })
}

export function MetadataRepositoryLive(options: MetadataRepositoryOptions) {
  return Layer.effect(MetadataRepository, makeMetadataRepository(options)).pipe(
    Layer.provide(PersistencePlatformLive),
  )
}

function repositoryApi(
  platform: PersistencePlatformApi,
  paths: ProjectStoragePaths,
): MetadataRepositoryApi {
  const load = persistenceAttempt("load project state", paths.statePath, async () => {
    const value = await readJsonIfPresent(platform, paths.statePath)
    if (value === undefined) throw new Error("Project state is missing")
    return domainState(decodeProjectState(value, true))
  })

  const update = (
    transform: (state: ProjectState) => ProjectState,
  ): Effect.Effect<ProjectState, PersistenceError> =>
    persistenceAttempt("update project state", paths.statePath, () =>
      withTransactionLock(platform, paths.stateLockPath, async () => {
        const value = await readJsonIfPresent(platform, paths.statePath)
        if (value === undefined) throw new Error("Project state is missing")
        const current = domainState(decodeProjectState(value, true))
        const next = canonicalizeState(transform(current))
        const validated = decodeProjectState(persistedState(next), false)
        await writeJsonAtomically(platform, paths.statePath, validated)
        return domainState(validated)
      }),
    )

  return {
    projectPath: paths.projectPath,
    statePath: paths.statePath,
    load,
    update,
    saveRelation: (relation) =>
      Effect.map(
        update((state) => {
          const existing = state.relations.find(
            (candidate) => candidate.childSessionId === relation.childSessionId,
          )
          if (existing !== undefined) {
            if (!jsonEqual(existing, relation)) {
              throw new Error(
                `Session ${relation.childSessionId} already has different branch metadata`,
              )
            }
            return state
          }
          return { ...state, relations: [...state.relations, relation] }
        }),
        (state) =>
          state.relations.find(
            (candidate) => candidate.childSessionId === relation.childSessionId,
          )!,
      ),
    removeRelation: (relation) =>
      Effect.asVoid(
        update((state) => {
          const existing = state.relations.find(
            (candidate) => candidate.childSessionId === relation.childSessionId,
          )
          if (existing === undefined || !jsonEqual(existing, relation)) {
            throw new Error(
              `Session ${relation.childSessionId} has different branch metadata`,
            )
          }
          return {
            ...state,
            relations: state.relations.filter(
              (candidate) => candidate.childSessionId !== relation.childSessionId,
            ),
          }
        }),
      ),
    saveRemoval: (removal) => {
      const canonical = canonicalizeRemoval(removal)
      return Effect.map(
        update((state) => {
          const identity = removalIdentity(canonical)
          const existing = state.removals.find(
            (candidate) => removalIdentity(candidate) === identity,
          )
          if (existing !== undefined) return state
          return { ...state, removals: [...state.removals, canonical] }
        }),
        (state) =>
          state.removals.find(
            (candidate) => removalIdentity(candidate) === removalIdentity(canonical),
          )!,
      )
    },
    replaceSessionId: (previousSessionId, newSessionId) =>
      update((state) => {
        requireNonEmpty(previousSessionId, "Previous session ID")
        requireNonEmpty(newSessionId, "New session ID")
        if (previousSessionId === newSessionId) return state
        return replaceSessionIdInState(state, previousSessionId, newSessionId)
      }),
    saveNavigationState: (navigation) =>
      Effect.asVoid(
        update((state) => {
          if (navigation === undefined) {
            const { navigation: _, ...withoutNavigation } = state
            return withoutNavigation
          }
          return { ...state, navigation }
        }),
      ),
  }
}

function replaceSessionIdInState(
  state: ProjectState,
  previousSessionId: string,
  newSessionId: string,
): ProjectState {
  const replace = (sessionId: string) =>
    sessionId === previousSessionId ? newSessionId : sessionId
  const relations = state.relations.map((relation) => ({
    ...relation,
    childSessionId: replace(relation.childSessionId),
    parentSessionId: replace(relation.parentSessionId),
  }))
  const removals = state.removals.map((removal): ConversationRemoval => {
    if (removal.kind === "tree") {
      return {
        ...removal,
        rootSessionId: replace(removal.rootSessionId),
        memberSessionIds: uniqueOpaqueIds(removal.memberSessionIds.map(replace)),
      }
    }
    if (removal.target.kind === "endpoint") {
      return {
        ...removal,
        target: { ...removal.target, sessionId: replace(removal.target.sessionId) },
      }
    }
    return {
      ...removal,
      target: {
        ...removal.target,
        aliases: uniqueMessageRefs(
          removal.target.aliases.map((alias) => ({
            ...alias,
            sessionId: replace(alias.sessionId),
          })),
        ),
      },
    }
  })
  const navigation = replaceSessionIdInNavigation(
    state.navigation,
    previousSessionId,
    newSessionId,
  )
  return navigation === undefined
    ? { relations, removals }
    : { relations, removals, navigation }
}

function replaceSessionIdInNavigation(
  navigation: NavigationState | undefined,
  previousSessionId: string,
  newSessionId: string,
): NavigationState | undefined {
  if (navigation === undefined) return undefined
  const replace = (sessionId: string) =>
    sessionId === previousSessionId ? newSessionId : sessionId
  if (navigation.view === "roots") {
    return {
      ...navigation,
      selectedSessionId:
        navigation.selectedSessionId === null
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
      target: {
        ...navigation.target,
        sessionId: replace(navigation.target.sessionId),
      },
    }
  }
  return {
    ...navigation,
    familySessionId: replace(navigation.familySessionId),
    target: {
      ...navigation.target,
      preferred: {
        ...navigation.target.preferred,
        sessionId: replace(navigation.target.preferred.sessionId),
      },
      aliases: uniqueMessageRefs(
        navigation.target.aliases.map((alias) => ({
          ...alias,
          sessionId: replace(alias.sessionId),
        })),
      ),
    },
  }
}

function uniqueOpaqueIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)]
}

function uniqueMessageRefs<
  Ref extends { readonly sessionId: string; readonly messageId: string },
>(refs: readonly Ref[]): readonly Ref[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const identity = `${ref.sessionId.length}:${ref.sessionId}${ref.messageId}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

function decodeProjectState(
  input: unknown,
  requireCanonical: boolean,
): PersistedProjectState {
  const decoded = decodeStrict(PersistedProjectStateSchema, input) as PersistedProjectState
  const state = domainState(decoded)
  validateProjectState(state)
  if (requireCanonical && !jsonEqual(decoded, persistedState(canonicalizeState(state)))) {
    throw new Error("Project state is not canonically ordered")
  }
  return decoded
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

    const parentMessages = new Set<string>()
    const childMessages = new Set<string>()
    for (const mapping of relation.sharedMessages) {
      if (
        parentMessages.has(mapping.parentMessageId) ||
        childMessages.has(mapping.childMessageId)
      ) {
        throw new Error("Shared message mappings must be unique")
      }
      parentMessages.add(mapping.parentMessageId)
      childMessages.add(mapping.childMessageId)
    }
  }

  for (const child of parentByChild.keys()) {
    const seen = new Set<string>()
    let current: string | undefined = child
    while (current !== undefined) {
      if (seen.has(current)) {
        throw new Error(`Branch metadata contains a cycle involving ${current}`)
      }
      seen.add(current)
      current = parentByChild.get(current)
    }
  }

  const removalIdentities = new Set<string>()
  for (const removal of state.removals) {
    requireCanonicalDate(removal.createdAt)
    if (removal.kind === "tree") {
      if (removal.memberSessionIds.length === 0) {
        throw new Error("Tree removals must contain at least one member")
      }
      if (new Set(removal.memberSessionIds).size !== removal.memberSessionIds.length) {
        throw new Error("Tree member session IDs must be unique")
      }
      if (!removal.memberSessionIds.includes(removal.rootSessionId)) {
        throw new Error("Tree members must include the root session")
      }
    } else if (removal.target.kind === "message") {
      if (removal.target.aliases.length === 0) {
        throw new Error("Message removals must contain at least one alias")
      }
      requireUniqueMessageRefs(removal.target.aliases, "Message aliases must be unique")
    }

    const identity = removalIdentity(removal)
    if (removalIdentities.has(identity)) {
      throw new Error("Removal identities must be unique")
    }
    removalIdentities.add(identity)
  }

  if (state.navigation?.view === "graph" && state.navigation.target.kind === "message") {
    const { aliases, preferred } = state.navigation.target
    if (aliases.length === 0) throw new Error("Navigation message aliases cannot be empty")
    requireUniqueMessageRefs(aliases, "Navigation message aliases must be unique")
    if (!aliases.some((alias) => messageRefEqual(alias, preferred))) {
      throw new Error("Preferred navigation message must be one of its aliases")
    }
  }
}

function canonicalizeState(state: ProjectState): ProjectState {
  const relations = [...state.relations].sort((left, right) =>
    compareOpaqueIds(left.childSessionId, right.childSessionId),
  )
  const removals = state.removals.map(canonicalizeRemoval).sort((left, right) =>
    compareOpaqueIds(removalIdentity(left), removalIdentity(right)),
  )
  const navigation = canonicalizeNavigation(state.navigation)
  return navigation === undefined
    ? { relations, removals }
    : { relations, removals, navigation }
}

function canonicalizeRemoval(removal: ConversationRemoval): ConversationRemoval {
  if (removal.kind === "tree") {
    return {
      ...removal,
      memberSessionIds: [...removal.memberSessionIds].sort(compareOpaqueIds),
    }
  }
  if (removal.target.kind === "endpoint") return removal
  return {
    ...removal,
    target: {
      ...removal.target,
      aliases: [...removal.target.aliases].sort(compareMessageRefs),
    },
  }
}

function canonicalizeNavigation(
  navigation: NavigationState | undefined,
): NavigationState | undefined {
  if (navigation?.view !== "graph" || navigation.target.kind !== "message") {
    return navigation
  }
  return {
    ...navigation,
    target: {
      ...navigation.target,
      aliases: [...navigation.target.aliases].sort(compareMessageRefs),
    },
  }
}

function removalIdentity(removal: ConversationRemoval): string {
  return JSON.stringify(
    removal.kind === "tree"
      ? {
          kind: removal.kind,
          rootSessionId: removal.rootSessionId,
          memberSessionIds: removal.memberSessionIds,
        }
      : { kind: removal.kind, target: removal.target },
  )
}

function persistedState(state: ProjectState): PersistedProjectState {
  return state.navigation === undefined
    ? {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        relations: state.relations,
        removals: state.removals,
      }
    : {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        relations: state.relations,
        removals: state.removals,
        navigation: state.navigation,
      }
}

function domainState(state: PersistedProjectState): ProjectState {
  return state.navigation === undefined
    ? { relations: state.relations, removals: state.removals }
    : {
        relations: state.relations,
        removals: state.removals,
        navigation: state.navigation,
      }
}

function requireUniqueMessageRefs(
  refs: readonly { readonly sessionId: string; readonly messageId: string }[],
  message: string,
): void {
  const identities = new Set(refs.map((ref) => `${ref.sessionId.length}:${ref.sessionId}${ref.messageId}`))
  if (identities.size !== refs.length) throw new Error(message)
}

function requireCanonicalDate(value: string): void {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    throw new Error(`Invalid canonical timestamp: ${value}`)
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} cannot be empty`)
}

function compareMessageRefs(
  left: { readonly sessionId: string; readonly messageId: string },
  right: { readonly sessionId: string; readonly messageId: string },
): number {
  return (
    compareOpaqueIds(left.sessionId, right.sessionId) ||
    compareOpaqueIds(left.messageId, right.messageId)
  )
}

function compareOpaqueIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function messageRefEqual(
  left: { readonly sessionId: string; readonly messageId: string },
  right: { readonly sessionId: string; readonly messageId: string },
): boolean {
  return left.sessionId === right.sessionId && left.messageId === right.messageId
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right)
}

function persistenceAttempt<A>(
  operation: string,
  path: string,
  run: () => Promise<A>,
): Effect.Effect<A, PersistenceError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof PersistenceError
        ? cause
        : new PersistenceError({
            operation,
            path,
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  })
}
