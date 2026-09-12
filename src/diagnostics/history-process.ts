import { Effect } from "effect"

import type { BuildInfo } from "../build-info"
import { ClaudeProvider } from "../infrastructure/providers/claude/provider"
import { HistoryTrace } from "./history-trace"

export interface HistoryDiagnosticJob {
  readonly projectPath: string
  readonly sessionId: string
  readonly build: BuildInfo
}

process.once("message", (value) => {
  const job = value as HistoryDiagnosticJob
  const trace = new HistoryTrace(job.sessionId)
  const provider = new ClaudeProvider(job.projectPath)
  const send = (report: ReturnType<HistoryTrace["finish"]>) => {
    process.send?.(report, () => { if (process.connected) process.disconnect?.() })
  }
  // The same public read operation used by refresh. No application runtime,
  // repository, terminal supervisor, or provider mutation is acquired here.
  Effect.runPromise(provider.readTranscripts([job.sessionId], trace)).then((reads) => {
    const read = reads.get(job.sessionId)
    if (!read) trace.fail("worker", "unexpected-failure")
    send(trace.finish(job.build, read?._tag ?? "Unavailable", read?._tag === "Available"
      ? { messages: read.messages.length, visible: read.messages.filter((message) => message.visible).length } : undefined))
  }, () => {
    trace.fail("worker", "unexpected-failure")
    send(trace.finish(job.build, "Unavailable"))
  })
})
