import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"

import type {
  AgentMessage,
  AgentProvider,
  AgentSession,
  AgentSessionSnapshot,
  MessageRef,
  PreparedBranch,
  PreparedSession,
  TerminalLaunch,
  TerminalObserver,
} from "../agent-provider"
import { theme } from "../theme"
import {
  CodexAppServerClient,
  type CodexAppServer,
  type CodexAppServerFactory,
  CodexRpcError,
  createCodexAppServerFactory,
  type CodexThread,
  type CodexThreadItem,
  type CodexTurn,
  type CodexTurnStatus,
  type CodexUserInput,
} from "./codex-app-server"
import { CodexTerminalObserver } from "./codex-terminal-observer"

export const EXPECTED_CODEX_VERSION = "0.150.1"
const TRANSCRIPT_READ_CONCURRENCY = 16
const OVERLOAD_RETRY_DELAYS_MS = [25, 50, 100, 200]
const SIDECAR_STDERR_LIMIT = 8_192

export interface CodexMessage extends AgentMessage {
  readonly rawItem: CodexThreadItem
  readonly turnId: string
  readonly turnStatus: CodexTurnStatus
  readonly itemIndex: number
}

export interface CodexProviderDependencies {
  appServerFactory?: CodexAppServerFactory
  observerFactory?: () => TerminalObserver
  which?: (executable: string) => string | null
  readVersion?: (executable: string) => Promise<string>
  canonicalize?: (path: string) => Promise<string>
  newSessionFactory?: CodexNewSessionFactory
}

export interface CodexNewSession {
  sessionId: string
  threadStarted: Promise<CodexThread>
  remoteUrl: string
  bearerToken: string
  cleanup(): Promise<void>
}

export type CodexNewSessionFactory = (
  executable: string,
  projectPath: string,
) => Promise<CodexNewSession>

export class CodexProvider implements AgentProvider {
  readonly id = "codex"
  readonly displayName = "Codex"
  readonly navigatorIdentity = { label: "Codex", color: theme.codex }

  constructor(
    private readonly projectPath: string,
    private readonly executable: string,
    readonly compatibilityWarning: string | undefined,
    private readonly appServerFactory: CodexAppServerFactory = createCodexAppServerFactory(executable),
    private readonly observerFactory: () => TerminalObserver = () => new CodexTerminalObserver(),
    private readonly newSessionFactory: CodexNewSessionFactory = createCodexNewSession,
  ) {}

  async listSessions(): Promise<AgentSession[]> {
    return this.withServer((server) => this.listSessionsFrom(server))
  }

  async readTranscripts(
    sessionIds: readonly string[],
  ): Promise<Map<string, AgentMessage[] | null>> {
    return this.withServer((server) => this.readTranscriptsFrom(server, sessionIds))
  }

  async loadSessionSnapshot(): Promise<AgentSessionSnapshot> {
    return this.withServer(async (server) => {
      const sessions = await this.listSessionsFrom(server)
      const transcripts = await this.readTranscriptsFrom(
        server,
        sessions.map((session) => session.id),
      )
      return { sessions, transcripts }
    })
  }

  async prepareNewSession(): Promise<PreparedSession> {
    const created = await this.newSessionFactory(this.executable, this.projectPath)
    const startedSession = created.threadStarted.then((thread) => ({ ...toSession(thread), transient: true }))
    void startedSession.catch(() => undefined)
    const session = {
      id: created.sessionId,
      title: "Untitled conversation",
      lastModified: Date.now(),
      transient: true,
    }
    return {
      session,
      launch: {
        sessionId: created.sessionId,
        command: [
          this.executable,
          "--remote",
          created.remoteUrl,
          "--remote-auth-token-env",
          "CLAUDE_TREE_CODEX_TOKEN",
          "--cd",
          this.projectPath,
        ],
        cwd: this.projectPath,
        env: { CLAUDE_TREE_CODEX_TOKEN: created.bearerToken },
        observer: this.observerFactory(),
        cleanup: created.cleanup,
      },
      startedSession,
    }
  }

  async prepareResume(session: AgentSession): Promise<TerminalLaunch> {
    return this.launch(session.id)
  }

