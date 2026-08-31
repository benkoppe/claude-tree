const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000
const STDERR_LIMIT = 8_192

export interface CodexGitInfo {
  branch: string | null
  originUrl?: string | null
  sha?: string | null
}

export type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress"

export interface CodexTurn {
  id: string
  items: CodexThreadItem[]
  status: CodexTurnStatus
  [key: string]: unknown
}

export interface CodexThread {
  id: string
  name: string | null
  preview: string
  updatedAt: number
  cwd: string
  gitInfo: CodexGitInfo | null
  turns: CodexTurn[]
  [key: string]: unknown
}

export type CodexUserInput =
  | { type: "text"; text: string; [key: string]: unknown }
  | { type: "image"; url: string; [key: string]: unknown }
  | { type: "localImage"; path: string; [key: string]: unknown }
  | { type: "audio"; url: string; [key: string]: unknown }
  | { type: "localAudio"; path: string; [key: string]: unknown }
  | { type: "skill"; name: string; path: string; [key: string]: unknown }
  | { type: "mention"; name: string; path: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown }

export type CodexThreadItem =
  | { type: "userMessage"; id: string; content: CodexUserInput[]; [key: string]: unknown }
  | { type: "agentMessage"; id: string; text: string; [key: string]: unknown }
  | { type: string; id: string; [key: string]: unknown }

export interface CodexThreadListPage {
  data: CodexThread[]
  nextCursor: string | null
}

export interface CodexThreadListParams {
  cwd: string
  cursor?: string
  modelProviders: readonly string[]
  sourceKinds: readonly ("cli" | "vscode" | "appServer")[]
  sortKey: "updated_at"
}

export interface CodexAppServer {
  listThreads(params: CodexThreadListParams): Promise<CodexThreadListPage>
  listLoadedThreadIds(): Promise<string[]>
  readThread(threadId: string, includeTurns?: boolean): Promise<CodexThread>
  forkThread(threadId: string, lastTurnId: string, cwd: string): Promise<CodexThread>
  close(): Promise<void>
}

export type CodexAppServerFactory = () => Promise<CodexAppServer>

export interface CodexAppServerProcess {
  readonly stdin: {
    write(data: string): number | Promise<number>
    flush(): number | Promise<number>
    end(): void
  }
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
}

export interface CodexAppServerOptions {
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  spawn?: (command: string[]) => CodexAppServerProcess
}

interface PendingRequest {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class CodexProtocolError extends Error {}

export class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`Codex app-server ${method} failed (${code}): ${message}`)
  }
}

export class CodexAppServerClient implements CodexAppServer {
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly expiredRequestIds = new Set<number>()
  private readonly stdoutTask: Promise<void>
  private readonly stderrTask: Promise<void>
  private stderrText = ""
  private failure: Error | undefined
  private closing = false
  private closed = false

  private constructor(
    private readonly process: CodexAppServerProcess,
    private readonly requestTimeoutMs: number,
    private readonly shutdownTimeoutMs: number,
  ) {
    this.stdoutTask = this.readStdout()
    this.stderrTask = this.readStderr()
  }

  static async start(
    executable: string,
    options: CodexAppServerOptions = {},
  ): Promise<CodexAppServerClient> {
    const spawn = options.spawn ?? spawnCodex
    return this.initialize(spawn([executable, "app-server", "--stdio"]), options)
  }

  static async connect(
    remoteUrl: string,
    options: Omit<CodexAppServerOptions, "spawn"> & { bearerToken?: string } = {},
  ): Promise<CodexAppServerClient> {
    return this.initialize(await connectWebSocket(remoteUrl, options.bearerToken), options)
  }

