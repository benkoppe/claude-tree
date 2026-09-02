import { Data, Deferred, Effect, Schema, Scope } from "effect"

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000
const DEFAULT_JSONL_RECORD_LIMIT_BYTES = 1_024 * 1_024
const STDERR_LIMIT_BYTES = 8_192
const EXPIRED_REQUEST_LIMIT = 1_024

export interface CodexGitInfo {
  readonly branch: string | null
  readonly originUrl?: string | null
  readonly sha?: string | null
}

export type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress"

export type CodexUserInput =
  | { readonly type: "text"; readonly text: string; readonly [key: string]: unknown }
  | { readonly type: "image"; readonly url: string; readonly [key: string]: unknown }
  | { readonly type: "localImage"; readonly path: string; readonly [key: string]: unknown }
  | { readonly type: "audio"; readonly url: string; readonly [key: string]: unknown }
  | { readonly type: "localAudio"; readonly path: string; readonly [key: string]: unknown }
  | { readonly type: "skill"; readonly name: string; readonly path: string; readonly [key: string]: unknown }
  | { readonly type: "mention"; readonly name: string; readonly path: string; readonly [key: string]: unknown }
  | { readonly type: string; readonly [key: string]: unknown }

export type CodexThreadItem =
  | {
      readonly type: "userMessage"
      readonly id: string
      readonly content: readonly CodexUserInput[]
      readonly [key: string]: unknown
    }
  | {
      readonly type: "agentMessage"
      readonly id: string
      readonly text: string
      readonly [key: string]: unknown
    }
  | { readonly type: string; readonly id: string; readonly [key: string]: unknown }

export interface CodexTurn {
  readonly id: string
  readonly items: readonly CodexThreadItem[]
  readonly status: CodexTurnStatus
  readonly [key: string]: unknown
}

export interface CodexThread {
  readonly id: string
  readonly name: string | null
  readonly preview: string
  readonly updatedAt: number
  readonly cwd: string
  readonly gitInfo: CodexGitInfo | null
  readonly turns: readonly CodexTurn[]
  readonly [key: string]: unknown
}

export interface CodexThreadListPage {
  readonly data: readonly CodexThread[]
  readonly nextCursor: string | null
}

export interface CodexThreadListParams {
  readonly cwd: string
  readonly cursor?: string
  readonly modelProviders: readonly string[]
  readonly sourceKinds: readonly ("cli" | "vscode" | "appServer")[]
  readonly sortKey: "updated_at"
}

export class CodexProtocolError extends Data.TaggedError("CodexProtocolError")<{
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class CodexRpcError extends Data.TaggedError("CodexRpcError")<{
  readonly method: string
  readonly code: number
  readonly message: string
  readonly data?: unknown
}> {}

export class CodexRequestTimeout extends Data.TaggedError("CodexRequestTimeout")<{
  readonly method: string
  readonly timeoutMs: number
}> {}

export class CodexProcessError extends Data.TaggedError("CodexProcessError")<{
  readonly operation: string
  readonly message: string
  readonly exitCode?: number
  readonly stderr?: string
  readonly cause?: unknown
}> {}

export class CodexConnectionError extends Data.TaggedError("CodexConnectionError")<{
  readonly url: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class CodexCleanupError extends Data.TaggedError("CodexCleanupError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type CodexAppServerError =
  | CodexProtocolError
  | CodexRpcError
  | CodexRequestTimeout
  | CodexProcessError
  | CodexConnectionError

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
  readonly requestTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly maxJsonlRecordBytes?: number
  readonly spawn?: (command: readonly string[]) => CodexAppServerProcess
}

export interface CodexSidecarOptions {
  readonly bearerToken: string
  readonly requestTimeoutMs?: number
  readonly connectTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly maxJsonlRecordBytes?: number
}

export interface CodexAppServerClient {
  readonly listThreads: (
    params: CodexThreadListParams,
  ) => Effect.Effect<CodexThreadListPage, CodexAppServerError>
  readonly listLoadedThreadIds: () => Effect.Effect<readonly string[], CodexAppServerError>
  readonly readThread: (
    threadId: string,
    includeTurns?: boolean,
  ) => Effect.Effect<CodexThread, CodexAppServerError>
  readonly forkThread: (
    threadId: string,
    lastTurnId: string,
    cwd: string,
  ) => Effect.Effect<CodexThread, CodexAppServerError>
  readonly close: () => Effect.Effect<void, CodexCleanupError>
}

interface PendingRequest {
  readonly method: string
  readonly deferred: Deferred.Deferred<unknown, CodexAppServerError>
}

interface CodexTransport {
  readonly stdin: CodexAppServerProcess["stdin"]
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  readonly terminate: (signal: "SIGTERM" | "SIGKILL") => void
}

const GitInfoSchema = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  originUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sha: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const ThreadItemSchema = Schema.Struct({ id: Schema.String, type: Schema.String })
const TurnSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.Union([
    Schema.Literal("completed"),
    Schema.Literal("interrupted"),
    Schema.Literal("failed"),
    Schema.Literal("inProgress"),
  ]),
  items: Schema.Array(ThreadItemSchema),
})
const ThreadSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  preview: Schema.String,
  updatedAt: Schema.Number,
  cwd: Schema.String,
  gitInfo: Schema.NullOr(GitInfoSchema),
  turns: Schema.Array(TurnSchema),
})
const ThreadListSchema = Schema.Struct({
  data: Schema.Array(ThreadSchema),
  nextCursor: Schema.NullOr(Schema.String),
})
const LoadedThreadListSchema = Schema.Struct({ data: Schema.Array(Schema.String) })

