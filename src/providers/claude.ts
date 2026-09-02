import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import {
  forkSession,
  getSessionMessages,
  importSessionToStore,
  listSessions,
  type SDKSessionInfo,
  type SessionStore,
  type SessionStoreEntry,
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
  forkRecords?(
    sessionId: string,
    options: { dir: string; parentSessionId: string },
  ): Promise<ClaudeForkRecord[]>
}

export interface ClaudeForkRecord {
  childMessageId: string
  parentSessionId: string
  parentMessageId: string
  parentOrdinal: number
  parentType: "user" | "assistant"
  parentMessage: unknown
  type: "user" | "assistant"
  message: unknown
}

export interface ClaudeProviderOptions {
  forkValidationRetryDelaysMs?: readonly number[]
}

export interface ClaudeProviderDependencies {
  sdk?: ClaudeSdk
  which?: (executable: string) => string | null
}

const defaultSdk: ClaudeSdk = {
  list: listSessions,
  messages: getSessionMessages,
  fork: forkSession,
  forkRecords: readClaudeForkRecords,
}

const LOCAL_COMMAND_INVOCATION_PATTERN =
  /^<command-name>.*?<\/command-name>(?:\s*<command-message>.*?<\/command-message>)?(?:\s*<command-args>.*?<\/command-args>)?$/s
const LOCAL_COMMAND_OUTPUT_PATTERN =
  /^<local-command-(stdout|stderr|caveat)>.*<\/local-command-\1>$/s
const NO_RESPONSE_REQUESTED = "No response requested."
const FORK_VALIDATION_RETRY_DELAYS_MS = [25, 50, 100, 200]

interface ClaudeMessage extends AgentMessage {
  replayText?: string
  rawMessage: unknown
}

