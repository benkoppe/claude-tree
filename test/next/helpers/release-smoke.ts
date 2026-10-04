import { Effect } from "effect"
import { join } from "node:path"

import { makeMetadataWorker } from "../../../src/infrastructure/metadata/worker-service"
import { makeProviderReads } from "../../../src/infrastructure/providers/read-service"
import { makeProjectionService } from "../../../src/infrastructure/projection/service"
import { makeInitialApplicationState } from "../../../src/application/state"
import { makeSessionGuard } from "../../../src/infrastructure/session-guard"
import { SessionOwnedError } from "../../../src/domain/errors"

const projectDirectory = process.argv[2]!
await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const guard = makeSessionGuard(join(projectDirectory, "session-guards"), "claude")
  const claim = yield* guard.acquire("compiled-session")
  yield* Effect.gen(function*() {
    const conflict = yield* Effect.flip(guard.acquire("compiled-session"))
    if (!(conflict instanceof SessionOwnedError)) throw new Error("Compiled session guard did not detect ownership")
  }).pipe(Effect.ensuring(claim.release.pipe(Effect.orDie)))
  const metadata = yield* makeMetadataWorker({ projectDirectory, providerId: "claude", instanceId: "compiled-smoke" })
  yield* metadata.saveNavigation({ view: "terminal", sessionId: "example" })
  const loaded = yield* metadata.loadMetadata
  if (loaded.navigation?.view !== "terminal") throw new Error("Compiled metadata worker lost navigation")
  const reads = yield* makeProviderReads({ providerId: "claude", projectPath: projectDirectory })
  const snapshot = yield* reads.loadSnapshot()
  if (snapshot.sessions.length) throw new Error("Release smoke fixture must have no provider sessions")
  const projection = yield* makeProjectionService()
  yield* projection.prepare(makeInitialApplicationState({ relations: [], removals: [] }))
  yield* projection.close; yield* reads.close; yield* metadata.close
})))
console.log("Compiled workers passed")
