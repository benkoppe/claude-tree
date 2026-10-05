import { isAbsolute } from "node:path"

import { Cause, Data, Deferred, Effect, Exit, Fiber, FiberSet, PubSub, Scope } from "effect"
import { makeCloseOperation } from "../../../services/close-operation"
import { makeCleanupBudget } from "../../../services/cleanup-budget"

import type { IdentityTransitionKind } from "../../../domain/persistence"
import type { ProviderTerminalEvent } from "../../../services/provider"
import { CodexLifecycleObserver } from "./lifecycle"
import { optionalOperationTimeout, withOperationTimeout } from "../../../services/operation-deadline"

const DEFAULT_PREOPEN_MESSAGES = 64
const DEFAULT_PREOPEN_BYTES = 256 * 1_024
const DEFAULT_PENDING_REQUESTS = 256
const DEFAULT_TRANSITION_CAPACITY = 64
const DEFAULT_CLIENTS = 8
const DEFAULT_SERVER_MESSAGES = 256
const DEFAULT_SERVER_MESSAGE_BYTES = 8 * 1_024 * 1_024

export type CodexThreadOperation = "start" | "resume" | "fork"

export interface CodexThreadTransition {
  readonly _tag: "CodexThreadTransition"
  readonly operation: CodexThreadOperation
  readonly kind: IdentityTransitionKind
  readonly previousThreadId: string
  readonly threadId: string
  readonly title: string
  readonly updatedAt: number
  readonly cwd: string
  readonly requestedThreadId?: string
  readonly forkPointTurnId?: string
}

export interface CodexThreadTransitionFailed {
  readonly _tag: "TransitionFailed"
  readonly operation: CodexThreadOperation
  readonly previousThreadId: string
  readonly error: CodexTuiProxyError
}

export type CodexTuiProxyTransition = CodexThreadTransition | CodexThreadTransitionFailed

type ObservedCodexTuiProxyTransition =
  | Omit<CodexThreadTransition, "kind">
  | CodexThreadTransitionFailed

export interface CodexTuiProxyTransitionRequest {
  readonly transition: CodexTuiProxyTransition
  readonly acknowledgment: Deferred.Deferred<void, CodexTuiProxyError>
}

