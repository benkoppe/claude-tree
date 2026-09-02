import { Data, Effect, PubSub, Scope } from "effect"

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000
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
  readonly previousThreadId: string
  readonly threadId: string
  readonly title: string
  readonly updatedAt: number
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

export class CodexTuiProxyError extends Data.TaggedError("CodexTuiProxyError")<{
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export interface CodexTuiProxyOptions {
  readonly upstreamUrl: string
  readonly bearerToken: string
  readonly initialThreadId: string
  readonly connectTimeoutMs?: number
  readonly cleanupTimeoutMs?: number
  readonly maxPreOpenMessages?: number
  readonly maxPreOpenBytes?: number
  readonly maxPendingRequests?: number
  readonly transitionCapacity?: number
  readonly maxClients?: number
  readonly maxServerMessages?: number
  readonly maxServerMessageBytes?: number
}

export interface CodexTuiProxy {
  readonly remoteUrl: string
  readonly transitions: PubSub.PubSub<CodexTuiProxyTransition>
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
  connectTimer: ReturnType<typeof setTimeout> | undefined
  readonly queued: QueuedMessage[]
  queuedBytes: number
  readonly requests: Map<string, PendingSwitch>
  currentThreadId: string
  serverTail: Promise<void>
  pendingServerMessages: number
  pendingServerMessageBytes: number
  closed: boolean
}

interface ProxyState {
  readonly server: Bun.Server<ProxySocketData>
  readonly port: number
  readonly clients: Set<Bun.ServerWebSocket<ProxySocketData>>
  readonly transitions: PubSub.PubSub<CodexTuiProxyTransition>
  readonly cleanupTimeoutMs: number
  closed: boolean
  publishTail: Promise<void>
  pendingPublications: number
  publicationFailure: CodexTuiProxyError | undefined
  cleanupTask: Promise<void> | undefined
}

export function makeCodexTuiProxy(
  options: CodexTuiProxyOptions,
): Effect.Effect<CodexTuiProxy, CodexTuiProxyError, Scope.Scope> {
  return Effect.gen(function*() {
    const transitionCapacity = positiveInteger(options.transitionCapacity, DEFAULT_TRANSITION_CAPACITY)
    const transitions = yield* PubSub.bounded<CodexTuiProxyTransition>(transitionCapacity)
    const state = yield* Effect.acquireRelease(
      createProxyState(options, transitions, transitionCapacity),
      (state) => cleanupProxy(state).pipe(Effect.orDie),
    )
    return {
      remoteUrl: `ws://127.0.0.1:${state.port}`,
      transitions,
      close: () => cleanupProxy(state),
    }
  })
}

function createProxyState(
  options: CodexTuiProxyOptions,
  transitions: PubSub.PubSub<CodexTuiProxyTransition>,
  transitionCapacity: number,
): Effect.Effect<ProxyState, CodexTuiProxyError> {
  return Effect.try({
    try: () => {
      assertLoopbackWebSocketUrl(options.upstreamUrl)
      requireIdentifier(options.initialThreadId, "initial thread id")
      const clients = new Set<Bun.ServerWebSocket<ProxySocketData>>()
      let clientSlots = 0
      let currentThreadId = options.initialThreadId
      const state = {} as ProxyState
      const maxPreOpenMessages = positiveInteger(options.maxPreOpenMessages, DEFAULT_PREOPEN_MESSAGES)
      const maxPreOpenBytes = positiveInteger(options.maxPreOpenBytes, DEFAULT_PREOPEN_BYTES)
      const maxPendingRequests = positiveInteger(options.maxPendingRequests, DEFAULT_PENDING_REQUESTS)
      const connectTimeoutMs = positiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS)
      const maxClients = positiveInteger(options.maxClients, DEFAULT_CLIENTS)
      const maxServerMessages = positiveInteger(options.maxServerMessages, DEFAULT_SERVER_MESSAGES)
      const maxServerMessageBytes = positiveInteger(
        options.maxServerMessageBytes,
        DEFAULT_SERVER_MESSAGE_BYTES,
      )

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
              serverTail: Promise.resolve(),
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
            const upstream = new WebSocket(options.upstreamUrl, {
              headers: { Authorization: `Bearer ${options.bearerToken}` },
            })
            socket.data.upstream = upstream
            socket.data.connectTimer = setTimeout(() => {
              upstream.terminate()
              socket.close(1013, "Upstream connect timeout")
            }, connectTimeoutMs)

            upstream.addEventListener("open", () => {
              clearConnectTimer(socket.data)
              for (const message of socket.data.queued.splice(0)) upstream.send(message.text)
              socket.data.queuedBytes = 0
            }, { once: true })
            upstream.addEventListener("message", (event) => {
              if (typeof event.data !== "string") {
                upstream.terminate()
                socket.close(1003, "Upstream messages must be text")
                return
              }
              enqueueServerMessage(
                socket,
                event.data,
                maxServerMessages,
                maxServerMessageBytes,
                async () => {
                  const transition = observeServerMessage(socket.data, event.data)
                  if (transition) {
                    if (!await publishTransition(state, transition, transitionCapacity, socket)) return
                    if (transition._tag === "CodexThreadTransition") {
                      currentThreadId = transition.threadId
                      for (const client of clients) client.data.currentThreadId = transition.threadId
                    }
                  }
                  if (!socket.data.closed) socket.send(event.data)
                },
              )
            })
            upstream.addEventListener("error", () => {
              clearConnectTimer(socket.data)
              socket.close(1011, "Upstream failed")
            }, { once: true })
            upstream.addEventListener("close", (event) => {
              clearConnectTimer(socket.data)
              socket.close(event.code === 1000 ? 1000 : 1011, "Upstream closed")
            }, { once: true })
          },
          message(socket, message) {
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
          },
          close(socket) {
            clients.delete(socket)
            clientSlots -= 1
            clearSocketState(socket.data)
          },
        },
      })
      const port = server.port
      if (port === undefined) {
        void server.stop(true)
        throw new CodexTuiProxyError({
          operation: "listen",
          message: "Codex TUI proxy did not bind a loopback port",
        })
      }
      Object.assign(state, {
        server,
        port,
        clients,
        transitions,
        cleanupTimeoutMs: positiveInteger(options.cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS),
        closed: false,
        publishTail: Promise.resolve(),
        pendingPublications: 0,
        publicationFailure: undefined,
        cleanupTask: undefined,
      })
      return state
    },
    catch: (cause) => cause instanceof CodexTuiProxyError
      ? cause
      : new CodexTuiProxyError({
        operation: "listen",
        message: "Unable to start Codex TUI proxy",
        cause,
      }),
  })
}

