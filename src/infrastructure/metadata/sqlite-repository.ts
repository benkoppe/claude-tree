import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { join } from "node:path"
import { stat } from "node:fs/promises"
import { and, asc, eq } from "drizzle-orm"
import { Cause, Effect } from "effect"

import { PersistenceError, SessionRemovedError } from "../../domain/errors"
import type { MessageRef, NavigationState } from "../../domain/model"
import type { BranchRelation, ConversationRemoval, ProjectState, ProviderState } from "../../domain/persistence"
import { canonicalizeAndValidate, canonicalizeRemoval, decodeState, removalIdentity, replaceSessionIdInProjectState,
  type ProviderStateRepositoryApi, type ProviderStateRepositoryOptions } from "../../services/legacy-provider-state"
import { databaseOrm, openStateDatabase, sqliteTransaction } from "./database"
import { PersistencePlatform, isErrorCode } from "./platform"
import { decodeStrict, readJsonIfPresent, withTransactionLock } from "./storage"
import { Schema } from "effect"
import * as s from "./schema"

export function makeSqliteRepository(options: ProviderStateRepositoryOptions): Effect.Effect<ProviderStateRepositoryApi, PersistenceError, PersistencePlatform> {
  return Effect.gen(function*() {
    const platform = yield* PersistencePlatform
    const instanceId = options.instanceId ?? platform.instanceId
    const projectPath = yield* Effect.tryPromise({ try: () => platform.realpath(options.projectDirectory), catch: (e) => e })
    if (!instanceId || !/^[a-z0-9][a-z0-9-]*$/.test(options.providerId)) throw new Error("Invalid workspace or provider identity")
    const home = options.stateHome ?? platform.stateHome()
    const legacyDirectory = join(home, "claude-tree", "v2", "projects", createHash("sha256").update(projectPath).digest("hex"))
    const legacyProvider = join(legacyDirectory, "providers", options.providerId)
    const legacyPath = join(legacyProvider, "state.json")
    const legacyPresent = yield* Effect.tryPromise({ try: async () => {
      for (const path of [legacyPath, join(legacyProvider, "leases")]) {
        try { await stat(path); return true } catch (e) { if (!isErrorCode(e, "ENOENT")) throw e }
      }
      return false
    }, catch: (e) => e })
    const database = yield* openStateDatabase(home, options.requireExisting || !!options.resumeWorkspaceId)
    const db = database.db
    const identityResult = yield* Effect.exit(Effect.tryPromise({ try: () => stat(database.path), catch: (e) => e }))
    if (identityResult._tag === "Failure") { yield* Effect.promise(database.close); return yield* Effect.failCause(identityResult.cause) }
    const databaseIdentity = identityResult.value
    const orm = databaseOrm(db)
    const scopeResult = yield* Effect.exit(sqliteTransaction(db, () => {
      let project = orm.select().from(s.projects).where(eq(s.projects.path, projectPath)).get()
      let scope = project && orm.select().from(s.scopes).where(and(eq(s.scopes.projectId, project.id), eq(s.scopes.providerId, options.providerId))).get()
      if (legacyPresent && !scope?.importDigest && !options.importLegacy) throw new Error(`Legacy state requires explicit import. Close legacy invocations, then run claude-tree state import-json ${options.providerId === "codex" ? "--codex " : ""}${JSON.stringify(projectPath)}. Existing files were left untouched.`)
      if (!scope && (options.requireExisting || options.resumeWorkspaceId)) throw new Error("Provider state is missing")
      if (!project) {
        project = { id: platform.randomToken(), path: projectPath, createdAt: platform.now(), updatedAt: platform.now() }
        orm.insert(s.projects).values(project).run()
      }
      if (!scope) {
        scope = { id: platform.randomToken(), projectId: project.id, providerId: options.providerId, importDigest: null, importedAt: null }
        orm.insert(s.scopes).values(scope).run()
      }
      return { project, scope }
    }))
    if (scopeResult._tag === "Failure") { yield* Effect.promise(database.close); return yield* Effect.failCause(scopeResult.cause) }
    const { project, scope } = scopeResult.value
    let closed = false
    const knownRefs = new Map(orm.select().from(s.sessions).where(eq(s.sessions.scopeId, scope.id)).all().map((row) => [row.providerSessionId, row.id]))
    let referenceUndo: Map<string, string | undefined> | undefined
    const rememberRef = (id: string, reference: string) => {
      if (referenceUndo && !referenceUndo.has(id)) referenceUndo.set(id, knownRefs.get(id))
      knownRefs.set(id, reference)
    }
    const adopted = new Map<string, string>()
    const resolveIdentity = (id: string): string => {
      const seen = new Set<string>()
      while (adopted.has(id)) { if (seen.has(id)) throw new Error("Identity adoption cycle"); seen.add(id); id = adopted.get(id)! }
      return id
    }
    const failure = (operation: string, cause: unknown) => cause instanceof PersistenceError ? cause : new PersistenceError({
      operation, path: database.path, message: cause instanceof Error ? cause.message : String(cause), cause,
    })
    const transaction = <A>(operation: string, run: () => A): Effect.Effect<A, PersistenceError> => Effect.suspend(() => {
      if (closed) return Effect.fail(failure(operation, new Error("State repository is closed")))
      return Effect.tryPromise({ try: async () => {
        const current = await stat(database.path)
        if (current.ino !== databaseIdentity.ino || current.dev !== databaseIdentity.dev) throw new Error("State database was replaced; restart the application")
      }, catch: (e) => e }).pipe(
        Effect.andThen(sqliteTransaction(db, () => {
          const undo = new Map<string, string | undefined>(); referenceUndo = undo
          try { return run() } catch (e) {
            for (const [key, value] of undo) if (value === undefined) knownRefs.delete(key); else knownRefs.set(key, value)
            throw e
          } finally { referenceUndo = undefined }
        })), Effect.mapError((e) => failure(operation, e)))
    })
    const ref = (providerId: string): string => {
      const actual = resolveIdentity(providerId)
      const retained = knownRefs.get(actual) ?? knownRefs.get(providerId)
      if (retained && orm.select().from(s.sessions).where(and(eq(s.sessions.scopeId, scope.id), eq(s.sessions.id, retained))).get()) return retained
      const existing = orm.select().from(s.sessions).where(and(eq(s.sessions.scopeId, scope.id), eq(s.sessions.providerSessionId, actual))).get()
      if (existing) { rememberRef(actual, existing.id); return existing.id }
      const id = platform.randomToken()
      orm.insert(s.sessions).values({ id, scopeId: scope.id, providerSessionId: actual }).run()
      rememberRef(actual, id)
      return id
    }
    const sessionIds = () => new Map(orm.select().from(s.sessions).where(eq(s.sessions.scopeId, scope.id)).all().map((row) => {
      rememberRef(row.providerSessionId, row.id)
      return [row.id, row.providerSessionId]
    }))
    const sessionId = (refs: ReadonlyMap<string, string>, id: string) => {
      const value = refs.get(id)
      if (!value) throw new Error("Metadata refers to an unavailable session reference")
      return value
    }
    const readNavigation = (row: typeof s.workspaces.$inferSelect, refs: ReadonlyMap<string, string>): NavigationState => {
      if (row.view === "roots") return { view: "roots", selectedSessionId: row.selected === null ? null : sessionId(refs, row.selected) }
      if (row.view === "terminal") return { view: "terminal", sessionId: sessionId(refs, row.target!) }
      if (row.view !== "graph") throw new Error("Invalid workspace view")
      return { view: "graph", familySessionId: sessionId(refs, row.family!), target: row.targetKind === "endpoint"
        ? { kind: "endpoint", sessionId: sessionId(refs, row.target!) }
        : { kind: "message", preferred: { sessionId: sessionId(refs, row.target!), messageId: row.message! },
          aliases: orm.select().from(s.workspaceAliases).where(and(eq(s.workspaceAliases.scopeId, scope.id), eq(s.workspaceAliases.workspace, row.id))).all()
            .map((alias) => ({ sessionId: sessionId(refs, alias.session), messageId: alias.message })) } }
    }
    const writeNavigation = (workspace: string, input: NavigationState) => {
      let navigation = input
      for (const [previous, next] of adopted) navigation = replaceSessionIdInProjectState({ relations: [], removals: [], navigation }, previous, next).navigation!
      canonicalizeAndValidate({ relations: [], removals: [], navigations: [{ instanceId: workspace, navigation }] })
      const row = { scopeId: scope.id, id: workspace, view: navigation.view, selected: null as string | null, family: null as string | null,
        targetKind: null as string | null, target: null as string | null, message: null as string | null, createdAt: platform.now(), updatedAt: platform.now() }
      let aliases: readonly MessageRef[] = []
      if (navigation.view === "roots") row.selected = navigation.selectedSessionId === null ? null : ref(navigation.selectedSessionId)
      else if (navigation.view === "terminal") row.target = ref(navigation.sessionId)
      else {
        row.family = ref(navigation.familySessionId); row.targetKind = navigation.target.kind
        if (navigation.target.kind === "endpoint") row.target = ref(navigation.target.sessionId)
        else { row.target = ref(navigation.target.preferred.sessionId); row.message = navigation.target.preferred.messageId; aliases = navigation.target.aliases }
      }
      orm.insert(s.workspaces).values(row).onConflictDoUpdate({ target: [s.workspaces.scopeId, s.workspaces.id], set: {
        view: row.view, selected: row.selected, family: row.family, targetKind: row.targetKind, target: row.target, message: row.message, updatedAt: row.updatedAt,
      } }).run()
      orm.delete(s.workspaceAliases).where(and(eq(s.workspaceAliases.scopeId, scope.id), eq(s.workspaceAliases.workspace, workspace))).run()
      for (const alias of aliases) orm.insert(s.workspaceAliases).values({ scopeId: scope.id, workspace, session: ref(alias.sessionId), message: alias.messageId }).run()
    }
    const readRelations = (): readonly BranchRelation[] => {
      const refs = sessionIds()
      const mappingRows = orm.select({ child: s.mappings.child, ordinal: s.mappings.ordinal, parentMessage: s.mappings.parentMessage, childMessage: s.mappings.childMessage })
        .from(s.mappings).innerJoin(s.relations, eq(s.mappings.child, s.relations.child)).where(eq(s.relations.scopeId, scope.id)).orderBy(asc(s.mappings.ordinal)).all()
      const grouped = new Map<string, typeof mappingRows>()
      for (const row of mappingRows) { const group = grouped.get(row.child) ?? []; group.push(row); grouped.set(row.child, group) }
      return orm.select().from(s.relations).where(eq(s.relations.scopeId, scope.id)).all().map((row) => {
        const mappings = grouped.get(row.child) ?? []
        if (mappings.some((entry, index) => entry.ordinal !== index)) throw new Error("Shared message mapping ordinals are not contiguous")
        return { childSessionId: sessionId(refs, row.child), parentSessionId: sessionId(refs, row.parent), sourceMessageId: row.source, createdAt: row.createdAt,
          sharedMessages: mappings.map((entry) => ({ parentMessageId: entry.parentMessage, childMessageId: entry.childMessage })) }
      })
    }
    const writeRelation = (relation: BranchRelation) => {
      const child = ref(relation.childSessionId)
      orm.insert(s.relations).values({ child, scopeId: scope.id, parent: ref(relation.parentSessionId), source: relation.sourceMessageId, createdAt: relation.createdAt }).run()
      relation.sharedMessages.forEach((mapping, ordinal) => orm.insert(s.mappings).values({ child, ordinal, parentMessage: mapping.parentMessageId, childMessage: mapping.childMessageId }).run())
    }
    const readRemovals = (): readonly ConversationRemoval[] => {
      const refs = sessionIds()
      return orm.select().from(s.removals).where(eq(s.removals.scopeId, scope.id)).all().map((row): ConversationRemoval => {
        const members = orm.select().from(s.removalMembers).where(eq(s.removalMembers.removal, row.id)).all()
        const aliases = orm.select().from(s.removalAliases).where(eq(s.removalAliases.removal, row.id)).all()
        const expectedKey = row.kind === "tree" ? { kind: "tree", root: row.root, members: members.map((member) => member.session).sort() }
          : row.kind === "endpoint" ? { kind: "endpoint", session: row.endpoint, after: row.afterMessage }
            : { kind: "message", aliases: sortedLocalAliases(aliases.map((alias) => [alias.session, alias.message])) }
        if (row.key !== JSON.stringify(expectedKey)) throw new Error("Removal semantic key does not match its stable references")
        if (row.kind === "tree") {
          if (aliases.length) throw new Error("Tree removal contains message aliases")
          return { kind: "tree", rootSessionId: sessionId(refs, row.root!), memberSessionIds: members.map((member) => sessionId(refs, member.session)), createdAt: row.createdAt }
        }
        if (members.length || (row.kind === "endpoint" && aliases.length)) throw new Error("Invalid removal child records")
        return { kind: "subtree", createdAt: row.createdAt, target: row.kind === "endpoint"
          ? { kind: "endpoint", sessionId: sessionId(refs, row.endpoint!), afterMessageId: row.afterMessage }
          : { kind: "message", aliases: aliases.map((alias) => ({ sessionId: sessionId(refs, alias.session), messageId: alias.message })) } }
      })
    }
    const writeRemoval = (input: ConversationRemoval): ConversationRemoval => {
      const actualId = (id: string) => orm.select().from(s.sessions).where(eq(s.sessions.id, ref(id))).get()!.providerSessionId
      const translated: ConversationRemoval = input.kind === "tree" ? { ...input, rootSessionId: actualId(input.rootSessionId), memberSessionIds: [...new Set(input.memberSessionIds.map(actualId))] }
        : { ...input, target: input.target.kind === "endpoint" ? { ...input.target, sessionId: actualId(input.target.sessionId) }
          : { ...input.target, aliases: input.target.aliases.map((alias) => ({ ...alias, sessionId: actualId(alias.sessionId) })) } }
      const removal = canonicalizeRemoval(translated)
      canonicalizeAndValidate({ relations: [], removals: [removal], navigations: [] })
      const local = removal.kind === "tree"
        ? { kind: "tree", root: ref(removal.rootSessionId), members: removal.memberSessionIds.map(ref).sort() }
        : removal.target.kind === "endpoint"
          ? { kind: "endpoint", session: ref(removal.target.sessionId), after: removal.target.afterMessageId }
          : { kind: "message", aliases: sortedLocalAliases(removal.target.aliases.map((alias) => [ref(alias.sessionId), alias.messageId])) }
      const key = JSON.stringify(local)
      const existing = orm.select().from(s.removals).where(and(eq(s.removals.scopeId, scope.id), eq(s.removals.key, key))).get()
      if (existing) return readRemovals().find((entry) => removalIdentity(canonicalizeRemoval(entry)) === removalIdentity(removal))!
      const id = platform.randomToken()
      orm.insert(s.removals).values({ id, scopeId: scope.id, kind: local.kind, key, createdAt: removal.createdAt,
        root: removal.kind === "tree" ? ref(removal.rootSessionId) : null,
        endpoint: removal.kind === "subtree" && removal.target.kind === "endpoint" ? ref(removal.target.sessionId) : null,
        afterMessage: removal.kind === "subtree" && removal.target.kind === "endpoint" ? removal.target.afterMessageId : null }).run()
      if (removal.kind === "tree") for (const member of removal.memberSessionIds) orm.insert(s.removalMembers).values({ scopeId: scope.id, removal: id, session: ref(member) }).run()
      else if (removal.target.kind === "message") for (const alias of removal.target.aliases) orm.insert(s.removalAliases).values({ scopeId: scope.id, removal: id, session: ref(alias.sessionId), message: alias.messageId }).run()
      return removal
    }
    const read = (): ProviderState => {
      const refs = sessionIds()
      const navigations = orm.select().from(s.workspaces).where(eq(s.workspaces.scopeId, scope.id)).all().map((row) => {
        const navigation = readNavigation(row, refs)
        if (!(navigation.view === "graph" && navigation.target.kind === "message") &&
          orm.select().from(s.workspaceAliases).where(and(eq(s.workspaceAliases.scopeId, scope.id), eq(s.workspaceAliases.workspace, row.id))).get()) throw new Error("Unexpected workspace aliases")
        return { instanceId: row.id, navigation }
      })
      return canonicalizeAndValidate({ relations: readRelations(), removals: readRemovals(), navigations })
    }
    const metadata = (state: ProviderState, workspace = instanceId): ProjectState => ({ relations: state.relations, removals: state.removals,
      ...(state.navigations.find((entry) => entry.instanceId === workspace)?.navigation ? { navigation: state.navigations.find((entry) => entry.instanceId === workspace)!.navigation } : {}) })
    const syncMetadata = (current: ProjectState, next: ProjectState) => {
      canonicalizeAndValidate({ relations: next.relations, removals: next.removals, navigations: [] })
      for (const relation of current.relations) if (!next.relations.some((entry) => isDeepStrictEqual(entry, relation))) orm.delete(s.relations).where(eq(s.relations.child, ref(relation.childSessionId))).run()
      for (const relation of next.relations) if (!current.relations.some((entry) => isDeepStrictEqual(entry, relation))) writeRelation(relation)
      if (!isDeepStrictEqual(current.removals, next.removals)) {
        orm.delete(s.removals).where(eq(s.removals.scopeId, scope.id)).run()
        next.removals.forEach(writeRemoval)
      }
    }
    const api: ProviderStateRepositoryApi = {
      projectId: project.id, scopeId: scope.id, projectPath, statePath: database.path, instanceId,
      close: Effect.suspend(() => { closed = true; return Effect.tryPromise({ try: database.close, catch: (e) => failure("close state", e) }) }),
      load: transaction("load state", read), loadMetadata: transaction("load metadata", () => metadata(read())),
      saveNavigation: (navigation) => transaction("save navigation", () => writeNavigation(instanceId, navigation)),
      saveRelation: (relation) => transaction("save relation", () => {
        const current = readRelations()
        const existing = current.find((entry) => entry.childSessionId === relation.childSessionId)
        if (existing) { if (!isDeepStrictEqual(existing, relation)) throw new Error("Session already has different branch metadata"); return existing }
        canonicalizeAndValidate({ relations: [...current, relation], removals: [], navigations: [] })
        writeRelation(relation); return relation
      }),
      removeExactRelation: (relation) => transaction("remove relation", () => {
        const existing = readRelations().find((entry) => isDeepStrictEqual(entry, relation))
        if (existing) orm.delete(s.relations).where(eq(s.relations.child, ref(existing.childSessionId))).run()
      }),
      updateMetadata: (transform) => transaction("update metadata", () => {
        const current = metadata(read()); const next = transform(current); syncMetadata(current, next)
        if (next.navigation) writeNavigation(instanceId, next.navigation)
        else orm.delete(s.workspaces).where(and(eq(s.workspaces.scopeId, scope.id), eq(s.workspaces.id, instanceId))).run()
        return metadata(read())
      }),
      commitRemoval: (removal) => transaction("commit removal", () => writeRemoval(removal)),
      replaceIdentity: (previous, actual, transition) => transaction("replace identity", () => {
        if (!previous || !actual || previous === actual) throw new Error("Identity replacement requires two different nonempty IDs")
        const state = read()
        if (state.removals.some((entry) => entry.kind === "tree" && (entry.memberSessionIds.includes(previous) || entry.memberSessionIds.includes(actual)))) throw new SessionRemovedError({ providerId: options.providerId, sessionId: actual, message: `Session ${actual} was removed from the navigator` })
        const next = replaceSessionIdInProjectState(metadata(state), previous, actual, transition)
        if (transition.kind === "temporary-adoption") {
          const before = ref(previous)
          const destination = orm.select().from(s.sessions).where(and(eq(s.sessions.scopeId, scope.id), eq(s.sessions.providerSessionId, actual))).get()
          if (destination && destination.id !== before) throw new Error("Identity destination already has metadata")
          orm.update(s.sessions).set({ providerSessionId: actual }).where(eq(s.sessions.id, before)).run()
          for (const entry of state.navigations) writeNavigation(entry.instanceId, replaceSessionIdInProjectState({ relations: [], removals: [], navigation: entry.navigation }, previous, actual).navigation!)
        } else if (next.navigation) writeNavigation(instanceId, next.navigation)
        if (transition.relation) {
          const relation = transition.relation
          if (relation.childSessionId !== actual || (transition.kind === "native-fork" && relation.parentSessionId !== previous)) throw new Error("Identity relation does not match its session IDs")
          const current = readRelations()
          const existing = current.find((entry) => entry.childSessionId === actual)
          if (existing && !isDeepStrictEqual(existing, relation)) throw new Error("Session already has different branch metadata")
          if (!existing) { canonicalizeAndValidate({ relations: [...current, relation], removals: [], navigations: [] }); writeRelation(relation) }
        }
        read()
      }).pipe(Effect.catch((error): Effect.Effect<never, PersistenceError | SessionRemovedError> => error.cause instanceof SessionRemovedError ? Effect.fail(error.cause) : Effect.fail(error)),
        Effect.tap(() => Effect.sync(() => { if (transition.kind === "temporary-adoption") adopted.set(previous, actual) }))),
    }
    const initialize = Effect.gen(function*() {
      if (options.importLegacy) {
        const imported = yield* withTransactionLock(platform, join(legacyProvider, "state.lock"), Effect.gen(function*() {
          const manifest = yield* readJsonIfPresent(platform, join(legacyDirectory, "project.json"))
          const decodedManifest = decodeStrict(Schema.Struct({ schemaVersion: Schema.Literal(3), projectPath: Schema.NonEmptyString }), manifest)
          if (decodedManifest.projectPath !== projectPath) throw new Error("Legacy manifest belongs to another project")
          const leases = yield* Effect.result(Effect.tryPromise({ try: () => platform.readDirectory(join(legacyProvider, "leases")), catch: (e) => e }))
          if (leases._tag === "Success") throw new Error("Obsolete lease layout cannot be imported")
          if (!isErrorCode(leases.failure, "ENOENT")) return yield* Effect.fail(leases.failure)
          const value = yield* readJsonIfPresent(platform, legacyPath)
          const state = decodeState(value, { projectDirectory: legacyDirectory })
          return { state, digest: createHash("sha256").update(JSON.stringify(value)).digest("hex") }
        }))
        yield* transaction("import legacy state", () => {
          const existing = orm.select().from(s.scopes).where(eq(s.scopes.id, scope.id)).get()!
          if (existing.importDigest) { if (existing.importDigest !== imported.digest) throw new Error("Legacy state changed after import; automatic merging is disabled"); return }
          const current = read()
          if (current.relations.length || current.removals.length || current.navigations.length) throw new Error("Cannot import into a nonempty metadata scope")
          imported.state.relations.forEach(writeRelation); imported.state.removals.forEach(writeRemoval)
          for (const entry of imported.state.navigations) writeNavigation(entry.instanceId, entry.navigation)
          orm.update(s.scopes).set({ importDigest: imported.digest, importedAt: platform.now() }).where(eq(s.scopes.id, scope.id)).run()
        })
      }
      if (options.resumeWorkspaceId) yield* transaction("resume workspace", () => {
        const row = orm.select().from(s.workspaces).where(and(eq(s.workspaces.scopeId, scope.id), eq(s.workspaces.id, options.resumeWorkspaceId!))).get()
        if (!row) throw new Error(`Workspace ${options.resumeWorkspaceId} is unavailable for this project and provider`)
        writeNavigation(instanceId, readNavigation(row, sessionIds()))
      })
      yield* api.load
    })
    const initialized = yield* Effect.exit(initialize)
    if (initialized._tag === "Failure") { yield* api.close; return yield* Effect.failCause(initialized.cause) }
    return api
  }).pipe(Effect.catchCause((failure) => {
    if (Cause.hasInterruptsOnly(failure)) return Effect.interrupt
    const cause = Cause.squash(failure)
    return Effect.fail(cause instanceof PersistenceError ? cause : new PersistenceError({ operation: "open state", path: options.projectDirectory, message: cause instanceof Error ? cause.message : String(cause), cause }))
  }))
}

function sortedLocalAliases(aliases: string[][]): string[][] {
  return aliases.sort((a, b) => {
    const left = JSON.stringify(a); const right = JSON.stringify(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}
