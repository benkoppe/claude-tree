import { parentPort, workerData } from "node:worker_threads"

import { Cause, Deferred, Effect, Exit, Fiber, FiberSet } from "effect"

import type { AgentMessage, AgentSessionSnapshot, TranscriptRead } from "../../domain/model"
import { errorSummary } from "../../error-format"
import type { AgentProviderApi } from "../../services/provider"
import type { ProviderReadRequest, ProviderReadResponse, ProviderReadWorkerOptions } from "./read-worker-protocol"

const port = parentPort!
const options = workerData as ProviderReadWorkerOptions
const jobs = new Map<number, Fiber.Fiber<void, never>>()
const acknowledgments = new Map<string, Deferred.Deferred<void>>()
let closing = false
const drained = Deferred.makeUnsafe<void>()
const PROGRESS_CHARACTER_BUDGET = 1_000_000

// Provider-specific payloads remain inside this read boundary. Forks independently
// reread and validate their source; the actor consumes normalized history only.
function messageForActor(message: AgentMessage): AgentMessage {
  const { id, role, preview, ordinal, visible, text, displayGroupId, turnComplete, copyIdentity, historyBoundary, historical } = message
  return { id, role, preview, ordinal, visible,
    ...(text === undefined ? {} : { text }),
    ...(displayGroupId === undefined ? {} : { displayGroupId }),
    ...(turnComplete === undefined ? {} : { turnComplete }),
    ...(copyIdentity === undefined ? {} : { copyIdentity }),
    ...(historyBoundary === undefined ? {} : { historyBoundary }),
    ...(historical === undefined ? {} : { historical }),
  }
}

function snapshotForActor(snapshot: AgentSessionSnapshot): AgentSessionSnapshot {
  const normalized = new WeakMap<AgentMessage, AgentMessage>()
  const message = (value: AgentMessage) => {
    const previous = normalized.get(value)
    if (previous) return previous
    const result = messageForActor(value)
    normalized.set(value, result)
    return result
  }
  return { sessions: snapshot.sessions, transcripts: new Map([...snapshot.transcripts].map(([id, read]): [string, TranscriptRead] =>
    [id, read._tag !== "Available" ? read : { ...read, messages: read.messages.map(message),
      ...(read.context === undefined ? {} : { context: { ...read.context, messages: read.context.messages.map(message) } }),
    }])) }
}

function readCharacters(read: TranscriptRead): number {
  if (read._tag !== "Available") return 0
  const count = (messages: readonly AgentMessage[]) => messages.reduce((size, message) =>
    size + message.preview.length + (message.text?.length ?? 0) + (message.copyIdentity?.length ?? 0), 0)
  return count(read.messages) + count(read.context?.messages ?? [])
}

function send(message: ProviderReadResponse): void {
  port.postMessage(message)
}

function finishClose(): void {
  if (!closing || jobs.size > 0) return
  Deferred.doneUnsafe(drained, Effect.void)
}

const makeProvider = Effect.gen(function*(): Effect.gen.Return<AgentProviderApi, unknown> {
  if (options.providerId === "codex") {
    const { createCodexProvider } = yield* Effect.promise(() => import("./codex/provider"))
    return yield* createCodexProvider(options.projectPath)
  }
  const { ClaudeProvider } = yield* Effect.promise(() => import("./claude/provider"))
  return new ClaudeProvider(options.projectPath)
})

const run = Effect.scoped(Effect.gen(function*() {
  const provider = yield* makeProvider
  const runJob = yield* FiberSet.makeRuntime<never, void, never>()
  port.on("message", (request: ProviderReadRequest) => {
    if (request._tag === "Acknowledged") {
      const key = `${request.id}:${request.sequence}`
      const reply = acknowledgments.get(key)
      if (reply) Deferred.doneUnsafe(reply, Effect.void)
      return
    }
    if (request._tag === "Cancel") {
      jobs.get(request.id)?.interruptUnsafe()
      return
    }
    if (request._tag === "Close") {
      closing = true
      for (const job of jobs.values()) job.interruptUnsafe()
      finishClose()
      return
    }
    if (closing) { send({ _tag: "Failed", id: request.id, message: "Provider read worker is closing" }); return }
    let sequence = 0
    const sendProgress = (snapshot: AgentSessionSnapshot) => Effect.gen(function*() {
      const current = ++sequence
      const key = `${request.id}:${current}`
      const reply = yield* Deferred.make<void>()
      acknowledgments.set(key, reply)
      yield* Effect.sync(() => send({ _tag: "Progress", id: request.id, sequence: current, snapshot: snapshotForActor(snapshot) }))
      yield* Deferred.await(reply).pipe(Effect.ensuring(Effect.sync(() => acknowledgments.delete(key))))
    })
    const publish = (snapshot: AgentSessionSnapshot) => Effect.gen(function*() {
      let sessions = snapshot.sessions
      let batch = new Map<string, TranscriptRead>()
      let characters = 0
      for (const [id, read] of snapshot.transcripts) {
        const size = readCharacters(read)
        if (batch.size > 0 && characters + size > PROGRESS_CHARACTER_BUDGET) {
          yield* sendProgress({ sessions, transcripts: batch })
          sessions = []
          batch = new Map()
          characters = 0
        }
        batch.set(id, read)
        characters += size
      }
      if (batch.size || sessions.length || snapshot.transcripts.size === 0) yield* sendProgress({ sessions, transcripts: batch })
    })
    const publishedIds = new Set<string>()
    // Record successful batches without retaining another copy of their payloads.
    const progressivePublish = (snapshot: AgentSessionSnapshot) => publish(snapshot).pipe(Effect.tap(() => Effect.sync(() => {
      for (const id of snapshot.transcripts.keys()) publishedIds.add(id)
    })))
    const operation = request.transcriptsOnly
      ? provider.readTranscripts(request.sessionIds ?? []).pipe(Effect.flatMap((transcripts) => publish({ sessions: [], transcripts })))
      : request.sessionIds === undefined
      ? provider.loadSessionSnapshotProgressively!(progressivePublish).pipe(Effect.flatMap((snapshot) => {
          const remaining = new Map([...snapshot.transcripts].filter(([id]) => !publishedIds.has(id)))
          return remaining.size ? publish({ sessions: [], transcripts: remaining }) : Effect.void
        }))
      : provider.loadSessionSnapshotFor(request.sessionIds).pipe(Effect.flatMap(publish))
    const fiber = runJob(Effect.yieldNow.pipe(Effect.andThen(operation), Effect.onExit((exit) => Effect.sync(() => {
      jobs.delete(request.id)
      if (Exit.isSuccess(exit)) send({ _tag: "Completed", id: request.id })
      else send({ _tag: "Failed", id: request.id, message: errorSummary(Cause.squash(exit.cause)) })
      finishClose()
    })), Effect.exit, Effect.asVoid))
    jobs.set(request.id, fiber)
  })
  send({ _tag: "Ready" })
  yield* Deferred.await(drained)
}))
Effect.runPromise(run).then(() => { send({ _tag: "Closed" }); port.close() }, (cause) => { throw cause })
