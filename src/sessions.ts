import {
  forkSession,
  getSessionMessages,
  listSessions,
  type SDKSessionInfo,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk"

import type { BranchRelation } from "./metadata"

export interface SessionSummary {
  sessionId: string
  title: string
  lastModified: number
  gitBranch?: string
  transient?: boolean
}

export interface ConversationMessage {
  id: string
  role: "user" | "assistant" | "system"
  preview: string
  rawIndex: number
  visible: boolean
  prefillText?: string
}

export interface SessionTreeRow {
  session: SessionSummary
  depth: number
}

interface SessionSdk {
  list(options: {
    dir: string
    includeWorktrees: boolean
    includeProgrammatic: boolean
  }): Promise<SDKSessionInfo[]>
  messages(sessionId: string, options: { dir: string }): Promise<SessionMessage[]>
  fork(
    sessionId: string,
    options: { dir: string; upToMessageId: string },
  ): Promise<{ sessionId: string }>
}

const defaultSdk: SessionSdk = {
  list: listSessions,
  messages: getSessionMessages,
  fork: forkSession,
}

export class SessionService {
  constructor(
    private readonly projectPath: string,
    private readonly sdk: SessionSdk = defaultSdk,
  ) {}

  async list(): Promise<SessionSummary[]> {
    const sessions = await this.sdk.list({
      dir: this.projectPath,
      includeWorktrees: false,
      includeProgrammatic: true,
    })
    return sessions.map(toSessionSummary)
  }

  async messages(sessionId: string): Promise<ConversationMessage[]> {
    const messages = await this.sdk.messages(sessionId, { dir: this.projectPath })
    return messages.map((message, rawIndex) => {
      const prefillText = message.type === "user" ? extractUserPromptText(message.message) : undefined
      return {
        id: message.uuid,
        role: message.type,
        preview: formatMessage(message.message),
        rawIndex,
        visible: isVisibleMessage(message),
        ...(prefillText === undefined ? {} : { prefillText }),
      }
    })
  }

  async fork(sessionId: string, messageId: string): Promise<string> {
    const result = await this.sdk.fork(sessionId, {
      dir: this.projectPath,
      upToMessageId: messageId,
    })
    return result.sessionId
  }
}

export function buildSessionTree(
  sessions: SessionSummary[],
  relations: BranchRelation[],
): SessionTreeRow[] {
  const sessionsById = new Map(sessions.map((session) => [session.sessionId, session]))
  const children = new Map<string, SessionSummary[]>()
  const attachedChildren = new Set<string>()

  for (const relation of relations) {
    const child = sessionsById.get(relation.childSessionId)
    if (!child || !sessionsById.has(relation.parentSessionId)) continue

    const siblings = children.get(relation.parentSessionId) ?? []
    siblings.push(child)
    children.set(relation.parentSessionId, siblings)
    attachedChildren.add(child.sessionId)
  }

  const sortNewestFirst = (left: SessionSummary, right: SessionSummary) =>
    right.lastModified - left.lastModified || left.sessionId.localeCompare(right.sessionId)

  const rows: SessionTreeRow[] = []
  const append = (session: SessionSummary, depth: number) => {
    rows.push({ session, depth })
    for (const child of (children.get(session.sessionId) ?? []).sort(sortNewestFirst)) {
      append(child, depth + 1)
    }
  }

  for (const root of sessions.filter((session) => !attachedChildren.has(session.sessionId)).sort(sortNewestFirst)) {
    append(root, 0)
  }
  return rows
}

export function childCountByMessage(relations: BranchRelation[], parentSessionId: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const relation of relations) {
    if (relation.parentSessionId !== parentSessionId) continue
    counts.set(relation.sourceMessageId, (counts.get(relation.sourceMessageId) ?? 0) + 1)
  }
  return counts
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
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text)
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      parts.push(`[tool: ${block.name}]`)
    } else if (block.type === "tool_result") {
      parts.push("[tool result]")
    } else if (block.type === "thinking") {
      parts.push("[thinking]")
    }
  }
  return normalizePreview(parts.join(" ") || "[non-text message]")
}

export function isVisibleMessage(message: Pick<SessionMessage, "type" | "message">): boolean {
  if (message.type !== "user" && message.type !== "assistant") return false
  if (typeof message.message === "string") return message.message.trim().length > 0
  if (!isRecord(message.message)) return false

  const content = message.message.content
  if (typeof content === "string") return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some(
    (block) => isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
  )
}

export function extractUserPromptText(message: unknown): string | undefined {
  if (typeof message === "string") return message.trim().length > 0 ? message : undefined
  if (!isRecord(message)) return undefined

  const content = message.content
  if (typeof content === "string") return content.trim().length > 0 ? content : undefined
  if (!Array.isArray(content) || content.length === 0) return undefined

  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      return undefined
    }
    parts.push(block.text)
  }
  const text = parts.join("\n")
  return text.trim().length > 0 ? text : undefined
}

function toSessionSummary(session: SDKSessionInfo): SessionSummary {
  const title = session.customTitle || session.summary || session.firstPrompt || "Untitled conversation"
  const summary: SessionSummary = {
    sessionId: session.sessionId,
    title: normalizePreview(title),
    lastModified: session.lastModified,
  }
  if (session.gitBranch) summary.gitBranch = session.gitBranch
  return summary
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "[empty message]"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