class ClientImpl implements CodexAppServerClient {
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly expiredRequestIds = new Set<number>()
  private readonly expiredRequestOrder: number[] = []
  private readonly stdoutTask: Promise<void>
  private readonly stderrTask: Promise<void>
  private stderrBytes = new Uint8Array()
  private writeTail: Promise<void> = Promise.resolve()
  private closeTask: Promise<void> | undefined
  private failure: CodexAppServerError | undefined
  private closing = false
  private closed = false
  private stdoutReader: { cancel(reason?: unknown): Promise<void> } | undefined
  private stderrReader: { cancel(reason?: unknown): Promise<void> } | undefined

  constructor(
    private readonly transport: CodexTransport,
    private readonly requestTimeoutMs: number,
    private readonly shutdownTimeoutMs: number,
    private readonly maxJsonlRecordBytes: number,
  ) {
    this.stdoutTask = this.readStdout()
    this.stderrTask = this.readStderr()
    void transport.exited.then(
      (exitCode) => {
        if (!this.closing) {
          this.failAll(new CodexProcessError({
            operation: "run",
            message: `Codex app-server exited unexpectedly with code ${exitCode}`,
            exitCode,
            ...(this.stderrText ? { stderr: this.stderrText } : {}),
          }))
        }
      },
      (cause) => this.failAll(new CodexProcessError({
        operation: "run",
        message: "Unable to observe Codex app-server exit",
        cause,
      })),
    )
  }

  initialize(): Effect.Effect<void, CodexAppServerError> {
    const self = this
    return Effect.gen(function*() {
      const result = yield* self.request("initialize", {
        clientInfo: { name: "claude_tree", title: "claude-tree", version: "0.1.0" },
        capabilities: null,
      })
      yield* decodeResult(Schema.Struct({}), result, "initialize")
      yield* self.notify("initialized")
    })
  }

  listThreads = (params: CodexThreadListParams): Effect.Effect<CodexThreadListPage, CodexAppServerError> =>
    this.request("thread/list", params).pipe(
      Effect.flatMap((result) => decodeResult(ThreadListSchema, result, "thread/list").pipe(
        Effect.flatMap((page) => {
          const sourceData = isRecord(result) && Array.isArray(result.data) ? result.data : page.data
          return Effect.all(sourceData.map((thread) => decodeThreadValue(thread, "thread/list"))).pipe(
            Effect.flatMap((data) => validateUniqueIds(
              data.map((thread) => thread.id),
              "thread/list",
              "thread ids",
            ).pipe(Effect.as({ data, nextCursor: page.nextCursor }))),
          )
        }),
      )),
    )