  private static async initialize(
    process: CodexAppServerProcess,
    options: Omit<CodexAppServerOptions, "spawn">,
  ): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(
      process,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    )
    try {
      await client.request("initialize", {
        clientInfo: { name: "claude_tree", title: "claude-tree", version: "0.1.0" },
        capabilities: null,
      })
      await client.notify("initialized")
      return client
    } catch (error) {
      await client.close().catch(() => undefined)
      throw error
    }
  }

  async listThreads(params: CodexThreadListParams): Promise<CodexThreadListPage> {
    const result = expectRecord(await this.request("thread/list", params), "thread/list")
    if (!Array.isArray(result.data)) throw invalidResult("thread/list", "data must be an array")
    const nextCursor = result.nextCursor
    if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
      throw invalidResult("thread/list", "nextCursor must be a string or null")
    }
    return {
      data: result.data.map((thread) => parseThread(thread, "thread/list")),
      nextCursor: nextCursor ?? null,
    }
  }

  async readThread(threadId: string, includeTurns = true): Promise<CodexThread> {
    const result = expectRecord(await this.request("thread/read", {
      threadId,
      includeTurns,
    }), "thread/read")
    return parseThread(result.thread, "thread/read")
  }

  async listLoadedThreadIds(): Promise<string[]> {
    const result = expectRecord(await this.request("thread/loaded/list", {}), "thread/loaded/list")
    if (!Array.isArray(result.data) || result.data.some((id) => typeof id !== "string")) {
      throw invalidResult("thread/loaded/list", "data must be an array of strings")
    }
    return result.data
  }

  async forkThread(threadId: string, lastTurnId: string, cwd: string): Promise<CodexThread> {
    const result = expectRecord(await this.request("thread/fork", {
      threadId,
      lastTurnId,
      cwd,
      ephemeral: false,
    }), "thread/fork")
    return parseThread(result.thread, "thread/fork")
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closing = true
    try {
      this.process.stdin.end()
    } catch {
      // The process may already have closed stdin after an earlier protocol failure.
    }

    let exited = await settlesWithin(this.process.exited, this.shutdownTimeoutMs)
    if (!exited) {
      this.process.kill("SIGTERM")
      exited = await settlesWithin(this.process.exited, this.shutdownTimeoutMs)
    }
    if (!exited) {
      this.process.kill("SIGKILL")
      exited = await settlesWithin(this.process.exited, this.shutdownTimeoutMs)
    }
    if (!exited) throw new Error("Codex app-server did not exit after SIGKILL")

    await Promise.all([this.stdoutTask, this.stderrTask])
    this.closed = true
    const exitCode = await this.process.exited
    if (exitCode !== 0 && !this.failure) {
      throw new Error(
        `Codex app-server exited with code ${exitCode}${this.stderrText ? `: ${this.stderrText}` : ""}`,
      )
    }
  }

  private async request<Result>(method: string, params: unknown): Promise<Result> {
    if (this.failure) throw this.failure
    if (this.closing) throw new Error("Codex app-server is closing")
    const id = this.nextRequestId++
    const result = new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.expiredRequestIds.add(id)
        reject(new Error(`Codex app-server ${method} timed out after ${this.requestTimeoutMs}ms`))
      }, this.requestTimeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as Result),
        reject,
        timer,
      })
    })
    try {
      await this.write({ id, method, params })
    } catch (error) {
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(asError(error))
      }
    }
    return result
  }

  private notify(method: string): Promise<void> {
    return this.write({ method })
  }

  private async write(message: unknown): Promise<void> {
    if (this.failure) throw this.failure
    await this.process.stdin.write(`${JSON.stringify(message)}\n`)
    await this.process.stdin.flush()
  }

  private async readStdout(): Promise<void> {
    try {
      const reader = this.process.stdout.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) this.handleLine(line)
          newline = buffer.indexOf("\n")
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) this.handleLine(buffer.trim())
      if (!this.closing && this.pending.size > 0) {
        this.fail(new Error(`Codex app-server closed unexpectedly${this.stderrText ? `: ${this.stderrText}` : ""}`))
      }
    } catch (error) {
      this.fail(asError(error))
    }
  }

  private handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.fail(new CodexProtocolError(`Codex app-server emitted invalid JSONL: ${line}`))
      return
    }
    if (!isRecord(message)) {
      this.fail(new CodexProtocolError("Codex app-server emitted a non-object message"))
      return
    }

    if (typeof message.id !== "number") {
      if (typeof message.method === "string") return
      this.fail(new CodexProtocolError("Codex app-server emitted a message without an id or method"))
      return
    }
    if (typeof message.method === "string") {
      void this.write({
        id: message.id,
        error: { code: -32601, message: `Unsupported server request: ${message.method}` },
      }).catch((error: unknown) => this.fail(asError(error)))
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) {
      if (this.expiredRequestIds.delete(message.id)) return
      this.fail(new CodexProtocolError(`Codex app-server responded with unknown id ${message.id}`))
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(message.id)

    if ("error" in message) {
      if (!isRecord(message.error) || typeof message.error.code !== "number" || typeof message.error.message !== "string") {
        pending.reject(new CodexProtocolError(`Codex app-server returned a malformed error for ${pending.method}`))
        return
      }
      pending.reject(new CodexRpcError(pending.method, message.error.code, message.error.message, message.error.data))
      return
    }
    if (!("result" in message)) {
      pending.reject(new CodexProtocolError(`Codex app-server returned no result for ${pending.method}`))
      return
    }
    pending.resolve(message.result)
  }

  private async readStderr(): Promise<void> {
    try {
      const reader = this.process.stderr.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.stderrText = (this.stderrText + decoder.decode(value, { stream: true })).slice(-STDERR_LIMIT)
      }
      this.stderrText = (this.stderrText + decoder.decode()).trim().slice(-STDERR_LIMIT)
    } catch {
      // Stderr is diagnostic only; stdout and exit status remain authoritative.
    }
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export function createCodexAppServerFactory(
  executable: string,
  options?: CodexAppServerOptions,
): CodexAppServerFactory {
  return () => CodexAppServerClient.start(executable, options)
}

