import { Cause, Data, Deferred, Effect, Exit, Fiber, FiberSet, Queue, Schema, Scope } from "effect"
import { optionalOperationTimeout, withOperationTimeout } from "../../../services/operation-deadline"
import { makeCloseOperation } from "../../../services/close-operation"
import { makeCleanupBudget } from "../../../services/cleanup-budget"
import { PROCESS_TERMINATION_GRACE_PERIOD_MS } from "../../../services/lifecycle-policy"

import { CodexProtocolError, CodexRpcError, decodeCodexMessage } from "./protocol"
import { CodexTurnStatusSchema } from "./protocol-schema"

export { CodexProtocolError, CodexRpcError } from "./protocol"

import {
  cleanupProcessGroup, isProcessGroupAlive, waitForProcessGroupExit,
  type ProcessGroupHandle,
} from "../../process-group"
import { providerEnvironment } from "../../provider-environment"

const DEFAULT_JSONL_RECORD_LIMIT_BYTES = 1_024 * 1_024
const STDERR_LIMIT_BYTES = 8_192
const DEFAULT_PENDING_REQUEST_LIMIT = 1_024

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
  readonly retryable?: boolean
  readonly url: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class CodexCleanupError extends Data.TaggedError("CodexCleanupError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class CodexMutationAmbiguousError extends Data.TaggedError("CodexMutationAmbiguousError")<{
  readonly method: string
  readonly message: string
  readonly cause: CodexAppServerError
}> {}

export type CodexAppServerError =
  | CodexProtocolError
  | CodexRpcError
  | CodexRequestTimeout
  | CodexProcessError
  | CodexConnectionError
  | CodexCleanupError
  | CodexMutationAmbiguousError

export interface CodexAppServerProcess {
  readonly pid?: number
  readonly exitCode?: number | null
  readonly stdin: {
    write(data: string): number | Promise<number>
    flush(): number | Promise<number>
    end(): void
  }
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
  unref?(): void
}

export interface CodexAppServerOptions {
  readonly requestTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly maxJsonlRecordBytes?: number
  readonly maxPendingRequests?: number
  readonly spawn?: (command: readonly string[]) => CodexAppServerProcess
}

export interface CodexSidecarOptions {
  readonly bearerToken: string
  readonly requestTimeoutMs?: number
  readonly connectTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly maxJsonlRecordBytes?: number
  readonly maxPendingRequests?: number
  readonly createWebSocket?: (url: string, options: { readonly headers: Record<string, string> }) => WebSocket
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
    dispatched?: () => void,
  ) => Effect.Effect<CodexThread, CodexAppServerError>
  readonly close: () => Effect.Effect<void, CodexCleanupError>
}

interface PendingRequest {
  readonly method: string
  readonly deferred: Deferred.Deferred<unknown, CodexAppServerError>
  readonly mutation: boolean
  readonly dispatched?: () => void
  assigned: boolean
  sent: boolean
}

interface QueuedWrite {
  readonly text: string
  readonly deferred: Deferred.Deferred<void, CodexAppServerError>
  readonly assignmentReady: Deferred.Deferred<void>
  readonly dispatchAllowed: Deferred.Deferred<boolean>
  readonly requestId?: number
  phase: "queued" | "offered" | "assigned" | "completed"
  cancelled: boolean
}

type RunTask = (effect: Effect.Effect<void>) => Fiber.Fiber<void>

interface CodexTransport {
  readonly stdin: CodexAppServerProcess["stdin"]
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  readonly terminate: (signal: "SIGTERM" | "SIGKILL") => void
  readonly unref: () => void
  readonly processGroup?: ProcessGroupHandle
}