export class CodexTuiProxyError extends Data.TaggedError("CodexTuiProxyError")<{
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export interface CodexTuiProxyOptions {
  readonly upstreamUrl: string
  readonly bearerToken: string
  readonly initialThreadId: string
  readonly initialThreadIsTemporary?: boolean
  readonly connectTimeoutMs?: number
  readonly cleanupTimeoutMs?: number
  readonly maxPreOpenMessages?: number
  readonly maxPreOpenBytes?: number
  readonly maxPendingRequests?: number
  readonly transitionCapacity?: number
  readonly maxClients?: number
  readonly maxServerMessages?: number
  readonly maxServerMessageBytes?: number
  readonly transitionAcknowledgmentTimeoutMs?: number
}

export interface CodexTuiProxy {
  readonly remoteUrl: string
  readonly transitions: PubSub.PubSub<CodexTuiProxyTransitionRequest>
  readonly providerEvents: PubSub.PubSub<ProviderTerminalEvent>
  readonly close: () => Effect.Effect<void, CodexTuiProxyError>
}

interface PendingSwitch {
  readonly operation: CodexThreadOperation
  readonly previousThreadId: string
  readonly requestedThreadId?: string
  readonly forkPointTurnId?: string
}

interface QueuedMessage {
  readonly text: string
  readonly bytes: number
}

interface ProxySocketData {
  upstream: WebSocket | undefined
  connectTimer: Fiber.Fiber<void> | undefined
  readonly queued: QueuedMessage[]
  queuedBytes: number
  readonly requests: Map<string, PendingSwitch>
  currentThreadId: string
  serverTail: Fiber.Fiber<void> | undefined
  readonly runTask: RunTask
  pendingServerMessages: number
  pendingServerMessageBytes: number
  closed: boolean
}

interface ProxyState {
  readonly server: Bun.Server<ProxySocketData>
  readonly port: number
  readonly clients: Set<Bun.ServerWebSocket<ProxySocketData>>
  readonly transitions: PubSub.PubSub<CodexTuiProxyTransitionRequest>
  readonly providerEvents: PubSub.PubSub<ProviderTerminalEvent>
  readonly cleanupTimeoutMs: number | undefined
  readonly runTask: RunTask
  closed: boolean
  cleanupComplete: boolean
  publishTail: Fiber.Fiber<void, CodexTuiProxyError> | undefined
  pendingPublications: number
  readonly transitionAcknowledgments: Set<Deferred.Deferred<void, CodexTuiProxyError>>
  awaitingTemporaryAdoption: boolean
  publicationFailure: CodexTuiProxyError | undefined
  cleanupTask: Effect.Effect<void, CodexTuiProxyError> | undefined
  stopTask: Effect.Effect<void, unknown> | undefined
}

type RunTask = <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>

export function makeCodexTuiProxy(
  options: CodexTuiProxyOptions,
): Effect.Effect<CodexTuiProxy, CodexTuiProxyError, Scope.Scope> {
  return Effect.gen(function*() {
    const fork = yield* FiberSet.makeRuntime<never>()
    const runTask: RunTask = (effect) => fork(Effect.yieldNow.pipe(Effect.andThen(effect)))
    const transitionCapacity = positiveInteger(options.transitionCapacity, DEFAULT_TRANSITION_CAPACITY)
    const transitions = yield* Effect.acquireRelease(
      PubSub.bounded<CodexTuiProxyTransitionRequest>(transitionCapacity),
      PubSub.shutdown,
    )
    const providerEvents = yield* Effect.acquireRelease(PubSub.unbounded<ProviderTerminalEvent>(), PubSub.shutdown)
    const state = yield* createProxyState(options, transitions, providerEvents, transitionCapacity, runTask)
    yield* Effect.addFinalizer(() => cleanupProxy(state).pipe(Effect.orDie))
    return {
      remoteUrl: `ws://127.0.0.1:${state.port}`,
      transitions,
      providerEvents,
      close: () => cleanupProxy(state),
    }
  })
}

function createProxyState(
  options: CodexTuiProxyOptions,
  transitions: PubSub.PubSub<CodexTuiProxyTransitionRequest>,
  providerEvents: PubSub.PubSub<ProviderTerminalEvent>,
  transitionCapacity: number,
  runTask: RunTask,
): Effect.Effect<ProxyState, CodexTuiProxyError> {
  return Effect.gen(function*() {
    try {
      assertLoopbackWebSocketUrl(options.upstreamUrl)
      requireIdentifier(options.initialThreadId, "initial thread id")
      const clients = new Set<Bun.ServerWebSocket<ProxySocketData>>()
      const lifecycle = new CodexLifecycleObserver()
      let clientSlots = 0
      let currentThreadId = options.initialThreadId
      let awaitingTemporaryAdoption = options.initialThreadIsTemporary === true
      const disconnectLifecycle = (data: ProxySocketData) => {
        // Release evidence after this generation's queued frames, never before them.
        const previous = data.serverTail
        data.serverTail = runTask((previous ? Fiber.join(previous) : Effect.void).pipe(Effect.andThen(Effect.sync(() => {
          for (const observed of lifecycle.disconnect(data, currentThreadId)) {
            PubSub.publishUnsafe(providerEvents, observed)
          }
        }))))
      }
      const state = {} as ProxyState
      const maxPreOpenMessages = positiveInteger(options.maxPreOpenMessages, DEFAULT_PREOPEN_MESSAGES)
      const maxPreOpenBytes = positiveInteger(options.maxPreOpenBytes, DEFAULT_PREOPEN_BYTES)
      const maxPendingRequests = positiveInteger(options.maxPendingRequests, DEFAULT_PENDING_REQUESTS)
      const connectTimeoutMs = optionalOperationTimeout(options.connectTimeoutMs)
      const maxClients = positiveInteger(options.maxClients, DEFAULT_CLIENTS)
      const maxServerMessages = positiveInteger(options.maxServerMessages, DEFAULT_SERVER_MESSAGES)
      const maxServerMessageBytes = positiveInteger(
        options.maxServerMessageBytes,
        DEFAULT_SERVER_MESSAGE_BYTES,
      )
      const transitionAcknowledgmentTimeoutMs = optionalOperationTimeout(options.transitionAcknowledgmentTimeoutMs)

      const server = Bun.serve<ProxySocketData>({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request, bunServer) {
          if (state.closed) return new Response("Proxy is closing", { status: 503 })
          if (request.headers.get("authorization") !== `Bearer ${options.bearerToken}`) {
            return new Response("Unauthorized", { status: 401 })
          }
          if (clientSlots >= maxClients) return new Response("Too many proxy clients", { status: 503 })
          const upgraded = bunServer.upgrade(request, {
            data: {
              upstream: undefined,
              connectTimer: undefined,
              queued: [],
              queuedBytes: 0,
              requests: new Map(),
              currentThreadId,
              serverTail: undefined,
              runTask,
              pendingServerMessages: 0,
              pendingServerMessageBytes: 0,
              closed: false,
            },
          })
          if (!upgraded) return new Response("WebSocket upgrade required", { status: 426 })
          clientSlots += 1
          return undefined
        },
        websocket: {
          open(socket) {
            if (state.closed) {
              socket.close(1012, "Proxy is closing")
              return
            }
            clients.add(socket)
            let upstream: WebSocket
            try {
              upstream = new WebSocket(options.upstreamUrl, {
                headers: { Authorization: `Bearer ${options.bearerToken}` },
              })
            } catch {
              socket.close(1011, "Unable to create upstream connection")
              return
            }
            socket.data.upstream = upstream
            const forward = (text: string) => {
              if (socket.data.closed) return
              for (const observed of lifecycle.observe(text, currentThreadId, socket.data)) {
                PubSub.publishUnsafe(providerEvents, observed)
              }
              socket.send(text)
            }
            if (connectTimeoutMs !== undefined) socket.data.connectTimer = runTask(Effect.sleep(connectTimeoutMs).pipe(Effect.andThen(Effect.sync(() => {
              closeQuietly(socket, 1013, "Upstream connect timeout")
              terminateQuietly(upstream)
            }))))

            upstream.addEventListener("open", () => {
              try {
                clearConnectTimer(socket.data)
                for (const message of socket.data.queued.splice(0)) upstream.send(message.text)
                socket.data.queuedBytes = 0
              } catch {
                closeQuietly(socket, 1011, "Unable to flush upstream messages")
                terminateQuietly(upstream)
              }
            }, { once: true })
            upstream.addEventListener("message", (event) => {
              try {
                if (typeof event.data !== "string") {
                  closeQuietly(socket, 1003, "Upstream messages must be text")
                  terminateQuietly(upstream)
                  return
                }
                const queuedBehindTransition = socket.data.pendingServerMessages > 0
                const immediateTransition = queuedBehindTransition
                  ? undefined : observeServerMessage(socket.data, event.data)
                if (!queuedBehindTransition && !immediateTransition) {
                  forward(event.data)
                  return
                }
                enqueueServerMessage(
                  socket,
                  event.data,
                  maxServerMessages,
                  maxServerMessageBytes,
                  Effect.gen(function*() {
                    const transition = queuedBehindTransition
                      ? observeServerMessage(socket.data, event.data) : immediateTransition
                    if (transition) {
                      if (!(yield* publishTransition(
                        state,
                        transition,
                        transitionCapacity,
                        transitionAcknowledgmentTimeoutMs,
                        socket,
                      ))) return
                      if (transition._tag === "CodexThreadTransition") {
                        currentThreadId = transition.threadId
                        awaitingTemporaryAdoption = false
                        for (const client of clients) {
                          client.data.currentThreadId = transition.threadId
                        }
                      }
                    }
                    forward(event.data)
                  }),
                )
              } catch {
                closeQuietly(socket, 1011, "Unable to process upstream message")
                terminateQuietly(upstream)
              }
            })
            upstream.addEventListener("error", () => {
              if (socket.data.closed) return
              clearConnectTimer(socket.data)
              closeQuietly(socket, 1011, "Upstream failed")
            }, { once: true })
            upstream.addEventListener("close", (event) => {
              if (socket.data.closed) return
              clearConnectTimer(socket.data)
              disconnectLifecycle(socket.data)
              closeQuietly(socket, event.code === 1000 ? 1000 : 1011, upstreamCloseReason(event.code, event.reason))
            }, { once: true })
          },
          message(socket, message) {
            try {
              if (typeof message !== "string") {
                socket.close(1003, "Protocol messages must be text")
                return
              }
              if (!observeClientMessage(socket.data, message, maxPendingRequests)) {
                socket.close(1013, "Too many pending protocol requests")
                return
              }
              const upstream = socket.data.upstream
              if (upstream?.readyState === WebSocket.OPEN) {
                upstream.send(message)
                return
              }
              const bytes = Buffer.byteLength(message)
              if (socket.data.queued.length >= maxPreOpenMessages ||
                socket.data.queuedBytes + bytes > maxPreOpenBytes) {
                socket.close(1009, "Pre-open queue limit exceeded")
                return
              }
              socket.data.queued.push({ text: message, bytes })
              socket.data.queuedBytes += bytes
            } catch {
              closeQuietly(socket, 1011, "Unable to process protocol message")
              terminateQuietly(socket.data.upstream)
            }
          },
          close(socket) {
            clients.delete(socket)
            clientSlots -= 1
            clearSocketState(socket.data)
            disconnectLifecycle(socket.data)
          },
        },
      })
      const port = server.port
      if (port === undefined) {
        const listenError = new CodexTuiProxyError({
          operation: "listen",
          message: "Codex TUI proxy did not bind a loopback port",
        })
        let cleanupFailure: unknown
        try {
          const stopped = yield* Effect.exit(withOperationTimeout(Effect.interruptible(makeCloseOperation(Effect.tryPromise({
            try: () => server.stop(true), catch: (cause) => cause,
          }))), optionalOperationTimeout(options.cleanupTimeoutMs), () => Effect.fail(new Error("Codex TUI proxy acquisition rollback timed out"))))
          if (Exit.isFailure(stopped)) cleanupFailure = stopped.cause
        } catch (cause) {
          cleanupFailure = cause
        }
        if (cleanupFailure !== undefined) {
          throw new CodexTuiProxyError({
            operation: "acquire-rollback",
            message: "Codex TUI proxy acquisition failed and rollback was incomplete",
            cause: new AggregateError([listenError, cleanupFailure]),
          })
        }
        throw listenError
      }
      Object.assign(state, {
        server,
        port,
        clients,
        transitions,
        providerEvents,
        cleanupTimeoutMs: optionalOperationTimeout(options.cleanupTimeoutMs),
        runTask,
        closed: false,
        cleanupComplete: false,
        publishTail: undefined,
        pendingPublications: 0,
        transitionAcknowledgments: new Set(),
        awaitingTemporaryAdoption,
        publicationFailure: undefined,
        cleanupTask: undefined,
        stopTask: undefined,
      })
      return state
    } catch (cause) {
      return yield* Effect.fail(cause instanceof CodexTuiProxyError
      ? cause
      : new CodexTuiProxyError({
        operation: "listen",
        message: "Unable to start Codex TUI proxy",
        cause,
      }))
    }
  })
}

