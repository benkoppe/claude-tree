import { Deferred, Effect } from "effect"

import { HistoryProcessRequestSchema, type HistoryDiagnosticJob } from "./history-protocol"
import { runHistoryProcess } from "./history-runtime"

const job = Deferred.makeUnsafe<HistoryDiagnosticJob>()
const cancelled = Deferred.makeUnsafe<void>()
const cancel = () => { Deferred.doneUnsafe(cancelled, Effect.void) }
const receive = (value: unknown) => {
  const parsed = HistoryProcessRequestSchema.safeParse(value)
  if (!parsed.success) { cancel(); return }
  if (parsed.data._tag === "Cancel") cancel()
  else if (Deferred.isDoneUnsafe(job)) cancel()
  else Deferred.doneUnsafe(job, Effect.succeed(parsed.data.job))
}

process.on("message", receive)
process.on("disconnect", cancel)
process.on("SIGTERM", cancel)
process.on("SIGINT", cancel)
if (!process.connected) cancel()

void Effect.runPromise(runHistoryProcess(job, cancelled, (report) => Effect.tryPromise({
  try: () => new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) { reject(); return }
    process.send(report, (error) => error ? reject(error) : resolve())
  }), catch: () => undefined,
}))).finally(() => {
  process.off("message", receive)
  process.off("disconnect", cancel)
  process.off("SIGTERM", cancel)
  process.off("SIGINT", cancel)
  if (process.connected) process.disconnect?.()
})
