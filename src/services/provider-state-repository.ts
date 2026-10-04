import { isDeepStrictEqual } from "node:util"
import { Context, Effect, Layer, Schema } from "effect"

import { PersistenceError, SessionRemovedError } from "../domain/errors"
import type { MessageRef, NavigationState } from "../domain/model"
import type { BranchRelation, ConversationRemoval, IdentityTransitionKind, ProjectState, ProviderState } from "../domain/persistence"
import { PersistencePlatform, PersistencePlatformLive, type PersistencePlatformApi } from "../infrastructure/metadata/platform"
import { PERSISTENCE_SCHEMA_VERSION, decodeStrict, prepareProjectStorage, readJsonIfPresent, requireSchemaVersion,
  withTransactionLock, writeJsonAtomically, type ProjectStoragePaths } from "../infrastructure/metadata/storage"

const MessageRefSchema = Schema.Struct({ sessionId: Schema.NonEmptyString, messageId: Schema.NonEmptyString })
const BranchRelationSchema = Schema.Struct({
  childSessionId: Schema.NonEmptyString, parentSessionId: Schema.NonEmptyString, sourceMessageId: Schema.NonEmptyString,
  sharedMessages: Schema.Array(Schema.Struct({ parentMessageId: Schema.NonEmptyString, childMessageId: Schema.NonEmptyString })),
  createdAt: Schema.NonEmptyString,
})
const RemovalSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("tree"), rootSessionId: Schema.NonEmptyString,
    memberSessionIds: Schema.Array(Schema.NonEmptyString), createdAt: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("subtree"), target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("message"), aliases: Schema.Array(MessageRefSchema) }),
    Schema.Struct({ kind: Schema.Literal("endpoint"), sessionId: Schema.NonEmptyString,
      afterMessageId: Schema.Union([Schema.NonEmptyString, Schema.Null]) }),
  ]), createdAt: Schema.NonEmptyString }),
])
const NavigationSchema = Schema.Union([
  Schema.Struct({ view: Schema.Literal("roots"), selectedSessionId: Schema.Union([Schema.NonEmptyString, Schema.Null]) }),
  Schema.Struct({ view: Schema.Literal("terminal"), sessionId: Schema.NonEmptyString }),
  Schema.Struct({ view: Schema.Literal("graph"), familySessionId: Schema.NonEmptyString, target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("message"), preferred: MessageRefSchema, aliases: Schema.Array(MessageRefSchema) }),
    Schema.Struct({ kind: Schema.Literal("endpoint"), sessionId: Schema.NonEmptyString }),
  ]) }),
])
const ProviderStateSchema = Schema.Struct({
  schemaVersion: Schema.Literal(PERSISTENCE_SCHEMA_VERSION), relations: Schema.Array(BranchRelationSchema),
  removals: Schema.Array(RemovalSchema),
  navigations: Schema.Array(Schema.Struct({ instanceId: Schema.NonEmptyString, navigation: NavigationSchema })),
})

export interface ProviderStateRepositoryOptions {
  readonly projectDirectory: string
  readonly providerId: string
  readonly stateHome?: string
  readonly instanceId?: string
  readonly resumeWorkspaceId?: string
  readonly requireExisting?: boolean
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
  readonly saveNavigation: (navigation: NavigationState) => Effect.Effect<void, PersistenceError>
  readonly updateMetadata: (transform: (state: ProjectState) => ProjectState) => Effect.Effect<ProjectState, PersistenceError>
  readonly commitRemoval: (removal: ConversationRemoval, affectedSessionIds: readonly string[], mutationToken?: string) =>
    Effect.Effect<ConversationRemoval, PersistenceError | SessionRemovedError>
  readonly replaceIdentity: (previousSessionId: string, sessionId: string, options: ReplaceSessionIdentityOptions) =>
    Effect.Effect<void, PersistenceError | SessionRemovedError>
}

export class ProviderStateRepository extends Context.Service<ProviderStateRepository, ProviderStateRepositoryApi>()(
  "claude-tree/ProviderStateRepository",
) {}

