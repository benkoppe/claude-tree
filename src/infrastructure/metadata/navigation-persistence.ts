import { Worker } from "node:worker_threads"

import { Deferred, Effect, Scope } from "effect"

import type { NavigationMetadataFacet } from "../../application/navigation-writer"
import { PersistenceError } from "../../domain/errors"
import type { NavigationWorkerOptions, NavigationWorkerRequest, NavigationWorkerResponse } from "./navigation-protocol"

export const NAVIGATION_WORKER_STARTUP_TIMEOUT_MS = 5_000
export const NAVIGATION_WORKER_CLOSE_TIMEOUT_MS = 1_000

export interface NavigationPersistence extends NavigationMetadataFacet {
  readonly close: Effect.Effect<void, PersistenceError>
}

/** Only navigation commands cross the worker boundary; the unified transaction stays intact. */
export function makeNavigationPersistenceWorker(
  options: NavigationWorkerOptions,
  createWorker: () => Worker = () => new Worker(new URL("./navigation-worker.ts", import.meta.url), { workerData: options }),
): Effect.Effect<NavigationPersistence, PersistenceError, Scope.Scope> {
  return Effect.gen(function*() {
    const error = (message: string) => new PersistenceError({ operation: "navigation worker", path: options.projectDirectory, message })
    const ready = Deferred.makeUnsafe<void, PersistenceError>()
    const exited = Deferred.makeUnsafe<void, PersistenceError>()
    const pending = new Map<number, Deferred.Deferred<void, PersistenceError>>()
    let nextId = 1
    let closing = false
    let drained = false
    let failed: PersistenceError | undefined
    const fail = (failure: PersistenceError) => {
      failed = failure
      Deferred.doneUnsafe(ready, Effect.fail(failure))
      for (const reply of pending.values()) Deferred.doneUnsafe(reply, Effect.fail(failure))
      pending.clear()
    }
    const worker = yield* Effect.try({
      try: createWorker,
      catch: (cause) => error(String(cause)),
    })
    worker.on("message", (message: NavigationWorkerResponse) => {
      if (message._tag === "Ready") Deferred.doneUnsafe(ready, Effect.void)
      else if (message._tag === "Closed") {
        drained = true
        // Termination is safe only after the worker has finished every transaction.
        void worker.terminate().catch((cause) => {
          const failure = error(String(cause))
          fail(failure)
          Deferred.doneUnsafe(exited, Effect.fail(failure))
        })
      }
      else if (message._tag === "Failed" && message.id === null) fail(new PersistenceError({ operation: message.operation, path: message.path, message: message.message }))
      else {
        const reply = message.id === null ? undefined : pending.get(message.id)
        if (!reply) return
        pending.delete(message.id!)
        Deferred.doneUnsafe(reply, message._tag === "Saved" ? Effect.void : Effect.fail(new PersistenceError({ operation: message.operation, path: message.path, message: message.message })))
      }
    })
    worker.on("error", (cause) => fail(error(cause instanceof Error ? cause.message : String(cause))))
    worker.on("exit", (code) => {
      if (!failed && (!closing || (!drained && code !== 0) || pending.size > 0)) fail(error(`Navigation worker exited unexpectedly (${code})`))
      Deferred.doneUnsafe(exited, failed ? Effect.fail(failed) : Effect.void)
    })
    const post = (request: NavigationWorkerRequest) => Effect.try({
      try: () => worker.postMessage(request), catch: (cause) => error(String(cause)),
    })
    const close = Effect.suspend(() => {
      if (closing) return Deferred.await(exited)
      closing = true
      return post({ _tag: "Close" }).pipe(Effect.andThen(Deferred.await(exited)))
    }).pipe(Effect.timeoutOrElse({ duration: NAVIGATION_WORKER_CLOSE_TIMEOUT_MS, orElse: () => Effect.fail(error("Navigation worker did not finish closing")) }),
      Effect.onError(() => Effect.sync(() => worker.unref())))
    yield* Effect.addFinalizer(() => close.pipe(Effect.catch((failure) => Effect.logError(failure))))
    yield* Deferred.await(ready).pipe(Effect.timeoutOrElse({
      duration: NAVIGATION_WORKER_STARTUP_TIMEOUT_MS, orElse: () => Effect.fail(error("Navigation worker did not become ready")),
    }))
    return {
      saveNavigation: (navigation) => Effect.gen(function*() {
        if (failed || closing) return yield* Effect.fail(failed ?? error("Navigation worker is closing"))
        const id = nextId++
        const reply = Deferred.makeUnsafe<void, PersistenceError>()
        pending.set(id, reply)
        yield* post({ _tag: "Save", id, navigation }).pipe(Effect.tapError((failure) => Effect.sync(() => fail(failure))))
        // Interruption stops waiting, not an admitted transaction that may already hold the lock.
        yield* Deferred.await(reply)
      }),
      close,
    }
  })
}
