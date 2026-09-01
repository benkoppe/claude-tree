import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"

import {
  BranchCreatedError,
  type AgentMessage,
  type AgentProvider,
  type AgentSession,
  type AgentSessionSnapshot,
  type BranchDerivation,
  type MessageRef,
  type PreparedBranch,
  type PreparedSession,
  type TerminalLaunch,
  type TerminalObserver,
  type TerminalSessionTransition,
  type TerminalSessionTransitionSource,
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
import {
  createCodexTuiProxy,
  type CodexTuiSwitch,
} from "./codex-tui-proxy"

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
  canonicalize?: (path: string) => Promise<string>
  newSessionFactory?: CodexNewSessionFactory
  resumeSessionFactory?: CodexResumeSessionFactory
}

export interface CodexNewSession {
  sessionId: string
  threadStarted: Promise<AgentSession>
  remoteUrl: string
  bearerToken: string
  transitions: TerminalSessionTransitionSource
  cleanup(): Promise<void>
}

export type CodexNewSessionFactory = (
  executable: string,
  projectPath: string,
  transitionFor: Parameters<CodexResumeSessionFactory>[3],
) => Promise<CodexNewSession>

export interface CodexResumeSession {
  remoteUrl: string
  bearerToken: string
  transitions: TerminalSessionTransitionSource
  cleanup(): Promise<void>
}

export type CodexResumeSessionFactory = (
  executable: string,
  projectPath: string,
  sessionId: string,
  transitionFor: (observed: CodexTuiSwitch) => {
    session: AgentSession
    derivation?: Promise<BranchDerivation | undefined>
  },
) => Promise<CodexResumeSession>

export class CodexProvider implements AgentProvider {
  readonly id = "codex"
  readonly displayName = "Codex"
  readonly navigatorIdentity = { label: "Codex", color: theme.codex }

