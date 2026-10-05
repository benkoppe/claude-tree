import { randomUUID } from "node:crypto"
import { Worker } from "node:worker_threads"
import { Deferred, Effect, Scope } from "effect"
import { workerEntry } from "../worker-entry"
import { makeCloseOperation } from "../../services/close-operation"
import { withOperationTimeout } from "../../services/operation-deadline"

import { PersistenceError, SessionRemovedError } from "../../domain/errors"
import type { ProviderState, ProjectState } from "../../domain/persistence"
import type { ProviderStateRepositoryApi, ProviderStateRepositoryOptions } from "../../services/provider-state-repository"
import type { MetadataCommand, MetadataLocation, MetadataRequest, MetadataResponse } from "./worker-protocol"

type Result = Extract<MetadataResponse, { _tag: "Completed" }>["value"]

export function makeMetadataWorker(options: ProviderStateRepositoryOptions,
  createWorker: (options: ProviderStateRepositoryOptions & { instanceId: string }) => Worker = (data) => new Worker(workerEntry(new URL("./worker.ts", import.meta.url), "src/infrastructure/metadata/worker.ts"), { workerData: data }),
  closeTimeoutMs?: number,
): Effect.Effect<ProviderStateRepositoryApi, PersistenceError, Scope.Scope> {
  return Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
    const instanceId = options.instanceId ?? randomUUID()
    const ready = Deferred.makeUnsafe<MetadataLocation, PersistenceError>()
    const exited = Deferred.makeUnsafe<void, PersistenceError>()
    const pending = new Map<number, Deferred.Deferred<Result, PersistenceError | SessionRemovedError>>()
    let nextId = 1
    let navigationRevision = 0
    const transitions = new Set<number>()
    let closing = false
    let drained = false
    let failed: PersistenceError | undefined
    const error = (message: string) => new PersistenceError({ operation: "metadata worker", path: options.projectDirectory, message })
    const fail = (failure: PersistenceError) => {
      failed ??= failure; Deferred.doneUnsafe(ready, Effect.fail(failed))
      for (const reply of pending.values()) Deferred.doneUnsafe(reply, Effect.fail(failed))
      pending.clear()
    }
    const worker = yield* Effect.try({ try: () => createWorker({ ...options, instanceId }), catch: (e) => error(String(e)) })
    worker.on("message", (message: MetadataResponse) => {
      if (message._tag === "Ready") Deferred.doneUnsafe(ready, Effect.succeed(message.location))
      else if (message._tag === "Closed") {
        drained = true
        void worker.terminate().catch((e) => { fail(error(String(e))); Deferred.doneUnsafe(exited, Effect.fail(failed!)) })
      } else if (message._tag === "Failed" && message.id === null) fail(error(message.message))
      else {
        const reply = pending.get(message.id!)
        if (!reply) return
        pending.delete(message.id!)
        if (transitions.delete(message.id!) && message._tag === "Completed") navigationRevision++
        Deferred.doneUnsafe(reply, message._tag === "Completed" ? Effect.succeed(message.value) : Effect.fail(message.removed
          ? new SessionRemovedError({ ...message.removed, message: message.message }) : error(message.message)))
      }
    })
    worker.on("error", (e) => fail(error(String(e))))
    worker.on("exit", (code) => {
      if (!failed && (!closing || !drained || pending.size)) fail(error(`Metadata worker exited unexpectedly (${code})`))
      Deferred.doneUnsafe(exited, failed ? Effect.fail(failed) : Effect.void)
    })
    const post = (request: MetadataRequest) => Effect.try({ try: () => worker.postMessage(request), catch: (e) => error(String(e)) })
    const close = withOperationTimeout(makeCloseOperation(Effect.suspend(() => {
      if (closing || Deferred.isDoneUnsafe(exited)) return Deferred.await(exited)
      closing = true
      return post({ _tag: "Close" }).pipe(Effect.tapError((e) => Effect.sync(() => fail(e))), Effect.andThen(Deferred.await(exited)))
    })), closeTimeoutMs, () => Effect.fail(error("Metadata worker did not finish closing; admitted commands may still commit"))).pipe(
      Effect.tapError(() => Effect.sync(() => worker.unref())))
    yield* Effect.addFinalizer(() => close.pipe(Effect.catch((e) => Effect.logError(e))))
    const location = yield* restore(Deferred.await(ready))
    const request = <A extends Result>(command: MetadataCommand): Effect.Effect<A, PersistenceError> => Effect.gen(function*() {
      if (closing || failed) return yield* Effect.fail(failed ?? error("Metadata worker is closing"))
      const id = nextId++; const reply = Deferred.makeUnsafe<Result, PersistenceError | SessionRemovedError>(); pending.set(id, reply)
      if (command._tag === "ReplaceIdentity") transitions.add(id)
      yield* post({ _tag: "Command", id, command }).pipe(Effect.tapError((e) => Effect.sync(() => fail(e))))
      return (yield* Deferred.await(reply).pipe(Effect.mapError((failure) => failure instanceof SessionRemovedError ? new PersistenceError({ operation: "metadata worker", path: options.projectDirectory, message: failure.message, cause: failure }) : failure))) as A
    })
    const load = request<ProviderState>({ _tag: "Load" })
    const loadMetadata = load.pipe(Effect.map((state): ProjectState => ({ relations: state.relations, removals: state.removals,
      ...(state.navigations.find((entry) => entry.instanceId === instanceId)?.navigation ? { navigation: state.navigations.find((entry) => entry.instanceId === instanceId)!.navigation } : {}) })))
    return { ...location, close, load, loadMetadata,
      saveNavigation: (navigation) => request({ _tag: "SaveNavigation", navigation, revision: navigationRevision }),
      saveRelation: (relation) => request({ _tag: "SaveRelation", relation }),
      removeExactRelation: (relation) => request({ _tag: "RemoveRelation", relation }),
      commitRemoval: (removal) => request({ _tag: "CommitRemoval", removal }),
      replaceIdentity: (previous, actual, transition) => request<undefined>({ _tag: "ReplaceIdentity", previous, actual, options: transition }).pipe(
        Effect.catch((failure): Effect.Effect<never, PersistenceError | SessionRemovedError> => failure.cause instanceof SessionRemovedError ? Effect.fail(failure.cause) : Effect.fail(failure))),
      updateMetadata: (transform) => Effect.gen(function*() {
        const before = yield* loadMetadata
        const after = yield* Effect.try({ try: () => transform(before), catch: (e) => error(String(e)) })
        return yield* request<ProjectState>({ _tag: "CompareMetadata", before, after })
      }),
    }
  }))
}