  listLoadedThreadIds = (): Effect.Effect<readonly string[], CodexAppServerError> =>
    this.request("thread/loaded/list", {}).pipe(
      Effect.flatMap((result) => decodeResult(LoadedThreadListSchema, result, "thread/loaded/list")),
      Effect.flatMap((result) => validateUniqueIds(
        result.data,
        "thread/loaded/list",
        "loaded thread ids",
      ).pipe(Effect.as(result.data))),
    )

  readThread = (threadId: string, includeTurns = true): Effect.Effect<CodexThread, CodexAppServerError> =>
    validateIdentifier(threadId, "thread/read", "requested thread id").pipe(
      Effect.andThen(this.request("thread/read", { threadId, includeTurns })),
      Effect.flatMap((result) => decodeThreadEnvelope(result, "thread/read")),
      Effect.flatMap((thread) => thread.id === threadId
        ? Effect.succeed(thread)
        : Effect.fail(invalidResult("thread/read", `response thread id ${JSON.stringify(thread.id)} did not match ${JSON.stringify(threadId)}`))),
    )

  forkThread = (
    threadId: string,
    lastTurnId: string,
    cwd: string,
  ): Effect.Effect<CodexThread, CodexAppServerError> =>
    Effect.all([
      validateIdentifier(threadId, "thread/fork", "source thread id"),
      validateIdentifier(lastTurnId, "thread/fork", "last turn id"),
    ]).pipe(
      Effect.andThen(this.request("thread/fork", { threadId, lastTurnId, cwd, ephemeral: false })),
      Effect.flatMap((result) => decodeThreadEnvelope(result, "thread/fork")),
      Effect.flatMap((thread) => thread.id !== threadId
        ? Effect.succeed(thread)
        : Effect.fail(invalidResult("thread/fork", "forked thread id matched the source thread id"))),
    )

  close = (): Effect.Effect<void, CodexCleanupError> => Effect.tryPromise({
    try: () => {
      this.closeTask ??= this.closePromise()
      return this.closeTask
    },
    catch: (cause) => cause instanceof CodexCleanupError
      ? cause
      : new CodexCleanupError({ message: "Failed to close Codex app-server", cause }),
  })

  private request(method: string, params: unknown): Effect.Effect<unknown, CodexAppServerError> {
    const self = this
    return Effect.gen(function*() {
      if (self.failure) return yield* Effect.fail(self.failure)
      if (self.closing) {
        return yield* Effect.fail(new CodexProcessError({
          operation: method,
          message: "Codex app-server is closing",
        }))
      }

      const id = self.nextRequestId++
      const deferred = yield* Deferred.make<unknown, CodexAppServerError>()
      const execute = Effect.gen(function*() {
        self.pending.set(id, { method, deferred })
        yield* self.write({ id, method, params }).pipe(
          Effect.catch((error) => Effect.sync(() => self.failAll(error))),
        )
        return yield* Deferred.await(deferred)
      })
      return yield* execute.pipe(
        Effect.timeoutOrElse({
          duration: self.requestTimeoutMs,
          orElse: () => Effect.fail(new CodexRequestTimeout({
            method,
            timeoutMs: self.requestTimeoutMs,
          })),
        }),
        Effect.ensuring(Effect.sync(() => {
          if (self.pending.get(id)?.deferred === deferred) {
            self.pending.delete(id)
            self.rememberExpired(id)
          }
        })),
      )
    })
  }

  private notify(method: string): Effect.Effect<void, CodexAppServerError> {
    return this.write({ method })
  }

  private write(message: unknown): Effect.Effect<void, CodexAppServerError> {
    if (this.failure) return Effect.fail(this.failure)
    return Effect.tryPromise({
      try: () => {
        const write = this.writeTail.then(async () => {
          if (this.failure) throw this.failure
          await this.transport.stdin.write(`${JSON.stringify(message)}\n`)
          await this.transport.stdin.flush()
        })
        this.writeTail = write.then(() => undefined, () => undefined)
        return write
      },
      catch: (cause) => isCodexAppServerError(cause)
        ? cause
        : new CodexProcessError({
            operation: "write",
            message: "Unable to write to Codex app-server",
            cause,
          }),
    })
  }