function spawnCodex(command: string[]): CodexAppServerProcess {
  return Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
}

async function connectWebSocket(
  remoteUrl: string,
  bearerToken?: string,
): Promise<CodexAppServerProcess> {
  const encoder = new TextEncoder()
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>
  let stdoutClosed = false
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller
    },
  })
  const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
  let resolveExited!: (exitCode: number) => void
  const exited = new Promise<number>((resolve) => { resolveExited = resolve })
  const socket = new WebSocket(
    remoteUrl,
    bearerToken ? { headers: { Authorization: `Bearer ${bearerToken}` } } : undefined,
  )
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.removeEventListener("error", onError)
      resolve()
    }
    const onError = () => {
      socket.removeEventListener("open", onOpen)
      reject(new Error(`Unable to connect to Codex app-server at ${remoteUrl}`))
    }
    socket.addEventListener("open", onOpen, { once: true })
    socket.addEventListener("error", onError, { once: true })
  })

  socket.addEventListener("message", (event) => {
    if (stdoutClosed) return
    if (typeof event.data !== "string") {
      stdoutClosed = true
      stdoutController.error(
        new CodexProtocolError("Codex app-server sent a non-text WebSocket message"),
      )
      return
    }
    stdoutController.enqueue(encoder.encode(`${event.data}\n`))
  })
  socket.addEventListener(
    "close",
    (event) => {
      if (!stdoutClosed) {
        stdoutClosed = true
        stdoutController.close()
      }
      resolveExited(event.code === 1000 ? 0 : 1)
    },
    { once: true },
  )

  return {
    stdin: {
      write(data) {
        socket.send(data.trimEnd())
        return data.length
      },
      flush() {
        return 0
      },
      end() {
        socket.close(1000)
      },
    },
    stdout,
    stderr,
    exited,
    kill() {
      socket.close(1000)
    },
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseThread(value: unknown, method: string): CodexThread {
  const thread = expectRecord(value, method)
  if (typeof thread.id !== "string") throw invalidResult(method, "thread.id must be a string")
  if (thread.name !== null && typeof thread.name !== "string") {
    throw invalidResult(method, "thread.name must be a string or null")
  }
  if (typeof thread.preview !== "string") {
    throw invalidResult(method, "thread.preview must be a string")
  }
  if (typeof thread.updatedAt !== "number") {
    throw invalidResult(method, "thread.updatedAt must be a number")
  }
  if (typeof thread.cwd !== "string") throw invalidResult(method, "thread.cwd must be a string")
  if (!Array.isArray(thread.turns)) throw invalidResult(method, "thread.turns must be an array")

  for (const turnValue of thread.turns) {
    const turn = expectRecord(turnValue, method)
    if (typeof turn.id !== "string") throw invalidResult(method, "turn.id must be a string")
    if (!isTurnStatus(turn.status)) throw invalidResult(method, "turn.status is not recognized")
    if (!Array.isArray(turn.items)) throw invalidResult(method, "turn.items must be an array")
    for (const itemValue of turn.items) {
      const item = expectRecord(itemValue, method)
      if (typeof item.id !== "string" || typeof item.type !== "string") {
        throw invalidResult(method, "thread items must have string id and type fields")
      }
    }
  }

  return thread as CodexThread
}

function expectRecord(value: unknown, method: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw invalidResult(method, "expected an object")
  }
  return value
}

function isTurnStatus(value: unknown): value is CodexTurnStatus {
  return value === "completed" || value === "interrupted" || value === "failed" || value === "inProgress"
}

function invalidResult(method: string, detail: string): CodexProtocolError {
  return new CodexProtocolError(`Codex app-server ${method} returned an invalid result: ${detail}`)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
