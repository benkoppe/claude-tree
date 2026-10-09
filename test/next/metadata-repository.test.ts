import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, open as openFile, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"

import type { BranchRelation } from "../../src/domain/persistence"
import { PersistencePlatform, nativePersistencePlatform } from "../../src/infrastructure/metadata/platform"
import { makeProviderStateRepository, type ProviderStateRepositoryApi, type ProviderStateRepositoryOptions } from "../../src/services/provider-state-repository"
import { makeMetadataWorker } from "../../src/infrastructure/metadata/worker-service"
import { runStateCommand } from "../../src/infrastructure/metadata/state-commands"
import { databasePath, nativeStateDatabasePlatform, openStateDatabase, sqliteTransaction, type DatabaseSchemaPolicy, type StateDatabasePlatform } from "../../src/infrastructure/metadata/database"
import { readMigrationFiles } from "drizzle-orm/migrator"

const directories: string[] = []
const repositories: ProviderStateRepositoryApi[] = []
let testScope = Scope.makeUnsafe()
afterEach(async () => {
  for (const repository of repositories.splice(0)) await run(repository.close)
  await Effect.runPromise(Scope.close(testScope, Exit.void))
  testScope = Scope.makeUnsafe()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Scope.provide(effect, testScope))
async function fixture() {
  await mkdir("/tmp/opencode", { recursive: true })
  const directory = await realpath(await mkdtemp("/tmp/opencode/sqlite-test-"))
  directories.push(directory)
  const projectDirectory = join(directory, "project"); await mkdir(projectDirectory)
  return { projectDirectory, stateHome: join(directory, "state"), providerId: "claude", instanceId: "one" }
}
async function open(options: ProviderStateRepositoryOptions) {
  const repository = await run(makeProviderStateRepository(options).pipe(Effect.provideService(PersistencePlatform, nativePersistencePlatform)))
  repositories.push(repository); return repository
}
const relation = (child: string, parent = "root"): BranchRelation => ({ childSessionId: child, parentSessionId: parent,
  sourceMessageId: "z", sharedMessages: [{ parentMessageId: "b", childMessageId: "copy-b" }, { parentMessageId: "a", childMessageId: "copy-a" }, { parentMessageId: "z", childMessageId: "copy-z" }], createdAt: "2026-01-01T00:00:00.000Z" })

test("one private STRICT database stores separate project/provider scopes and ordered mappings", async () => {
  const options = await fixture(); const first = await open(options)
  const second = await open({ ...options, providerId: "codex" })
  expect(first.statePath).toBe(second.statePath)
  expect(first.projectId).toBe(second.projectId)
  expect(first.scopeId).not.toBe(second.scopeId)
  await run(first.saveRelation(relation("child")))
  expect((await run(first.loadMetadata)).relations).toEqual([relation("child")])
  expect((await run(second.loadMetadata)).relations).toEqual([])
  expect((await stat(first.statePath)).mode & 0o777).toBe(0o600)
  using db = new Database(first.statePath, { readonly: true })
  expect(db.query<{ strict: number; name: string }, []>("PRAGMA table_list").all().filter((row) => !row.name.startsWith("sqlite_") && row.name !== "__drizzle_migrations").every((row) => row.strict === 1)).toBe(true)
  expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE '%transcript%' OR name LIKE '%owner%'").all()).toEqual([])
})

test("relation conflicts and cycles roll back without modifying valid ancestry", async () => {
  const repository = await open(await fixture())
  await run(repository.saveRelation(relation("child")))
  await expect(run(repository.saveRelation(relation("child", "different")))).rejects.toThrow("different branch metadata")
  await expect(run(repository.saveRelation(relation("root", "child")))).rejects.toThrow("cycle")
  expect((await run(repository.loadMetadata)).relations).toEqual([relation("child")])
  await run(repository.saveRelation({ ...relation("empty"), sharedMessages: [] }))
  expect((await run(repository.loadMetadata)).relations).toHaveLength(2)
})

test("workspace writes do not query ancestry and temporary adoption retains local references", async () => {
  const options = await fixture(); const first = await open(options); const second = await open({ ...options, instanceId: "two" })
  await run(first.saveRelation({ ...relation("temporary"), sharedMessages: [] }))
  await run(first.saveNavigation({ view: "terminal", sessionId: "temporary" }))
  await run(second.saveNavigation({ view: "roots", selectedSessionId: "temporary" }))
  await run(second.saveNavigation({ view: "roots", selectedSessionId: "temporary" }))
  using db = new Database(first.statePath)
  const before = db.query("SELECT session_ref_id FROM session_refs WHERE provider_session_id = 'temporary'").get()
  await run(first.replaceIdentity("temporary", "actual", { kind: "temporary-adoption" }))
  expect(db.query("SELECT session_ref_id FROM session_refs WHERE provider_session_id = 'actual'").get()).toEqual(before)
  await run(first.saveNavigation({ view: "terminal", sessionId: "temporary" }))
  expect((await run(first.loadMetadata)).navigation).toEqual({ view: "terminal", sessionId: "actual" })
  expect((await run(second.loadMetadata)).navigation).toEqual({ view: "roots", selectedSessionId: "actual" })
  // A malformed ancestry record does not make a single cursor save scan ancestry.
  db.run("UPDATE branch_relations SET source_message_id = 'missing'")
  await run(first.saveNavigation({ view: "roots", selectedSessionId: "actual" }))
})

test("removal variants round-trip and remain idempotent through adoption", async () => {
  const repository = await open(await fixture())
  const removal = { kind: "subtree" as const, target: { kind: "message" as const, aliases: [{ sessionId: "temporary", messageId: "a" }] }, createdAt: "2026-01-01T00:00:00.000Z" }
  await run(repository.commitRemoval(removal, []))
  await run(repository.replaceIdentity("temporary", "actual", { kind: "temporary-adoption" }))
  const actual = { ...removal, target: { ...removal.target, aliases: [{ sessionId: "actual", messageId: "a" }] } }
  await run(repository.commitRemoval(actual, []))
  expect((await run(repository.loadMetadata)).removals).toEqual([actual])
})

test("metadata worker serializes writes, preserves workspace isolation, and drains on close", async () => {
  const options = await fixture()
  await run(Effect.scoped(Effect.gen(function*() {
    const first = yield* makeMetadataWorker(options)
    const second = yield* makeMetadataWorker({ ...options, instanceId: "two" })
    yield* first.saveNavigation({ view: "roots", selectedSessionId: "first" })
    yield* second.saveNavigation({ view: "roots", selectedSessionId: "second" })
    yield* Effect.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).saveRelation({ ...relation(`child-${i}`), sharedMessages: [] })), { concurrency: "unbounded" })
    expect((yield* first.loadMetadata).relations).toHaveLength(20)
    expect((yield* second.loadMetadata).navigation).toEqual({ view: "roots", selectedSessionId: "second" })
    yield* first.saveNavigation({ view: "roots", selectedSessionId: "latest" })
    expect((yield* first.loadMetadata).relations).toHaveLength(20)
    expect((yield* second.loadMetadata).navigation).toEqual({ view: "roots", selectedSessionId: "second" })
    yield* first.close; yield* second.close
    expect((yield* Effect.flip(first.saveNavigation({ view: "roots", selectedSessionId: null }))).message).toContain("closing")
  })))
})

