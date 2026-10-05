import { z } from "zod"

import { HistoryDiagnosticReportSchema } from "./history-trace"

export const HistoryDiagnosticJobSchema = z.object({
  projectPath: z.string().min(1),
  sessionId: z.string().min(1),
  build: HistoryDiagnosticReportSchema.shape.build,
}).strict()

export const HistoryProcessRequestSchema = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("Execute"), job: HistoryDiagnosticJobSchema }).strict(),
  z.object({ _tag: z.literal("Cancel") }).strict(),
])

export type HistoryDiagnosticJob = z.infer<typeof HistoryDiagnosticJobSchema>
export type HistoryProcessRequest = z.infer<typeof HistoryProcessRequestSchema>
