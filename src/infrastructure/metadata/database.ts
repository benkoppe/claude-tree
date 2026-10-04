import { createHash } from "node:crypto"
import { chmod, open, stat } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { Database } from "bun:sqlite"
import type { Statement } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { Effect } from "effect"

import { fileLocker } from "../session-guard"
import { isStandaloneExecutable } from "../worker-entry"
import { isErrorCode, nativePersistencePlatform } from "./platform"
import { createDirectoryDurably, syncDirectory } from "./storage"
import journal from "./migrations/meta/_journal.json" with { type: "json" }
import initialSql from "./migrations/0000_initial.sql" with { type: "text" }

export const DATABASE_VERSION = 1
export const DATABASE_APPLICATION_ID = 0x43545245
const migrationFolder = isStandaloneExecutable ? join(dirname(process.execPath), "migrations") : new URL("./migrations", import.meta.url).pathname
export const initialMigrationHash = createHash("sha256").update(initialSql).digest("hex")

export interface DatabaseSchemaPolicy {
  readonly version: number
  readonly folder: string
  readonly migrations: readonly { readonly hash: string; readonly when: number }[]
}
const schemaPolicy: DatabaseSchemaPolicy = { version: DATABASE_VERSION, folder: migrationFolder,
  migrations: [{ hash: initialMigrationHash, when: journal.entries[0]!.when }] }

/** Drizzle's prepare() statements otherwise outlive close() on the pinned Bun runtime. */
export function databaseOrm(db: Database) {
  return drizzle(new Proxy(db, { get(target, property) {
    if (property === "prepare") return target.query.bind(target)
    const value = Reflect.get(target, property, target)
    return typeof value === "function" ? value.bind(target) : value
  } }))
}

function connection(path: string) {
  const db = new Database(path, { strict: true, create: false })
  const statements = new Map<string, Statement>()
  const prepare = db.prepare.bind(db)
  const query = (sql: string) => {
    let statement = statements.get(sql)
    if (statement) statements.delete(sql)
    else statement = prepare(sql)
    statements.set(sql, statement)
    if (statements.size > 128) {
      const oldest = statements.entries().next().value!
      oldest[1].finalize(); statements.delete(oldest[0])
    }
    return statement
  }
  db.query = query as Database["query"]
  return { db, close: () => {
    for (const statement of statements.values()) statement.finalize()
    statements.clear()
    db.close(true)
  } }
}

export interface StateDatabase {
  readonly db: Database
  readonly path: string
  readonly close: () => Promise<void>
}

export function databasePath(stateHome: string): string {
  if (!isAbsolute(stateHome)) throw new Error("XDG state directory must be an absolute path")
  return join(stateHome, "claude-tree", "state.sqlite")
}

