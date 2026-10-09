import { resolve } from "node:path"
import { Effect } from "effect"

import type { CliOptions } from "../../cli-options"
import { makeProviderStateRepository } from "../../services/provider-state-repository"
import { canonicalizeAndValidate } from "../../services/legacy-provider-state"
import { databaseOrm, openStateDatabase } from "./database"
import { PersistencePlatform, nativePersistencePlatform } from "./platform"
import * as s from "./schema"
import { backupDatabase } from "./backup"

export function runStateCommand(options: Extract<CliOptions, { command: "state" }>): Effect.Effect<string, unknown> {
  if (options.action === "export" || options.action === "import-json") return Effect.acquireUseRelease(
    makeProviderStateRepository({ projectDirectory: options.project, providerId: options.provider, requireExisting: options.action === "export", importLegacy: options.action === "import-json" })
      .pipe(Effect.provideService(PersistencePlatform, nativePersistencePlatform)),
    (repository) => repository.load.pipe(Effect.map((state) => options.action === "export" ? JSON.stringify({ projectId: repository.projectId, projectPath: repository.projectPath, providerId: options.provider, ...state }, null, 2)
      : `Imported application metadata for ${repository.projectPath}. Legacy files were left untouched.`)),
    (repository) => repository.close)
  return Effect.acquireUseRelease(openStateDatabase(nativePersistencePlatform.stateHome(), true),
    ({ db }) => Effect.gen(function*() {
      if (options.action === "check") {
        yield* Effect.try({ try: () => {
          const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all()
          if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("SQLite integrity check failed")
          if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("SQLite foreign key check failed")
        }, catch: (e) => e })
        const orm = databaseOrm(db)
        // Validate every scope without requiring its project directory to still exist.
        const scopes = orm.select().from(s.scopes).all()
        for (const scope of scopes) {
          const project = orm.select().from(s.projects).all().find((entry) => entry.id === scope.projectId)!
          const status = yield* Effect.result(Effect.acquireUseRelease(makeProviderStateRepository({ projectDirectory: project.path, providerId: scope.providerId,
            requireExisting: true }).pipe(Effect.provideService(PersistencePlatform, { ...nativePersistencePlatform,
              realpath: async () => project.path })), (r) => r.load.pipe(Effect.map(canonicalizeAndValidate)), (r) => r.close))
          if (status._tag === "Failure") return yield* Effect.fail(status.failure)
        }
        return "State database integrity and metadata checks passed."
      }
      const destination = resolve(options.destination!)
      yield* Effect.tryPromise({ try: () => backupDatabase(db, destination), catch: (e) => e })
      return `State backup written to ${destination}.`
    }), ({ close }) => Effect.promise(close))
}
