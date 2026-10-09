import { createHash } from "node:crypto"
import { chmod, open, stat } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { Database } from "bun:sqlite"
import type { Statement } from "bun:sqlite"
import type { FileHandle } from "node:fs/promises"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { Effect } from "effect"

import { fileLocker } from "../session-guard"
import { isStandaloneExecutable } from "../worker-entry"
import { isErrorCode, nativePersistencePlatform } from "./platform"
import { createDirectoryDurably, syncDirectory } from "./storage"
import { backupDatabase } from "./backup"
import journal from "./migrations/meta/_journal.json" with { type: "json" }
import initialSql from "./migrations/0000_initial.sql" with { type: "text" }
import continuationSql from "./migrations/0001_lazy_continuations.sql" with { type: "text" }

export const DATABASE_VERSION = 2
export const DATABASE_APPLICATION_ID = 0x43545245
const LOCK_RETRY_INTERVAL_MS = 10
const migrationFolder = isStandaloneExecutable ? join(dirname(process.execPath), "migrations") : new URL("./migrations", import.meta.url).pathname
export const initialMigrationHash = createHash("sha256").update(initialSql).digest("hex")

export interface DatabaseSchemaPolicy {
  readonly version: number
  readonly folder: string
  readonly migrations: readonly { readonly hash: string; readonly when: number }[]
}
const schemaPolicy: DatabaseSchemaPolicy = { version: DATABASE_VERSION, folder: migrationFolder,
  migrations: [{ hash: initialMigrationHash, when: journal.entries[0]!.when },
    { hash: createHash("sha256").update(continuationSql).digest("hex"), when: journal.entries[1]!.when }] }

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
  let closed = false
  return { db, close: () => {
    if (closed) return
    const errors: unknown[] = []
    for (const [sql, statement] of statements) {
      try { statement.finalize(); statements.delete(sql) } catch (error) { errors.push(error) }
    }
    try { db.close(true); closed = true; statements.clear() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, "Unable to close state database")
  } }
}

export interface StateDatabasePlatform {
  readonly openLock: (path: string) => Promise<Pick<FileHandle, "fd" | "close">>
  readonly connect: (path: string) => { readonly db: Database; readonly close: () => void }
  readonly fileLocker: typeof fileLocker
}

export const nativeStateDatabasePlatform: StateDatabasePlatform = {
  openLock: (path) => open(path, "a", 0o600), connect: connection, fileLocker,
}