  async branchFrom(target: MessageRef): Promise<PreparedBranch> {
    return this.withServer(async (server) => {
      const parentThread = await server.readThread(target.sessionId)
      const parentTranscript = normalizeCodexThread(parentThread)
      const selectedIndex = parentTranscript.findIndex((message) => message.id === target.messageId)
      const selected = parentTranscript[selectedIndex]
      if (!selected) throw new Error("The selected historical message is no longer available")
      validateForkTarget(selected, parentThread)

      const copiedParent = parentTranscript.slice(0, selectedIndex + 1)
      const childThread = await server.forkThread(target.sessionId, selected.turnId, this.projectPath)
      let readChildThread: CodexThread
      let childTranscript: CodexMessage[]
      try {
        readChildThread = await server.readThread(childThread.id)
        childTranscript = normalizeCodexThread(readChildThread)
      } catch (error) {
        throw new Error(
          `Fork ${childThread.id} was created, but its transcript could not be read: ${errorMessage(error)}`,
        )
      }
      validateCopiedPrefix(childThread.id, copiedParent, childTranscript)

      return {
        session: toSession(readChildThread),
        launch: this.launch(childThread.id),
        derivation: {
          childSessionId: childThread.id,
          parentSessionId: target.sessionId,
          sourceMessageId: selected.id,
          sharedMessages: copiedParent.map((message, index) => ({
            parentMessageId: message.id,
            childMessageId: childTranscript[index]!.id,
          })),
        },
        providerSessionCreated: true,
      }
    })
  }

  private launch(
    sessionId: string,
    remoteUrl?: string,
    bearerToken?: string,
    cleanup?: () => Promise<void>,
  ): TerminalLaunch {
    return {
      sessionId,
      command: remoteUrl
        ? [
            this.executable,
            "resume",
            "--remote",
            remoteUrl,
            "--remote-auth-token-env",
            "CLAUDE_TREE_CODEX_TOKEN",
            sessionId,
          ]
        : [this.executable, "resume", sessionId],
      cwd: this.projectPath,
      ...(bearerToken === undefined ? {} : { env: { CLAUDE_TREE_CODEX_TOKEN: bearerToken } }),
      observer: this.observerFactory(),
      ...(cleanup === undefined ? {} : { cleanup }),
    }
  }