function cleanupProxy(state: ProxyState): Effect.Effect<void, CodexTuiProxyError> {
  state.cleanupTask ??= makeCloseOperation(cleanupProxyResources(state), true)
  return state.cleanupTask
}

function cleanupProxyResources(state: ProxyState): Effect.Effect<void, CodexTuiProxyError> {
  return Effect.gen(function*() {
    if (state.cleanupComplete) return
    state.closed = true
    const failures: unknown[] = []
    const serverTails = [...state.clients].map((client) => client.data.serverTail)
    for (const client of state.clients) {
      clearSocketState(client.data)
      try { client.terminate() }
      catch (cause) { failures.push(cause) }
    }
    state.clients.clear()
    for (const acknowledgment of state.transitionAcknowledgments) {
      Deferred.doneUnsafe(acknowledgment, Effect.fail(new CodexTuiProxyError({
        operation: "cleanup", message: "Codex TUI proxy closed before transition acknowledgment",
      })))
    }

    state.stopTask ??= makeCloseOperation(Effect.tryPromise({ try: () => state.server.stop(true), catch: (cause) => cause }), true)
    const budget = yield* makeCleanupBudget(state.cleanupTimeoutMs)
    yield* PubSub.shutdown(state.transitions)
    const background = yield* Effect.all([
      ...(state.publishTail ? [Fiber.join(state.publishTail)] : []),
      ...serverTails.flatMap((tail) => tail ? [Fiber.join(tail)] : []),
    ].map((effect) => Effect.exit(budget.observe(effect,
      () => new Error("Codex TUI proxy message cleanup timed out")))), { concurrency: "unbounded" })
    for (const result of background) {
      if (Exit.isFailure(result)) failures.push(result.cause)
    }
    if (state.publishTail?.pollUnsafe()?._tag === "Failure") state.publishTail = undefined
    if (state.publicationFailure) {
      failures.push(state.publicationFailure)
      state.publicationFailure = undefined
    }

    const closure = yield* Effect.exit(budget.observe(Effect.raceFirst(state.stopTask,
      waitForListenerClose(state.port, state.cleanupTimeoutMs).pipe(Effect.flatMap((result) => result === "closed"
        ? Effect.void : Effect.never))), () => new Error("Unable to verify that the Codex TUI proxy listener closed")))
    if (Exit.isFailure(closure)) failures.push(closure.cause)

    if (failures.length > 0) {
      return yield* Effect.fail(new CodexTuiProxyError({
        operation: "cleanup", message: "Unable to clean up Codex TUI proxy",
        cause: failures.length === 1 ? failures[0] : new AggregateError(failures),
      }))
    }
    state.cleanupComplete = true
  })
}