const GitInfoSchema = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  originUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sha: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const ThreadItemSchema = Schema.Struct({ id: Schema.String, type: Schema.String })
const TurnSchema = Schema.Struct({
  id: Schema.String,
  status: CodexTurnStatusSchema,
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
  private readonly stdoutTask: Fiber.Fiber<void>
  private readonly stderrTask: Fiber.Fiber<void>
  private stderrBytes = new Uint8Array()
  private readonly writeQueue: QueuedWrite[] = []
  private activeWrite: QueuedWrite | undefined
  private readonly writerTask: Fiber.Fiber<void>
  private readonly closeTask: Effect.Effect<void, CodexCleanupError>
  private failure: CodexAppServerError | undefined
  private closing = false
  private closed = false
  private stdinEnded = false
  private nativeWrite: Promise<void> | undefined
  private stdoutReader: { cancel(reason?: unknown): Promise<void> } | undefined
  private stderrReader: { cancel(reason?: unknown): Promise<void> } | undefined
  private readonly cancelStdout = makeCloseOperation(Effect.tryPromise({
    try: () => cancelReader(this.stdoutReader, this.transport.stdout), catch: (cause) => cause,
  }), true)
  private readonly cancelStderr = makeCloseOperation(Effect.tryPromise({
    try: () => cancelReader(this.stderrReader, this.transport.stderr), catch: (cause) => cause,
  }), true)

  constructor(
    private readonly transport: CodexTransport,
    runTask: RunTask,
    private readonly writeSignal: Queue.Queue<void>,
    private readonly requestTimeoutMs: number | undefined,
    private readonly shutdownTimeoutMs: number,
    private readonly maxJsonlRecordBytes: number,
    private readonly maxPendingRequests: number,
    private readonly cleanupTimeoutMs: number | undefined,
  ) {
    this.stdoutTask = runTask(Effect.interruptible(this.readStdout()))
    this.stderrTask = runTask(Effect.interruptible(this.readStderr()))
    this.writerTask = runTask(Effect.interruptible(Effect.forever(Queue.take(writeSignal).pipe(Effect.andThen(this.drainWrites())))))
    this.closeTask = makeCloseOperation(this.closeResources(), true)
    runTask(Effect.interruptible(Effect.tryPromise({ try: () => transport.exited, catch: (cause) => cause })).pipe(Effect.match({
      onSuccess: (exitCode) => {
        if (!this.closing) {
          this.failAll(new CodexProcessError({
            operation: "run",
            message: `Codex app-server exited unexpectedly with code ${exitCode}`,
            exitCode,
            ...(this.stderrText ? { stderr: this.stderrText } : {}),
          }))
        }
      },
      onFailure: (cause) => this.failAll(new CodexProcessError({
        operation: "run",
        message: "Unable to observe Codex app-server exit",
        cause,
      })),
    }), Effect.asVoid))
  }

  initialize(): Effect.Effect<void, CodexAppServerError> {
    const self = this
    return Effect.gen(function*() {
      const result = yield* self.request("initialize", {
        clientInfo: { name: "claude_tree", title: "claude-tree", version: "0.1.0" },
        capabilities: null,
      }, false)
      yield* decodeResult(Schema.Struct({}), result, "initialize")
      yield* self.notify("initialized")
    })
  }

  listThreads = (params: CodexThreadListParams): Effect.Effect<CodexThreadListPage, CodexAppServerError> =>
    this.request("thread/list", params, false).pipe(
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
    this.request("thread/loaded/list", {}, false).pipe(
      Effect.flatMap((result) => decodeResult(LoadedThreadListSchema, result, "thread/loaded/list")),
      Effect.flatMap((result) => validateUniqueIds(
        result.data,
        "thread/loaded/list",
        "loaded thread ids",
      ).pipe(Effect.as(result.data))),
    )

  readThread = (threadId: string, includeTurns = true): Effect.Effect<CodexThread, CodexAppServerError> =>
    validateIdentifier(threadId, "thread/read", "requested thread id").pipe(
      Effect.andThen(this.request("thread/read", { threadId, includeTurns }, false)),
      Effect.flatMap((result) => decodeThreadEnvelope(result, "thread/read")),
      Effect.flatMap((thread) => thread.id === threadId
        ? Effect.succeed(thread)
        : Effect.fail(invalidResult("thread/read", `response thread id ${JSON.stringify(thread.id)} did not match ${JSON.stringify(threadId)}`))),
    )

  forkThread = (
    threadId: string,
    lastTurnId: string,
    cwd: string,
    dispatched?: () => void,
  ): Effect.Effect<CodexThread, CodexAppServerError> =>
    Effect.all([
      validateIdentifier(threadId, "thread/fork", "source thread id"),
      validateIdentifier(lastTurnId, "thread/fork", "last turn id"),
    ]).pipe(
      Effect.andThen(this.request("thread/fork", { threadId, lastTurnId, cwd, ephemeral: false }, true, dispatched)),
      Effect.flatMap((result) => decodeThreadEnvelope(result, "thread/fork").pipe(
        Effect.flatMap((thread) => thread.id !== threadId
          ? Effect.succeed(thread)
          : Effect.fail(invalidResult("thread/fork", "forked thread id matched the source thread id"))),
        Effect.mapError((cause) => new CodexMutationAmbiguousError({
          method: "thread/fork",
          message: "Codex thread/fork returned a response that did not identify the created thread",
          cause,
        })),
      )),
    )

  close = (): Effect.Effect<void, CodexCleanupError> => this.closeTask

  private request(
    method: string,
    params: unknown,
    mutation: boolean,
    dispatched?: () => void,
  ): Effect.Effect<unknown, CodexAppServerError> {
    const self = this
    return Effect.gen(function*() {
      if (self.failure) return yield* Effect.fail(self.failure)
      if (self.closing) {
        return yield* Effect.fail(new CodexProcessError({
          operation: method,
          message: "Codex app-server is closing",
        }))
      }
      if (self.pending.size >= self.maxPendingRequests) {
        return yield* Effect.fail(new CodexProcessError({
          operation: method,
          message: `Codex app-server has ${self.maxPendingRequests} pending requests`,
        }))
      }

      const id = self.nextRequestId++
      const deferred = yield* Deferred.make<unknown, CodexAppServerError>()
      const pending: PendingRequest = { method, deferred, mutation, assigned: false, sent: false, ...(dispatched ? { dispatched } : {}) }
      const execute = Effect.gen(function*() {
        self.pending.set(id, pending)
        return yield* Effect.raceFirst(
          self.write({ id, method, params }, id).pipe(Effect.andThen(Deferred.await(deferred))),
          // Termination must settle even a hung write; success still waits for dispatch completion.
          Deferred.await(deferred).pipe(Effect.flatMap(() => Effect.never)),
        )
      })
      return yield* withOperationTimeout(execute, self.requestTimeoutMs,
          () => Effect.fail(self.requestFailure(pending, new CodexRequestTimeout({
            method,
            timeoutMs: self.requestTimeoutMs!,
          }))),
      ).pipe(
        Effect.mapError((error) => self.requestFailure(pending, error)),
        Effect.onInterrupt(() => {
          const failure = pending.mutation && pending.sent
            ? self.ambiguousInterruption(pending)
            : new CodexProcessError({
                operation: method,
                message: `Codex ${method} request was interrupted before completion`,
              })
          Deferred.doneUnsafe(pending.deferred, Effect.fail(failure))
          return pending.mutation && pending.sent ? Effect.fail(failure) : Effect.void
        }),
        Effect.onExit((exit) => Effect.sync(() => {
          if (Exit.isSuccess(exit)) return
          const failure = Cause.hasInterruptsOnly(exit.cause) && pending.mutation && pending.sent
            ? self.ambiguousInterruption(pending)
            : self.requestFailure(pending, causeAsAppServerError(method, exit.cause))
          Deferred.doneUnsafe(pending.deferred, Effect.fail(failure))
        })),
        Effect.ensuring(Effect.sync(() => {
          if (self.pending.get(id)?.deferred === deferred) {
            self.pending.delete(id)
          }
        })),
      )
    })
  }

  private notify(method: string): Effect.Effect<void, CodexAppServerError> {
    return withOperationTimeout(Effect.suspend(() => this.write({ method })), this.requestTimeoutMs,
      () => Effect.fail(new CodexRequestTimeout({
        method,
        timeoutMs: this.requestTimeoutMs!,
      })),
    )
  }

  private write(message: unknown, requestId?: number): Effect.Effect<void, CodexAppServerError> {
    if (this.failure) return Effect.fail(this.failure)
    if (this.writeQueue.length >= this.maxPendingRequests) {
      return Effect.fail(new CodexProcessError({
        operation: "write",
        message: `Codex app-server write queue reached ${this.maxPendingRequests} entries`,
      }))
    }
    const self = this
    return Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
      const text = yield* Effect.try({
        try: () => `${JSON.stringify(message)}\n`,
        catch: (cause) => new CodexProcessError({
          operation: "write",
          message: "Unable to encode a Codex app-server message",
          cause,
        }),
      })
      const deferred = yield* Deferred.make<void, CodexAppServerError>()
      const assignmentReady = yield* Deferred.make<void>()
      const dispatchAllowed = yield* Deferred.make<boolean>()
      const queued: QueuedWrite = {
        text,
        deferred,
        assignmentReady,
        dispatchAllowed,
        ...(requestId === undefined ? {} : { requestId }),
        phase: "queued",
        cancelled: false,
      }
      self.writeQueue.push(queued)
      Queue.offerUnsafe(self.writeSignal, undefined)
      yield* restore(Deferred.await(assignmentReady)).pipe(
        Effect.onInterrupt(() => Effect.sync(() => self.cancelQueuedWrite(queued))),
      )
      if (queued.cancelled) {
        return yield* Effect.fail(self.failure ?? new CodexProcessError({
          operation: "write",
          message: "Codex app-server write was cancelled before dispatch",
        }))
      }
      const pending = requestId === undefined ? undefined : self.pending.get(requestId)
      if (requestId !== undefined && pending === undefined) {
        self.cancelQueuedWrite(queued)
        return yield* Effect.fail(self.failure ?? new CodexProcessError({
          operation: "write",
          message: "Codex app-server request was no longer pending before dispatch",
        }))
      }
      queued.phase = "assigned"
      if (pending) pending.assigned = true
      yield* Deferred.succeed(dispatchAllowed, true)
      return yield* restore(Deferred.await(deferred)).pipe(
        Effect.onInterrupt(() => Effect.sync(() => self.cancelQueuedWrite(queued))),
      )
    }))
  }

  private drainWrites(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function*() {
      while (this.writeQueue.length > 0) {
        const queued = this.writeQueue.shift()!
        this.activeWrite = queued
        const pending = queued.requestId === undefined ? undefined : this.pending.get(queued.requestId)
        try {
          if (queued.cancelled || (queued.requestId !== undefined && pending === undefined)) continue
          if (this.failure) throw this.failure
          queued.phase = "offered"
          Deferred.doneUnsafe(queued.assignmentReady, Effect.void)
          const dispatch = yield* Deferred.await(queued.dispatchAllowed)
          if (!dispatch || queued.cancelled) continue
          const assigned = queued.requestId === undefined ? undefined : this.pending.get(queued.requestId)
          if (queued.requestId !== undefined && (!assigned || !assigned.assigned)) continue
          if (this.failure) throw this.failure
          const write = yield* Effect.exit(Effect.tryPromise({
            try: () => {
              if (assigned) assigned.sent = true
              assigned?.dispatched?.()
              const operation = (async () => {
                await this.transport.stdin.write(queued.text)
                await this.transport.stdin.flush()
              })()
              this.nativeWrite = operation
              return operation
            },
            catch: (cause) => cause,
          }))
          if (Exit.isFailure(write)) throw Cause.squash(write.cause)
          this.nativeWrite = undefined
          queued.phase = "completed"
          Deferred.doneUnsafe(queued.deferred, Effect.void)
        } catch (cause) {
          const error = isCodexAppServerError(cause) ? cause : new CodexProcessError({
            operation: "write", message: "Unable to write to Codex app-server", cause,
          })
          queued.phase = "completed"
          Deferred.doneUnsafe(queued.deferred, Effect.fail(error))
          this.failAll(error)
        } finally {
          if (this.activeWrite === queued) this.activeWrite = undefined
        }
      }
    }).pipe(Effect.catch((cause) => Effect.sync(() => this.failAll(isCodexAppServerError(cause) ? cause : new CodexProcessError({
      operation: "write", message: "Unable to write to Codex app-server", cause,
    })))))
  }

  private cancelQueuedWrite(queued: QueuedWrite): void {
    if (queued.phase === "completed") return
    const pending = queued.requestId === undefined ? undefined : this.pending.get(queued.requestId)
    if (queued.phase === "assigned" && queued.requestId !== undefined) {
      if (pending?.sent) {
        Deferred.doneUnsafe(queued.deferred, Effect.fail(this.ambiguousInterruption(pending)))
        return
      }
    }
    queued.cancelled = true
    queued.phase = "completed"
    const index = this.writeQueue.indexOf(queued)
    if (index >= 0) this.writeQueue.splice(index, 1)
    const error = this.failure ?? new CodexProcessError({
      operation: "write",
      message: "Codex app-server write was cancelled before dispatch",
    })
    Deferred.doneUnsafe(queued.assignmentReady, Effect.void)
    Deferred.doneUnsafe(queued.dispatchAllowed, Effect.succeed(false))
    Deferred.doneUnsafe(queued.deferred, Effect.fail(error))
  }

  private requestFailure(pending: PendingRequest, error: CodexAppServerError): CodexAppServerError {
    if (!pending.mutation || !pending.sent || error instanceof CodexMutationAmbiguousError ||
      error instanceof CodexRpcError) return error
    return new CodexMutationAmbiguousError({
      method: pending.method,
      message: `Codex ${pending.method} may have completed after its response became unavailable`,
      cause: error,
    })
  }

  private ambiguousInterruption(pending: PendingRequest): CodexMutationAmbiguousError {
    return new CodexMutationAmbiguousError({
      method: pending.method,
      message: `Codex ${pending.method} may have completed after its caller was interrupted`,
      cause: new CodexProcessError({
        operation: pending.method,
        message: `Codex ${pending.method} was interrupted after dispatch`,
      }),
    })
  }

  private readStdout(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function*() {
      const reader = this.transport.stdout.getReader()
      this.stdoutReader = reader
      const decoder = new TextDecoder("utf-8", { fatal: true })
      let buffer: Uint8Array = new Uint8Array()
      while (true) {
        const { done, value } = yield* Effect.tryPromise({ try: () => reader.read(), catch: (cause) => cause })
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
        yield* Effect.promise(() => Promise.resolve())
        if (!this.failure && !this.closing) {
          this.failAll(new CodexProcessError({
            operation: "read",
            message: "Codex app-server stdout closed unexpectedly",
            ...(this.stderrText ? { stderr: this.stderrText } : {}),
          }))
        }
      }
    }).pipe(Effect.catchCause((cause) => Effect.sync(() => {
      if (!this.closing && !Cause.hasInterruptsOnly(cause)) {
        const error = Cause.squash(cause)
        this.failAll(error instanceof CodexProtocolError ? error : new CodexProtocolError({
          operation: "read", message: "Codex app-server stream failed", cause,
        }))
      }
    })))
  }

  private handleLine(line: string): void {
    let message: ReturnType<typeof decodeCodexMessage>
    try {
      message = decodeCodexMessage(line)
    } catch (cause) {
      this.failAll(cause instanceof CodexProtocolError
        ? cause
        : new CodexProtocolError({ operation: "read", message: "Unable to decode Codex app-server message", cause }))
      return
    }
    if (message.kind === "notification") return
    if (message.kind === "request") {
      // Metadata reads never act as a permission/input client. The stock TUI owns those decisions.
      this.failProtocol("read", `Unsupported server request: ${message.method}`)
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) {
      if (message.id > 0 && message.id < this.nextRequestId) return
      this.failProtocol("read", `Codex app-server responded with unknown id ${message.id}`)
      return
    }

    Deferred.doneUnsafe(pending.deferred, message.kind === "error"
      ? Effect.fail(new CodexRpcError({ method: pending.method, ...message.error }))
      : Effect.succeed(message.result))
  }

  private readStderr(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function*() {
      const reader = this.transport.stderr.getReader()
      this.stderrReader = reader
      while (true) {
        const { done, value } = yield* Effect.promise(() => reader.read())
        if (done) break
        this.appendStderr(value)
      }
    }).pipe(Effect.catchCause(() => Effect.void))
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
      Deferred.doneUnsafe(pending.deferred, Effect.fail(this.requestFailure(pending, error)))
    }
    this.cancelQueuedWrites(error)
    this.pending.clear()
  }

  private closeResources(): Effect.Effect<void, CodexCleanupError> {
    return Effect.gen({ self: this }, function*() {
      if (this.closed) return
      this.closing = true
      const closingError = new CodexProcessError({
        operation: "close", message: "Codex app-server is closing",
      })
      this.failAll(closingError)
      const failures: unknown[] = []
      if (!this.stdinEnded) {
        try {
          this.transport.stdin.end()
          this.stdinEnded = true
        } catch (cause) {
          failures.push(cause)
        }
      }

      if (this.transport.processGroup) {
        const result = yield* cleanupProcessGroup(this.transport.processGroup, {
          gracePeriodMs: this.shutdownTimeoutMs,
          killPeriodMs: this.shutdownTimeoutMs,
        })
        for (const issue of result.issues) failures.push(issue.cause ?? new Error(issue.message))
        if (result.status !== "absent" && result.issues.length === 0) {
          failures.push(new Error("Codex app-server process group did not exit after SIGKILL"))
        }
      } else {
        const observeExit = Effect.interruptible(Effect.tryPromise({
          try: () => this.transport.exited, catch: (cause) => cause,
        })).pipe(Effect.asVoid, Effect.timeoutOrElse({
          duration: this.shutdownTimeoutMs,
          orElse: () => Effect.fail(new Error("Codex app-server did not exit")),
        }))
        let exit = yield* Effect.exit(observeExit)
        for (const signal of ["SIGTERM", "SIGKILL"] as const) {
          if (Exit.isSuccess(exit)) break
          try { this.transport.terminate(signal) }
          catch (cause) { failures.push(cause) }
          exit = yield* Effect.exit(observeExit)
        }
        if (Exit.isFailure(exit)) failures.push(exit.cause)
      }

      const budget = yield* makeCleanupBudget(this.cleanupTimeoutMs)
      this.writerTask.interruptUnsafe()
      const cleanupSettlements = yield* Effect.all([
        this.cancelStdout, this.cancelStderr,
        Fiber.join(this.stdoutTask), Fiber.join(this.stderrTask),
        Fiber.await(this.writerTask).pipe(Effect.asVoid),
        Effect.promise(() => this.nativeWrite?.then(() => undefined, () => undefined) ?? Promise.resolve()),
      ].map((effect) => Effect.exit(budget.observe(effect,
        () => new Error("Codex app-server stream cleanup timed out")))), { concurrency: "unbounded" })
      for (const settlement of cleanupSettlements) {
        if (Exit.isFailure(settlement) && Cause.squash(settlement.cause) !== this.failure) failures.push(settlement.cause)
      }
      try { this.transport.unref() }
      catch (cause) { failures.push(cause) }
      if (failures.length > 0) {
        return yield* Effect.fail(new CodexCleanupError({
          message: "Failed to clean up Codex app-server",
          cause: failures.length === 1 ? failures[0] : new AggregateError(failures),
        }))
      }
      this.closed = true
    })
  }

  private cancelQueuedWrites(error: CodexAppServerError): void {
    const active = this.activeWrite
    if (active && active.phase !== "completed") {
      active.cancelled = true
      const pending = active.requestId === undefined ? undefined : this.pending.get(active.requestId)
      const failure = pending === undefined ? error : this.requestFailure(pending, error)
      Deferred.doneUnsafe(active.deferred, Effect.fail(failure))
      Deferred.doneUnsafe(active.assignmentReady, Effect.void)
      Deferred.doneUnsafe(active.dispatchAllowed, Effect.succeed(false))
    }
    for (const queued of this.writeQueue.splice(0)) {
      queued.cancelled = true
      Deferred.doneUnsafe(queued.deferred, Effect.fail(error))
      Deferred.doneUnsafe(queued.assignmentReady, Effect.void)
      Deferred.doneUnsafe(queued.dispatchAllowed, Effect.succeed(false))
    }
  }
}

