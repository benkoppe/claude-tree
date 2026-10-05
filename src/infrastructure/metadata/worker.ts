import { parentPort, workerData } from "node:worker_threads"
import { Cause, Deferred, Effect, Queue } from "effect"

import { PersistencePlatform, nativePersistencePlatform } from "./platform"
import { runMetadataWorker } from "./worker-runtime"
import type { MetadataRequest, MetadataResponse, MetadataWorkerOptions } from "./worker-protocol"

const port = parentPort!
const options = workerData as MetadataWorkerOptions
const inbox = Effect.runSync(Queue.unbounded<MetadataRequest>())
const closeRequested = Deferred.makeUnsafe<void>()
const send = (message: MetadataResponse) => port.postMessage(message)
port.on("message", (message: MetadataRequest) => {
  if (message._tag === "Close") Deferred.doneUnsafe(closeRequested, Effect.void)
  Queue.offerUnsafe(inbox, message)
})

const run = runMetadataWorker(options, inbox, closeRequested, send).pipe(
  Effect.provideService(PersistencePlatform, { ...nativePersistencePlatform, instanceId: options.instanceId }),
  Effect.catchCause((cause) => Effect.sync(() => {
    const error = Cause.squash(cause)
    send({ _tag: "Failed", id: null, message: error instanceof Error ? error.message : String(error) })
    // The scoped runtime has settled, including rollback/finalizers. No admitted
    // command remains; preserve Failed while allowing the parent to reap us.
    send({ _tag: "Closed" })
  })),
)
Effect.runPromise(run).finally(() => { port.close() })