function observeClientMessage(data: ProxySocketData, text: string, limit: number): boolean {
  const message = parseRecord(text)
  if (!message || !Object.hasOwn(message, "id") || typeof message.method !== "string") return true
  const operation = operationFor(message.method)
  if (!operation) return true
  if (typeof message.id !== "number" && typeof message.id !== "string") return true
  const key = requestKey(message.id)
  if (data.requests.has(key) || data.requests.size >= limit) return false
  const params = isRecord(message.params) ? message.params : undefined
  const forkPointTurnId = params && typeof params.lastTurnId === "string"
    ? params.lastTurnId
    : params && typeof params.beforeTurnId === "string"
      ? params.beforeTurnId
      : undefined
  data.requests.set(key, {
    operation,
    previousThreadId: data.currentThreadId,
    ...(params && typeof params.threadId === "string" ? { requestedThreadId: params.threadId } : {}),
    ...(forkPointTurnId === undefined ? {} : { forkPointTurnId }),
  })
  return true
}

function observeServerMessage(
  data: ProxySocketData,
  text: string,
): ObservedCodexTuiProxyTransition | undefined {
  const message = parseRecord(text)
  if (!message || !Object.hasOwn(message, "id") ||
    (typeof message.id !== "number" && typeof message.id !== "string")) return undefined
  const key = requestKey(message.id)
  const request = data.requests.get(key)
  if (!request) return undefined
  data.requests.delete(key)
  const hasError = Object.hasOwn(message, "error")
  const hasResult = Object.hasOwn(message, "result")
  if (hasError && !hasResult) return undefined
  if (!hasResult || hasError || !isRecord(message.result) || !isRecord(message.result.thread)) {
    return transitionFailure(request, "tracked switch returned a malformed successful response")
  }
  const thread = message.result.thread
  if (typeof thread.id !== "string" || thread.id.trim().length === 0 ||
    typeof thread.preview !== "string" || typeof thread.updatedAt !== "number" ||
    !Number.isFinite(thread.updatedAt) || !isCanonicalPathCandidate(thread.cwd) ||
    typeof thread.ephemeral !== "boolean" ||
    !(thread.parentThreadId === null ||
      (typeof thread.parentThreadId === "string" && thread.parentThreadId.trim().length > 0))) {
    return transitionFailure(request, "tracked switch returned malformed thread data")
  }
  if (thread.id === request.previousThreadId || thread.ephemeral || thread.parentThreadId !== null) {
    return undefined
  }
  return {
    _tag: "CodexThreadTransition",
    operation: request.operation,
    previousThreadId: request.previousThreadId,
    threadId: thread.id,
    title: thread.preview,
    updatedAt: thread.updatedAt,
    cwd: thread.cwd,
    ...(request.requestedThreadId === undefined
      ? {}
      : { requestedThreadId: request.requestedThreadId }),
    ...(request.forkPointTurnId === undefined
      ? {}
      : { forkPointTurnId: request.forkPointTurnId }),
  }
}