  private async readStdout(): Promise<void> {
    try {
      const reader = this.transport.stdout.getReader()
      this.stdoutReader = reader
      const decoder = new TextDecoder("utf-8", { fatal: true })
      let buffer: Uint8Array = new Uint8Array()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        let start = 0
        for (let index = 0; index < value.byteLength; index += 1) {
          if (value[index] !== 0x0a) continue
          const segment = value.subarray(start, index)
          if (buffer.byteLength + segment.byteLength > this.maxJsonlRecordBytes) {
            this.failProtocol("read", `Codex app-server JSONL record exceeded ${this.maxJsonlRecordBytes} bytes`)
            return
          }
          const record = concatenateBytes(buffer, segment)
          buffer = new Uint8Array()
          if (record.byteLength > 0 && record[record.byteLength - 1] === 0x0d) {
            this.failProtocol("read", "CRLF is not valid Codex JSONL framing")
          } else if (record.byteLength === 0) {
            this.failProtocol("read", "Codex app-server emitted an empty JSONL record")
          } else {
            this.handleLine(decoder.decode(record))
          }
          if (this.failure) return
          start = index + 1
        }
        const remainder = value.subarray(start)
        if (buffer.byteLength + remainder.byteLength > this.maxJsonlRecordBytes) {
          this.failProtocol("read", `Codex app-server JSONL buffer exceeded ${this.maxJsonlRecordBytes} bytes`)
          return
        }
        buffer = concatenateBytes(buffer, remainder)
      }
      if (buffer.byteLength > 0 && !this.closing) {
        this.failProtocol("read", "Codex app-server closed with an unterminated JSONL record")
      } else if (!this.closing) {
        // Give the process observer one microtask to report its more useful exit code first.
        await Promise.resolve()
        if (!this.failure && !this.closing) {
          this.failAll(new CodexProcessError({
            operation: "read",
            message: "Codex app-server stdout closed unexpectedly",
            ...(this.stderrText ? { stderr: this.stderrText } : {}),
          }))
        }
      }
    } catch (cause) {
      if (!this.closing) {
        this.failAll(cause instanceof CodexProtocolError
          ? cause
          : new CodexProtocolError({
            operation: "read",
            message: "Codex app-server emitted invalid UTF-8",
            cause,
          }))
      }
    }
  }

  private handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch (cause) {
      this.failProtocol("read", "Codex app-server emitted invalid JSONL", cause)
      return
    }
    if (!isRecord(message)) {
      this.failProtocol("read", "Codex app-server emitted a non-object message")
      return
    }

    const hasId = Object.hasOwn(message, "id")
    const hasMethod = Object.hasOwn(message, "method")
    if (hasMethod) {
      if (typeof message.method !== "string") {
        this.failProtocol("read", "Codex app-server emitted a non-string method")
        return
      }
      if (!hasId) return
      if (typeof message.id !== "number" && typeof message.id !== "string") {
        this.failProtocol("read", "Codex app-server emitted a server request with an invalid id")
        return
      }
      Effect.runFork(this.write({
        id: message.id,
        error: { code: -32601, message: `Unsupported server request: ${message.method}` },
      }).pipe(Effect.catch((error) => Effect.sync(() => this.failAll(error)))))
      return
    }

    if (!hasId || typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
      this.failProtocol("read", "Codex app-server emitted a response with an invalid id")
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) {
      if (this.expiredRequestIds.delete(message.id)) return
      this.failProtocol("read", `Codex app-server responded with unknown id ${message.id}`)
      return
    }

    const hasResult = Object.hasOwn(message, "result")
    const hasError = Object.hasOwn(message, "error")
    if (hasResult === hasError) {
      this.failProtocol("read", `Codex app-server returned a malformed response for ${pending.method}`)
      return
    }
    if (hasError) {
      if (!isRecord(message.error) || typeof message.error.code !== "number" ||
        typeof message.error.message !== "string") {
        this.failProtocol("read", `Codex app-server returned a malformed error for ${pending.method}`)
        return
      }
      this.pending.delete(message.id)
      Effect.runSync(Deferred.fail(pending.deferred, new CodexRpcError({
        method: pending.method,
        code: message.error.code,
        message: message.error.message,
        ...(Object.hasOwn(message.error, "data") ? { data: message.error.data } : {}),
      })))
      return
    }

    this.pending.delete(message.id)
    Effect.runSync(Deferred.succeed(pending.deferred, message.result))
  }

  private async readStderr(): Promise<void> {
    try {
      const reader = this.transport.stderr.getReader()
      this.stderrReader = reader
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.appendStderr(value)
      }
    } catch {
      // Stderr is bounded diagnostic context; stdout and process exit remain authoritative.
    }
  }

  private appendStderr(chunk: Uint8Array): void {
    const retained = chunk.byteLength >= STDERR_LIMIT_BYTES
      ? chunk.slice(chunk.byteLength - STDERR_LIMIT_BYTES)
      : (() => {
          const keep = Math.min(this.stderrBytes.byteLength, STDERR_LIMIT_BYTES - chunk.byteLength)
          const bytes = new Uint8Array(keep + chunk.byteLength)
          bytes.set(this.stderrBytes.slice(this.stderrBytes.byteLength - keep))
          bytes.set(chunk, keep)
          return bytes
        })()
    this.stderrBytes = retained
  }

  private get stderrText(): string {
    return new TextDecoder().decode(this.stderrBytes).trim()
  }

  private failProtocol(operation: string, message: string, cause?: unknown): void {
    this.failAll(new CodexProtocolError({
      operation,
      message,
      ...(cause === undefined ? {} : { cause }),
    }))
  }

  private failAll(error: CodexAppServerError): void {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) {
      Effect.runSync(Deferred.fail(pending.deferred, error))
    }
    this.pending.clear()
  }

  private rememberExpired(id: number): void {
    this.expiredRequestIds.add(id)
    this.expiredRequestOrder.push(id)
    if (this.expiredRequestOrder.length > EXPIRED_REQUEST_LIMIT) {
      const oldest = this.expiredRequestOrder.shift()
      if (oldest !== undefined) this.expiredRequestIds.delete(oldest)
    }
  }

  private async closePromise(): Promise<void> {
    if (this.closed) return
    this.closing = true
    this.failAll(new CodexProcessError({ operation: "close", message: "Codex app-server is closing" }))
    const failures: unknown[] = []
    try {
      this.transport.stdin.end()
    } catch (cause) {
      failures.push(cause)
    }

    let exit = await settlementWithin(this.transport.exited, this.shutdownTimeoutMs)
    if (exit._tag !== "Fulfilled") {
      try {
        this.transport.terminate("SIGTERM")
      } catch (cause) {
        failures.push(cause)
      }
      exit = await settlementWithin(this.transport.exited, this.shutdownTimeoutMs)
    }
    if (exit._tag !== "Fulfilled") {
      try {
        this.transport.terminate("SIGKILL")
      } catch (cause) {
        failures.push(cause)
      }
      exit = await settlementWithin(this.transport.exited, this.shutdownTimeoutMs)
    }
    if (exit._tag === "Rejected") {
      failures.push(exit.cause)
    } else if (exit._tag === "TimedOut") {
      failures.push(new Error("Codex app-server did not exit after SIGKILL"))
    }

    const cancellations = [
      cancelReader(this.stdoutReader, this.transport.stdout),
      cancelReader(this.stderrReader, this.transport.stderr),
    ]
    const cleanupSettlements = await Promise.all([
      ...cancellations.map((promise) => settlementWithin(promise, this.shutdownTimeoutMs)),
      settlementWithin(this.stdoutTask, this.shutdownTimeoutMs),
      settlementWithin(this.stderrTask, this.shutdownTimeoutMs),
    ])
    for (const settlement of cleanupSettlements) {
      if (settlement._tag === "Rejected" && settlement.cause !== this.failure) failures.push(settlement.cause)
      else if (settlement._tag === "TimedOut") failures.push(new Error("Codex app-server stream cleanup timed out"))
    }
    this.closed = true
    if (failures.length > 0) {
      this.closeTask = undefined
      throw new CodexCleanupError({
        message: "Failed to clean up Codex app-server",
        cause: failures.length === 1 ? failures[0] : new AggregateError(failures),
      })
    }
  }
}

