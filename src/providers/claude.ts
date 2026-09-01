import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import {
  forkSession,
  getSessionMessages,
  listSessions,
  type SDKSessionInfo,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk"

import {
  BranchCreatedError,
  type AgentMessage,
  type AgentProvider,
  type AgentSession,
  type MessageRef,
  type PreparedBranch,
  type PreparedSession,
  type TerminalLaunch,
} from "../agent-provider"
import { theme } from "../theme"
import { ClaudeTerminalObserver } from "./claude-terminal-observer"

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

export interface ClaudeProviderOptions {
  compatibilityWarning?: string
  forkValidationRetryDelaysMs?: readonly number[]
}

export interface ClaudeProviderDependencies {
  sdk?: ClaudeSdk
  which?: (executable: string) => string | null
  readVersion?: (executable: string) => Promise<string>
}

const defaultSdk: ClaudeSdk = {
  list: listSessions,
  messages: getSessionMessages,
  fork: forkSession,
}

const LOCAL_COMMAND_INVOCATION_PATTERN =
  /^<command-name>.*?<\/command-name>(?:\s*<command-message>.*?<\/command-message>)?(?:\s*<command-args>.*?<\/command-args>)?$/s
const LOCAL_COMMAND_OUTPUT_PATTERN =
  /^<local-command-(stdout|stderr|caveat)>.*<\/local-command-\1>$/s
const NO_RESPONSE_REQUESTED = "No response requested."
const FORK_VALIDATION_RETRY_DELAYS_MS = [25, 50, 100, 200]

export const EXPECTED_CLAUDE_VERSION = "2.1.251"

interface ClaudeMessage extends AgentMessage {
  replayText?: string
  rawMessage: unknown
}

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude"
  readonly displayName = "Claude Code"
  readonly navigatorIdentity = { label: "Claude", color: theme.claude }
  readonly compatibilityWarning: string | undefined

  private readonly forkValidationRetryDelaysMs: readonly number[]

  constructor(
    private readonly projectPath: string,
    private readonly executable: string,
    private readonly sdk: ClaudeSdk = defaultSdk,
    options: ClaudeProviderOptions = {},
  ) {
    this.compatibilityWarning = options.compatibilityWarning
    this.forkValidationRetryDelaysMs =
      options.forkValidationRetryDelaysMs ?? FORK_VALIDATION_RETRY_DELAYS_MS
  }

  async listSessions(): Promise<AgentSession[]> {
    const sessions = await this.sdk.list({
      dir: this.projectPath,
      includeWorktrees: false,
      includeProgrammatic: true,
    })
    return sessions.map(toSessionSummary)
  }

  async readTranscripts(
    sessionIds: readonly string[],
  ): Promise<Map<string, AgentMessage[] | null>> {
    return new Map(
      await Promise.all(
        sessionIds.map(async (sessionId) => {
          try {
            return [sessionId, await this.readClaudeTranscript(sessionId)] as const
          } catch {
            return [sessionId, null] as const
          }
        }),
      ),
    )
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
        if (parentTranscript[index]?.role === "agent") {
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

    this.validateDraft(replayText)
    if (this.compatibilityWarning) {
      throw new Error(`${this.compatibilityWarning}. Historical branching is disabled for this version pair`)
    }

    const forkMessage = parentTranscript[forkIndex]!
    const parentSession = (await this.listSessions()).find((session) => session.id === target.sessionId)
    const result = await this.sdk.fork(target.sessionId, {
      dir: this.projectPath,
      upToMessageId: forkMessage.id,
    })
    const session: AgentSession = {
      id: result.sessionId,
      title: `${parentSession?.title ?? "Conversation"} (fork)`,
      lastModified: Date.now(),
    }
    const copiedPrefixLength = forkIndex + 1
    const childTranscript = await this.readForkedTranscript(session, copiedPrefixLength)
    for (let index = 0; index < copiedPrefixLength; index += 1) {
      const parentMessage = parentTranscript[index]!
      const childMessage = childTranscript[index]!
      if (
        parentMessage.role !== childMessage.role ||
        !isDeepStrictEqual(parentMessage.rawMessage, childMessage.rawMessage) ||
        parentMessage.visible !== childMessage.visible
      ) {
        throw new BranchCreatedError(
          session,
          childTranscript,
          true,
          `Fork ${result.sessionId} was created, but its copied prefix does not match the source`,
        )
      }
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
    this.validateDraft(draft)
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

  private validateDraft(draft: string | undefined): void {
    if (draft?.includes("\0")) throw new Error("Claude prompt prefill cannot contain a null byte")
  }

  private async readClaudeTranscript(sessionId: string): Promise<ClaudeMessage[]> {
    const messages = await this.sdk.messages(sessionId, { dir: this.projectPath })
    let assistantDisplayGroupId: string | undefined
    return messages.map((message, ordinal) => {
      const localCommandArtifact = isLocalCommandArtifact(message)
      const visible = !localCommandArtifact && isVisibleMessage(message)
      if (message.type === "user" && visible) assistantDisplayGroupId = message.uuid
      const turnComplete = assistantTurnComplete(message)
      const replayText =
        message.type === "user" && !localCommandArtifact
          ? extractUserPromptText(message.message)
          : undefined
      return {
        id: message.uuid,
        role: message.type === "assistant" ? "agent" : message.type,
        preview: formatMessage(message.message),
        ordinal,
        visible,
        rawMessage: message.message,
        copyIdentity: JSON.stringify(message.message) ?? "undefined",
        ...(message.type === "assistant" && assistantDisplayGroupId !== undefined
          ? { displayGroupId: assistantDisplayGroupId }
          : {}),
        ...(turnComplete === undefined ? {} : { turnComplete }),
        ...(replayText === undefined ? {} : { replayText }),
      }
    })
  }

  private async readForkedTranscript(
    session: AgentSession,
    copiedPrefixLength: number,
  ): Promise<ClaudeMessage[]> {
    let observedTranscript: ClaudeMessage[] = []
    let transcriptAvailable = false
    let lastReadError: unknown
    const delays = [0, ...this.forkValidationRetryDelaysMs]

    for (const delayMs of delays) {
      if (delayMs > 0) await Bun.sleep(delayMs)
      try {
        const transcript = await this.readClaudeTranscript(session.id)
        observedTranscript = transcript
        transcriptAvailable = true
        lastReadError = undefined
        if (transcript.length >= copiedPrefixLength) return transcript
      } catch (error) {
        lastReadError = error
      }
    }

    if (lastReadError !== undefined) {
      throw new BranchCreatedError(
        session,
        observedTranscript,
        transcriptAvailable,
        `Fork ${session.id} was created, but its transcript could not be read after ${delays.length} attempts: ${lastReadError instanceof Error ? lastReadError.message : String(lastReadError)}`,
        { cause: lastReadError },
      )
    }
    throw new BranchCreatedError(
      session,
      observedTranscript,
      true,
      `Fork ${session.id} was created, but its copied prefix could not be validated (expected ${copiedPrefixLength} messages; found ${observedTranscript.length})`,
    )
  }
}

export async function createClaudeProvider(
  projectPath: string,
  dependencies: ClaudeProviderDependencies = {},
): Promise<ClaudeProvider> {
  const executable = (dependencies.which ?? Bun.which)("claude")
  if (!executable) throw new Error("Claude Code was not found on PATH")
  const installedVersion = await (dependencies.readVersion ?? readClaudeVersion)(executable)
  const compatibilityWarning = claudeCompatibilityWarning(installedVersion)
  return new ClaudeProvider(
    projectPath,
    executable,
    dependencies.sdk ?? defaultSdk,
    compatibilityWarning === undefined ? {} : { compatibilityWarning },
  )
}

export function claudeCompatibilityWarning(installedVersion: string): string | undefined {
  const escaped = EXPECTED_CLAUDE_VERSION.replace(/\./g, "\\.")
  if (new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`).test(installedVersion.trim())) return undefined
  return `Warning: validated with Claude Code ${EXPECTED_CLAUDE_VERSION}; found ${installedVersion.trim()}`
}

export async function readClaudeVersion(executable: string): Promise<string> {
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

function isLocalCommandArtifact(message: Pick<SessionMessage, "type" | "message">): boolean {
  const text = extractUserPromptText(message.message)?.trim()
  if (!text) return false
  // Historical SDK messages omit Claude's synthetic-message metadata.
  if (message.type === "assistant") {
    return (
      isRecord(message.message) &&
      message.message.model === "<synthetic>" &&
      text === NO_RESPONSE_REQUESTED
    )
  }
  return (
    message.type === "user" &&
    (LOCAL_COMMAND_INVOCATION_PATTERN.test(text) || LOCAL_COMMAND_OUTPUT_PATTERN.test(text))
  )
}

function assistantTurnComplete(
  message: Pick<SessionMessage, "type" | "message">,
): boolean | undefined {
  if (message.type !== "assistant" || !isRecord(message.message)) return undefined
  const stopReason = message.message.stop_reason
  if (stopReason === null) return false
  if (typeof stopReason !== "string") return undefined
  return stopReason !== "tool_use" && stopReason !== "pause_turn"
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