test.each(["incompatible", "missing"])("metadata worker rejects %s initialized state without replacing it", async (kind) => {
  const options = await fixture()
  const repository = await open(options)
  await run(repository.close)
  const invalid = "{\"version\":1}"
  if (kind === "incompatible") await writeFile(repository.statePath, invalid)
  else await rm(repository.statePath)
  const failure = await run(Effect.scoped(Effect.flip(makeMetadataWorker({ ...options, requireExisting: true }))))
  expect(failure._tag).toBe("PersistenceError")
  if (kind === "incompatible") expect(await readFile(repository.statePath, "utf8")).toBe(invalid)
  else expect(await Bun.file(repository.statePath).exists()).toBeFalse()
})

test("foreign keys prevent cross-scope references", async () => {
  const options = await fixture(); const first = await open(options); const second = await open({ ...options, providerId: "codex" })
  await run(first.saveNavigation({ view: "terminal", sessionId: "a" })); await run(second.saveNavigation({ view: "terminal", sessionId: "b" }))
  using db = new Database(first.statePath)
  db.run("PRAGMA foreign_keys = ON")
  const rows = db.query<{ session_ref_id: string; scope_id: string }, []>("SELECT session_ref_id, scope_id FROM session_refs ORDER BY provider_session_id").all()
  expect(() => db.query("INSERT INTO branch_relations VALUES (?, ?, ?, 'source', '2026-01-01T00:00:00.000Z')").run(rows[0]!.session_ref_id, rows[0]!.scope_id, rows[1]!.session_ref_id)).toThrow()
})