export function makeCodexAppServerClient(
  executable: string,
  options: CodexAppServerOptions = {},
): Effect.Effect<CodexAppServerClient, CodexAppServerError, Scope.Scope> {
  const acquire = Effect.try({
    try: () => {
      const process = (options.spawn ?? spawnCodex)([executable, "app-server", "--stdio"])
      return new ClientImpl(
        processTransport(process),
        positiveDuration(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
        positiveDuration(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS),
        positiveInteger(options.maxJsonlRecordBytes, DEFAULT_JSONL_RECORD_LIMIT_BYTES),
      )
    },
    catch: (cause) => new CodexProcessError({
      operation: "spawn",
      message: "Unable to spawn Codex app-server",
      cause,
    }),
  })

  return Effect.acquireRelease(
    acquire,
    (client) => client.close().pipe(Effect.orDie),
  ).pipe(
    Effect.tap((client) => client.initialize()),
  )
}

export function connectCodexAppServerSidecar(
  url: string,
  options: CodexSidecarOptions,
): Effect.Effect<CodexAppServerClient, CodexAppServerError, Scope.Scope> {
  const acquire = Effect.tryPromise({
    try: () => connectWebSocketTransport(
      url,
      options.bearerToken,
      positiveDuration(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
    ),
    catch: (cause) => cause instanceof CodexConnectionError || cause instanceof CodexProtocolError
      ? cause
      : new CodexConnectionError({ url, message: "Unable to connect to Codex sidecar", cause }),
  }).pipe(
    Effect.map((transport) => new ClientImpl(
      transport,
      positiveDuration(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
      positiveDuration(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS),
      positiveInteger(options.maxJsonlRecordBytes, DEFAULT_JSONL_RECORD_LIMIT_BYTES),
    )),
  )

  return Effect.acquireRelease(
    acquire,
    (client) => client.close().pipe(Effect.orDie),
  ).pipe(
    Effect.tap((client) => client.initialize()),
  )
}

function processTransport(process: CodexAppServerProcess): CodexTransport {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exited: process.exited,
    terminate: (signal) => process.kill(signal),
  }
}

function spawnCodex(command: readonly string[]): CodexAppServerProcess {
  return Bun.spawn([...command], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
}

async function connectWebSocketTransport(
  url: string,
  bearerToken: string,
  connectTimeoutMs: number,
): Promise<CodexTransport> {
  assertLoopbackWebSocketUrl(url)
  const encoder = new TextEncoder()
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>
  let stdoutSettled = false
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller
    },
  })
  const stderr = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
  let resolveExited!: (exitCode: number) => void
  let exitSettled = false
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve
  })
  const settleExit = (code: number) => {
    if (exitSettled) return
    exitSettled = true
    resolveExited(code)
  }
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  })

  socket.addEventListener("message", (event) => {
    if (stdoutSettled) return
    if (typeof event.data !== "string") {
      stdoutSettled = true
      stdoutController.error(new CodexProtocolError({
        operation: "read",
        message: "Codex sidecar sent a non-text WebSocket message",
      }))
      socket.terminate()
      settleExit(1)
      return
    }
    stdoutController.enqueue(encoder.encode(`${event.data}\n`))
  })
  socket.addEventListener("close", (event) => {
    if (!stdoutSettled) {
      stdoutSettled = true
      stdoutController.close()
    }
    settleExit(event.code === 1000 ? 0 : 1)
  }, { once: true })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new CodexConnectionError({
        url,
        message: `Timed out connecting to Codex sidecar after ${connectTimeoutMs}ms`,
      }))
    }, connectTimeoutMs)
    const cleanup = () => clearTimeout(timer)
    socket.addEventListener("open", () => {
      cleanup()
      resolve()
    }, { once: true })
    socket.addEventListener("error", (event) => {
      cleanup()
      socket.terminate()
      reject(new CodexConnectionError({
        url,
        message: "Unable to connect to Codex sidecar",
        cause: event,
      }))
    }, { once: true })
  })

  return {
    stdin: {
      write(data) {
        socket.send(data.endsWith("\n") ? data.slice(0, -1) : data)
        return data.length
      },
      flush: () => 0,
      end: () => socket.close(1000),
    },
    stdout,
    stderr,
    exited,
    terminate(signal) {
      if (signal === "SIGKILL") {
        socket.terminate()
        settleExit(1)
      } else {
        socket.close(1000)
      }
    },
  }
}