function cleanupProxy(state: ProxyState): Effect.Effect<void, CodexTuiProxyError> {
  return Effect.tryPromise({
    try: () => {
      state.cleanupTask ??= cleanupProxyPromise(state)
      return state.cleanupTask
    },
    catch: (cause) => cause instanceof CodexTuiProxyError
      ? cause
      : new CodexTuiProxyError({
        operation: "cleanup",
        message: "Unable to clean up Codex TUI proxy",
        cause,
      }),
  })
}

async function cleanupProxyPromise(state: ProxyState): Promise<void> {
  if (state.closed) return
  state.closed = true
  const failures: unknown[] = []
  const serverTails = [...state.clients].map((client) => client.data.serverTail)
  for (const client of state.clients) {
    clearSocketState(client.data)
    try {
      client.terminate()
    } catch (cause) {
      failures.push(cause)
    }
  }
  state.clients.clear()

  let stop: Promise<void>
  try {
    stop = state.server.stop(true)
  } catch (cause) {
    failures.push(cause)
    stop = Promise.reject(cause)
  }

  const publicationBeforeShutdown = await settlementWithin(state.publishTail, state.cleanupTimeoutMs)
  if (publicationBeforeShutdown._tag === "TimedOut") {
    failures.push(new Error("Codex TUI proxy transition publication did not drain in time"))
  } else if (publicationBeforeShutdown._tag === "Rejected") {
    failures.push(publicationBeforeShutdown.cause)
  }

  try {
    await Effect.runPromise(PubSub.shutdown(state.transitions))
  } catch (cause) {
    failures.push(cause)
  }

  const background = await Promise.all([
    settlementWithin(state.publishTail, state.cleanupTimeoutMs),
    ...serverTails.map((tail) => settlementWithin(tail, state.cleanupTimeoutMs)),
  ])
  for (const result of background) {
    if (result._tag === "Rejected") failures.push(result.cause)
    else if (result._tag === "TimedOut") failures.push(new Error("Codex TUI proxy message cleanup timed out"))
  }
  if (state.publicationFailure) failures.push(state.publicationFailure)

  const stopped = settlementWithin(stop, state.cleanupTimeoutMs)
  const listenerClosed = waitForListenerClose(state.port, state.cleanupTimeoutMs)
  const firstClosure = await Promise.race([
    stopped.then((result) => ({ _tag: "Stop" as const, result })),
    listenerClosed.then((result) => ({ _tag: "Listener" as const, result })),
  ])
  if (firstClosure._tag === "Stop") {
    if (firstClosure.result._tag === "Rejected") failures.push(firstClosure.result.cause)
    if (firstClosure.result._tag !== "Fulfilled") {
      const listener = await listenerClosed
      if (listener === "open") failures.push(new Error("Codex TUI proxy listener remained open"))
      if (listener === "uncertain") failures.push(new Error("Unable to verify that the Codex TUI proxy listener closed"))
    }
  } else if (firstClosure.result !== "closed") {
    const result = await stopped
    if (result._tag === "Rejected") failures.push(result.cause)
    if (result._tag !== "Fulfilled") {
      if (firstClosure.result === "open") failures.push(new Error("Codex TUI proxy listener remained open"))
      else failures.push(new Error("Unable to verify that the Codex TUI proxy listener closed"))
    }
  }

  if (failures.length > 0) {
    state.cleanupTask = undefined
    throw new CodexTuiProxyError({
      operation: "cleanup",
      message: "Unable to clean up Codex TUI proxy",
      cause: failures.length === 1 ? failures[0] : new AggregateError(failures),
    })
  }
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
): CodexTuiProxyTransition | undefined {
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
    !Number.isFinite(thread.updatedAt) || typeof thread.ephemeral !== "boolean" ||
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
    ...(request.requestedThreadId === undefined
      ? {}
      : { requestedThreadId: request.requestedThreadId }),
    ...(request.forkPointTurnId === undefined
      ? {}
      : { forkPointTurnId: request.forkPointTurnId }),
  }
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