test("delayed navigation cannot undo a native fork; fresh navigation may select its source", async () => {
  const options = await fixture()
  await run(Effect.scoped(Effect.gen(function*() {
    const worker = yield* makeMetadataWorker(options)
    yield* worker.saveNavigation({ view: "terminal", sessionId: "root" })
    const delayed = worker.saveNavigation({ view: "terminal", sessionId: "root" })
    yield* worker.replaceIdentity("root", "fork", { kind: "native-fork", relation: { ...relation("fork"), sharedMessages: [] } })
    yield* delayed
    expect((yield* worker.loadMetadata).navigation).toEqual({ view: "terminal", sessionId: "fork" })
    yield* worker.saveNavigation({ view: "terminal", sessionId: "root" })
    expect((yield* worker.loadMetadata).navigation).toEqual({ view: "terminal", sessionId: "root" })
  })))
})

test("newer schema and altered migration history are rejected in place", async () => {
  const options = await fixture(); const first = await open(options); await run(first.close)
  using db = new Database(first.statePath)
  db.run("PRAGMA user_version = 99")
  await expect(open(options)).rejects.toThrow("Unsupported")
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 99 })
  db.run("PRAGMA user_version = 1"); db.run("UPDATE __drizzle_migrations SET hash = 'invalid'")
  await expect(open(options)).rejects.toThrow("migration history")
})

test("missing database is not recreated by an attached repository", async () => {
  const repository = await open(await fixture())
  await rm(repository.statePath)
  await expect(run(repository.saveNavigation({ view: "roots", selectedSessionId: null }))).rejects.toThrow()
  await expect(stat(repository.statePath)).rejects.toThrow()
})

test("explicit v3 import preserves navigation and leaves source untouched", async () => {
  const options = await fixture()
  const legacyDirectory = join(options.stateHome, "claude-tree/v2/projects", createHash("sha256").update(options.projectDirectory).digest("hex"))
  const providerDirectory = join(legacyDirectory, "providers/claude"); await mkdir(providerDirectory, { recursive: true })
  await writeFile(join(legacyDirectory, "project.json"), JSON.stringify({ schemaVersion: 3, projectPath: options.projectDirectory }))
  const source = JSON.stringify({ schemaVersion: 3, relations: [relation("child")], removals: [], navigations: [{ instanceId: "old", navigation: { view: "terminal", sessionId: "child" } }] })
  const path = join(providerDirectory, "state.json"); await writeFile(path, source)
  await expect(open(options)).rejects.toThrow("explicit import")
  const imported = await open({ ...options, importLegacy: true })
  expect((await run(imported.load)).navigations[0]?.instanceId).toBe("old")
  expect(await readFile(path, "utf8")).toBe(source)
  await run(imported.close)
  await open({ ...options, importLegacy: true })
  await writeFile(path, source.replace('"child"', '"changed"'))
  await expect(open({ ...options, importLegacy: true })).rejects.toThrow("changed after import")
})

test("backup contains committed WAL data and exports private metadata", async () => {
  const options = await fixture(); const repository = await open(options)
  await run(repository.saveRelation(relation("child")))
  const destination = join(options.stateHome, "backup.sqlite")
  const previous = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = options.stateHome
  try {
    await run(runStateCommand({ command: "state", action: "backup", provider: "claude", project: ".", destination }))
    using backup = new Database(destination, { readonly: true })
    expect(backup.query("SELECT count(*) AS count FROM branch_relations").get()).toEqual({ count: 1 })
    expect((await stat(destination)).mode & 0o777).toBe(0o600)
    const original = await readFile(destination)
    await expect(run(runStateCommand({ command: "state", action: "backup", provider: "claude", project: ".", destination }))).rejects.toThrow()
    expect(await readFile(destination)).toEqual(original)
    expect((await readdir(options.stateHome)).filter((name) => name.startsWith(".claude-tree-backup-"))).toEqual([])
    expect(await run(runStateCommand({ command: "state", action: "check", provider: "claude", project: "." }))).toContain("passed")
  } finally { if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous }
})

