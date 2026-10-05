import { Deferred, Effect, Exit, type Scope } from "effect"

import { ClaudeProvider } from "../infrastructure/providers/claude/provider"
import type { HistoryDiagnosticJob } from "./history-protocol"
import { HistoryTrace, type HistoryDiagnosticReport } from "./history-trace"

export function readHistoryDiagnostic(job: HistoryDiagnosticJob): Effect.Effect<HistoryDiagnosticReport> {
  return Effect.gen(function*() {
    const trace = new HistoryTrace(job.sessionId)
    const provider = new ClaudeProvider(job.projectPath)
    const result = yield* Effect.exit(provider.readTranscripts([job.sessionId], trace))
    if (Exit.isFailure(result)) {
      trace.fail("worker", "unexpected-failure")
      return trace.finish(job.build, "Unavailable")
    }
    const read = result.value.get(job.sessionId)
    if (!read) trace.fail("worker", "unexpected-failure")
    return trace.finish(job.build, read?._tag === "Available" && read.coverage ? "Limited" : read?._tag ?? "Unavailable", read?._tag === "Available"
      ? { messages: read.messages.length, visible: read.messages.filter((message) => message.visible).length } : undefined)
  })
}

/** Report delivery follows scoped finalization; cancellation also waits for it. */
export function runHistoryProcess(
  job: Deferred.Deferred<HistoryDiagnosticJob>,
  cancelled: Deferred.Deferred<void>,
  send: (report: HistoryDiagnosticReport) => Effect.Effect<void, unknown>,
  read: (job: HistoryDiagnosticJob) => Effect.Effect<HistoryDiagnosticReport, unknown, Scope.Scope> = readHistoryDiagnostic,
): Effect.Effect<void> {
  return Effect.gen(function*() {
    const result = yield* Effect.exit(Effect.raceFirst(
      Deferred.await(job).pipe(Effect.flatMap((job) => Effect.scoped(read(job)))),
      Deferred.await(cancelled).pipe(Effect.andThen(Effect.interrupt)),
    ))
    if (Exit.isSuccess(result) && !Deferred.isDoneUnsafe(cancelled)) {
      yield* send(result.value).pipe(Effect.catchCause(() => Effect.void))
    }
  })
}
