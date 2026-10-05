import { isDeepStrictEqual } from "node:util"
import { Cause, Deferred, Effect, Queue } from "effect"

import { SessionRemovedError } from "../../domain/errors"
import { makeProviderStateRepository } from "../../services/provider-state-repository"
import type { MetadataCommand, MetadataRequest, MetadataResponse, MetadataWorkerOptions } from "./worker-protocol"
import type { PersistencePlatform } from "./platform"

export function runMetadataWorker(
  options: MetadataWorkerOptions,
  inbox: Queue.Queue<MetadataRequest>,
  closeRequested: Deferred.Deferred<void>,
  send: (response: MetadataResponse) => void,
  acquire: ReturnType<typeof makeProviderStateRepository> = makeProviderStateRepository(options),
): Effect.Effect<void, unknown, PersistencePlatform> {
  return Effect.scoped(Effect.gen(function*() {
    const startup = yield* Effect.exit(Effect.raceFirst(acquire,
      Deferred.await(closeRequested).pipe(Effect.andThen(Effect.interrupt))))
    if (startup._tag === "Failure") {
      if (Cause.hasInterruptsOnly(startup.cause) && Deferred.isDoneUnsafe(closeRequested)) return
      return yield* Effect.failCause(startup.cause)
    }
    const repository = startup.value
    let navigationRevision = 0
    send({ _tag: "Ready", location: { projectId: repository.projectId, scopeId: repository.scopeId, projectPath: repository.projectPath, statePath: repository.statePath, instanceId: repository.instanceId } })
    const command = (request: MetadataCommand) => {
      switch (request._tag) {
        case "Load": return repository.load
        case "SaveNavigation": return request.revision === navigationRevision ? repository.saveNavigation(request.navigation) : Effect.void
        case "SaveRelation": return repository.saveRelation(request.relation)
        case "RemoveRelation": return repository.removeExactRelation(request.relation)
        case "CommitRemoval": return repository.commitRemoval(request.removal, [])
        case "ReplaceIdentity": return repository.replaceIdentity(request.previous, request.actual, request.options)
        case "CompareMetadata": return repository.updateMetadata((current) => {
          if (!isDeepStrictEqual(current, request.before)) throw new Error("Metadata changed before the transaction was admitted")
          return request.after
        })
      }
    }
    while (true) {
      const request = yield* Queue.take(inbox)
      if (request._tag === "Close") { yield* repository.close; return }
      const result = yield* Effect.exit(command(request.command) as Effect.Effect<unknown, unknown>)
      if (result._tag === "Success") {
        if (request.command._tag === "ReplaceIdentity") navigationRevision++
        send({ _tag: "Completed", id: request.id, value: result.value as Extract<MetadataResponse, { _tag: "Completed" }>["value"] })
      } else {
        const error = Cause.squash(result.cause)
        send({ _tag: "Failed", id: request.id, message: error instanceof Error ? error.message : String(error),
          ...(error instanceof SessionRemovedError ? { removed: { providerId: error.providerId, sessionId: error.sessionId } } : {}) })
      }
    }
  })).pipe(Effect.andThen(Effect.sync(() => send({ _tag: "Closed" }))))
}