async function upgradePolicy(options: Awaited<ReturnType<typeof fixture>>, fail = false, extraSql = ""): Promise<DatabaseSchemaPolicy> {
  const folder = join(options.stateHome, "upgrade-migrations")
  await cp("src/infrastructure/metadata/migrations", folder, { recursive: true })
  const journalPath = join(folder, "meta/_journal.json")
  const journal = JSON.parse(await readFile(journalPath, "utf8"))
  journal.entries.push({ idx: 1, version: "6", when: journal.entries[0].when + 1, tag: "0001_upgrade", breakpoints: true })
  await writeFile(journalPath, JSON.stringify(journal))
  await writeFile(join(folder, "0001_upgrade.sql"), `CREATE TABLE upgrade_marker (value TEXT NOT NULL) STRICT;\n--> statement-breakpoint\n${fail ? "INSERT INTO upgrade_marker VALUES (NULL);" : "INSERT INTO upgrade_marker VALUES ('upgraded');"}\n--> statement-breakpoint\nPRAGMA user_version = 2;\n--> statement-breakpoint\n${extraSql}`)
  return { version: 2, folder, migrations: readMigrationFiles({ migrationsFolder: folder }).map((entry) => ({ hash: entry.hash, when: entry.folderMillis })) }
}

test("forward migration requires exclusive access, backs up, and rejects downgrade", async () => {
  const options = await fixture(); const repository = await open(options)
  const policy = await upgradePolicy(options)
  await expect(run(openStateDatabase(options.stateHome, true, policy))).rejects.toThrow("Exit other")
  await run(repository.close)
  const upgraded = await run(openStateDatabase(options.stateHome, true, policy))
  expect(upgraded.db.query("SELECT value FROM upgrade_marker").get()).toEqual({ value: "upgraded" })
  await upgraded.close()
  const backups = (await readdir(join(options.stateHome, "claude-tree"))).filter((name) => name.includes("before-v2"))
  expect(backups).toHaveLength(1)
  expect((await stat(join(options.stateHome, "claude-tree", backups[0]!))).mode & 0o777).toBe(0o600)
  await expect(open(options)).rejects.toThrow("Unsupported")
})

test("failed forward migration rolls back DDL, ledger, and compatibility version", async () => {
  const options = await fixture(); const repository = await open(options); await run(repository.close)
  const policy = await upgradePolicy(options, true)
  await expect(run(openStateDatabase(options.stateHome, true, policy))).rejects.toThrow()
  const reopened = await open(options)
  using db = new Database(reopened.statePath, { readonly: true })
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 })
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'upgrade_marker'").all()).toEqual([])
})

for (const [name, sql, error] of [
  ["foreign keys", "CREATE TABLE upgrade_child (parent TEXT REFERENCES projects(project_id) DEFERRABLE INITIALLY DEFERRED) STRICT;\n--> statement-breakpoint\nINSERT INTO upgrade_child VALUES ('missing');", "foreign key integrity"],
  ["schema version", "PRAGMA user_version = 3;", "schema version"],
  ["migration history", "UPDATE __drizzle_migrations SET hash = 'invalid';", "migration history"],
  ["application identity", "PRAGMA application_id = 123;", "application identity"],
] as const) test(`migration validation of ${name} rolls back before commit`, async () => {
  const options = await fixture(); const repository = await open(options)
  await run(repository.saveRelation(relation("retained")))
  const path = repository.statePath
  await run(repository.close)
  using before = new Database(path, { readonly: true })
  const history = before.query("SELECT * FROM __drizzle_migrations").all()
  const identity = before.query("PRAGMA application_id").get()
  await expect(run(openStateDatabase(options.stateHome, true, await upgradePolicy(options, false, sql)))).rejects.toThrow(error)
  using after = new Database(path, { readonly: true })
  expect(after.query("PRAGMA user_version").get()).toEqual({ user_version: 1 })
  expect(after.query("PRAGMA application_id").get()).toEqual(identity)
  expect(after.query("SELECT * FROM __drizzle_migrations").all()).toEqual(history)
  expect(after.query("SELECT name FROM sqlite_master WHERE name LIKE 'upgrade_%'").all()).toEqual([])
  expect((await run((await open(options)).loadMetadata)).relations).toEqual([relation("retained")])
  const backups = (await readdir(join(options.stateHome, "claude-tree"))).filter((entry) => entry.includes("before-v2"))
  expect(backups).toHaveLength(1)
})