async function closeWithBackstop(close: () => Promise<void>): Promise<void> {
  try { await close() } catch (error) {
    try { await close() } catch (retryError) { throw new AggregateError([error, retryError], "State cleanup failed") }
    throw error
  }
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

export function openStateDatabase(stateHome: string, requireExisting = false, policy: DatabaseSchemaPolicy = schemaPolicy, platform: StateDatabasePlatform = nativeStateDatabasePlatform): Effect.Effect<StateDatabase, unknown> {
  return Effect.uninterruptible(Effect.gen(function*() {
    const path = databasePath(stateHome)
    const lock = platform.fileLocker()
    yield* createDirectoryDurably(nativePersistencePlatform, dirname(path))
    let db: Database | undefined
    let opened: ReturnType<StateDatabasePlatform["connect"]> | undefined
    let gate: Awaited<ReturnType<StateDatabasePlatform["openLock"]>> | undefined
    let closing: Promise<void> | undefined
    const release = async () => {
      if (opened) { opened.close(); opened = undefined }
      if (gate) { await gate.close(); gate = undefined }
    }
    const close = () => closing ??= release().finally(() => { closing = undefined })
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({ try: () => platform.openLock(`${path}.startup.lock`), catch: (e) => e }),
      (startup) => Effect.gen(function*() {
        const schemaGate = yield* Effect.tryPromise({ try: () => platform.openLock(`${path}.schema.lock`), catch: (e) => e })
        gate = schemaGate
        const acquire = Effect.gen(function*() {
          while (!lock(startup.fd, 2 | 4)) yield* Effect.sleep(LOCK_RETRY_INTERVAL_MS)
          while (!lock(schemaGate.fd, 1 | 4)) yield* Effect.sleep(LOCK_RETRY_INTERVAL_MS)
        })
        yield* Effect.interruptible(acquire)
        return yield* Effect.tryPromise({ try: async () => {
          let exists = true
          try { await stat(path) } catch (error) { if (isErrorCode(error, "ENOENT")) exists = false; else throw error }
          if (!exists && requireExisting) throw new Error("Provider state is missing")
          if (!exists) {
            try { const file = await open(path, "wx", 0o600); await file.close() }
            catch (e) { if (!isErrorCode(e, "EEXIST")) throw e }
          }
          opened = platform.connect(path)
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
            lock(schemaGate.fd, 8)
            if (!lock(schemaGate.fd, 2 | 4)) throw new Error("Exit other claude-tree invocations before upgrading the state schema")
            opened.close()
            opened = undefined
            opened = platform.connect(path)
            db = opened.db
            db.run("PRAGMA foreign_keys = ON")
            db.run("PRAGMA synchronous = FULL")
            const current = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
            const currentApplication = db.query<{ application_id: number }, []>("PRAGMA application_id").get()!.application_id
            if (current > 0 && currentApplication !== DATABASE_APPLICATION_ID) throw new Error("Not a claude-tree state database")
            if (current > policy.version) throw new Error(`Unsupported state database schema ${current}`)
            if (current > 0) validateMigrationHistory(db, policy, current)
            if (current < policy.version) {
              const migrations = readMigrationFiles({ migrationsFolder: policy.folder })
              if (migrations.length !== policy.version || migrations.length !== policy.migrations.length || migrations.some((entry, index) => entry.hash !== policy.migrations[index]?.hash || entry.folderMillis !== policy.migrations[index]?.when)) throw new Error("Packaged migrations do not match this application")
              if (current > 0) await backupDatabase(db, `${path}.before-v${policy.version}-${Date.now()}.sqlite`)
              applyMigrations(db, migrations, current, policy)
            }
            lock(schemaGate.fd, 1)
          }
          const migratedVersion = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
          if (migratedVersion !== policy.version) throw new Error("Migration did not atomically publish its schema version")
          validateMigrationHistory(db, policy)
          db.run("PRAGMA journal_mode = WAL")
          db.run("PRAGMA synchronous = FULL")
          await chmod(path, 0o600)
          await syncDirectory(nativePersistencePlatform, dirname(path))
          return { db, path, close }
        }, catch: (e) => e })
      }),
      (startup) => Effect.tryPromise({ try: () => closeWithBackstop(() => startup.close()), catch: (e) => e }),
    ).pipe(Effect.onExit((exit) => exit._tag === "Failure"
      ? Effect.tryPromise({ try: () => closeWithBackstop(close), catch: (e) => e }) : Effect.void))
  }))
}

function applyMigrations(db: Database, migrations: ReturnType<typeof readMigrationFiles>, current: number, policy: DatabaseSchemaPolicy): void {
  db.transaction(() => {
    db.run("CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)")
    for (let index = current; index < migrations.length; index++) {
      const migration = migrations[index]!
      for (const statement of migration.sql) if (statement.trim()) db.query(statement).run()
      db.query("INSERT INTO __drizzle_migrations (id, hash, created_at) VALUES (?, ?, ?)").run(index + 1, migration.hash, migration.folderMillis)
    }
    if (db.query<{ application_id: number }, []>("PRAGMA application_id").get()?.application_id !== DATABASE_APPLICATION_ID) throw new Error("Migration changed the database application identity")
    if (db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version !== policy.version) throw new Error("Migration did not atomically publish its schema version")
    if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Migration violated foreign key integrity")
    validateMigrationHistory(db, policy)
  }).immediate()
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
    while (true) {
      const result = yield* Effect.result(attempt)
      if (result._tag === "Success") return result.success
      const code = (result.failure as { code?: string })?.code
      if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") return yield* Effect.fail(result.failure)
      yield* Effect.sleep(LOCK_RETRY_INTERVAL_MS)
    }
  })
}
