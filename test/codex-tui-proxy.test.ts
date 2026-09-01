import { expect, test } from "bun:test"

import type { TerminalSessionTransition } from "../src/agent-provider"
import { createCodexTuiProxy } from "../src/providers/codex-tui-proxy"

test("relays protocol traffic and reports a successful top-level thread switch", async () => {
  const token = "proxy-secret"
  const upstream = protocolServer(token)
  const proxy = await createCodexTuiProxy(
    `ws://127.0.0.1:${upstream.server.port}`,
    token,
    "thread-a",
    (observed) => ({
      session: {
        id: String(observed.thread.id),
        title: String(observed.thread.preview),
        lastModified: Number(observed.thread.updatedAt) * 1_000,
      },
    }),
  )
  const observed: TerminalSessionTransition[] = []
  const unsubscribe = proxy.transitions.subscribe(
    (transition) => observed.push(transition),
    (error) => { throw error },
  )
  const client = new WebSocket(proxy.remoteUrl, {
    headers: { Authorization: `Bearer ${token}` },
  })
  let secondary: WebSocket | undefined

  try {
    await socketOpened(client)
    const response = nextSocketMessage(client)
    client.send(JSON.stringify({
      id: 7,
      method: "thread/fork",
      params: { threadId: "thread-a", beforeTurnId: "turn-2", ephemeral: false },
    }))

    expect(JSON.parse(await response)).toEqual({
      id: 7,
      result: {
        thread: {
          id: "thread-b",
          preview: "Forked",
          updatedAt: 12,
          ephemeral: false,
          parentThreadId: null,
        },
      },
    })
    await waitUntil(() => observed.length === 1)
    expect(observed[0]?.session).toEqual({
      id: "thread-b",
      title: "Forked",
      lastModified: 12_000,
    })
    expect(upstream.requests).toEqual([
      {
        id: 7,
        method: "thread/fork",
        params: { threadId: "thread-a", beforeTurnId: "turn-2", ephemeral: false },
      },
    ])

    secondary = new WebSocket(proxy.remoteUrl, {
      headers: { Authorization: `Bearer ${token}` },
    })
    await socketOpened(secondary)
    const resumeResponse = nextSocketMessage(secondary)
    secondary.send(JSON.stringify({
      id: 8,
      method: "thread/resume",
      params: { threadId: "thread-c" },
    }))
    expect(JSON.parse(await resumeResponse).result.thread.id).toBe("thread-c")
    await waitUntil(() => observed.length === 2)
    expect(observed[1]?.session.id).toBe("thread-c")
  } finally {
    unsubscribe()
    secondary?.close()
    client.close()
    await proxy.cleanup()
    await upstream.close()
  }
})

test("ignores ephemeral child threads", async () => {
  const token = "proxy-secret"
  const upstream = protocolServer(token, true)
  const proxy = await createCodexTuiProxy(
    `ws://127.0.0.1:${upstream.server.port}`,
    token,
    "thread-a",
    (observed) => ({
      session: { id: String(observed.thread.id), title: "Side", lastModified: 1 },
    }),
  )
  const observed: TerminalSessionTransition[] = []
  const unsubscribe = proxy.transitions.subscribe(
    (transition) => observed.push(transition),
    (error) => { throw error },
  )
  const client = new WebSocket(proxy.remoteUrl, {
    headers: { Authorization: `Bearer ${token}` },
  })

  try {
    await socketOpened(client)
    const response = nextSocketMessage(client)
    client.send(JSON.stringify({ id: 1, method: "thread/fork", params: { threadId: "thread-a" } }))
    await response
    await Bun.sleep(10)
    expect(observed).toEqual([])
  } finally {
    unsubscribe()
    client.close()
    await proxy.cleanup()
    await upstream.close()
  }
})

test("keeps each switch request's parent when responses arrive out of order", async () => {
  const token = "proxy-secret"
  const requests: Array<{ socket: Bun.ServerWebSocket<unknown>; message: Record<string, unknown> }> = []
  const sockets = new Set<Bun.ServerWebSocket<unknown>>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("Unauthorized", { status: 401 })
      }
      return server.upgrade(request) ? undefined : new Response("Upgrade required", { status: 426 })
    },
    websocket: {
      open(socket) { sockets.add(socket) },
      message(socket, message) {
        requests.push({
          socket,
          message: JSON.parse(typeof message === "string" ? message : Buffer.from(message).toString("utf8")),
        })
      },
      close(socket) { sockets.delete(socket) },
    },
  })
  const switches: Array<{ method: string; previousThreadId: string }> = []
  const proxy = await createCodexTuiProxy(
    `ws://127.0.0.1:${upstream.port}`,
    token,
    "thread-a",
    (observed) => {
      switches.push({ method: observed.method, previousThreadId: observed.previousThreadId })
      return {
        session: { id: String(observed.thread.id), title: "Switched", lastModified: 1 },
      }
    },
  )
  const unsubscribe = proxy.transitions.subscribe(() => undefined, (error) => { throw error })
  const client = new WebSocket(proxy.remoteUrl, {
    headers: { Authorization: `Bearer ${token}` },
  })

  try {
    await socketOpened(client)
    client.send(JSON.stringify({ id: 1, method: "thread/fork", params: { threadId: "thread-a" } }))
    client.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "thread-c" } }))
    await waitUntil(() => requests.length === 2)
    for (const id of [2, 1]) {
      const request = requests.find((candidate) => candidate.message.id === id)!
      request.socket.send(JSON.stringify({
        id,
        result: {
          thread: {
            id: id === 1 ? "thread-b" : "thread-c",
            preview: "Switched",
            updatedAt: 1,
            ephemeral: false,
            parentThreadId: null,
          },
        },
      }))
    }
    await waitUntil(() => switches.length === 2)
    expect(switches).toEqual([
      { method: "thread/resume", previousThreadId: "thread-a" },
      { method: "thread/fork", previousThreadId: "thread-a" },
    ])
  } finally {
    unsubscribe()
    client.close()
    await proxy.cleanup()
    for (const socket of sockets) socket.terminate()
    void upstream.stop(true)
  }
})

function protocolServer(token: string, ephemeral = false): {
  server: ReturnType<typeof Bun.serve>
  requests: unknown[]
  close(): Promise<void>
} {
  const requests: unknown[] = []
  const sockets = new Set<Bun.ServerWebSocket<unknown>>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("Unauthorized", { status: 401 })
      }
      return bunServer.upgrade(request)
        ? undefined
        : new Response("WebSocket upgrade required", { status: 426 })
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
      },
      message(socket, message) {
        const request = JSON.parse(typeof message === "string" ? message : Buffer.from(message).toString("utf8"))
        requests.push(request)
        const threadId = request.method === "thread/resume" ? request.params.threadId : "thread-b"
        socket.send(JSON.stringify({
          id: request.id,
          result: {
            thread: {
              id: threadId,
              preview: "Forked",
              updatedAt: 12,
              ephemeral,
              parentThreadId: ephemeral ? "thread-a" : null,
            },
          },
        }))
      },
      close(socket) {
        sockets.delete(socket)
      },
    },
  })
  return {
    server,
    requests,
    async close() {
      for (const socket of sockets) socket.terminate()
      void server.stop(true)
    },
  }
}

function socketOpened(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open")), {
      once: true,
    })
  })
}

function nextSocketMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") resolve(event.data)
      else reject(new Error("Expected text WebSocket message"))
    }, { once: true })
  })
}

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!condition() && performance.now() < deadline) await Bun.sleep(5)
  expect(condition()).toBeTrue()
}