function decodeThreadEnvelope(
  value: unknown,
  operation: string,
): Effect.Effect<CodexThread, CodexProtocolError> {
  if (!isRecord(value) || !Object.hasOwn(value, "thread")) {
    return Effect.fail(invalidResult(operation, "expected a thread result"))
  }
  return decodeThreadValue(value.thread, operation)
}

function decodeThreadValue(
  value: unknown,
  operation: string,
): Effect.Effect<CodexThread, CodexProtocolError> {
  return decodeResult(ThreadSchema, value, operation).pipe(
    Effect.flatMap((decoded) => Effect.try({
      try: () => validateThreadDetails(rebuildThread(value, decoded), operation),
      catch: (cause) => cause instanceof CodexProtocolError
        ? cause
        : invalidResult(operation, "thread validation failed", cause),
    })),
  )
}

function decodeResult<A>(
  schema: Schema.Codec<A, unknown, never, never>,
  value: unknown,
  operation: string,
): Effect.Effect<A, CodexProtocolError> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => invalidResult(operation, "schema validation failed", cause)),
  )
}

function validateThreadDetails(
  source: CodexThread,
  operation: string,
): CodexThread {
  requireIdentifier(source.id, operation, "thread id")
  const turnIds = new Set<string>()
  const itemIds = new Set<string>()
  for (const turn of source.turns) {
    requireUniqueIdentifier(turn.id, turnIds, operation, "turn id")
    for (const item of turn.items) {
      requireUniqueIdentifier(item.id, itemIds, operation, "item id")
      if (item.type === "agentMessage" && typeof item.text !== "string") {
        throw invalidResult(operation, "agentMessage.text must be a string")
      }
      if (item.type === "userMessage") validateUserMessage(item, operation)
    }
  }
  return source
}