  private async listSessionsFrom(server: CodexAppServer): Promise<AgentSession[]> {
    const sessions: AgentSession[] = []
    let cursor: string | undefined
    do {
      const page = await server.listThreads({
        cwd: this.projectPath,
        modelProviders: [],
        sourceKinds: ["cli", "vscode", "appServer"],
        sortKey: "updated_at",
        ...(cursor === undefined ? {} : { cursor }),
      })
      sessions.push(...page.data.map(toSession))
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    return sessions
  }

  private async readTranscriptsFrom(
    server: CodexAppServer,
    sessionIds: readonly string[],
  ): Promise<Map<string, AgentMessage[] | null>> {
    const transcripts = new Array<AgentMessage[] | null>(sessionIds.length)
    let nextIndex = 0
    const workers = Array.from(
      { length: Math.min(TRANSCRIPT_READ_CONCURRENCY, sessionIds.length) },
      async () => {
        while (nextIndex < sessionIds.length) {
          const index = nextIndex++
          try {
            const thread = await readThreadWithOverloadRetry(server, sessionIds[index]!)
            transcripts[index] = normalizeCodexThread(thread)
          } catch (error) {
            if (!isMissingCodexThreadError(error)) throw error
            transcripts[index] = null
          }
        }
      },
    )
    await Promise.all(workers)
    return new Map(sessionIds.map((sessionId, index) => [sessionId, transcripts[index]!] as const))
  }

  private async withServer<Result>(operation: (server: CodexAppServer) => Promise<Result>): Promise<Result> {
    const server = await this.appServerFactory()
    let operationError: unknown
    try {
      return await operation(server)
    } catch (error) {
      operationError = error
      throw error
    } finally {
      try {
        await server.close()
      } catch (closeError) {
        if (operationError === undefined) throw closeError
      }
    }
  }
}

export async function createCodexProvider(
  projectPath: string,
  dependencies: CodexProviderDependencies = {},
): Promise<CodexProvider> {
  const executable = (dependencies.which ?? Bun.which)("codex")
  if (!executable) throw new Error("Codex was not found on PATH")
  const installedVersion = await (dependencies.readVersion ?? readCodexVersion)(executable)
  const compatibilityWarning = codexCompatibilityWarning(installedVersion)
  const canonicalPath = await (dependencies.canonicalize ?? realpath)(projectPath)
  return new CodexProvider(
    canonicalPath,
    executable,
    compatibilityWarning,
    dependencies.appServerFactory ?? createCodexAppServerFactory(executable),
    dependencies.observerFactory,
    dependencies.newSessionFactory,
  )
}

export async function createCodexNewSession(
  executable: string,
  projectPath: string,
): Promise<CodexNewSession> {
  const directory = await mkdtemp(join(tmpdir(), "claude-tree-codex-"))
  const tokenPath = join(directory, "token")
  const bearerToken = crypto.randomUUID().replaceAll("-", "")
  await writeFile(tokenPath, bearerToken, { mode: 0o600 })
  const remoteUrl = `ws://127.0.0.1:${await availableLoopbackPort()}`
  const process = Bun.spawn([
    executable,
    "app-server",
    "--listen",
    remoteUrl,
    "--ws-auth",
    "capability-token",
    "--ws-token-file",
    tokenPath,
  ], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
  const stderr = readBoundedText(process.stderr, SIDECAR_STDERR_LIMIT)
  const sessionId = `pending-codex-${crypto.randomUUID()}`
  let threadSettled = false
  let resolveThread!: (thread: CodexThread) => void
  let rejectThread!: (error: Error) => void
  const threadStarted = new Promise<CodexThread>((resolve, reject) => {
    resolveThread = resolve
    rejectThread = reject
  })
  void threadStarted.catch(() => undefined)
  let allocationClient: CodexAppServerClient | undefined
  let cleanupPromise: Promise<void> | undefined
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      if (!threadSettled) {
        threadSettled = true
        rejectThread(new Error("Codex exited before starting its new thread"))
      }
      await allocationClient?.close().catch(() => undefined)
      allocationClient = undefined
      if (process.exitCode === null) signalProcessGroup(process, "SIGTERM")
      if (!(await settlesWithin(process.exited, 1_000)) && process.exitCode === null) {
        signalProcessGroup(process, "SIGKILL")
        await settlesWithin(process.exited, 1_000)
      }
      if (process.exitCode === null) process.unref()
      await rm(directory, { recursive: true, force: true })
    })()
    return cleanupPromise
  }

  try {
    allocationClient = await connectToCodexAppServer(remoteUrl, bearerToken, process, stderr)
    void waitForLoadedThread(allocationClient).then(
      (thread) => {
        if (threadSettled) return
        threadSettled = true
        resolveThread(thread)
      },
      (error: unknown) => {
        if (threadSettled) return
        threadSettled = true
        rejectThread(error instanceof Error ? error : new Error(String(error)))
      },
    )
    return { sessionId, threadStarted, remoteUrl, bearerToken, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export function normalizeCodexThread(thread: Pick<CodexThread, "turns">): CodexMessage[] {
  const messages: CodexMessage[] = []
  for (const turn of thread.turns) {
    for (const [itemIndex, item] of turn.items.entries()) {
      const normalized = normalizeCodexItem(item)
      messages.push({
        id: item.id,
        ...normalized,
        ordinal: messages.length,
        rawItem: item,
        turnId: turn.id,
        turnStatus: turn.status,
        itemIndex,
      })
    }
  }
  return messages
}

export function formatCodexUserInput(content: readonly CodexUserInput[]): string {
  const parts = content.map((input) => {
    switch (input.type) {
      case "text":
        return typeof input.text === "string" ? input.text : "[text]"
      case "image":
        return "[image]"
      case "localImage":
        return "[localImage]"
      case "audio":
        return "[audio]"
      case "localAudio":
        return "[localAudio]"
      case "skill":
        return `[skill: ${typeof input.name === "string" ? input.name : "unknown"}]`
      case "mention":
        return `[mention: ${typeof input.name === "string" ? input.name : "unknown"}]`
      default:
        return `[${input.type || "input"}]`
    }
  })
  return normalizePreview(parts.join(" "))
}

export function codexCompatibilityWarning(installedVersion: string): string | undefined {
  const escaped = EXPECTED_CODEX_VERSION.replace(/\./g, "\\.")
  if (new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`).test(installedVersion.trim())) return undefined
  return `Warning: validated with Codex ${EXPECTED_CODEX_VERSION}; found ${installedVersion.trim()}`
}

export async function readCodexVersion(executable: string): Promise<string> {
  const child = Bun.spawn([executable, "--version"], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`Unable to run Codex: ${stderr.trim() || `exit ${exitCode}`}`)
  }
  return stdout.trim()
}

function normalizeCodexItem(item: CodexThreadItem): Pick<AgentMessage, "role" | "preview" | "visible"> {
  if (item.type === "userMessage") {
    const preview = formatCodexUserInput(Array.isArray(item.content) ? item.content : [])
    if (preview !== "[empty message]") return { role: "user", preview, visible: true }
  }
  if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
    return { role: "agent", preview: normalizePreview(item.text), visible: true }
  }
  return { role: "system", preview: `[${item.type || "unknown item"}]`, visible: false }
}

function validateForkTarget(selected: CodexMessage, parentThread: CodexThread): void {
  if (selected.role === "user") throw new Error("Codex can only branch from an agent message, not a user message")
  if (selected.role === "system") throw new Error("Codex can only branch from an agent message, not a system item")
  const turn = parentThread.turns.find((candidate) => candidate.id === selected.turnId)
  if (!turn) throw new Error("The selected message's turn is no longer available")
  if (turn.status !== "completed") {
    throw new Error(`Codex can only branch from a completed turn; this turn is ${turn.status}`)
  }
  if (selected.itemIndex !== turn.items.length - 1) {
    throw new Error("Codex can only branch from the final item of a completed turn")
  }
}

function validateCopiedPrefix(
  childSessionId: string,
  parent: readonly CodexMessage[],
  child: readonly CodexMessage[],
): void {
  if (child.length !== parent.length) {
    throw new Error(`Fork ${childSessionId} was created, but its copied prefix could not be validated`)
  }
  for (let index = 0; index < parent.length; index += 1) {
    const parentMessage = parent[index]!
    const childMessage = child[index]!
    if (
      parentMessage.role !== childMessage.role ||
      parentMessage.visible !== childMessage.visible ||
      parentMessage.turnStatus !== childMessage.turnStatus ||
      parentMessage.itemIndex !== childMessage.itemIndex ||
      !isDeepStrictEqual(withoutItemId(parentMessage.rawItem), withoutItemId(childMessage.rawItem))
    ) {
      throw new Error(`Fork ${childSessionId} was created, but its copied prefix does not match the source`)
    }
  }
}

function withoutItemId(item: CodexThreadItem): Record<string, unknown> {
  const { id: _id, ...payload } = item
  return payload
}

function toSession(thread: CodexThread): AgentSession {
  const title = firstNonempty(thread.name, thread.preview) ?? "Untitled conversation"
  return {
    id: thread.id,
    title: normalizePreview(title),
    lastModified: thread.updatedAt * 1_000,
    ...(thread.gitInfo?.branch ? { gitBranch: thread.gitInfo.branch } : {}),
  }
}

function firstNonempty(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "[empty message]"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingCodexThreadError(error: unknown): boolean {
  if (!(error instanceof CodexRpcError) || error.code !== -32600) return false
  if (
    typeof error.data === "object" &&
    error.data !== null &&
    "appErrorCode" in error.data &&
    (error.data.appErrorCode === "thread_not_found" || error.data.appErrorCode === "rollout_not_found")
  ) {
    return true
  }
  return /no rollout found for (?:thread|conversation) id/i.test(error.message)
}

async function connectToCodexAppServer(
  remoteUrl: string,
  bearerToken: string,
  process: Pick<Bun.Subprocess, "exitCode" | "exited">,
  stderr: Promise<string>,
): Promise<CodexAppServerClient> {
  const deadline = performance.now() + 5_000
  let lastError: unknown
  while (performance.now() < deadline) {
    if (process.exitCode !== null) {
      const detail = (await stderr).trim()
      throw new Error(`Codex app-server exited before accepting connections${detail ? `: ${detail}` : ""}`)
    }
    try {
      return await CodexAppServerClient.connect(remoteUrl, { bearerToken })
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(10)
  }
  throw new Error(
    `Codex app-server did not accept connections within 5000ms: ${errorMessage(lastError)}`,
  )
}

async function waitForLoadedThread(client: CodexAppServerClient): Promise<CodexThread> {
  while (true) {
    const sessionIds = await client.listLoadedThreadIds()
    if (sessionIds.length > 1) {
      throw new Error("The dedicated Codex app-server loaded more than one thread")
    }
    if (sessionIds[0]) return client.readThread(sessionIds[0], false)
    await Bun.sleep(10)
  }
}

async function readThreadWithOverloadRetry(
  server: CodexAppServer,
  sessionId: string,
): Promise<CodexThread> {
  for (const delay of OVERLOAD_RETRY_DELAYS_MS) {
    try {
      return await server.readThread(sessionId)
    } catch (error) {
      if (!(error instanceof CodexRpcError) || error.code !== -32001) throw error
      await Bun.sleep(delay)
    }
  }
  return server.readThread(sessionId)
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer()
  server.unref()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  if (!address || typeof address === "string") throw new Error("Unable to allocate a loopback port")
  return address.port
}

function signalProcessGroup(
  child: Pick<Bun.Subprocess, "exitCode" | "kill" | "pid">,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-child.pid, signal)
  } catch {
    if (child.exitCode === null) child.kill(signal)
  }
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text = (text + decoder.decode(value, { stream: true })).slice(-limit)
  }
  return (text + decoder.decode()).trim().slice(-limit)
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const settled = await Promise.race([promise.then(() => true, () => true), timeout])
  if (timer) clearTimeout(timer)
  return settled
}
