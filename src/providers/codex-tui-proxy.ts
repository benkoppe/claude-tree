import type { AgentSession, TerminalSessionTransitionSource } from "../agent-provider"

export interface CodexTuiSwitch {
  previousThreadId: string
  thread: Record<string, unknown>
  method: "thread/fork" | "thread/resume" | "thread/start"
  params: Record<string, unknown>
}

export interface CodexTuiProxy {
  remoteUrl: string
  transitions: TerminalSessionTransitionSource
  cleanup(): Promise<void>
}

interface PendingRequest {
  method: string
  params: Record<string, unknown>
  previousThreadId: string
}

interface ProxySocketData {
  upstream?: WebSocket
  queued: string[]
  requests: Map<string, PendingRequest>
  currentThreadId: string
}

export async function createCodexTuiProxy(
  upstreamUrl: string,
  bearerToken: string,
  initialThreadId: string,
  transitionFor: (observed: CodexTuiSwitch) => {
    session: AgentSession
    derivation?: Promise<import("../agent-provider").BranchDerivation | undefined>
  },
): Promise<CodexTuiProxy> {
  const listeners = new Set<{
    transition: (transition: ReturnType<typeof transitionFor>) => void
    error: (error: Error) => void
  }>()
  const clients = new Set<Bun.ServerWebSocket<ProxySocketData>>()
  let currentThreadId = initialThreadId
  let closed = false

  const reportError = (error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error))
    for (const listener of listeners) listener.error(normalized)
  }
  const server = Bun.serve<ProxySocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      if (closed) return new Response("Proxy is closing", { status: 503 })
      if (request.headers.get("authorization") !== `Bearer ${bearerToken}`) {
        return new Response("Unauthorized", { status: 401 })
      }
      const upgraded = bunServer.upgrade(request, {
        data: {
          queued: [],
          requests: new Map(),
          currentThreadId,
        },
      })
      return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 })
    },
    websocket: {
      open(socket) {
        clients.add(socket)
        const upstream = new WebSocket(upstreamUrl, {
          headers: { Authorization: `Bearer ${bearerToken}` },
        })
        socket.data.upstream = upstream
        upstream.addEventListener("open", () => {
          for (const message of socket.data.queued.splice(0)) upstream.send(message)
        })
        upstream.addEventListener("message", (event) => {
          if (typeof event.data !== "string") {
            reportError(new Error("Codex app-server sent a non-text WebSocket message"))
            socket.close(1011, "Invalid upstream message")
            return
          }
          observeServerMessage(
            socket.data,
            event.data,
            transitionFor,
            listeners,
            (sessionId) => {
              currentThreadId = sessionId
              for (const client of clients) client.data.currentThreadId = sessionId
            },
          )
          socket.send(event.data)
        })
        upstream.addEventListener("error", () => {
          reportError(new Error("Codex app-server WebSocket failed"))
          socket.close(1011, "Upstream failed")
        })
        upstream.addEventListener("close", (event) => {
          socket.close(event.code === 1000 ? 1000 : 1011, "Upstream closed")
        })
      },
      message(socket, message) {
        const text = typeof message === "string" ? message : Buffer.from(message).toString("utf8")
        observeClientMessage(socket.data, text)
        if (socket.data.upstream?.readyState === WebSocket.OPEN) {
          socket.data.upstream.send(text)
        } else {
          socket.data.queued.push(text)
        }
      },
      close(socket) {
        clients.delete(socket)
        const upstream = socket.data.upstream
        if (upstream && upstream.readyState < WebSocket.CLOSING) upstream.close(1000)
      },
    },
  })
  const port = server.port
  if (port === undefined) {
    void server.stop(true)
    throw new Error("Codex TUI proxy did not bind a loopback port")
  }

  const transitions: TerminalSessionTransitionSource = {
    subscribe(onTransition, onError) {
      const listener = { transition: onTransition, error: onError }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  let cleanupPromise: Promise<void> | undefined
  return {
    remoteUrl: `ws://127.0.0.1:${port}`,
    transitions,
    cleanup() {
      cleanupPromise ??= (async () => {
        closed = true
        listeners.clear()
        for (const client of clients) {
          const upstream = client.data.upstream
          if (upstream && upstream.readyState < WebSocket.CLOSING) upstream.close(1000)
          client.terminate()
        }
        clients.clear()
        const stopped = server.stop(true)
        void stopped.catch(() => undefined)
        await waitForListenerClose(port)
      })()
      return cleanupPromise
    },
  }
}

async function waitForListenerClose(port: number): Promise<void> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(50) })
    } catch {
      return
    }
    await Bun.sleep(10)
  }
  throw new Error("Codex TUI proxy listener did not stop")
}

function observeClientMessage(data: ProxySocketData, text: string): void {
  const message = parseRecord(text)
  if (!message || !("id" in message) || typeof message.method !== "string") return
  data.requests.set(requestKey(message.id), {
    method: message.method,
    params: isRecord(message.params) ? message.params : {},
    previousThreadId: data.currentThreadId,
  })
}

function observeServerMessage(
  data: ProxySocketData,
  text: string,
  transitionFor: (observed: CodexTuiSwitch) => {
    session: AgentSession
    derivation?: Promise<import("../agent-provider").BranchDerivation | undefined>
  },
  listeners: Set<{
    transition: (transition: ReturnType<typeof transitionFor>) => void
    error: (error: Error) => void
  }>,
  updateCurrentThreadId: (sessionId: string) => void,
): void {
  const message = parseRecord(text)
  if (!message || !("id" in message)) return
  const request = data.requests.get(requestKey(message.id))
  if (!request) return
  data.requests.delete(requestKey(message.id))
  if ("error" in message || !("result" in message)) return
  if (
    request.method !== "thread/fork" &&
    request.method !== "thread/resume" &&
    request.method !== "thread/start"
  ) {
    return
  }
  const result = isRecord(message.result) ? message.result : undefined
  const thread = result && isRecord(result.thread) ? result.thread : undefined
  if (!thread || typeof thread.id !== "string" || thread.id === request.previousThreadId) return
  if (thread.ephemeral === true || (thread.parentThreadId !== undefined && thread.parentThreadId !== null)) {
    return
  }
  const observed: CodexTuiSwitch = {
    previousThreadId: request.previousThreadId,
    thread,
    method: request.method,
    params: request.params,
  }
  updateCurrentThreadId(thread.id)
  if (listeners.size === 0) return
  const transition = transitionFor(observed)
  for (const listener of listeners) listener.transition(transition)
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function requestKey(id: unknown): string {
  return `${typeof id}:${String(id)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
