import { Worker } from "node:worker_threads"

import { Deferred, Effect, Exit, Queue, Scope } from "effect"
import { workerEntry } from "../worker-entry"
import { makeCloseOperation } from "../../services/close-operation"
import { withOperationTimeout } from "../../services/operation-deadline"

import { ProviderError } from "../../domain/errors"
import type { AgentSession, AgentSessionSnapshot, TranscriptRead } from "../../domain/model"
import type { AgentProviderApi } from "../../services/provider"
import type { ProviderReadRequest, ProviderReadResponse, ProviderReadWorkerOptions } from "./read-worker-protocol"

type ReadDelivery = Extract<ProviderReadResponse, { readonly _tag: "Progress" | "Completed" }>

/** Read-only jobs never acquire terminal ownership or perform provider mutations. */
export interface ProviderReads {
  readonly loadSnapshot: (sessionIds?: readonly string[], publish?: (snapshot: AgentSessionSnapshot) => Effect.Effect<void>) => Effect.Effect<AgentSessionSnapshot, ProviderError>
  readonly readTranscripts: AgentProviderApi["readTranscripts"]
  readonly close: Effect.Effect<void, ProviderError>
}

export function makeProviderReads(
  options: ProviderReadWorkerOptions,
  createWorker: () => Worker = () => new Worker(workerEntry(new URL("./read-worker.ts", import.meta.url), "src/infrastructure/providers/read-worker.ts"), { workerData: options }),
  closeTimeoutMs?: number,
): Effect.Effect<ProviderReads, ProviderError, Scope.Scope> {
  return Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
    const ready = yield* Deferred.make<void, ProviderError>()
    const exited = yield* Deferred.make<void, ProviderError>()
    const pending = new Map<number, { readonly queue: Queue.Queue<ReadDelivery>; readonly failure: Deferred.Deferred<never, ProviderError> }>()
    let nextId = 1
    let closing = false
    let drained = false
    let failed: ProviderError | undefined
    const error = (message: string) => new ProviderError({ providerId: options.providerId, operation: "provider read worker", message })
    const fail = (failure: ProviderError) => {
      failed ??= failure
      Deferred.doneUnsafe(ready, Effect.fail(failed))
      for (const job of pending.values()) Deferred.doneUnsafe(job.failure, Effect.fail(failed))
    }
    const worker = yield* Effect.try({ try: createWorker, catch: (cause) => error(String(cause)) })
    worker.on("message", (message: ProviderReadResponse) => {
      if (message._tag === "Ready") Deferred.doneUnsafe(ready, Effect.void)
      else if (message._tag === "Closed") {
        drained = true
        void worker.terminate().catch((cause) => {
          const failure = error(String(cause))
          fail(failure)
          Deferred.doneUnsafe(exited, Effect.fail(failure))
        })
      }
      else {
        const job = pending.get(message.id)
        if (!job) return
        if (message._tag === "Failed") Deferred.doneUnsafe(job.failure, Effect.fail(error(message.message)))
        else Queue.offerUnsafe(job.queue, message)
      }
    })
    worker.on("error", (cause: unknown) => fail(error(cause instanceof Error ? cause.message : String(cause))))
    worker.on("exit", (code) => {
      if (!failed && (!closing || !drained)) fail(error(`Provider read worker exited unexpectedly (${code})`))
      Deferred.doneUnsafe(exited, failed ? Effect.fail(failed) : Effect.void)
    })
    const post = (message: ProviderReadRequest) => Effect.try({
      try: () => worker.postMessage(message), catch: (cause) => error(String(cause)),
    })
    const close = withOperationTimeout(makeCloseOperation(Effect.suspend(() => {
      if (closing) return Deferred.await(exited)
      closing = true
      for (const job of pending.values()) Deferred.doneUnsafe(job.failure, Effect.fail(error("Provider read worker is closing")))
      return post({ _tag: "Close" }).pipe(Effect.tapError((failure) => Effect.sync(() => fail(failure))), Effect.andThen(Deferred.await(exited)))
    })), closeTimeoutMs, () => Effect.fail(error("Provider read worker did not finish closing"))).pipe(
      Effect.onError(() => Effect.sync(() => worker.unref())))
    yield* Effect.addFinalizer(() => close.pipe(Effect.catch((failure) => Effect.logError(failure))))
    yield* restore(Deferred.await(ready))
    const requestSnapshot = (sessionIds?: readonly string[], publish?: (snapshot: AgentSessionSnapshot) => Effect.Effect<void>, transcriptsOnly = false) => Effect.gen(function*() {
      if (closing || failed) return yield* Effect.fail(failed ?? error("Provider read worker is closing"))
      const id = nextId++
      const queue = yield* Queue.unbounded<ReadDelivery>()
      const failure = yield* Deferred.make<never, ProviderError>()
      pending.set(id, { queue, failure })
      let sessions: readonly AgentSession[] = []
      const transcripts = new Map<string, TranscriptRead>()
      const operation = Effect.gen(function*() {
        yield* post({ _tag: "Read", id, ...(sessionIds === undefined ? {} : { sessionIds }), ...(transcriptsOnly ? { transcriptsOnly: true } : {}) })
        while (true) {
          const message = yield* Queue.take(queue)
          if (message._tag === "Completed") return { sessions, transcripts }
          if (message.snapshot.sessions.length) sessions = message.snapshot.sessions
          for (const [id, read] of message.snapshot.transcripts) transcripts.set(id, read)
          if (publish) yield* publish(message.snapshot)
          yield* post({ _tag: "Acknowledged", id, sequence: message.sequence })
        }
      })
      return yield* Effect.raceFirst(operation, Deferred.await(failure)).pipe(Effect.onExit((exit) => Effect.gen(function*() {
        pending.delete(id)
        if (Exit.isFailure(exit) && !closing && !failed) yield* post({ _tag: "Cancel", id }).pipe(Effect.catch(() => Effect.void))
      })))
    })
    return { loadSnapshot: requestSnapshot, readTranscripts: (ids) => requestSnapshot(ids, undefined, true).pipe(Effect.map((snapshot) => snapshot.transcripts)), close }
  }))
}

export function withProviderReads(provider: AgentProviderApi, reads: ProviderReads): AgentProviderApi {
  const remember = (snapshot: AgentSessionSnapshot) => Effect.sync(() => provider.observeSessionSummaries?.(snapshot.sessions))
  const load = (ids?: readonly string[]) => reads.loadSnapshot(ids).pipe(Effect.tap(remember))
  return {
    id: provider.id, displayName: provider.displayName, capabilities: provider.capabilities,
    ...(provider.takeBranchMutationReconciliation === undefined ? {} : { takeBranchMutationReconciliation: provider.takeBranchMutationReconciliation }),
    loadSessionSnapshot: load(),
    loadSessionSnapshotProgressively: (publish) => reads.loadSnapshot(undefined, (snapshot) => remember(snapshot).pipe(Effect.andThen(publish(snapshot)))),
    loadSessionSnapshotFor: (ids) => load(ids),
    readTranscripts: reads.readTranscripts,
    prepareNewSession: provider.prepareNewSession,
    prepareResume: (session) => provider.prepareResume(session),
    branchFrom: (target, created) => provider.branchFrom(target, created),
  }
}