interface ValidatedFork {
  sharedMessages: Array<{ parentMessageId: string; childMessageId: string }>
}

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude"
  readonly displayName = "Claude Code"
  readonly navigatorIdentity = { label: "Claude", color: theme.claude }

  private readonly forkValidationRetryDelaysMs: readonly number[]

  constructor(
    private readonly projectPath: string,
    private readonly executable: string,
    private readonly sdk: ClaudeSdk = defaultSdk,
    options: ClaudeProviderOptions = {},
  ) {
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
    const readForkRecords = this.sdk.forkRecords
    if (!readForkRecords) {
      throw new Error("Claude SDK fork provenance is unavailable")
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
    const parentPrefix = parentTranscript.slice(0, forkIndex + 1)
    const validatedFork = await this.readForkedTranscript(
      session,
      target.sessionId,
      parentPrefix,
      (sessionId, options) => readForkRecords.call(this.sdk, sessionId, options),
    )

    return {
      session,
      launch: this.launch("resume", result.sessionId, replayText),
      derivation: {
        childSessionId: result.sessionId,
        parentSessionId: target.sessionId,
        sourceMessageId: forkMessage.id,
        sharedMessages: validatedFork.sharedMessages,
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
    parentSessionId: string,
    parentPrefix: ClaudeMessage[],
    readForkRecords: NonNullable<ClaudeSdk["forkRecords"]>,
  ): Promise<ValidatedFork> {
    let observedTranscript: ClaudeMessage[] = []
    let observedCopiedMessages = 0
    let transcriptAvailable = false
    let lastReadError: { kind: "transcript" | "provenance"; error: unknown } | undefined
    const delays = [0, ...this.forkValidationRetryDelaysMs]

    for (const delayMs of delays) {
      if (delayMs > 0) await Bun.sleep(delayMs)
      try {
        const transcript = await this.readClaudeTranscript(session.id)
        observedTranscript = transcript
        transcriptAvailable = true
        lastReadError = undefined
      } catch (error) {
        lastReadError = { kind: "transcript", error }
        continue
      }

      let forkRecords: ClaudeForkRecord[]
      try {
        forkRecords = await readForkRecords(session.id, {
          dir: this.projectPath,
          parentSessionId,
        })
        lastReadError = undefined
      } catch (error) {
        lastReadError = { kind: "provenance", error }
        continue
      }

      const validation = validateForkProvenance(
        parentSessionId,
        parentPrefix,
        observedTranscript,
        forkRecords,
      )
      observedCopiedMessages = validation.copiedMessages
      if (validation.kind === "short") continue
      if (validation.kind === "invalid") {
        throw new BranchCreatedError(
          session,
          observedTranscript,
          true,
          `Fork ${session.id} was created, but its copied prefix does not match the source`,
        )
      }
      return { sharedMessages: validation.sharedMessages }
    }

    if (lastReadError !== undefined) {
      const subject = lastReadError.kind === "transcript" ? "transcript" : "copied-prefix provenance"
      throw new BranchCreatedError(
        session,
        observedTranscript,
        transcriptAvailable,
        `Fork ${session.id} was created, but its ${subject} could not be read after ${delays.length} attempts: ${lastReadError.error instanceof Error ? lastReadError.error.message : String(lastReadError.error)}`,
        { cause: lastReadError.error },
      )
    }
    throw new BranchCreatedError(
      session,
      observedTranscript,
      true,
      `Fork ${session.id} was created, but its copied prefix could not be validated (expected ${parentPrefix.length} messages; found ${observedCopiedMessages})`,
    )
  }
}

type ForkProvenanceValidation =
  | {
      kind: "valid"
      copiedMessages: number
      sharedMessages: Array<{ parentMessageId: string; childMessageId: string }>
    }
  | { kind: "short"; copiedMessages: number }
  | { kind: "invalid"; copiedMessages: number }

function validateForkProvenance(
  parentSessionId: string,
  parentPrefix: ClaudeMessage[],
  childTranscript: ClaudeMessage[],
  forkRecords: ClaudeForkRecord[],
): ForkProvenanceValidation {
  const parentIndexById = new Map(parentPrefix.map((message, index) => [message.id, index]))
  const observedExpectedIds = new Set(
    forkRecords
      .filter((record) => parentIndexById.has(record.parentMessageId))
      .map((record) => record.parentMessageId),
  )
  const recordByParentId = new Map<string, ClaudeForkRecord>()
  const parentIdByChildId = new Map<string, string>()
  const seenParentIds = new Set<string>()
  const seenChildIds = new Set<string>()
  let previousParentOrdinal = -1
  let previousExpectedIndex = -1

  for (const record of forkRecords) {
    if (
      record.parentSessionId !== parentSessionId ||
      seenParentIds.has(record.parentMessageId) ||
      seenChildIds.has(record.childMessageId) ||
      record.parentType !== record.type ||
      !isDeepStrictEqual(record.parentMessage, record.message)
    ) {
      return { kind: "invalid", copiedMessages: recordByParentId.size }
    }
    if (record.parentOrdinal !== previousParentOrdinal + 1) {
      return observedExpectedIds.size < parentPrefix.length
        ? { kind: "short", copiedMessages: observedExpectedIds.size }
        : { kind: "invalid", copiedMessages: recordByParentId.size }
    }
    previousParentOrdinal = record.parentOrdinal
    seenParentIds.add(record.parentMessageId)
    seenChildIds.add(record.childMessageId)
    const expectedIndex = parentIndexById.get(record.parentMessageId)
    if (expectedIndex === undefined) continue
    if (expectedIndex <= previousExpectedIndex) {
      return { kind: "invalid", copiedMessages: recordByParentId.size }
    }
    previousExpectedIndex = expectedIndex
    recordByParentId.set(record.parentMessageId, record)
    parentIdByChildId.set(record.childMessageId, record.parentMessageId)
  }

  const copiedMessages = recordByParentId.size
  if (copiedMessages < parentPrefix.length) return { kind: "short", copiedMessages }
  if (forkRecords.at(-1)?.parentMessageId !== parentPrefix.at(-1)?.id) {
    return { kind: "invalid", copiedMessages }
  }

  const sharedMessages: Array<{ parentMessageId: string; childMessageId: string }> = []
  for (const parentMessage of parentPrefix) {
    const record = recordByParentId.get(parentMessage.id)
    if (!record) return { kind: "short", copiedMessages }
    const role = record.type === "assistant" ? "agent" : "user"
    const visible = !isLocalCommandArtifact(record) && isVisibleMessage(record)
    if (
      parentMessage.role !== role ||
      parentMessage.visible !== visible ||
      !isDeepStrictEqual(parentMessage.rawMessage, record.message)
    ) {
      return { kind: "invalid", copiedMessages }
    }
    sharedMessages.push({
      parentMessageId: parentMessage.id,
      childMessageId: record.childMessageId,
    })
  }

  let previousParentIndex = -1
  for (const childMessage of childTranscript) {
    const parentMessageId = parentIdByChildId.get(childMessage.id)
    const parentIndex = parentMessageId === undefined ? undefined : parentIndexById.get(parentMessageId)
    const parentMessage = parentIndex === undefined ? undefined : parentPrefix[parentIndex]
    if (
      parentIndex === undefined ||
      parentIndex <= previousParentIndex ||
      parentMessage === undefined ||
      parentMessage.role !== childMessage.role ||
      parentMessage.visible !== childMessage.visible ||
      !isDeepStrictEqual(parentMessage.rawMessage, childMessage.rawMessage)
    ) {
      return { kind: "invalid", copiedMessages }
    }
    previousParentIndex = parentIndex
  }
  if (previousParentIndex !== parentPrefix.length - 1) {
    return { kind: "short", copiedMessages }
  }

  return { kind: "valid", copiedMessages, sharedMessages }
}

async function readClaudeForkRecords(
  sessionId: string,
  options: { dir: string; parentSessionId: string },
): Promise<ClaudeForkRecord[]> {
  const [parentEntries, childEntries] = await Promise.all([
    readClaudeConversationEntries(options.parentSessionId, options.dir),
    readClaudeConversationEntries(sessionId, options.dir),
  ])
  const parentById = new Map<string, { ordinal: number; entry: SessionStoreEntry }>()
  for (const [ordinal, entry] of parentEntries.entries()) {
    if (typeof entry.uuid !== "string" || parentById.has(entry.uuid)) {
      throw new Error("Source conversation records do not have unique message IDs")
    }
    parentById.set(entry.uuid, { ordinal, entry })
  }

  return childEntries.map((entry): ClaudeForkRecord => {
    if (typeof entry.uuid !== "string" || !isRecord(entry.forkedFrom)) {
      throw new Error("Forked conversation record has no valid provenance")
    }
    const parentSessionId = entry.forkedFrom.sessionId
    const parentMessageId = entry.forkedFrom.messageUuid
    if (typeof parentSessionId !== "string" || typeof parentMessageId !== "string") {
      throw new Error("Forked conversation record has no valid provenance")
    }
    const parent = parentById.get(parentMessageId)
    if (!parent || (parent.entry.type !== "user" && parent.entry.type !== "assistant")) {
      throw new Error("Forked conversation record refers to an unavailable source message")
    }
    return {
      childMessageId: entry.uuid,
      parentSessionId,
      parentMessageId,
      parentOrdinal: parent.ordinal,
      parentType: parent.entry.type,
      parentMessage: parent.entry.message,
      type: entry.type as "user" | "assistant",
      message: entry.message,
    }
  })
}

async function readClaudeConversationEntries(
  sessionId: string,
  dir: string,
): Promise<SessionStoreEntry[]> {
  const entries: SessionStoreEntry[] = []
  const store: SessionStore = {
    async append(key, batch) {
      if (key.sessionId === sessionId && key.subpath === undefined) entries.push(...batch)
    },
    async load() {
      return null
    },
  }
  await importSessionToStore(sessionId, store, {
    dir,
    includeSubagents: false,
  })
  return entries.filter((entry) => entry.type === "user" || entry.type === "assistant")
}

export async function createClaudeProvider(
  projectPath: string,
  dependencies: ClaudeProviderDependencies = {},
): Promise<ClaudeProvider> {
  const executable = (dependencies.which ?? Bun.which)("claude")
  if (!executable) throw new Error("Claude Code was not found on PATH")
  return new ClaudeProvider(projectPath, executable, dependencies.sdk ?? defaultSdk)
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