function rebuildThread(
  value: unknown,
  decoded: typeof ThreadSchema.Type,
): CodexThread {
  if (!isRecord(value) || !Array.isArray(value.turns)) throw new TypeError("Decoded thread source was invalid")
  const sourceTurns = value.turns
  const turns = decoded.turns.map((turn, turnIndex): CodexTurn => {
    const sourceTurn = sourceTurns[turnIndex]
    if (!isRecord(sourceTurn) || !Array.isArray(sourceTurn.items)) {
      throw new TypeError("Decoded turn source was invalid")
    }
    const sourceItems = sourceTurn.items
    const items = turn.items.map((item, itemIndex): CodexThreadItem => {
      const sourceItem = sourceItems[itemIndex]
      if (!isRecord(sourceItem)) throw new TypeError("Decoded item source was invalid")
      return { ...sourceItem, id: item.id, type: item.type } as CodexThreadItem
    })
    return { ...sourceTurn, id: turn.id, status: turn.status, items }
  })
  const gitInfo = decoded.gitInfo === null
    ? null
    : {
        ...(isRecord(value.gitInfo) ? value.gitInfo : {}),
        branch: decoded.gitInfo.branch,
        ...(decoded.gitInfo.originUrl === undefined ? {} : { originUrl: decoded.gitInfo.originUrl }),
        ...(decoded.gitInfo.sha === undefined ? {} : { sha: decoded.gitInfo.sha }),
      }
  return {
    ...value,
    id: decoded.id,
    name: decoded.name,
    preview: decoded.preview,
    updatedAt: decoded.updatedAt,
    cwd: decoded.cwd,
    gitInfo,
    turns,
  }
}

function validateIdentifier(
  value: string,
  operation: string,
  label: string,
): Effect.Effect<void, CodexProtocolError> {
  return Effect.try({
    try: () => requireIdentifier(value, operation, label),
    catch: (cause) => cause instanceof CodexProtocolError
      ? cause
      : invalidResult(operation, `${label} validation failed`, cause),
  })
}