function upstreamCloseReason(code: number, detail: string): string {
  const message = `Upstream closed (${code})${detail ? `: ${detail}` : ""}`
  let reason = ""
  for (const character of message) {
    if (Buffer.byteLength(reason + character) > 123) break
    reason += character
  }
  return reason
}

function transitionFailure(request: PendingSwitch, detail: string): CodexThreadTransitionFailed {
  return {
    _tag: "TransitionFailed",
    operation: request.operation,
    previousThreadId: request.previousThreadId,
    error: new CodexTuiProxyError({
      operation: `thread/${request.operation}`,
      message: `Codex TUI proxy ${detail}`,
    }),
  }
}

function publishTransition(
  state: ProxyState,
  transition: ObservedCodexTuiProxyTransition,
  capacity: number,
  acknowledgmentTimeoutMs: number | undefined,
  socket: Bun.ServerWebSocket<ProxySocketData>,
): Effect.Effect<boolean> {
  return Effect.gen(function*() {
    if (state.pendingPublications >= capacity) {
      socket.close(1013, "Transition queue limit exceeded")
      return false
    }
    state.pendingPublications += 1
    const acknowledgment = Deferred.makeUnsafe<void, CodexTuiProxyError>()
    state.transitionAcknowledgments.add(acknowledgment)
    const previous = state.publishTail
    const publication = state.runTask(Effect.gen(function*() {
      if (previous) yield* Fiber.join(previous)
      const publishedTransition = transition._tag === "CodexThreadTransition"
        ? { ...transition, kind: state.awaitingTemporaryAdoption ? "temporary-adoption" as const : "native-fork" as const }
        : transition
      const published = yield* PubSub.publish(state.transitions, { transition: publishedTransition, acknowledgment })
      if (!published && !state.closed) {
        return yield* Effect.fail(new CodexTuiProxyError({
          operation: "publish-transition",
          message: "Codex TUI proxy transition channel was closed",
        }))
      }
      if (published) {
        yield* withOperationTimeout(Deferred.await(acknowledgment), acknowledgmentTimeoutMs,
          () => Effect.fail(new CodexTuiProxyError({
            operation: "publish-transition",
            message: `Codex TUI transition was not acknowledged within ${acknowledgmentTimeoutMs}ms`,
          })))
        if (publishedTransition._tag === "CodexThreadTransition") state.awaitingTemporaryAdoption = false
      }
    }))
    state.publishTail = publication
    const result = yield* Effect.exit(Fiber.join(publication).pipe(Effect.ensuring(Effect.sync(() => {
      state.pendingPublications -= 1
      state.transitionAcknowledgments.delete(acknowledgment)
    }))))
    if (Exit.isSuccess(result)) return true
    const cause = Cause.squash(result.cause)
    state.publicationFailure = cause instanceof CodexTuiProxyError
      ? cause
      : new CodexTuiProxyError({
          operation: "publish-transition",
          message: "Unable to publish Codex TUI transition",
          cause,
        })
    socket.close(1011, "Unable to publish thread transition")
    return false
  })
}

