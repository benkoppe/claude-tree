import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import {
  forkSession,
  getSessionMessages,
  listSessions,
  type SDKSessionInfo,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk"

import type {
  AgentMessage,
  AgentProvider,
  AgentSession,
  MessageRef,
  PreparedBranch,
  PreparedSession,
  TerminalLaunch,
} from "../agent-provider"
import { ClaudeTerminalObserver } from "./claude-terminal-observer"

const EXPECTED_CLAUDE_VERSION = "2.1.239"

export interface ClaudeSdk {
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

const defaultSdk: ClaudeSdk = {
  list: listSessions,
  messages: getSessionMessages,
  fork: forkSession,
}

interface ClaudeMessage extends AgentMessage {
  replayText?: string
  rawMessage: unknown
}

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude"
  readonly displayName = "Claude Code"

  constructor(
    private readonly projectPath: string,
    private readonly executable: string,
    readonly compatibilityWarning: string | undefined,
    private readonly sdk: ClaudeSdk = defaultSdk,
  ) {}

  async listSessions(): Promise<AgentSession[]> {
    const sessions = await this.sdk.list({
      dir: this.projectPath,
      includeWorktrees: false,
      includeProgrammatic: true,
    })
    return sessions.map(toSessionSummary)
  }

  async readTranscript(sessionId: string): Promise<AgentMessage[]> {
    return this.readClaudeTranscript(sessionId)
  }

  async prepareNewSession(): Promise<PreparedSession> {
    return this.prepareNewSessionWithDraft()
  }

  async prepareResume(session: AgentSession): Promise<TerminalLaunch> {
    return this.launch("resume", session.id)
  }

  async branchFrom(target: MessageRef): Promise<PreparedBranch> {
    const parentTranscript = await this.readClaudeTranscript(target.sessionId)
    const selectedIndex = parentTranscript.findIndex((message) => message.id === target.messageId)
    const selected = parentTranscript[selectedIndex]
    if (!selected) throw new Error("The selected historical message is no longer available")

    let forkIndex = selectedIndex
    let replayText: string | undefined
    if (selected.role === "user") {
      replayText = selected.replayText
      if (replayText === undefined) {
        throw new Error("This user message contains content that Claude Code cannot prefill")
      }
      forkIndex = -1
      for (let index = selectedIndex - 1; index >= 0; index -= 1) {
        if (parentTranscript[index]?.role === "assistant") {
          forkIndex = index
          break
        }
      }
    }

    if (forkIndex < 0) {
      const prepared = this.prepareNewSessionWithDraft(replayText)
      return {
        ...prepared,
        derivation: {
          childSessionId: prepared.session.id,
          parentSessionId: target.sessionId,
          sourceMessageId: target.messageId,
          sharedMessages: [],
        },
        providerSessionCreated: false,
      }
    }

    const forkMessage = parentTranscript[forkIndex]!
    const parentSession = (await this.listSessions()).find((session) => session.id === target.sessionId)
    const result = await this.sdk.fork(target.sessionId, {
      dir: this.projectPath,
      upToMessageId: forkMessage.id,
    })
    let childTranscript: ClaudeMessage[]
    try {
      childTranscript = await this.readClaudeTranscript(result.sessionId)
    } catch (error) {
      throw new Error(
        `Fork ${result.sessionId} was created, but its transcript could not be read: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const copiedPrefixLength = forkIndex + 1
    if (childTranscript.length < copiedPrefixLength) {
      throw new Error(`Fork ${result.sessionId} was created, but its copied prefix could not be validated`)
    }
    for (let index = 0; index < copiedPrefixLength; index += 1) {
      const parentMessage = parentTranscript[index]!
      const childMessage = childTranscript[index]!
      if (
        parentMessage.role !== childMessage.role ||
        !isDeepStrictEqual(parentMessage.rawMessage, childMessage.rawMessage) ||
        parentMessage.visible !== childMessage.visible
      ) {
        throw new Error(`Fork ${result.sessionId} was created, but its copied prefix does not match the source`)
      }
    }

    const session: AgentSession = {
      id: result.sessionId,
      title: `${parentSession?.title ?? "Conversation"} (fork)`,
      lastModified: Date.now(),
    }
    return {
      session,
      launch: this.launch("resume", result.sessionId, replayText),
      derivation: {
        childSessionId: result.sessionId,
        parentSessionId: target.sessionId,
        sourceMessageId: forkMessage.id,
        sharedMessages: parentTranscript.slice(0, copiedPrefixLength).map((message, index) => ({
          parentMessageId: message.id,
          childMessageId: childTranscript[index]!.id,
        })),
      },
      providerSessionCreated: true,
    }
  }

  private prepareNewSessionWithDraft(replayText?: string): PreparedSession {
    const sessionId = randomUUID()
    return {
      session: {
        id: sessionId,
        title: "New conversation",
        lastModified: Date.now(),
        transient: true,
      },
      launch: this.launch("new", sessionId, replayText),
    }
  }

  private launch(kind: "new" | "resume", sessionId: string, draft?: string): TerminalLaunch {
    if (draft?.includes("\0")) throw new Error("Claude prompt prefill cannot contain a null byte")
    const command =
      kind === "new"
        ? [this.executable, "--session-id", sessionId]
        : [this.executable, "--resume", sessionId]
    if (draft !== undefined) command.push(`--prefill=${draft}`)
    return {
      sessionId,
      command,
      cwd: this.projectPath,
      observer: new ClaudeTerminalObserver(),
      ...(draft === undefined ? {} : { initialDraft: { text: draft.trim(), exact: true } }),
    }
  }

  private async readClaudeTranscript(sessionId: string): Promise<ClaudeMessage[]> {
    const messages = await this.sdk.messages(sessionId, { dir: this.projectPath })
    return messages.map((message, ordinal) => {
      const replayText = message.type === "user" ? extractUserPromptText(message.message) : undefined
      return {
        id: message.uuid,
        role: message.type,
        preview: formatMessage(message.message),
        ordinal,
        visible: isVisibleMessage(message),
        rawMessage: message.message,
        ...(replayText === undefined ? {} : { replayText }),
      }
    })
  }
}

export async function createClaudeProvider(projectPath: string): Promise<ClaudeProvider> {
  const executable = Bun.which("claude")
  if (!executable) throw new Error("Claude Code was not found on PATH")
  const installedVersion = await readClaudeVersion(executable)
  const compatibilityWarning = installedVersion.includes(EXPECTED_CLAUDE_VERSION)
    ? undefined
    : `Warning: validated with Claude Code ${EXPECTED_CLAUDE_VERSION}; found ${installedVersion}`
  return new ClaudeProvider(projectPath, executable, compatibilityWarning)
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
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return undefined
    parts.push(block.text)
  }
  const text = parts.join("\n")
  return text.trim().length > 0 ? text : undefined
}

function toSessionSummary(session: SDKSessionInfo): AgentSession {
  const title = session.customTitle || session.summary || session.firstPrompt || "Untitled conversation"
  return {
    id: session.sessionId,
    title: normalizePreview(title),
    lastModified: session.lastModified,
    ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
  }
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "[empty message]"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function readClaudeVersion(executable: string): Promise<string> {
  const child = Bun.spawn([executable, "--version"], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`Unable to run Claude Code: ${stderr.trim() || `exit ${exitCode}`}`)
  }
  return stdout.trim()
}