  constructor(
    private readonly projectPath: string,
    private readonly executable: string,
    private readonly appServerFactory: CodexAppServerFactory = createCodexAppServerFactory(executable),
    private readonly observerFactory: () => TerminalObserver = () => new CodexTerminalObserver(),
    private readonly newSessionFactory: CodexNewSessionFactory = createCodexNewSession,
    private readonly resumeSessionFactory: CodexResumeSessionFactory = createCodexResumeSession,
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
    const created = await this.newSessionFactory(
      this.executable,
      this.projectPath,
      (transition) => ({
        session: sessionFromObservedThread(transition.thread),
        ...(transition.method === "thread/fork"
          ? { derivation: this.deriveNativeFork(transition) }
          : {}),
      }),
    )
    const startedSession = created.threadStarted.then((session) => ({ ...session, transient: true }))
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
        sessionTransitions: created.transitions,
        cleanup: created.cleanup,
      },
      startedSession,
    }
  }

  async prepareResume(session: AgentSession): Promise<TerminalLaunch> {
    return this.prepareObservedLaunch(session.id)
  }

  async branchFrom(target: MessageRef): Promise<PreparedBranch> {
    const prepared = await this.withServer(async (server) => {
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
        transcript: childTranscript,
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
    const { transcript, ...branch } = prepared
    try {
      return {
        ...branch,
        launch: await this.prepareObservedLaunch(prepared.session.id),
      }
    } catch (error) {
      throw new BranchCreatedError(
        prepared.session,
        transcript,
        true,
        `Fork ${prepared.session.id} was created, but its terminal could not be prepared: ${errorMessage(error)}`,
        { cause: error },
      )
    }
  }

  private launch(
    sessionId: string,
    remoteUrl?: string,
    bearerToken?: string,
    cleanup?: () => Promise<void>,
    sessionTransitions?: TerminalSessionTransitionSource,
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
      ...(sessionTransitions === undefined ? {} : { sessionTransitions }),
      ...(cleanup === undefined ? {} : { cleanup }),
    }
  }

  private async prepareObservedLaunch(sessionId: string): Promise<TerminalLaunch> {
    const observed = await this.resumeSessionFactory(
      this.executable,
      this.projectPath,
      sessionId,
      (transition) => ({
        session: sessionFromObservedThread(transition.thread),
        ...(transition.method === "thread/fork"
          ? { derivation: this.deriveNativeFork(transition) }
          : {}),
      }),
    )
    return this.launch(
      sessionId,
      observed.remoteUrl,
      observed.bearerToken,
      observed.cleanup,
      observed.transitions,
    )
  }

  private deriveNativeFork(observed: CodexTuiSwitch): Promise<BranchDerivation | undefined> {
    return this.withServer(async (server) => {
      const childSessionId = observed.thread.id
      if (typeof childSessionId !== "string") {
        throw new Error("Codex reported a fork without a thread ID")
      }
      const [parentThread, childThread] = await Promise.all([
        server.readThread(observed.previousThreadId),
        server.readThread(childSessionId),
      ])
      const parent = normalizeCodexThread(parentThread)
      const child = normalizeCodexThread(childThread)
      if (child.length > parent.length) {
        throw new Error(`Fork ${childSessionId} contains history not present in its source`)
      }
      for (let index = 0; index < child.length; index += 1) {
        if (!sameCopiedCodexMessage(parent[index]!, child[index]!)) {
          throw new Error(`Fork ${childSessionId} copied history does not match its source`)
        }
      }

      const sourceMessageId = parent[child.length - 1]?.id
      if (!sourceMessageId) return undefined
      return {
        childSessionId,
        parentSessionId: observed.previousThreadId,
        sourceMessageId,
        sharedMessages: child.map((message, index) => ({
          parentMessageId: parent[index]!.id,
          childMessageId: message.id,
        })),
      }
    })
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
  const canonicalPath = await (dependencies.canonicalize ?? realpath)(projectPath)
  return new CodexProvider(
    canonicalPath,
    executable,
    dependencies.appServerFactory ?? createCodexAppServerFactory(executable),
    dependencies.observerFactory,
    dependencies.newSessionFactory,
    dependencies.resumeSessionFactory,
  )
}

export async function createCodexResumeSession(
  executable: string,
  _projectPath: string,
  sessionId: string,
  transitionFor: Parameters<CodexResumeSessionFactory>[3],
): Promise<CodexResumeSession> {
  const sidecar = await startCodexSidecar(executable)
  let proxy: Awaited<ReturnType<typeof createCodexTuiProxy>> | undefined
  let cleanupPromise: Promise<void> | undefined
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      const results = await Promise.allSettled([
        proxy?.cleanup() ?? Promise.resolve(),
        sidecar.cleanup(),
      ])
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, "Unable to stop the Codex session services")
    })()
    return cleanupPromise
  }
  try {
    const probe = await connectToCodexAppServer(
      sidecar.remoteUrl,
      sidecar.bearerToken,
      sidecar.process,
      sidecar.stderr,
    )
    await probe.close()
    proxy = await createCodexTuiProxy(
      sidecar.remoteUrl,
      sidecar.bearerToken,
      sessionId,
      transitionFor,
    )
    return {
      remoteUrl: proxy.remoteUrl,
      bearerToken: sidecar.bearerToken,
      transitions: proxy.transitions,
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

interface CodexSidecar {
  remoteUrl: string
  bearerToken: string
  process: Bun.Subprocess
  stderr: Promise<string>
  cleanup(): Promise<void>
}

async function startCodexSidecar(executable: string): Promise<CodexSidecar> {
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
  let cleanupPromise: Promise<void> | undefined
  return {
    remoteUrl,
    bearerToken,
    process,
    stderr,
    cleanup() {
      cleanupPromise ??= (async () => {
        if (process.exitCode === null) signalProcessGroup(process, "SIGTERM")
        if (!(await settlesWithin(process.exited, 1_000)) && process.exitCode === null) {
          signalProcessGroup(process, "SIGKILL")
          await settlesWithin(process.exited, 1_000)
        }
        if (process.exitCode === null) {
          process.unref()
          throw new Error("Codex app-server did not stop after SIGKILL")
        }
      })().finally(async () => {
        await rm(directory, { recursive: true, force: true })
      })
      return cleanupPromise
    },
  }
}

export async function createCodexNewSession(
  executable: string,
  _projectPath: string,
  transitionFor: Parameters<CodexNewSessionFactory>[2],
): Promise<CodexNewSession> {
  const sidecar = await startCodexSidecar(executable)
  const sessionId = `pending-codex-${crypto.randomUUID()}`
  let threadSettled = false
  let resolveThread!: (session: AgentSession) => void
  let rejectThread!: (error: Error) => void
  const threadStarted = new Promise<AgentSession>((resolve, reject) => {
    resolveThread = resolve
    rejectThread = reject
  })
  void threadStarted.catch(() => undefined)
  const laterTransitions = transitionChannel()
  let proxy: Awaited<ReturnType<typeof createCodexTuiProxy>> | undefined
  let unsubscribeProxy: (() => void) | undefined
  let cleanupPromise: Promise<void> | undefined
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      if (!threadSettled) {
        threadSettled = true
        rejectThread(new Error("Codex exited before starting its new thread"))
      }
      unsubscribeProxy?.()
      const results = await Promise.allSettled([
        proxy?.cleanup() ?? Promise.resolve(),
        sidecar.cleanup(),
      ])
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, "Unable to stop the Codex session services")
    })()
    return cleanupPromise
  }

  try {
    const probe = await connectToCodexAppServer(
      sidecar.remoteUrl,
      sidecar.bearerToken,
      sidecar.process,
      sidecar.stderr,
    )
    await probe.close()
    proxy = await createCodexTuiProxy(
      sidecar.remoteUrl,
      sidecar.bearerToken,
      sessionId,
      transitionFor,
    )
    unsubscribeProxy = proxy.transitions.subscribe(
      (transition) => {
        if (!threadSettled) {
          threadSettled = true
          resolveThread(transition.session)
        }
        laterTransitions.emit(transition)
      },
      (error) => {
        if (threadSettled) {
          laterTransitions.fail(error)
        } else {
          threadSettled = true
          rejectThread(error)
        }
      },
    )
    return {
      sessionId,
      threadStarted,
      remoteUrl: proxy.remoteUrl,
      bearerToken: sidecar.bearerToken,
      transitions: laterTransitions.source,
      cleanup,
    }
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
        copyIdentity: JSON.stringify(withoutItemId(item)) ?? "undefined",
        turnId: turn.id,
        turnStatus: turn.status,
        itemIndex,
        turnComplete: turn.status !== "inProgress",
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
    if (!sameCopiedCodexMessage(parentMessage, childMessage)) {
      throw new Error(`Fork ${childSessionId} was created, but its copied prefix does not match the source`)
    }
  }
}