export function openStateDatabase(stateHome: string, requireExisting = false, policy: DatabaseSchemaPolicy = schemaPolicy): Effect.Effect<StateDatabase, unknown> {
  return Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
    const path = databasePath(stateHome)
    const lock = fileLocker()
    yield* createDirectoryDurably(nativePersistencePlatform, dirname(path))
    const startup = yield* Effect.tryPromise({ try: () => open(`${path}.startup.lock`, "a", 0o600), catch: (e) => e })
    const gateResult = yield* Effect.exit(Effect.tryPromise({ try: () => open(`${path}.schema.lock`, "a", 0o600), catch: (e) => e }))
    if (gateResult._tag === "Failure") { yield* Effect.promise(() => startup.close()); return yield* Effect.failCause(gateResult.cause) }
    const gate = gateResult.value
    let db: Database | undefined
    let opened: ReturnType<typeof connection> | undefined
    let closed = false
    const close = async () => { if (closed) return; opened?.close(); closed = true; await gate.close() }
    const acquire = Effect.gen(function*() {
      while (!lock(startup.fd, 2 | 4)) yield* Effect.sleep(10)
      while (!lock(gate.fd, 1 | 4)) yield* Effect.sleep(10)
    }).pipe(Effect.timeoutOrElse({ duration: 2_000, orElse: () => Effect.fail(new Error("State schema is being upgraded; retry after other invocations exit")) }))
    const result = yield* Effect.exit(restore(acquire).pipe(Effect.andThen(Effect.tryPromise({ try: async () => {
      let exists = true
      try { await stat(path) } catch (error) { if (isErrorCode(error, "ENOENT")) exists = false; else throw error }
      if (!exists && requireExisting) throw new Error("Provider state is missing")
      if (!exists) {
        try { const file = await open(path, "wx", 0o600); await file.close() }
        catch (e) { if (!isErrorCode(e, "EEXIST")) throw e }
      }
      opened = connection(path)
      db = opened.db
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
      const application = db.query<{ application_id: number }, []>("PRAGMA application_id").get()!.application_id
      const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
      const pristine = version === 0 && application === 0 && tables.length === 0
      if (!pristine && application !== DATABASE_APPLICATION_ID) throw new Error("Not a claude-tree state database; existing file was left untouched")
      if (version > policy.version || (!pristine && version < 1)) throw new Error(`Unsupported state database schema ${version}`)
      if (!pristine) validateMigrationHistory(db, policy, version)
      db.run("PRAGMA foreign_keys = ON")
      db.run("PRAGMA busy_timeout = 0")
      if (version < policy.version) {
        lock(gate.fd, 8)
        if (!lock(gate.fd, 2 | 4)) throw new Error("Exit other claude-tree invocations before upgrading the state schema")
        // Reopen after acquiring exclusivity: another startup may have initialized it.
        opened.close()
        opened = connection(path)
        db = opened.db
        db.run("PRAGMA foreign_keys = ON")
        const current = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
        const currentApplication = db.query<{ application_id: number }, []>("PRAGMA application_id").get()!.application_id
        if (current > 0 && currentApplication !== DATABASE_APPLICATION_ID) throw new Error("Not a claude-tree state database")
        if (current > policy.version) throw new Error(`Unsupported state database schema ${current}`)
        if (current > 0) validateMigrationHistory(db, policy, current)
        if (current < policy.version) {
          const migrations = readMigrationFiles({ migrationsFolder: policy.folder })
          if (migrations.length !== policy.migrations.length || migrations.some((entry, index) => entry.hash !== policy.migrations[index]?.hash || entry.folderMillis !== policy.migrations[index]?.when)) throw new Error("Packaged migrations do not match this application")
          if (current > 0) {
            const backup = `${path}.before-v${policy.version}-${Date.now()}.sqlite`
            const handle = await open(backup, "wx", 0o600); await handle.close()
            db.query("VACUUM INTO ?").run(backup)
            const durable = await open(backup, "r"); try { await durable.sync() } finally { await durable.close() }
            await syncDirectory(nativePersistencePlatform, dirname(backup))
          }
          migrate(databaseOrm(db), { migrationsFolder: policy.folder })
          if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Migration violated foreign key integrity")
        }
        lock(gate.fd, 1)
      }
      const migratedVersion = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
      if (migratedVersion !== policy.version) throw new Error("Migration did not atomically publish its schema version")
      validateMigrationHistory(db, policy)
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA synchronous = FULL")
      await chmod(path, 0o600)
      await syncDirectory(nativePersistencePlatform, dirname(path))
      return { db, path, close }
    }, catch: (e) => e }))))
    yield* Effect.promise(() => startup.close())
    if (result._tag === "Failure") { yield* Effect.promise(close); return yield* Effect.failCause(result.cause) }
    return result.value
  }))
}

export function validateMigrationHistory(db: Database, policy: DatabaseSchemaPolicy = schemaPolicy, version = policy.version): void {
  const rows = db.query<{ hash: string; created_at: number }, []>("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id").all()
  if (rows.length !== version || rows.some((row, index) => row.hash !== policy.migrations[index]?.hash || Number(row.created_at) !== policy.migrations[index]?.when)) {
    throw new Error("State migration history does not match this application; existing state was left untouched")
  }
}

export function sqliteTransaction<A>(db: Database, run: () => A): Effect.Effect<A, unknown> {
  const attempt = Effect.try({ try: () => db.transaction(run).immediate(), catch: (e) => e })
  return Effect.gen(function*() {
    for (let tries = 0; ; tries++) {
      const result = yield* Effect.result(attempt)
      if (result._tag === "Success") return result.success
      const code = (result.failure as { code?: string })?.code
      if ((code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") || tries >= 100) return yield* Effect.fail(result.failure)
      yield* Effect.sleep(10)
    }
  })
}