test("startup close failure runs its backstop and closes the database and schema gate", async () => {
  const options = await fixture(); await run((await open(options)).close)
  let startupCloses = 0; let gateCloses = 0; let databaseCloses = 0
  const platform: StateDatabasePlatform = { ...nativeStateDatabasePlatform,
    openLock: async (path) => {
      const handle = await nativeStateDatabasePlatform.openLock(path)
      return { fd: handle.fd, close: async () => {
        if (path.endsWith("startup.lock")) {
          if (++startupCloses === 1) throw new Error("startup close failed")
        } else gateCloses++
        await handle.close()
      } }
    },
    connect: (path) => {
      const connected = nativeStateDatabasePlatform.connect(path)
      return { db: connected.db, close: () => { databaseCloses++; connected.close() } }
    },
  }
  await expect(run(openStateDatabase(options.stateHome, true, undefined, platform))).rejects.toThrow("startup close failed")
  expect(startupCloses).toBe(2); expect(databaseCloses).toBe(1); expect(gateCloses).toBe(1)
  const upgraded = await run(openStateDatabase(options.stateHome, true, await upgradePolicy(options)))
  await upgraded.close()
})

test("schema gate close failure remains retryable and concurrent closes share one attempt", async () => {
  const options = await fixture(); await run((await open(options)).close)
  let gateCloses = 0; let databaseCloses = 0
  const platform: StateDatabasePlatform = { ...nativeStateDatabasePlatform,
    openLock: async (path) => {
      const handle = await nativeStateDatabasePlatform.openLock(path)
      return { fd: handle.fd, close: async () => {
        if (path.endsWith("schema.lock") && ++gateCloses === 1) throw new Error("gate close failed")
        await handle.close()
      } }
    },
    connect: (path) => {
      const connected = nativeStateDatabasePlatform.connect(path)
      return { db: connected.db, close: () => { databaseCloses++; connected.close() } }
    },
  }
  const database = await run(openStateDatabase(options.stateHome, true, undefined, platform))
  const first = database.close(); const concurrent = database.close()
  expect(first).toBe(concurrent)
  await expect(first).rejects.toThrow("gate close failed")
  expect(databaseCloses).toBe(1); expect(gateCloses).toBe(1)
  await database.close(); await database.close()
  expect(databaseCloses).toBe(1); expect(gateCloses).toBe(2)
})

test("failed database close retains the schema gate until a successful retry", async () => {
  const options = await fixture(); await run((await open(options)).close)
  let databaseCloses = 0; let gateCloses = 0
  const platform: StateDatabasePlatform = { ...nativeStateDatabasePlatform,
    openLock: async (path) => {
      const handle = await nativeStateDatabasePlatform.openLock(path)
      return { fd: handle.fd, close: async () => { if (path.endsWith("schema.lock")) gateCloses++; await handle.close() } }
    },
    connect: (path) => {
      const connected = nativeStateDatabasePlatform.connect(path)
      const close = connected.db.close.bind(connected.db)
      connected.db.close = (...args) => { if (++databaseCloses === 1) throw new Error("database close failed"); close(...args) }
      return connected
    },
  }
  const database = await run(openStateDatabase(options.stateHome, true, undefined, platform))
  await expect(database.close()).rejects.toThrow("Unable to close state database")
  expect(gateCloses).toBe(0)
  const gate = await openFile(`${databasePath(options.stateHome)}.schema.lock`, "a")
  try { expect(nativeStateDatabasePlatform.fileLocker()(gate.fd, 2 | 4)).toBe(false) } finally { await gate.close() }
  await database.close()
  expect(databaseCloses).toBe(2); expect(gateCloses).toBe(1)
})