function causeAsAppServerError(method: string, cause: Cause.Cause<unknown>): CodexAppServerError {
  const squashed = Cause.squash(cause)
  return isCodexAppServerError(squashed)
    ? squashed
    : new CodexProcessError({
        operation: method,
        message: `Codex ${method} request terminated before its response was available`,
        cause: squashed,
      })
}

export function makeCodexAppServerClient(
  executable: string,
  options: CodexAppServerOptions = {},
): Effect.Effect<CodexAppServerClient, CodexAppServerError, Scope.Scope> {
  return acquireClient((own) => Effect.try({
    try: () => {
      const process = (options.spawn ?? spawnCodex)([executable, "app-server", "--stdio"])
      const transport = processTransport(process)
      own(transport)
      return transport
    },
    catch: (cause) => new CodexProcessError({
      operation: "spawn",
      message: "Unable to spawn Codex app-server",
      cause,
    }),
  }), options)
}

export function connectCodexAppServerSidecar(
  url: string,
  options: CodexSidecarOptions,
): Effect.Effect<CodexAppServerClient, CodexAppServerError, Scope.Scope> {
  return acquireClient((own) => withOperationTimeout(Effect.tryPromise({
    try: (signal) => connectWebSocketTransport(
      url,
      options.bearerToken,
      signal,
      own,
      options.createWebSocket,
    ),
    catch: (cause) => cause instanceof CodexConnectionError || cause instanceof CodexProtocolError
      ? cause
      : new CodexConnectionError({ url, message: "Unable to connect to Codex sidecar", cause }),
  }), optionalOperationTimeout(options.connectTimeoutMs),
    () => Effect.fail(new CodexConnectionError({ url, message: "Timed out connecting to Codex sidecar", retryable: true }))), options)
}