function validateUniqueIds(
  values: readonly string[],
  operation: string,
  label: string,
): Effect.Effect<void, CodexProtocolError> {
  return Effect.try({
    try: () => {
      const seen = new Set<string>()
      for (const value of values) requireUniqueIdentifier(value, seen, operation, label)
    },
    catch: (cause) => cause instanceof CodexProtocolError
      ? cause
      : invalidResult(operation, `${label} validation failed`, cause),
  })
}

function requireIdentifier(value: string, operation: string, label: string): void {
  if (value.trim().length === 0) throw invalidResult(operation, `${label} must be nonempty`)
}

function requireUniqueIdentifier(
  value: string,
  seen: Set<string>,
  operation: string,
  label: string,
): void {
  requireIdentifier(value, operation, label)
  if (seen.has(value)) throw invalidResult(operation, `${label} ${JSON.stringify(value)} was duplicated`)
  seen.add(value)
}

function validateUserMessage(item: CodexThreadItem, operation: string): void {
  if (!Array.isArray(item.content)) {
    throw invalidResult(operation, "userMessage.content must be an array")
  }
  for (const input of item.content) {
    if (!isRecord(input) || typeof input.type !== "string") {
      throw invalidResult(operation, "userMessage content must have a string type")
    }
    if (input.type === "text" && typeof input.text !== "string") {
      throw invalidResult(operation, "text input must have string text")
    }
    if ((input.type === "image" || input.type === "audio") && typeof input.url !== "string") {
      throw invalidResult(operation, `${input.type} input must have a string url`)
    }
    if ((input.type === "localImage" || input.type === "localAudio") && typeof input.path !== "string") {
      throw invalidResult(operation, `${input.type} input must have a string path`)
    }
    if ((input.type === "skill" || input.type === "mention") &&
      (typeof input.name !== "string" || typeof input.path !== "string")) {
      throw invalidResult(operation, `${input.type} input must have string name and path`)
    }
  }
}

function invalidResult(operation: string, detail: string, cause?: unknown): CodexProtocolError {
  return new CodexProtocolError({
    operation,
    message: `Codex app-server ${operation} returned an invalid result: ${detail}`,
    ...(cause === undefined ? {} : { cause }),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCodexAppServerError(value: unknown): value is CodexAppServerError {
  return value instanceof CodexProtocolError || value instanceof CodexRpcError ||
    value instanceof CodexRequestTimeout || value instanceof CodexProcessError ||
    value instanceof CodexConnectionError
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice()
  if (right.byteLength === 0) return left
  const bytes = new Uint8Array(left.byteLength + right.byteLength)
  bytes.set(left)
  bytes.set(right, left.byteLength)
  return bytes
}

function cancelReader(
  reader: { cancel(reason?: unknown): Promise<void> } | undefined,
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  return Promise.resolve().then(() => reader?.cancel() ?? stream.cancel())
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function assertLoopbackWebSocketUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new CodexConnectionError({
      url: value,
      message: "Codex sidecar URL is invalid",
      cause,
    })
  }
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]")) {
    throw new CodexConnectionError({
      url: value,
      message: "Codex sidecar must use an authenticated loopback WebSocket",
    })
  }
}

type PromiseSettlement =
  | { readonly _tag: "Fulfilled" }
  | { readonly _tag: "Rejected"; readonly cause: unknown }
  | { readonly _tag: "TimedOut" }

async function settlementWithin(promise: Promise<unknown>, timeoutMs: number): Promise<PromiseSettlement> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<PromiseSettlement>((resolve) => {
    timer = setTimeout(() => resolve({ _tag: "TimedOut" }), timeoutMs)
  })
  const settled = await Promise.race([
    promise.then<PromiseSettlement, PromiseSettlement>(
      () => ({ _tag: "Fulfilled" }),
      (cause) => ({ _tag: "Rejected", cause }),
    ),
    timeout,
  ])
  if (timer !== undefined) clearTimeout(timer)
  return settled
}