function sameCopiedCodexMessage(parent: CodexMessage, child: CodexMessage): boolean {
  return (
    parent.role === child.role &&
    parent.visible === child.visible &&
    parent.turnStatus === child.turnStatus &&
    parent.itemIndex === child.itemIndex &&
    isDeepStrictEqual(withoutItemId(parent.rawItem), withoutItemId(child.rawItem))
  )
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

function sessionFromObservedThread(thread: Record<string, unknown>): AgentSession {
  const gitInfo = typeof thread.gitInfo === "object" && thread.gitInfo !== null
    ? thread.gitInfo as Record<string, unknown>
    : undefined
  return {
    id: String(thread.id),
    title: normalizePreview(firstNonempty(
      typeof thread.name === "string" ? thread.name : undefined,
      typeof thread.preview === "string" ? thread.preview : undefined,
    ) ?? "Untitled conversation"),
    lastModified: typeof thread.updatedAt === "number" ? thread.updatedAt * 1_000 : Date.now(),
    ...(typeof gitInfo?.branch === "string" ? { gitBranch: gitInfo.branch } : {}),
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

function transitionChannel(): {
  source: TerminalSessionTransitionSource
  emit(transition: TerminalSessionTransition): void
  fail(error: Error): void
} {
  const listeners = new Set<{
    transition: (transition: TerminalSessionTransition) => void
    error: (error: Error) => void
  }>()
  return {
    source: {
      subscribe(onTransition, onError) {
        const listener = { transition: onTransition, error: onError }
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    emit(transition) {
      for (const listener of listeners) listener.transition(transition)
    },
    fail(error) {
      for (const listener of listeners) listener.error(error)
    },
  }
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
