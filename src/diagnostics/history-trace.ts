import { isDeepStrictEqual } from "node:util"

import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

import type { BuildInfo } from "../build-info"

export const MAX_TRACE_EVENTS = 2_000
const MAX_COMPARISONS = 16
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const session = z.string().regex(/^S[1-9][0-9]*$/)
const record = z.string().regex(/^R[1-9][0-9]*$/)
const stage = z.enum(["setup", "worker", "active-context", "session-info", "session-records", "ancestor-records", "projection", "sdk-reconstruction", "validation", "navigation-history"])
const failure = z.enum([
  "project-unavailable", "worker-failed", "diagnostic-timeout", "invalid-diagnostic-report", "cleanup-failed", "unexpected-failure",
  "timeout", "sdk-request-failed", "source-not-found", "permission-denied", "protocol-error", "missing-active-record", "missing-logical-parent", "cycle", "invalid-preservation",
  "ambiguous-preservation", "missing-preservation-source", "invalid-provenance", "active-record-mismatch", "system-anchor-missing",
])
const differences = z.enum(["type", "subtype", "message.id", "message.type", "message.role", "message.model", "message.content", "message.usage", "message.stop_reason", "message.stop_sequence", "attachment", "data", "compactMetadata", "other-payload", "comparison-unavailable"])
const failureSchema = z.object({ stage, code: failure, session: session.optional(), record: record.optional(), related_record: record.optional() }).strict()
const event = z.discriminatedUnion("event", [
  z.object({ event: z.literal("stage"), stage, session, state: z.enum(["started", "succeeded", "failed"]), count: count.optional(), code: failure.optional() }).strict(),
  z.object({ event: z.literal("projection"), attempt: count, state: z.enum(["started", "succeeded", "failed"]), selected: count.optional(), changed: z.boolean().optional(), code: failure.optional(), record: record.optional(), related_record: record.optional() }).strict(),
  z.object({ event: z.literal("versions"), record, record_session: session, session, source_record: record, kind: z.enum(["user", "assistant", "system", "attachment", "progress", "unknown"]), total: count, matched: count,
    comparisons: z.array(z.object({ index: count, payload_matches: z.boolean(), differences: z.array(differences) }).strict()).max(MAX_COMPARISONS), omitted_comparisons: count }).strict(),
  z.object({ event: z.literal("lineage"), record, session, state: z.enum(["origin", "end", "conflicting", "invalid", "cycle"]), next_session: session.optional() }).strict(),
  z.object({ event: z.literal("parent"), record, session, parent: record.nullable(), mapped_parent: record.nullable().optional(), decision: z.enum(["excluded-context", "excluded-context-head", "accepted", "unmapped", "omitted-progress", "cycle", "conflicting-aliases", "optional-evidence-unavailable"]) }).strict(),
  z.object({ event: z.literal("parent-search"), record, session, versions: count, before: count, after: count, state: z.enum(["complete", "failed"]) }).strict(),
  z.object({ event: z.literal("decision"), boundary: record, record, action: z.enum(["restore-parent", "no-parent", "conflicting-parents", "reconnect-continuation", "rewind-prefix", "context-placement", "conflicting-continuation", "required-error", "ignored-error"]), candidates: count.optional(), parent: record.nullable().optional() }).strict(),
])

export const HistoryDiagnosticReportSchema = z.object({
  format: z.literal("claude-tree/history-diagnostic-v1"),
  provider: z.literal("claude"),
  build: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/), revision: z.string().regex(/^[0-9a-f]{40}$/).nullable(), dirty: z.boolean().nullable(), source: z.enum(["embedded", "checkout", "unknown"]) }).strict(),
  outcome: z.enum(["Available", "Missing", "Unavailable"]),
  failure: failureSchema.nullable(),
  message_count: count.optional(),
  visible_message_count: count.optional(),
  events: z.array(event).max(MAX_TRACE_EVENTS),
  omitted_events: count,
}).strict()

export type HistoryDiagnosticReport = z.infer<typeof HistoryDiagnosticReportSchema>
export type HistoryStage = z.infer<typeof stage>
export type HistoryFailure = z.infer<typeof failure>
export const safeHistoryFailure = (value: unknown): HistoryFailure => {
  const parsed = failure.safeParse(value)
  return parsed.success ? parsed.data : "unexpected-failure"
}
type SafeEvent = z.infer<typeof event>
type SessionLabel = `S${number}`
type RecordLabel = `R${number}`

/** This collector never stores records, exception text, paths, or payload values
 * in its event buffer. Identity strings are confined to private alias indexes. */
export class HistoryTrace {
  private readonly sessions = new Map<string, SessionLabel>()
  private readonly records = new Map<string, RecordLabel>()
  private readonly events: SafeEvent[] = []
  private omitted = 0
  private firstFailure: HistoryDiagnosticReport["failure"] = null

  constructor(private readonly currentSession: string) { this.session(currentSession) }

  private session(id: string | null): SessionLabel {
    const key = id ?? this.currentSession
    let label = this.sessions.get(key)
    if (!label) this.sessions.set(key, label = `S${this.sessions.size + 1}`)
    return label
  }

  private record(id: string, scope: string | null = null): RecordLabel {
    const key = JSON.stringify([scope ?? this.currentSession, id])
    let label = this.records.get(key)
    if (!label) this.records.set(key, label = `R${this.records.size + 1}`)
    return label
  }

  private emit(value: SafeEvent): void {
    this.events.push(value)
  }

  private room(): boolean {
    if (this.events.length < MAX_TRACE_EVENTS) return true
    this.omitted++
    return false
  }