for (const fail of [false, true]) test(`skipped-version migrations ${fail ? "roll back the entire chain on failure" : "apply together"}`, async () => {
  const options = await fixture(); const repository = await open(options); await run(repository.close)
  const second = await upgradePolicy(options)
  const journalPath = join(second.folder, "meta/_journal.json")
  const journal = JSON.parse(await readFile(journalPath, "utf8"))
  journal.entries.push({ idx: 2, version: "6", when: journal.entries[1].when + 1, tag: "0002_upgrade", breakpoints: true })
  await writeFile(journalPath, JSON.stringify(journal))
  await writeFile(join(second.folder, "0002_upgrade.sql"), `${fail ? "INSERT INTO upgrade_marker VALUES (NULL);" : "INSERT INTO upgrade_marker VALUES ('third');"}\n--> statement-breakpoint\nPRAGMA user_version = 3;`)
  const policy: DatabaseSchemaPolicy = { version: 3, folder: second.folder,
    migrations: readMigrationFiles({ migrationsFolder: second.folder }).map((entry) => ({ hash: entry.hash, when: entry.folderMillis })) }
  if (fail) {
    await expect(run(openStateDatabase(options.stateHome, true, policy))).rejects.toThrow("NOT NULL")
    using db = new Database(repository.statePath, { readonly: true })
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 })
    expect(db.query("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: 1 })
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'upgrade_marker'").all()).toEqual([])
  } else {
    const database = await run(openStateDatabase(options.stateHome, true, policy))
    try {
      expect(database.db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 })
      expect(database.db.query("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: 3 })
      expect(database.db.query("SELECT value FROM upgrade_marker ORDER BY rowid").all()).toEqual([{ value: "upgraded" }, { value: "third" }])
    } finally { await database.close() }
  }
})

test("failed initial validation rolls back the ledger and leaves a pristine database", async () => {
  const options = await fixture()
  const folder = join(options.stateHome, "initial-migrations")
  await cp("src/infrastructure/metadata/migrations", folder, { recursive: true })
  const sqlPath = join(folder, "0000_initial.sql")
  await writeFile(sqlPath, (await readFile(sqlPath, "utf8")).replace("PRAGMA user_version = 1;", "PRAGMA user_version = 2;"))
  const policy: DatabaseSchemaPolicy = { version: 1, folder,
    migrations: readMigrationFiles({ migrationsFolder: folder }).map((entry) => ({ hash: entry.hash, when: entry.folderMillis })) }
  await expect(run(openStateDatabase(options.stateHome, false, policy))).rejects.toThrow("schema version")
  using db = new Database(databasePath(options.stateHome), { readonly: true })
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 0 })
  expect(db.query("PRAGMA application_id").get()).toEqual({ application_id: 0 })
  expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([])
  await run((await open(options)).close)
})

test("interrupted schema-lock waiting finalizes both descriptors", async () => {
  const options = await fixture()
  const waiting = Deferred.makeUnsafe<void>()
  const closed: string[] = []
  const platform: StateDatabasePlatform = { ...nativeStateDatabasePlatform,
    fileLocker: () => {
      const lock = nativeStateDatabasePlatform.fileLocker()
      return (fd, operation) => {
        if (operation === (1 | 4)) { Deferred.doneUnsafe(waiting, Effect.void); return false }
        return lock(fd, operation)
      }
    },
    openLock: async (path) => {
      const handle = await nativeStateDatabasePlatform.openLock(path)
      return { fd: handle.fd, close: async () => { await handle.close(); closed.push(path) } }
    },
  }
  await run(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(openStateDatabase(options.stateHome, false, undefined, platform))
    yield* Deferred.await(waiting)
    yield* Fiber.interrupt(fiber)
  }))
  expect(closed).toHaveLength(2)
  expect(closed.some((path) => path.endsWith("startup.lock"))).toBe(true)
  expect(closed.some((path) => path.endsWith("schema.lock"))).toBe(true)
  const database = await run(openStateDatabase(options.stateHome))
  await database.close()
})

