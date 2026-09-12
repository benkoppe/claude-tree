import { parentPort, workerData } from "node:worker_threads"

import { Cause, Effect, Exit, Queue } from "effect"

import { makeProviderStateRepository } from "../../services/provider-state-repository"
import { PersistencePlatform, nativePersistencePlatform } from "./platform"
import type { NavigationWorkerOptions, NavigationWorkerRequest, NavigationWorkerResponse } from "./navigation-protocol"

const port = parentPort!
const options = workerData as NavigationWorkerOptions
const inbox = Effect.runSync(Queue.unbounded<NavigationWorkerRequest>())
const send = (response: NavigationWorkerResponse) => port.postMessage(response)
port.on("message", (message: NavigationWorkerRequest) => Queue.offerUnsafe(inbox, message))

const run = Effect.gen(function*() {
  const repository = yield* makeProviderStateRepository({ ...options, requireExisting: true })
  send({ _tag: "Ready" })
  while (true) {
    const request = yield* Queue.take(inbox)
    if (request._tag === "Close") return
    const exit = yield* Effect.exit(repository.saveNavigation(request.navigation))
    if (Exit.isSuccess(exit)) send({ _tag: "Saved", id: request.id })
    else {
      const error = Cause.squash(exit.cause)
      send({ _tag: "Failed", id: request.id, operation: "save navigation", path: repository.statePath,
        message: error instanceof Error ? error.message : String(error) })
    }
  }
}).pipe(
  Effect.provideService(PersistencePlatform, { ...nativePersistencePlatform, instanceId: options.instanceId }),
  Effect.catchCause((cause) => Effect.sync(() => {
    send({ _tag: "Failed", id: null, operation: "navigation worker", path: options.projectDirectory,
      message: String(Cause.squash(cause)) })
  })),
  Effect.ensuring(Effect.sync(() => {
    send({ _tag: "Closed" })
    port.close()
  })),
)

void Effect.runPromise(run)
