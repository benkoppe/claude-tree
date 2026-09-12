import { fork, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"

import { Deferred, Effect } from "effect"

import { readBuildInfo, type BuildInfo } from "../build-info"
import { resolveProjectDirectory, type CliOptions } from "../cli-options"
import { HistoryDiagnosticReportSchema, HistoryTrace, type HistoryDiagnosticReport, type HistoryFailure } from "./history-trace"
import type { HistoryDiagnosticJob } from "./history-process"

export const HISTORY_DIAGNOSTIC_TIMEOUT_MS = 30_000
const WORKER_CLOSE_TIMEOUT_MS = 1_000

export function diagnosticFailure(build: BuildInfo, code: HistoryFailure): HistoryDiagnosticReport {
  const trace = new HistoryTrace("diagnostic")
  trace.fail(code === "project-unavailable" ? "setup" : "worker", code)
  return trace.finish(build, "Unavailable")
}

export function runHistoryWorker(
  job: HistoryDiagnosticJob,
  createWorker: () => ChildProcess = () => fork(fileURLToPath(new URL("./history-process.ts", import.meta.url)), [], {
    execPath: process.execPath, stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, DEBUG: "", DEBUG_CLAUDE_AGENT_SDK: "" },
  }),
): Effect.Effect<HistoryDiagnosticReport> {
  return Effect.scoped(Effect.gen(function*() {
    const reply = yield* Deferred.make<HistoryDiagnosticReport, HistoryFailure>()
    let closing: Promise<void> | undefined
    const close = (worker: ChildProcess) => Effect.suspend(() => Effect.tryPromise({
      try: () => closing ??= new Promise<void>((resolve, reject) => {
        if (worker.exitCode !== null || worker.signalCode !== null) { resolve(); return }
        const clean = () => { worker.off("exit", exited); worker.off("error", failed) }
        const exited = () => { clean(); resolve() }
        const failed = () => { clean(); reject() }
        worker.once("exit", exited)
        worker.once("error", failed)
        // This child owns only read operations and IPC, never persistence locks.
        try { worker.kill("SIGKILL") } catch { failed() }
      }), catch: () => "cleanup-failed" as const,
    })).pipe(Effect.timeoutOrElse({
      duration: WORKER_CLOSE_TIMEOUT_MS, orElse: () => Effect.fail("cleanup-failed" as const),
    }), Effect.tapError(() => Effect.sync(() => { worker.unref(); worker.channel?.unref() })))
    const worker = yield* Effect.acquireRelease(Effect.try({ try: () => {
      const worker = createWorker()
      worker.on("error", () => Deferred.doneUnsafe(reply, Effect.fail("worker-failed")))
      worker.on("exit", () => Deferred.doneUnsafe(reply, Effect.fail("worker-failed")))
      worker.on("message", (value: unknown) => {
        try {
          const parsed = HistoryDiagnosticReportSchema.safeParse(value)
          Deferred.doneUnsafe(reply, parsed.success ? Effect.succeed(parsed.data) : Effect.fail("invalid-diagnostic-report"))
        } catch { Deferred.doneUnsafe(reply, Effect.fail("invalid-diagnostic-report")) }
      })
      return worker
    }, catch: () => "worker-failed" as const }), (worker) => close(worker).pipe(Effect.catch(() => Effect.void)))
    yield* Effect.sync(() => {
      try { worker.send(job, (error) => { if (error) Deferred.doneUnsafe(reply, Effect.fail("worker-failed")) }) }
      catch { Deferred.doneUnsafe(reply, Effect.fail("worker-failed")) }
    })
    const result = yield* Deferred.await(reply).pipe(Effect.timeoutOrElse({
      duration: HISTORY_DIAGNOSTIC_TIMEOUT_MS, orElse: () => Effect.fail("diagnostic-timeout" as const),
    }), Effect.catch((code) => Effect.succeed(diagnosticFailure(job.build, code))))
    const closed = yield* close(worker).pipe(Effect.result)
    return closed._tag === "Failure" ? diagnosticFailure(job.build, closed.failure) : result
  })).pipe(Effect.catch(() => Effect.succeed(diagnosticFailure(job.build, "worker-failed"))))
}

export function runHistoryDiagnostic(options: Extract<CliOptions, { command: "diagnose-history" }>): Effect.Effect<HistoryDiagnosticReport> {
  return Effect.gen(function*() {
    const build = yield* readBuildInfo
    const project = yield* Effect.tryPromise({ try: () => resolveProjectDirectory(options.project), catch: () => undefined }).pipe(Effect.result)
    if (project._tag === "Failure") return diagnosticFailure(build, "project-unavailable")
    return yield* runHistoryWorker({ sessionId: options.sessionId, projectPath: project.success, build })
  })
}