test("failed schema-handle acquisition still finalizes the startup handle", async () => {
  const options = await fixture()
  let startupCloses = 0
  const platform: StateDatabasePlatform = { ...nativeStateDatabasePlatform,
    openLock: async (path) => {
      if (path.endsWith("schema.lock")) throw new Error("schema open failed")
      const handle = await nativeStateDatabasePlatform.openLock(path)
      return { fd: handle.fd, close: async () => { startupCloses++; await handle.close() } }
    },
  }
  await expect(run(openStateDatabase(options.stateHome, false, undefined, platform))).rejects.toThrow("schema open failed")
  expect(startupCloses).toBe(1)
})

test("startup failure retries database cleanup and retains the original failure", async () => {
  const options = await fixture(); const repository = await open(options); await run(repository.close)
  using invalid = new Database(repository.statePath)
  invalid.run("PRAGMA user_version = 99")
  let databaseCloses = 0; let gateCloses = 0
  const platform: StateDatabasePlatform = { ...nativeStateDatabasePlatform,
    connect: (path) => {
      const connected = nativeStateDatabasePlatform.connect(path)
      return { db: connected.db, close: () => { if (++databaseCloses === 1) throw new Error("close failure"); connected.close() } }
    },
    openLock: async (path) => {
      const handle = await nativeStateDatabasePlatform.openLock(path)
      return { fd: handle.fd, close: async () => { if (path.endsWith("schema.lock")) gateCloses++; await handle.close() } }
    },
  }
  const exit = await Effect.runPromiseExit(openStateDatabase(options.stateHome, true, undefined, platform))
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Failure") {
    const messages = exit.cause.reasons.map((reason) => reason._tag === "Fail" ? String(reason.error) : "")
    expect(messages.join("\n")).toContain("Unsupported state database schema 99")
    expect(messages.join("\n")).toContain("close failure")
  }
  expect(databaseCloses).toBe(2); expect(gateCloses).toBe(1)
})

for (const stage of ["startup", "schema"] as const) test(`slow ${stage} lock acquisition waits without a deadline and remains cancellable`, async () => {
  const options = await fixture(); await run((await open(options)).close)
  let blocked = true; let closes = 0
  const entered = Deferred.makeUnsafe<void>()
  const platform: StateDatabasePlatform = { ...nativeStateDatabasePlatform,
    fileLocker: () => {
      const lock = nativeStateDatabasePlatform.fileLocker()
      return (fd, operation) => {
        if (blocked && operation === (stage === "startup" ? 2 | 4 : 1 | 4)) {
          Deferred.doneUnsafe(entered, Effect.void); return false
        }
        return lock(fd, operation)
      }
    },
    openLock: async (path) => {
      const handle = await nativeStateDatabasePlatform.openLock(path)
      return { fd: handle.fd, close: async () => { await handle.close(); closes++ } }
    },
  }
  await run(Effect.gen(function*() {
    const pending = yield* Effect.forkChild(openStateDatabase(options.stateHome, true, undefined, platform))
    yield* Deferred.await(entered)
    yield* TestClock.adjust(120_000)
    expect(pending.pollUnsafe()).toBeUndefined()
    expect(closes).toBe(0)
    yield* Fiber.interrupt(pending)
    expect(closes).toBe(2)
    blocked = false
    const database = yield* openStateDatabase(options.stateHome, true, undefined, platform)
    yield* Effect.promise(database.close)
  }).pipe(Effect.provide(TestClock.layer())))
  expect(closes).toBe(4)
})

test("slow startup proceeds when contention clears rather than requiring a restart", async () => {
  const options = await fixture(); await run((await open(options)).close)
  let blocked = true
  const entered = Deferred.makeUnsafe<void>()
  const platform: StateDatabasePlatform = { ...nativeStateDatabasePlatform,
    fileLocker: () => {
      const lock = nativeStateDatabasePlatform.fileLocker()
      return (fd, operation) => {
        if (blocked && operation === (2 | 4)) { Deferred.doneUnsafe(entered, Effect.void); return false }
        return lock(fd, operation)
      }
    },
  }
  await run(Effect.gen(function*() {
    const pending = yield* Effect.forkChild(openStateDatabase(options.stateHome, true, undefined, platform))
    yield* Deferred.await(entered)
    yield* TestClock.adjust(120_000)
    expect(pending.pollUnsafe()).toBeUndefined()
    blocked = false
    yield* TestClock.adjust(10)
    const database = yield* Fiber.join(pending)
    yield* Effect.promise(database.close)
  }).pipe(Effect.provide(TestClock.layer())))
})