export function makeProviderStateRepository(options: ProviderStateRepositoryOptions):
  Effect.Effect<ProviderStateRepositoryApi, PersistenceError, PersistencePlatform> {
  return Effect.gen(function*() {
    const platform = yield* PersistencePlatform
    const instanceId = options.instanceId ?? platform.instanceId
    if (!instanceId) return yield* Effect.fail(persistenceError("open provider state", options.projectDirectory, new Error("Instance ID cannot be empty")))
    const paths = yield* prepareProjectStorage(platform, options.projectDirectory, options.providerId, options.stateHome).pipe(
      Effect.mapError((cause) => persistenceError("open provider state", options.projectDirectory, cause)))
    yield* withTransactionLock(platform, paths.stateLockPath, Effect.gen(function*() {
      const value = yield* readJsonIfPresent(platform, paths.statePath)
      let state: ProviderState
      if (value === undefined) {
        if (options.requireExisting || options.resumeWorkspaceId) return yield* Effect.fail(new Error("Provider state is missing"))
        state = { relations: [], removals: [], navigations: [] }
      } else state = yield* attempt(() => decodeState(value, paths))
      if (options.resumeWorkspaceId) {
        const navigation = state.navigations.find((entry) => entry.instanceId === options.resumeWorkspaceId)?.navigation
        if (!navigation) return yield* Effect.fail(new Error(`Workspace ${options.resumeWorkspaceId} is unavailable for this project and provider`))
        state = replaceMetadata(state, instanceId, { ...metadataFor(state, instanceId), navigation })
      }
      if (value === undefined || options.resumeWorkspaceId) yield* writeJsonAtomically(platform, paths.statePath, persisted(canonicalize(state)))
    })).pipe(Effect.mapError((cause) => persistenceError("initialize provider state", paths.statePath, cause)))
    return repositoryApi(platform, paths, instanceId, options.providerId)
  })
}

export function ProviderStateRepositoryLive(options: ProviderStateRepositoryOptions) {
  return Layer.effect(ProviderStateRepository, makeProviderStateRepository(options)).pipe(Layer.provide(PersistencePlatformLive))
}

function repositoryApi(platform: PersistencePlatformApi, paths: ProjectStoragePaths, instanceId: string, providerId: string): ProviderStateRepositoryApi {
  const read = Effect.gen(function*() {
    const value = yield* readJsonIfPresent(platform, paths.statePath)
    if (value === undefined) return yield* Effect.fail(new Error("Provider state is missing"))
    return yield* attempt(() => decodeState(value, paths))
  })
  const load = withTransactionLock(platform, paths.stateLockPath, read, { interruptibleUse: true }).pipe(
    Effect.mapError((cause) => persistenceError("load provider state", paths.statePath, cause)))
  const transaction = <A>(operation: string, transform: (state: ProviderState) => readonly [ProviderState, A]) =>
    withTransactionLock(platform, paths.stateLockPath, Effect.gen(function*() {
      const current = yield* read
      const [candidate, result] = yield* attempt(() => transform(current))
      const next = yield* attempt(() => canonicalizeAndValidate(candidate))
      if (!isDeepStrictEqual(current, next)) yield* writeJsonAtomically(platform, paths.statePath, persisted(next))
      return result
    })).pipe(Effect.mapError((cause) => cause instanceof SessionRemovedError ? cause : persistenceError(operation, paths.statePath, cause)))
  const metadataTransaction = <A>(operation: string, transform: (state: ProviderState) => readonly [ProviderState, A]) =>
    transaction(operation, transform).pipe(Effect.mapError((cause) => persistenceError(operation, paths.statePath, cause)))
  return {
    projectPath: paths.projectPath, statePath: paths.statePath, instanceId, load,
    loadMetadata: load.pipe(Effect.map((state) => metadataFor(state, instanceId))),
    saveNavigation: (navigation) => metadataTransaction("save navigation", (state) =>
      [replaceMetadata(state, instanceId, { ...metadataFor(state, instanceId), navigation }), undefined]),
    updateMetadata: (transform) => metadataTransaction("update project metadata", (state) => {
      const next = canonicalizeAndValidate(replaceMetadata(state, instanceId, transform(metadataFor(state, instanceId))))
      return [next, metadataFor(next, instanceId)]
    }),
    commitRemoval: (removal) => transaction("commit conversation removal", (state) => {
      const canonical = canonicalizeRemoval(removal)
      const existing = state.removals.find((entry) => removalIdentity(entry) === removalIdentity(canonical))
      return existing ? [state, existing] : [{ ...state, removals: [...state.removals, canonical] }, canonical]
    }),
    replaceIdentity: (previousSessionId, sessionId, options) => transaction("replace session identity", (state) => {
      if (!previousSessionId || !sessionId || previousSessionId === sessionId) throw new Error("Identity replacement requires two different nonempty IDs")
      if (state.removals.some((removal) => removal.kind === "tree" &&
        (removal.memberSessionIds.includes(previousSessionId) || removal.memberSessionIds.includes(sessionId)))) {
        throw new SessionRemovedError({ providerId, sessionId, message: `Session ${sessionId} was removed from the navigator` })
      }
      const metadata = replaceSessionIdInProjectState({ relations: state.relations, removals: state.removals }, previousSessionId, sessionId, options)
      let next: ProviderState = { ...state, ...metadata, navigations: state.navigations.map((entry) =>
        options.kind === "temporary-adoption" || entry.instanceId === instanceId
          ? { ...entry, navigation: replaceSessionIdInProjectState({ relations: [], removals: [], navigation: entry.navigation }, previousSessionId, sessionId, options).navigation! }
          : entry) }
      if (options.relation) {
        const relation = options.relation
        if (relation.childSessionId !== sessionId || (options.kind === "native-fork" && relation.parentSessionId !== previousSessionId)) throw new Error("Identity relation does not match its session IDs")
        const existing = next.relations.find((entry) => entry.childSessionId === sessionId)
        if (existing && !isDeepStrictEqual(existing, relation)) throw new Error("Session already has different branch metadata")
        if (!existing) next = { ...next, relations: [...next.relations, relation] }
      }
      return [next, undefined]
    }),
  }
}