function enqueueServerMessage(
  socket: Bun.ServerWebSocket<ProxySocketData>,
  text: string,
  messageLimit: number,
  byteLimit: number,
  handle: Effect.Effect<void>,
): void {
  const data = socket.data
  const bytes = Buffer.byteLength(text)
  if (data.pendingServerMessages >= messageLimit || data.pendingServerMessageBytes + bytes > byteLimit) {
    closeQuietly(socket, 1013, "Upstream message queue limit exceeded")
    terminateQuietly(data.upstream)
    return
  }
  data.pendingServerMessages += 1
  data.pendingServerMessageBytes += bytes
  const previous = data.serverTail
  data.serverTail = data.runTask((previous ? Fiber.join(previous) : Effect.void).pipe(
    Effect.andThen(Effect.suspend(() => data.closed ? Effect.void : handle)),
    Effect.catchCause(() => Effect.sync(() => {
      if (!data.closed) socket.close(1011, "Unable to process upstream message")
    })),
    Effect.ensuring(Effect.sync(() => {
      data.pendingServerMessages -= 1
      data.pendingServerMessageBytes -= bytes
    })),
  ))
}

function clearSocketState(data: ProxySocketData): void {
  data.closed = true
  clearConnectTimer(data)
  data.queued.splice(0)
  data.queuedBytes = 0
  data.requests.clear()
  const upstream = data.upstream
  data.upstream = undefined
  if (upstream && upstream.readyState < WebSocket.CLOSING) terminateQuietly(upstream)
}

