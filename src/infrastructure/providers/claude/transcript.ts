import type { SessionMessage, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"
import type { AgentMessage } from "../../../domain/model"

export interface ClaudeMessage extends AgentMessage {
  readonly sourceType: "user" | "assistant" | "system"
  readonly rawMessage: unknown
  readonly replayText?: string
}

const LOCAL_COMMAND_INVOCATION_PATTERN =
  /^<command-name>.*?<\/command-name>(?:\s*<command-message>.*?<\/command-message>)?(?:\s*<command-args>.*?<\/command-args>)?$/s
const LOCAL_COMMAND_OUTPUT_PATTERN = /^<local-command-(stdout|stderr|caveat)>.*<\/local-command-\1>$/s
const NO_RESPONSE_REQUESTED = "No response requested."

export function normalizeTranscript(sessionId: string, messages: readonly SessionMessage[]): readonly ClaudeMessage[] {
  if (!Array.isArray(messages)) throw new Error("Transcript is not an array")
  let assistantDisplayGroupId: string | undefined
  const seenIds = new Set<string>()
  return messages.map((message, ordinal) => {
    const candidate: unknown = message
    if (!isRecord(candidate)) throw new Error(`Message ${ordinal} is not an object`)
    const sourceType = candidate.type
    if (sourceType !== "user" && sourceType !== "assistant" && sourceType !== "system") {
      throw new Error(`Message ${ordinal} has an unsupported role`)
    }
    if (typeof candidate.uuid !== "string" || candidate.uuid.length === 0 || seenIds.has(candidate.uuid)) {
      throw new Error(`Message ${ordinal} has no unique ID`)
    }
    if (candidate.session_id !== sessionId) throw new Error(`Message ${candidate.uuid} belongs to another session`)
    seenIds.add(candidate.uuid)
    const normalizedSource: Pick<SessionMessage, "type" | "message"> = { type: sourceType, message: candidate.message }
    const localCommandArtifact = isLocalCommandArtifact(normalizedSource)
    const taskNotification = sourceType === "user" &&
      /^\s*<task-notification>\s*<task-id>[^<]+<\/task-id>[\s\S]*?<\/task-notification>/.test(
        extractUserPromptText(candidate.message) ?? "",
      )
    const visible = !localCommandArtifact && !taskNotification && isVisibleMessage(normalizedSource)
    if (sourceType === "user" && (visible || taskNotification)) assistantDisplayGroupId = candidate.uuid
    const replayText = sourceType === "user" && !localCommandArtifact && !taskNotification
      ? extractUserPromptText(candidate.message) : undefined
    const turnComplete = assistantTurnComplete(normalizedSource)
    return {
      id: candidate.uuid, role: sourceRole(sourceType), preview: formatMessage(candidate.message),
      text: extractMessageText(candidate.message), ordinal, visible, sourceType,
      rawMessage: candidate.message, copyIdentity: JSON.stringify(candidate.message) ?? "undefined",
      ...(sourceType === "assistant" && assistantDisplayGroupId !== undefined ? { displayGroupId: assistantDisplayGroupId } : {}),
      ...(turnComplete === undefined ? {} : { turnComplete }),
      ...(replayText === undefined ? {} : { replayText }),
    }
  })
}

export function markCompactionSummaries(messages: readonly ClaudeMessage[], entries: readonly SessionStoreEntry[]): readonly ClaudeMessage[] {
  const boundaries = new Set(entries.filter((entry) => entry.type === "system" && entry.subtype === "compact_boundary").map((entry) => entry.uuid))
  const summaryIds = new Set(entries.filter((entry) => entry.type === "user" &&
    (entry.isCompactSummary === true || (typeof entry.parentUuid === "string" && boundaries.has(entry.parentUuid))))
    .map((entry) => entry.uuid))
  return messages.map((message) => summaryIds.has(message.id)
    ? { ...message, visible: false, historyBoundary: "compaction" as const } : message)
}

export function formatMessage(message: unknown): string {
  if (typeof message === "string") return normalizePreview(message)
  if (!isRecord(message)) return "[unavailable message]"
  const content = message.content
  if (typeof content === "string") return normalizePreview(content)
  if (!Array.isArray(content)) return "[unavailable message]"
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text)
    else if (block.type === "tool_use" && typeof block.name === "string") parts.push(`[tool: ${block.name}]`)
    else if (block.type === "tool_result") parts.push("[tool result]")
    else if (block.type === "thinking") parts.push("[thinking]")
  }
  return normalizePreview(parts.join(" ") || "[non-text message]")
}

function extractMessageText(message: unknown): string {
  if (typeof message === "string") return message
  if (!isRecord(message)) return ""
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content.flatMap((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
  ).join("\n")
}

export function extractUserPromptText(message: unknown): string | undefined {
  if (typeof message === "string") return message.trim().length > 0 ? message : undefined
  if (!isRecord(message)) return undefined
  const content = message.content
  if (typeof content === "string") return content.trim().length > 0 ? content : undefined
  if (!Array.isArray(content) || content.length === 0) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return undefined
    parts.push(block.text)
  }
  const text = parts.join("\n")
  return text.trim().length > 0 ? text : undefined
}

function isVisibleMessage(message: Pick<SessionMessage, "type" | "message">): boolean {
  if (message.type !== "user" && message.type !== "assistant") return false
  if (typeof message.message === "string") return message.message.trim().length > 0
  if (!isRecord(message.message)) return false
  const content = message.message.content
  if (typeof content === "string") return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0)
}

function isLocalCommandArtifact(message: Pick<SessionMessage, "type" | "message">): boolean {
  const text = extractUserPromptText(message.message)?.trim()
  if (!text) return false
  if (message.type === "assistant") return isRecord(message.message) && message.message.model === "<synthetic>" && text === NO_RESPONSE_REQUESTED
  return message.type === "user" && (LOCAL_COMMAND_INVOCATION_PATTERN.test(text) || LOCAL_COMMAND_OUTPUT_PATTERN.test(text))
}

function assistantTurnComplete(message: Pick<SessionMessage, "type" | "message">): boolean | undefined {
  if (message.type !== "assistant" || !isRecord(message.message)) return undefined
  const stopReason = message.message.stop_reason
  if (stopReason === null) return false
  if (typeof stopReason !== "string") return undefined
  return stopReason !== "tool_use" && stopReason !== "pause_turn"
}

export function sourceRole(type: "user" | "assistant" | "system"): AgentMessage["role"] {
  return type === "assistant" ? "agent" : type
}

export function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "[empty message]"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
