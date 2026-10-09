import { expect, test } from "bun:test"
import { mkdir, mkdtemp, open, rm } from "node:fs/promises"
import { join } from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"

import { makeSqliteRepository } from "../../src/infrastructure/metadata/sqlite-repository"
import { openStateDatabase, nativeStateDatabasePlatform } from "../../src/infrastructure/metadata/database"
import { PersistencePlatform, nativePersistencePlatform } from "../../src/infrastructure/metadata/platform"

for (const stage of ["references", "defect", "interruption"] as const) {
  test(`repository ${stage} during initialization closes its database before returning`, async () => {
    const directory = await mkdtemp("/tmp/opencode/sqlite-acquisition-")
    const project = join(directory, "project")
    await mkdir(project)
    let closes = 0
    const failure = new Error("initialization failed")
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const repository = makeSqliteRepository({ projectDirectory: project, providerId: "claude", stateHome: directory },
          (...args) => openStateDatabase(...args).pipe(Effect.map((database) => {
            const close = async () => { closes++; await database.close() }
            if (stage === "defect") return { path: database.path, close, get db(): typeof database.db { throw failure } }
            const query = database.db.query.bind(database.db)
            database.db.query = ((sql: string) => {
              if (stage === "references" && sql.startsWith("select") && sql.includes('"session_refs"')) throw failure
              return query(sql)
            }) as typeof database.db.query
            if (stage === "interruption") {
              // A cooperative interruption requested at acquisition's handoff must not leak it.
              Deferred.doneUnsafe(entered, Effect.void)
            }
            return { ...database, close }
          })))
        const acquisition = yield* Effect.forkChild(Effect.exit(stage === "interruption"
          ? repository.pipe(Effect.onExit(() => Effect.void)) : repository))
        if (stage === "interruption") { yield* Deferred.await(entered); acquisition.interruptUnsafe() }
        const outer = yield* Fiber.await(acquisition)
        const exit: Exit.Exit<unknown, unknown> = Exit.isSuccess(outer) ? outer.value : outer
        expect(Exit.isFailure(exit)).toBeTrue()
        if (stage === "defect" && Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure)
        expect(closes).toBe(1)
        const gate = yield* Effect.promise(() => open(join(directory, "claude-tree", "state.sqlite.schema.lock"), "a"))
        try { expect(nativeStateDatabasePlatform.fileLocker()(gate.fd, 2 | 4)).toBeTrue() }
        finally { yield* Effect.promise(() => gate.close()) }
      }).pipe(Effect.provideService(PersistencePlatform, nativePersistencePlatform))))
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}
