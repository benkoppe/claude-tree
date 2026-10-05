import { fork, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import { Deferred, Effect } from "effect"

import { readBuildInfo, type BuildInfo } from "../build-info"
import { resolveProjectDirectory, type CliOptions } from "../cli-options"
import { optionalOperationTimeout, withOperationTimeout } from "../services/operation-deadline"
import { makeCloseOperation } from "../services/close-operation"
import { PROCESS_TERMINATION_GRACE_PERIOD_MS } from "../services/lifecycle-policy"
import { HistoryDiagnosticReportSchema, HistoryTrace, type HistoryDiagnosticReport, type HistoryFailure } from "./history-trace"
import type { HistoryDiagnosticJob, HistoryProcessRequest } from "./history-protocol"
import { isStandaloneExecutable } from "../infrastructure/worker-entry"

export function diagnosticFailure(build: BuildInfo, code: HistoryFailure): HistoryDiagnosticReport {
  const trace = new HistoryTrace("diagnostic")
  trace.fail(code === "project-unavailable" ? "setup" : "worker", code)
  return trace.finish(build, "Unavailable")
}

export function runHistoryWorker(
  job: HistoryDiagnosticJob,
  createWorker: () => ChildProcess = () => fork(fileURLToPath(new URL("./history-process.ts", import.meta.url)), [], {
    execPath: isStandaloneExecutable ? join(dirname(process.execPath), "claude-tree-history") : process.execPath, stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, DEBUG: "", DEBUG_CLAUDE_AGENT_SDK: "" },
  }),
  executionTimeoutMs?: number,
  cleanupTimeoutMs?: number,
): Effect.Effect<HistoryDiagnosticReport> {
  return Effect.scoped(Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
    yield* Effect.sync(() => {
      optionalOperationTimeout(executionTimeoutMs)
      optionalOperationTimeout(cleanupTimeoutMs)
    })
    const reply = yield* Deferred.make<HistoryDiagnosticReport, HistoryFailure>()
    const exited = yield* Deferred.make<void>()
    let reported = false
    let close: Effect.Effect<void, HistoryFailure> = Effect.void
    const worker = yield* Effect.acquireRelease(Effect.try({ try: createWorker,
      catch: () => "worker-failed" as const }), () => close.pipe(Effect.catch(() => Effect.void)))
    const failed = () => { Deferred.doneUnsafe(reply, Effect.fail("worker-failed")) }
    const exit = () => { Deferred.doneUnsafe(exited, Effect.void) }
    const disconnected = () => { failed() }
    const closed = () => {
      // A failed spawn has no process whose exit event could arrive.
      if (worker.pid === undefined) exit()
      failed()
    }
    const message = (value: unknown) => {
      if (Deferred.isDoneUnsafe(reply)) return
      try {
        const parsed = HistoryDiagnosticReportSchema.safeParse(value)
        if (parsed.success) reported = true
        Deferred.doneUnsafe(reply, parsed.success ? Effect.succeed(parsed.data) : Effect.fail("invalid-diagnostic-report"))
      } catch { Deferred.doneUnsafe(reply, Effect.fail("invalid-diagnostic-report")) }
    }
    worker.on("error", failed)
    worker.on("exit", exit)
    worker.on("close", closed)
    worker.on("disconnect", disconnected)
    worker.on("message", message)
    if (worker.exitCode !== null || worker.signalCode !== null) exit()
    const send = (request: HistoryProcessRequest) => Effect.sync(() => {
      try { worker.send(request, (error) => { if (error) failed() }) }
      catch { failed() }
    })
    const awaitExit = Deferred.await(exited)
    const grace = Effect.interruptible(awaitExit).pipe(Effect.as(true), Effect.timeoutOrElse({
      duration: PROCESS_TERMINATION_GRACE_PERIOD_MS, orElse: () => Effect.succeed(false),
    }))
    const finalize = makeCloseOperation(Effect.gen(function*() {
      const signalFailures: unknown[] = []
      if (!Deferred.isDoneUnsafe(exited)) {
        if (!reported) yield* send({ _tag: "Cancel" })
        let stopped = yield* grace
        for (const signal of ["SIGTERM", "SIGKILL"] as const) {
          if (stopped) break
          yield* Effect.sync(() => { try { worker.kill(signal) } catch (cause) { signalFailures.push(cause) } })
          if (signal === "SIGTERM") stopped = yield* grace
        }
        yield* awaitExit
      }
      if (signalFailures.length) return yield* Effect.fail(new AggregateError(signalFailures, "Unable to signal diagnostic child"))
    }).pipe(Effect.ensuring(Effect.sync(() => {
      worker.off("error", failed)
      worker.off("exit", exit)
      worker.off("close", closed)
      worker.off("disconnect", disconnected)
      worker.off("message", message)
    }))))
    close = makeCloseOperation(withOperationTimeout(Effect.interruptible(finalize), cleanupTimeoutMs,
      () => Effect.fail(new Error("Diagnostic child exit remains unconfirmed"))).pipe(
      Effect.tapError(() => Effect.sync(() => { worker.unref(); worker.channel?.unref() })),
    )).pipe(Effect.mapError(() => "cleanup-failed" as const))
    yield* send({ _tag: "Execute", job })
    const result = yield* restore(withOperationTimeout(Deferred.await(reply), executionTimeoutMs,
      () => Effect.fail("diagnostic-timeout" as const)).pipe(
      Effect.catch((code) => Effect.succeed(diagnosticFailure(job.build, code))),
    ))
    const cleanup = yield* close.pipe(Effect.result)
    return cleanup._tag === "Failure" ? diagnosticFailure(job.build, cleanup.failure) : result
  }))).pipe(Effect.catch(() => Effect.succeed(diagnosticFailure(job.build, "worker-failed"))))
}

export function runHistoryDiagnostic(options: Extract<CliOptions, { command: "diagnose-history" }>): Effect.Effect<HistoryDiagnosticReport> {
  return Effect.gen(function*() {
    const build = yield* readBuildInfo
    const project = yield* Effect.tryPromise({ try: () => resolveProjectDirectory(options.project), catch: () => undefined }).pipe(Effect.result)
    if (project._tag === "Failure") return diagnosticFailure(build, "project-unavailable")
    return yield* runHistoryWorker({ sessionId: options.sessionId, projectPath: project.success, build })
  })
}