  fail(at: HistoryStage, code: HistoryFailure, sessionId?: string, recordId?: string, relatedId?: string): void {
    this.firstFailure ??= { stage: at, code,
      ...(sessionId === undefined ? {} : { session: this.session(sessionId) }),
      ...(recordId === undefined ? {} : { record: this.record(recordId) }),
      ...(relatedId === undefined ? {} : { related_record: this.record(relatedId) }),
    }
  }

  stage(at: HistoryStage, id: string, state: "started" | "succeeded" | "failed", amount?: number, code?: HistoryFailure): void {
    if (state === "failed") this.fail(at, code ?? "unexpected-failure", id)
    if (!this.room()) return
    this.emit({ event: "stage", stage: at, session: this.session(id), state,
      ...(amount === undefined ? {} : { count: amount }), ...(code === undefined ? {} : { code }) })
  }

  projection(attempt: number, state: "started" | "succeeded" | "failed", details: { selected?: number; changed?: boolean; code?: HistoryFailure; recordId?: string; relatedRecordId?: string } = {}): void {
    if (state === "failed" && details.code !== "missing-preservation-source") this.fail("projection", details.code ?? "unexpected-failure", undefined, details.recordId, details.relatedRecordId)
    if (!this.room()) return
    this.emit({ event: "projection", attempt, state,
      ...(details.selected === undefined ? {} : { selected: details.selected }),
      ...(details.changed === undefined ? {} : { changed: details.changed }),
      ...(details.code === undefined ? {} : { code: details.code }),
      ...(details.recordId === undefined ? {} : { record: this.record(details.recordId) }),
      ...(details.relatedRecordId === undefined ? {} : { related_record: this.record(details.relatedRecordId) }),
    })
  }

  versions(expected: SessionStoreEntry & { uuid: string }, scope: string | null, sourceId: string, all: readonly SessionStoreEntry[], matching: readonly SessionStoreEntry[], expectedScope: string | null = null): void {
    if (!this.room()) return
    const matched = new Set(matching)
    const kind = expected.type === "user" || expected.type === "assistant" || expected.type === "system" || expected.type === "attachment" || expected.type === "progress" ? expected.type : "unknown"
    this.emit({ event: "versions", record: this.record(expected.uuid, expectedScope), record_session: this.session(expectedScope), session: this.session(scope), source_record: this.record(sourceId, scope), kind,
      total: all.length, matched: matching.length,
      comparisons: all.slice(0, MAX_COMPARISONS).map((value, index) => ({ index, payload_matches: matched.has(value), differences: matched.has(value) ? [] : compareFields(expected, value) })),
      omitted_comparisons: Math.max(0, all.length - MAX_COMPARISONS),
    })
  }

  lineage(recordId: string, scope: string | null, state: Extract<SafeEvent, { event: "lineage" }>["state"], next?: string): void {
    if (!this.room()) return
    this.emit({ event: "lineage", record: this.record(recordId), session: this.session(scope), state, ...(next === undefined ? {} : { next_session: this.session(next) }) })
  }

  parent(recordId: string, scope: string | null, parentId: string | null, decision: Extract<SafeEvent, { event: "parent" }>["decision"], mapped?: string | null): void {
    if (!this.room()) return
    this.emit({ event: "parent", record: this.record(recordId), session: this.session(scope), parent: parentId === null ? null : this.record(parentId, scope), decision,
      ...(mapped === undefined ? {} : { mapped_parent: mapped === null ? null : this.record(mapped) }) })
  }

  search(recordId: string, scope: string | null, versions: number, before: number, after: number, state: "complete" | "failed"): void {
    if (!this.room()) return
    this.emit({ event: "parent-search", record: this.record(recordId), session: this.session(scope), versions, before, after, state })
  }

  decision(boundary: string, recordId: string, action: Extract<SafeEvent, { event: "decision" }>["action"], candidates?: number, parent?: string | null): void {
    if (!this.room()) return
    this.emit({ event: "decision", boundary: this.record(boundary), record: this.record(recordId), action,
      ...(candidates === undefined ? {} : { candidates }), ...(parent === undefined ? {} : { parent: parent === null ? null : this.record(parent) }) })
  }

  finish(build: BuildInfo, outcome: HistoryDiagnosticReport["outcome"], counts?: { messages: number; visible: number }): HistoryDiagnosticReport {
    return { format: "claude-tree/history-diagnostic-v1", provider: "claude", build, outcome,
      failure: outcome === "Unavailable" ? this.firstFailure ?? { stage: "worker", code: "unexpected-failure" } : null,
      ...(counts === undefined ? {} : { message_count: counts.messages, visible_message_count: counts.visible }),
      events: [...this.events], omitted_events: this.omitted }
  }
}

function compareFields(left: SessionStoreEntry, right: SessionStoreEntry): z.infer<typeof differences>[] {
  try {
    const result: z.infer<typeof differences>[] = []
    for (const key of ["type", "subtype", "attachment", "data", "compactMetadata"] as const) {
      if (!isDeepStrictEqual(left[key], right[key])) result.push(key)
    }
    const message = (entry: SessionStoreEntry): Record<string, unknown> => typeof entry.message === "object" && entry.message !== null ? entry.message as Record<string, unknown> : {}
    for (const key of ["id", "type", "role", "model", "content", "usage", "stop_reason", "stop_sequence"] as const) {
      if (!isDeepStrictEqual(message(left)[key], message(right)[key])) result.push(`message.${key}`)
    }
    return result.length ? result : ["other-payload"]
  } catch { return ["comparison-unavailable"] }
}