function acquireClient(
  acquireTransport: (own: (transport: CodexTransport) => void) => Effect.Effect<CodexTransport, CodexAppServerError>,
  options: CodexAppServerOptions | CodexSidecarOptions,
): Effect.Effect<CodexAppServerClient, CodexAppServerError, Scope.Scope> {
  const requestTimeoutMs = optionalOperationTimeout(options.requestTimeoutMs)
  return Effect.gen(function*() {
    const runTask = yield* FiberSet.makeRuntime<never, void, never>()
    const writeSignal = yield* Queue.unbounded<void>()
    return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
      let client: ClientImpl | undefined
      const own = (transport: CodexTransport) => {
        client = new ClientImpl(transport, runTask, writeSignal, requestTimeoutMs,
          positiveDuration(options.shutdownTimeoutMs, PROCESS_TERMINATION_GRACE_PERIOD_MS),
          positiveInteger(options.maxJsonlRecordBytes, DEFAULT_JSONL_RECORD_LIMIT_BYTES),
          positiveInteger(options.maxPendingRequests, DEFAULT_PENDING_REQUEST_LIMIT),
          optionalOperationTimeout(options.shutdownTimeoutMs))
      }
      yield* Effect.addFinalizer(() => client ? client.close().pipe(Effect.orDie) : Effect.void)
      const initialized = yield* Effect.exit(restore(Effect.gen(function*() {
        const transport = yield* acquireTransport(own)
        const owned = client
        if (!owned) return yield* Effect.die(new Error("Codex transport acquisition did not register ownership"))
        yield* Effect.try({
          try: () => transport.unref(),
          catch: (cause) => new CodexProcessError({
            operation: "spawn",
            message: "Unable to detach Codex app-server",
            cause,
          }),
        })
        yield* owned.initialize()
        return owned
      })))
      if (Exit.isFailure(initialized)) {
        const cleanup = yield* Effect.exit(client?.close() ?? Effect.void)
        if (Exit.isFailure(cleanup)) {
          return yield* Effect.fail(new CodexCleanupError({
            message: "Codex app-server acquisition failed and rollback was incomplete",
            cause: new AggregateError([
              Cause.squash(initialized.cause),
              Cause.squash(cleanup.cause),
            ]),
          }))
        }
        return yield* Effect.failCause(initialized.cause)
      }
      return initialized.value
    }))
  })
}