function clearConnectTimer(data: ProxySocketData): void {
  data.connectTimer?.interruptUnsafe()
  data.connectTimer = undefined
}

function terminateQuietly(socket: WebSocket | undefined): void {
  try {
    socket?.terminate()
  } catch {
    // Event callbacks cannot surface teardown failures to Bun safely.
  }
}

function closeQuietly(
  socket: Bun.ServerWebSocket<ProxySocketData>,
  code: number,
  reason: string,
): void {
  if (socket.data.closed) return
  socket.data.closed = true
  try {
    socket.close(code, reason)
  } catch {
    // The peer may already be gone.
  }
}

function operationFor(method: string): CodexThreadOperation | undefined {
  if (method === "thread/start") return "start"
  if (method === "thread/resume") return "resume"
  if (method === "thread/fork") return "fork"
  return undefined
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requestKey(id: number | string): string {
  return `${typeof id}:${String(id)}`
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function requireIdentifier(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new CodexTuiProxyError({
      operation: "listen",
      message: `Codex TUI proxy ${label} must be nonempty`,
    })
  }
}

function isCanonicalPathCandidate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value)
}

function assertLoopbackWebSocketUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new CodexTuiProxyError({
      operation: "connect",
      message: "Codex sidecar URL is invalid",
      cause,
    })
  }
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]")) {
    throw new CodexTuiProxyError({
      operation: "connect",
      message: "Codex TUI proxy upstream must be a loopback WebSocket",
    })
  }
}

function waitForListenerClose(
  port: number,
  timeoutMs: number | undefined,
): Effect.Effect<"closed" | "open" | "uncertain"> {
  return Effect.gen(function*() {
    const budget = yield* makeCleanupBudget(timeoutMs)
    let lastResult: "open" | "uncertain" = "uncertain"
    while ((yield* budget.remaining) > 0) {
      const remaining = yield* budget.remaining
      const result = yield* Effect.exit(budget.observe(Effect.tryPromise({
        try: (signal) => fetch(`http://127.0.0.1:${port}`, { signal }), catch: (cause) => cause,
      }).pipe(Effect.timeoutOrElse({
        duration: Math.min(50, remaining), orElse: () => Effect.fail(new Error("Listener probe timed out")),
      })), () => new Error("Listener cleanup deadline expired")))
      if (Exit.isSuccess(result)) {
        yield* Effect.promise(() => result.value.body?.cancel() ?? Promise.resolve())
        lastResult = "open"
      } else {
        const cause = Cause.squash(result.cause)
        if (hasErrorCode(cause, "ECONNREFUSED") || hasErrorCode(cause, "ConnectionRefused")) return "closed"
        lastResult = "uncertain"
      }
      yield* Effect.sleep(Math.min(10, yield* budget.remaining))
    }
    return lastResult
  })
}

function hasErrorCode(value: unknown, code: string): boolean {
  let current = value
  for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
    if (current.code === code) return true
    current = current.cause
  }
  return false
}