function decodeState(value: unknown, paths: ProjectStoragePaths): ProviderState {
  requireSchemaVersion(value, "provider state", paths.projectDirectory)
  const decoded = decodeStrict(ProviderStateSchema, value)
  const { schemaVersion: _, ...state } = decoded
  validate(state)
  if (!isDeepStrictEqual(value, persisted(canonicalize(state)))) throw new Error("Provider state is not canonically ordered")
  return state
}

function canonicalizeAndValidate(state: ProviderState): ProviderState {
  const next = canonicalize(state)
  decodeStrict(ProviderStateSchema, persisted(next))
  validate(next)
  return next
}

function validate(state: ProviderState): void {
  unique(state.navigations.map((entry) => entry.instanceId), "Navigation instance IDs")
  for (const entry of state.navigations) {
    const navigation = entry.navigation
    if (navigation.view === "graph" && navigation.target.kind === "message") {
      const { aliases, preferred } = navigation.target
      if (!aliases.length || !aliases.some((ref) => refKey(ref) === refKey(preferred))) throw new Error("Preferred navigation message must be one of its aliases")
      unique(aliases.map(refKey), "Navigation message aliases")
    }
  }
  const parents = new Map<string, string>()
  for (const relation of state.relations) {
    date(relation.createdAt)
    if (parents.has(relation.childSessionId)) throw new Error(`Session ${relation.childSessionId} has more than one parent`)
    parents.set(relation.childSessionId, relation.parentSessionId)
    unique(relation.sharedMessages.map((entry) => entry.parentMessageId), "Shared parent message mappings")
    unique(relation.sharedMessages.map((entry) => entry.childMessageId), "Shared child message mappings")
    if (relation.sharedMessages.length && relation.sharedMessages.at(-1)?.parentMessageId !== relation.sourceMessageId) throw new Error("Shared message mappings must end at the source message")
  }
  for (const child of parents.keys()) {
    const seen = new Set<string>()
    let current: string | undefined = child
    while (current !== undefined) {
      if (seen.has(current)) throw new Error(`Branch metadata contains a cycle involving ${current}`)
      seen.add(current)
      current = parents.get(current)
    }
  }
  unique(state.removals.map(removalIdentity), "Removal identities")
  for (const removal of state.removals) {
    date(removal.createdAt)
    if (removal.kind === "tree") {
      if (!removal.memberSessionIds.includes(removal.rootSessionId)) throw new Error("Tree members must include the root session")
      unique(removal.memberSessionIds, "Tree member session IDs")
    } else if (removal.target.kind === "message") {
      if (!removal.target.aliases.length) throw new Error("Message removals must contain at least one alias")
      unique(removal.target.aliases.map(refKey), "Message aliases")
    }
  }
}