function processTransport(process: CodexAppServerProcess): CodexTransport {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exited: process.exited,
    terminate: (signal) => signalProcessGroup(process, signal),
    unref: () => process.unref?.(),
    ...(process.pid === undefined ? {} : { processGroup: processGroupHandle(process) }),
  }
}

function spawnCodex(command: readonly string[]): CodexAppServerProcess {
  return Bun.spawn([...command], {
    env: providerEnvironment(),
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function connectWebSocketTransport(
  url: string,
  bearerToken: string,
  signal: AbortSignal,
  own: (transport: CodexTransport) => void,
  createWebSocket: NonNullable<CodexSidecarOptions["createWebSocket"]> = (url, options) => new WebSocket(url, options),
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
  const socket = createWebSocket(url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  })
  const confirmClosed = () => {
    if (socket.readyState !== WebSocket.CLOSED) return
    if (!stdoutSettled) { stdoutSettled = true; stdoutController.close() }
    settleExit(1)
  }
  const terminate = () => { socket.terminate(); confirmClosed() }

  socket.addEventListener("message", (event) => {
    if (stdoutSettled) return
    if (typeof event.data !== "string") {
      stdoutSettled = true
      stdoutController.error(new CodexProtocolError({
        operation: "read",
        message: "Codex sidecar sent a non-text WebSocket message",
      }))
      terminate()
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

  const transport: CodexTransport = {
    stdin: {
      write(data) {
        socket.send(data.endsWith("\n") ? data.slice(0, -1) : data)
        return data.length
      },
      flush: () => 0,
      end: () => {
        if (socket.readyState === WebSocket.CONNECTING) terminate()
        else { socket.close(1000); confirmClosed() }
      },
    },
    stdout,
    stderr,
    exited,
    terminate(signal) {
      if (signal === "SIGKILL" || socket.readyState === WebSocket.CONNECTING) terminate()
      else { socket.close(1000); confirmClosed() }
    },
    unref() {},
  }
  own(transport)

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (effect: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
      socket.removeEventListener("close", onClose)
      effect()
    }
    const onOpen = () => finish(resolve)
    const onClose = () => finish(() => reject(new CodexConnectionError({
      url,
      message: "Codex sidecar closed before the connection was established",
    })))
    const onError = (event: Event) => {
      terminate()
      finish(() => reject(new CodexConnectionError({
        url,
        message: "Unable to connect to Codex sidecar",
        retryable: "message" in event && typeof event.message === "string" &&
          /ECONNREFUSED|Failed to connect|Connection refused/i.test(event.message),
        cause: event,
      })))
    }
    const onAbort = () => {
      terminate()
      finish(() => reject(new CodexConnectionError({
        url,
        message: "Codex sidecar connection was interrupted",
        cause: signal.reason,
      })))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener("abort", onAbort, { once: true })
    socket.addEventListener("open", onOpen, { once: true })
    socket.addEventListener("error", onError, { once: true })
    socket.addEventListener("close", onClose, { once: true })
  })

  return transport
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
    value instanceof CodexConnectionError || value instanceof CodexCleanupError ||
    value instanceof CodexMutationAmbiguousError
}

function signalProcessGroup(process: CodexAppServerProcess, signal: NodeJS.Signals): void {
  if (process.pid === undefined) {
    process.kill(signal)
    return
  }
  try {
    globalThis.process.kill(-process.pid, signal)
  } catch (cause) {
    if (isNoSuchProcessError(cause)) return
    if (process.exitCode === null || process.exitCode === undefined) process.kill(signal)
  }
}

function processGroupHandle(process: CodexAppServerProcess): ProcessGroupHandle {
  const processGroupId = process.pid!
  return {
    processGroupId,
    signalGroup: (signal) => signalProcessGroup(process, signal),
    isGroupAlive: () => isProcessGroupAlive(processGroupId),
    waitForGroupExit: (timeoutMs) => waitForProcessGroupExit(
      () => isProcessGroupAlive(processGroupId),
      timeoutMs,
    ),
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return isRecord(error) && error.code === "ESRCH"
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
