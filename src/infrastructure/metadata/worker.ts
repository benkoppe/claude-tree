import { parentPort, workerData } from "node:worker_threads"
import { isDeepStrictEqual } from "node:util"
import { Cause, Effect, Queue } from "effect"
import { SessionRemovedError } from "../../domain/errors"

import { makeProviderStateRepository } from "../../services/provider-state-repository"
import { PersistencePlatform, nativePersistencePlatform } from "./platform"
import type { MetadataRequest, MetadataResponse, MetadataWorkerOptions, MetadataCommand } from "./worker-protocol"

const port = parentPort!
const options = workerData as MetadataWorkerOptions
const inbox = Effect.runSync(Queue.unbounded<MetadataRequest>())
const send = (message: MetadataResponse) => port.postMessage(message)
port.on("message", (message: MetadataRequest) => Effect.runSync(Queue.offer(inbox, message)))

const run = Effect.gen(function*() {
  const repository = yield* makeProviderStateRepository(options)
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
  yield* Effect.gen(function*() {
    while (true) {
      const request = yield* Queue.take(inbox)
      if (request._tag === "Close") return
      const result = yield* Effect.exit(command(request.command) as Effect.Effect<unknown, unknown>)
      if (result._tag === "Success") {
        if (request.command._tag === "ReplaceIdentity") navigationRevision++
        send({ _tag: "Completed", id: request.id, value: result.value as Extract<MetadataResponse, { _tag: "Completed" }>["value"] })
      }
      else { const error = Cause.squash(result.cause); send({ _tag: "Failed", id: request.id, message: error instanceof Error ? error.message : String(error),
        ...(error instanceof SessionRemovedError ? { removed: { providerId: error.providerId, sessionId: error.sessionId } } : {}) }) }
    }
  }).pipe(Effect.ensuring(repository.close.pipe(Effect.orDie)))
  send({ _tag: "Closed" })
}).pipe(Effect.provideService(PersistencePlatform, { ...nativePersistencePlatform, instanceId: options.instanceId }),
  Effect.catchCause((cause) => Effect.sync(() => { const error = Cause.squash(cause); send({ _tag: "Failed", id: null, message: error instanceof Error ? error.message : String(error) }) })))

Effect.runPromise(run).finally(() => { port.close() })
