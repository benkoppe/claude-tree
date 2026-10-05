import { Worker } from "node:worker_threads"

import { Deferred, Effect, Scope } from "effect"
import { workerEntry } from "../worker-entry"
import { makeCloseOperation } from "../../services/close-operation"
import { withOperationTimeout } from "../../services/operation-deadline"

import { prepareForest } from "../../application/forest-projection"
import { selectProjectedData, selectProjectedRelations, selectVisibleEndpointSessionIds } from "../../application/selectors"
import type { ApplicationState } from "../../application/state"
import { cacheGraphLayout } from "../../application/view-model"
import type { ProjectionRequest, ProjectionResponse } from "./protocol"


export interface ProjectionService {
  readonly prepare: (state: ApplicationState) => Effect.Effect<void, unknown>
  readonly close: Effect.Effect<void, unknown>
}

export function makeProjectionService(
  createWorker: () => Worker = () => new Worker(workerEntry(new URL("./worker.ts", import.meta.url), "src/infrastructure/projection/worker.ts")),
  closeTimeoutMs?: number,
): Effect.Effect<ProjectionService, unknown, Scope.Scope> {
  return Effect.uninterruptible(Effect.gen(function*() {
    const pending = new Map<number, Deferred.Deferred<Extract<ProjectionResponse, { _tag: "Projected" }>, Error>>()
    let nextId = 1
    let closing: Promise<number> | undefined
    let failure: Error | undefined
    const fail = (cause: unknown) => {
      failure ??= cause instanceof Error ? cause : new Error(String(cause))
      for (const reply of pending.values()) Deferred.doneUnsafe(reply, Effect.fail(failure))
      pending.clear()
    }
    const worker = yield* Effect.try({ try: createWorker, catch: (cause) => cause })
    worker.on("error", fail)
    worker.on("exit", (code) => { if (!closing) fail(new Error(`Projection worker exited unexpectedly (${code})`)) })
    worker.on("message", (response: ProjectionResponse) => {
      const reply = pending.get(response.id)
      if (!reply) return
      pending.delete(response.id)
      Deferred.doneUnsafe(reply, response._tag === "Projected" ? Effect.succeed(response) : Effect.fail(new Error(response.message)))
    })
    const close = withOperationTimeout(makeCloseOperation(Effect.tryPromise({ try: () => {
      // Pure computation: no provider mutation, persistence lock, or terminal resource.
      if (!closing) { fail(new Error("Projection worker is closing")); closing = worker.terminate() }
      return closing.then(() => {})
    }, catch: (cause) => cause })), closeTimeoutMs, () => Effect.fail(new Error("Projection worker did not finish closing"))).pipe(
      Effect.onError(() => Effect.sync(() => worker.unref())))
    yield* Effect.addFinalizer(() => close.pipe(Effect.catch((cause) => Effect.logError(cause))))
    return {
      close,
      prepare: (state) => Effect.suspend(() => {
        const data = selectProjectedData(state)
        const visible = selectVisibleEndpointSessionIds(state)
        return prepareForest({ sessions: [...data.sessions.values()], transcripts: data.transcripts,
          relations: selectProjectedRelations(state), removals: state.removals }, (input) => Effect.gen(function*() {
            if (failure || closing) return yield* Effect.fail(failure ?? new Error("Projection worker is closing"))
            const id = nextId++
            const reply = yield* Deferred.make<Extract<ProjectionResponse, { _tag: "Projected" }>, Error>()
            pending.set(id, reply)
            const request: ProjectionRequest = { id, input, visible }
            const response = yield* Effect.try({ try: () => worker.postMessage(request), catch: (cause) => cause }).pipe(
              Effect.andThen(Deferred.await(reply)), Effect.ensuring(Effect.sync(() => pending.delete(id))),
            )
            for (const graph of response.forest.graphs) {
              const layout = response.layouts.get(graph.rootSessionId)
              if (layout) cacheGraphLayout(graph, visible, layout)
            }
            return response.forest
          }))
      }),
    }
  }))
}