for (const code of ["SQLITE_BUSY", "SQLITE_LOCKED"]) test(`${code} retries past the old limit without partial writes and can be interrupted`, async () => {
  using db = new Database(":memory:")
  db.run("CREATE TABLE writes (value TEXT NOT NULL) STRICT")
  let blocked = true; let attempts = 0
  const entered = Deferred.makeUnsafe<void>()
  const write = sqliteTransaction(db, () => {
    attempts++
    db.query("INSERT INTO writes VALUES ('committed')").run()
    if (blocked) { Deferred.doneUnsafe(entered, Effect.void); throw Object.assign(new Error("contended"), { code }) }
    return "saved"
  })
  await run(Effect.gen(function*() {
    const cancelled = yield* Effect.forkChild(write)
    yield* Deferred.await(entered)
    yield* TestClock.adjust(120_000)
    expect(cancelled.pollUnsafe()).toBeUndefined()
    expect(attempts).toBeGreaterThan(100)
    expect(db.query("SELECT count(*) AS count FROM writes").get()).toEqual({ count: 0 })
    yield* Fiber.interrupt(cancelled)
    const before = attempts
    yield* TestClock.adjust(100)
    expect(attempts).toBe(before)
    const waiting = yield* Effect.forkChild(write)
    yield* TestClock.adjust(120_000)
    expect(waiting.pollUnsafe()).toBeUndefined()
    blocked = false
    yield* TestClock.adjust(10)
    expect(yield* Fiber.join(waiting)).toBe("saved")
    expect(db.query("SELECT count(*) AS count FROM writes").get()).toEqual({ count: 1 })
  }).pipe(Effect.provide(TestClock.layer())))
})

test("non-contention SQLite errors fail immediately rather than retrying forever", async () => {
  using db = new Database(":memory:")
  db.run("CREATE TABLE writes (value TEXT NOT NULL) STRICT")
  let attempts = 0
  await expect(run(sqliteTransaction(db, () => { attempts++; db.query("INSERT INTO writes VALUES (NULL)").run() }))).rejects.toThrow("NOT NULL")
  expect(attempts).toBe(1)
})

test("independent processes serialize metadata writes without losing relationships", async () => {
  const options = await fixture()
  const children = Array.from({ length: 4 }, (_, index) => Bun.spawn([process.execPath, "test/next/helpers/sqlite-process.ts", options.projectDirectory, options.stateHome, `process-${index}`], { stdout: "pipe", stderr: "pipe" }))
  for (const child of children) {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).toBe(""); expect(code).toBe(0)
  }
  const repository = await open(options)
  expect((await run(repository.loadMetadata)).relations).toHaveLength(80)
})

test("process death rolls back an uncommitted write and releases database and schema locks", async () => {
  const options = await fixture(); const repository = await open(options)
  await run(repository.saveRelation(relation("child")))
  const child = Bun.spawn([process.execPath, "test/next/helpers/sqlite-process.ts", options.projectDirectory, options.stateHome, "crash-holder", "crash"], { stdout: "pipe", stderr: "pipe" })
  try {
    const reader = child.stdout.getReader()
    const chunk = await reader.read()
    expect(new TextDecoder().decode(chunk.value)).toContain("transaction-held")
    reader.releaseLock()
  } finally { child.kill("SIGKILL"); await child.exited }
  expect((await run(repository.loadMetadata)).relations).toEqual([relation("child")])
  await run(repository.saveRelation({ ...relation("after-crash"), sharedMessages: [] }))
  await run(repository.close)
  const upgraded = await run(openStateDatabase(options.stateHome, true, await upgradePolicy(options)))
  await upgraded.close()
})