async function publishTransition(
  state: ProxyState,
  transition: CodexTuiProxyTransition,
  capacity: number,
  socket: Bun.ServerWebSocket<ProxySocketData>,
): Promise<boolean> {
  if (state.pendingPublications >= capacity) {
    socket.close(1013, "Transition queue limit exceeded")
    return false
  }
  state.pendingPublications += 1
  const publication = state.publishTail.then(async () => {
    const published = await Effect.runPromise(PubSub.publish(state.transitions, transition))
    if (!published && !state.closed) {
      throw new CodexTuiProxyError({
        operation: "publish-transition",
        message: "Codex TUI proxy transition channel was closed",
      })
    }
  })
  state.publishTail = publication
  try {
    await publication
    return true
  } catch (cause) {
    state.publicationFailure = cause instanceof CodexTuiProxyError
      ? cause
      : new CodexTuiProxyError({
          operation: "publish-transition",
          message: "Unable to publish Codex TUI transition",
          cause,
        })
    socket.close(1011, "Unable to publish thread transition")
    return false
  } finally {
    state.pendingPublications -= 1
  }
}

function enqueueServerMessage(
  socket: Bun.ServerWebSocket<ProxySocketData>,
  text: string,
  messageLimit: number,
  byteLimit: number,
  handle: () => Promise<void>,
): void {
  const data = socket.data
  const bytes = Buffer.byteLength(text)
  if (data.pendingServerMessages >= messageLimit || data.pendingServerMessageBytes + bytes > byteLimit) {
    data.upstream?.terminate()
    socket.close(1013, "Upstream message queue limit exceeded")
    return
  }
  data.pendingServerMessages += 1
  data.pendingServerMessageBytes += bytes
  data.serverTail = data.serverTail
    .then(() => data.closed ? undefined : handle())
    .catch(() => {
      if (!data.closed) socket.close(1011, "Unable to process upstream message")
    })
    .finally(() => {
      data.pendingServerMessages -= 1
      data.pendingServerMessageBytes -= bytes
    })
}

function clearSocketState(data: ProxySocketData): void {
  data.closed = true
  clearConnectTimer(data)
  data.queued.splice(0)
  data.queuedBytes = 0
  data.requests.clear()
  const upstream = data.upstream
  data.upstream = undefined
  if (upstream && upstream.readyState < WebSocket.CLOSING) upstream.terminate()
}

function clearConnectTimer(data: ProxySocketData): void {
  if (data.connectTimer !== undefined) clearTimeout(data.connectTimer)
  data.connectTimer = undefined
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

async function waitForListenerClose(
  port: number,
  timeoutMs: number,
): Promise<"closed" | "open" | "uncertain"> {
  const deadline = performance.now() + timeoutMs
  let lastResult: "open" | "uncertain" = "uncertain"
  while (performance.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - performance.now())
      await fetch(`http://127.0.0.1:${port}`, {
        signal: AbortSignal.timeout(Math.min(50, remaining)),
      })
      lastResult = "open"
    } catch (cause) {
      if (hasErrorCode(cause, "ECONNREFUSED") || hasErrorCode(cause, "ConnectionRefused")) return "closed"
      lastResult = "uncertain"
    }
    await Bun.sleep(10)
  }
  return lastResult
}

function hasErrorCode(value: unknown, code: string): boolean {
  let current = value
  for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
    if (current.code === code) return true
    current = current.cause
  }
  return false
}