function canonicalize(state: ProviderState): ProviderState {
  return {
    relations: [...state.relations].sort((a, b) => compare(a.childSessionId, b.childSessionId)),
    removals: state.removals.map(canonicalizeRemoval).sort((a, b) => compare(removalIdentity(a), removalIdentity(b))),
    navigations: state.navigations.map((entry) => ({ ...entry, navigation: canonicalizeNavigation(entry.navigation) })).sort((a, b) => compare(a.instanceId, b.instanceId)),
  }
}
function canonicalizeRemoval(removal: ConversationRemoval): ConversationRemoval {
  if (removal.kind === "tree") return { ...removal, memberSessionIds: [...removal.memberSessionIds].sort(compare) }
  if (removal.target.kind === "endpoint") return removal
  return { ...removal, target: { ...removal.target, aliases: sortRefs(removal.target.aliases) } }
}
function canonicalizeNavigation(navigation: NavigationState): NavigationState {
  if (navigation.view !== "graph" || navigation.target.kind !== "message") return navigation
  return { ...navigation, target: { ...navigation.target, aliases: sortRefs(navigation.target.aliases) } }
}
function sortRefs(refs: readonly MessageRef[]): readonly MessageRef[] {
  return [...refs].sort((a, b) => compare(a.sessionId, b.sessionId) || compare(a.messageId, b.messageId))
}
function persisted(state: ProviderState) { return { schemaVersion: PERSISTENCE_SCHEMA_VERSION, ...state } }
function metadataFor(state: ProviderState, instanceId: string): ProjectState {
  const navigation = state.navigations.find((entry) => entry.instanceId === instanceId)?.navigation
  return { relations: state.relations, removals: state.removals, ...(navigation === undefined ? {} : { navigation }) }
}
function replaceMetadata(state: ProviderState, instanceId: string, metadata: ProjectState): ProviderState {
  return { ...state, relations: metadata.relations, removals: metadata.removals,
    navigations: [...state.navigations.filter((entry) => entry.instanceId !== instanceId),
      ...(metadata.navigation === undefined ? [] : [{ instanceId, navigation: metadata.navigation }])] }
}

export function replaceSessionIdInProjectState(state: ProjectState, previousSessionId: string, sessionId: string, options?: ReplaceSessionIdentityOptions): ProjectState {
  const replace = (id: string) => id === previousSessionId ? sessionId : id
  const nativeFork = options?.kind === "native-fork"
  const mapping = nativeFork ? new Map(options.relation?.sharedMessages.map((entry) => [entry.parentMessageId, entry.childMessageId])) : undefined
  const replaceRef = (ref: MessageRef): MessageRef => ref.sessionId !== previousSessionId ? ref
    : mapping === undefined ? { ...ref, sessionId }
    : mapping.has(ref.messageId) ? { sessionId, messageId: mapping.get(ref.messageId)! } : ref
  const deduplicate = (refs: readonly MessageRef[]) => [...new Map(refs.map((ref) => [refKey(ref), ref])).values()]
  const navigation = state.navigation
  let nextNavigation: NavigationState | undefined
  if (navigation?.view === "roots") nextNavigation = { ...navigation, selectedSessionId: navigation.selectedSessionId === null ? null : replace(navigation.selectedSessionId) }
  else if (navigation?.view === "terminal") nextNavigation = { ...navigation, sessionId: replace(navigation.sessionId) }
  else if (navigation?.view === "graph") nextNavigation = { ...navigation, familySessionId: replace(navigation.familySessionId), target:
    navigation.target.kind === "endpoint" ? { ...navigation.target, sessionId: replace(navigation.target.sessionId) }
      : { ...navigation.target, preferred: replaceRef(navigation.target.preferred), aliases: deduplicate(navigation.target.aliases.map(replaceRef)) } }
  return {
    relations: nativeFork ? state.relations : state.relations.map((relation) => ({ ...relation,
      childSessionId: replace(relation.childSessionId), parentSessionId: replace(relation.parentSessionId) })),
    removals: nativeFork ? state.removals : state.removals.map((removal): ConversationRemoval => {
      if (removal.kind === "tree") return { ...removal, rootSessionId: replace(removal.rootSessionId), memberSessionIds: [...new Set(removal.memberSessionIds.map(replace))] }
      return { ...removal, target: removal.target.kind === "endpoint" ? { ...removal.target, sessionId: replace(removal.target.sessionId) }
        : { ...removal.target, aliases: deduplicate(removal.target.aliases.map((ref) => ({ ...ref, sessionId: replace(ref.sessionId) }))) } }
    }),
    ...(nextNavigation === undefined ? {} : { navigation: nextNavigation }),
  }
}
function removalIdentity(removal: ConversationRemoval): string {
  return JSON.stringify(removal.kind === "tree" ? { kind: removal.kind, rootSessionId: removal.rootSessionId, memberSessionIds: removal.memberSessionIds }
    : { kind: removal.kind, target: removal.target })
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
function refKey(ref: MessageRef): string { return `${ref.sessionId.length}:${ref.sessionId}${ref.messageId}` }
function unique(values: readonly string[], label: string): void { if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`) }
function date(value: string): void { const parsed = new Date(value); if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new Error(`Invalid canonical timestamp: ${value}`) }
function attempt<A>(run: () => A): Effect.Effect<A, unknown> { return Effect.try({ try: run, catch: (cause) => cause }) }
function persistenceError(operation: string, path: string, cause: unknown): PersistenceError {
  return cause instanceof PersistenceError ? cause : new PersistenceError({ operation, path, message: cause instanceof Error ? cause.message : String(cause), cause })
}
