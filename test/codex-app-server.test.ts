import { describe, expect, test } from "bun:test"

import {
  CodexAppServerClient,
  CodexProtocolError,
  CodexRpcError,
  type CodexAppServerProcess,
} from "../src/providers/codex-app-server"

describe("Codex app-server JSONL client", () => {
  test("initializes, handles split and out-of-order responses, and closes cleanly", async () => {
    const transport = fakeProcess((message, process) => {
      if (message.method === "initialize") {
        process.respond(message.id, { userAgent: "test" }, true)
      } else if (message.method === "thread/read") {
        const params = message.params as { threadId: string }
        const delay = params.threadId === "slow" ? 5 : 0
        setTimeout(() => process.respond(message.id, { thread: thread(params.threadId) }), delay)
      }
    })
    const client = await CodexAppServerClient.start("/usr/bin/codex", {
      spawn(command) {
        expect(command).toEqual(["/usr/bin/codex", "app-server", "--stdio"])
        return transport.process
      },
    })

    const [slow, fast] = await Promise.all([client.readThread("slow"), client.readThread("fast")])

    expect(slow.id).toBe("slow")
    expect(fast.id).toBe("fast")
    expect(transport.messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/read",
      "thread/read",
    ])
    expect(transport.messages[2]?.params).toEqual({ threadId: "slow", includeTurns: true })
    await client.close()
    expect(transport.ended).toBeTrue()
  })

  test("surfaces structured RPC errors", async () => {
    const transport = fakeProcess((message, process) => {
      if (message.method === "initialize") process.respond(message.id, {})
      if (message.method === "thread/read") {
        process.error(message.id, -32602, "invalid thread", { field: "threadId" })
      }
    })
    const client = await CodexAppServerClient.start("codex", { spawn: () => transport.process })

    const error = await client.readThread("bad").catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CodexRpcError)
    expect(error).toMatchObject({ method: "thread/read", code: -32602, data: { field: "threadId" } })
    await client.close()
  })

  test("supports metadata-only thread reads", async () => {
    const transport = fakeProcess((message, process) => {
      if (message.method === "initialize") process.respond(message.id, {})
      if (message.method === "thread/read") process.respond(message.id, { thread: thread("metadata") })
    })
    const client = await CodexAppServerClient.start("codex", { spawn: () => transport.process })

    expect((await client.readThread("metadata", false)).id).toBe("metadata")
    expect(transport.messages[2]?.params).toEqual({ threadId: "metadata", includeTurns: false })
    await client.close()
  })

  test("lists loaded thread ids", async () => {
    const transport = fakeProcess((message, process) => {
      if (message.method === "initialize") process.respond(message.id, {})
      if (message.method === "thread/loaded/list") {
        process.respond(message.id, { data: ["new-thread"], nextCursor: null })
      }
    })
    const client = await CodexAppServerClient.start("codex", {
      spawn: () => transport.process,
    })

    expect(await client.listLoadedThreadIds()).toEqual(["new-thread"])
    await client.close()
  })

  test("rejects malformed JSONL instead of hanging", async () => {
    const transport = fakeProcess((message, process) => {
      if (message.method === "initialize") process.respond(message.id, {})
      if (message.method === "thread/read") process.emit("not-json\n")
    })
    const client = await CodexAppServerClient.start("codex", { spawn: () => transport.process })

    await expect(client.readThread("bad")).rejects.toBeInstanceOf(CodexProtocolError)
    await client.close()
  })

  test("rejects malformed method results with protocol context", async () => {
    const transport = fakeProcess((message, process) => {
      if (message.method === "initialize") process.respond(message.id, {})
      if (message.method === "thread/read") process.respond(message.id, { thread: { id: "partial" } })
    })
    const client = await CodexAppServerClient.start("codex", { spawn: () => transport.process })

    await expect(client.readThread("partial")).rejects.toThrow(
      "Codex app-server thread/read returned an invalid result",
    )
    await client.close()
  })

  test("bounds request waits with a descriptive timeout", async () => {
    const transport = fakeProcess((message, process) => {
      if (message.method === "initialize") process.respond(message.id, {})
    })
    const client = await CodexAppServerClient.start("codex", {
      spawn: () => transport.process,
      requestTimeoutMs: 5,
    })

    await expect(client.readThread("missing")).rejects.toThrow(
      "Codex app-server thread/read timed out after 5ms",
    )
    await client.close()
  })

  test("connects to an authenticated WebSocket transport", async () => {
    const authorizations: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(request, bunServer) {
        authorizations.push(request.headers.get("authorization") ?? "")
        if (bunServer.upgrade(request)) return
        return new Response("upgrade required", { status: 426 })
      },
      websocket: {
        message(socket, data) {
          const message = JSON.parse(String(data)) as WireMessage
          if (message.id === undefined) return
          const result = message.method === "thread/read"
            ? { thread: thread("websocket") }
            : {}
          socket.send(JSON.stringify({ id: message.id, result }))
        },
      },
    })

    try {
      const client = await CodexAppServerClient.connect(
        `ws://127.0.0.1:${server.port}`,
        { bearerToken: "secret" },
      )
      expect((await client.readThread("websocket")).id).toBe("websocket")
      await client.close()
      expect(authorizations).toEqual(["Bearer secret"])
    } finally {
      server.stop(true)
    }
  })
})

interface WireMessage {
  id?: number
  method?: string
  params?: unknown
}

function fakeProcess(onMessage: (message: WireMessage, controls: Controls) => void): {
  process: CodexAppServerProcess
  messages: WireMessage[]
  readonly ended: boolean
} & Controls {
  let stdoutController: ReadableStreamDefaultController<Uint8Array>
  let stderrController: ReadableStreamDefaultController<Uint8Array>
  let resolveExited: (code: number) => void = () => undefined
  let ended = false
  const messages: WireMessage[] = []
  const encoder = new TextEncoder()
  const controls: Controls = {
    emit(text) {
      stdoutController.enqueue(encoder.encode(text))
    },
    respond(id, result, split = false) {
      const line = `${JSON.stringify({ id, result })}\n`
      if (split) {
        const middle = Math.floor(line.length / 2)
        controls.emit(line.slice(0, middle))
        controls.emit(line.slice(middle))
      } else {
        controls.emit(line)
      }
    },
    error(id, code, message, data) {
      controls.emit(`${JSON.stringify({ id, error: { code, message, data } })}\n`)
    },
  }
  const process: CodexAppServerProcess = {
    stdin: {
      write(data) {
        for (const line of data.trim().split("\n")) {
          const message = JSON.parse(line) as WireMessage
          messages.push(message)
          onMessage(message, controls)
        }
        return data.length
      },
      flush() {
        return 0
      },
      end() {
        if (ended) return
        ended = true
        stdoutController.close()
        stderrController.close()
        resolveExited(0)
      },
    },
    stdout: new ReadableStream({ start(controller) { stdoutController = controller } }),
    stderr: new ReadableStream({ start(controller) { stderrController = controller } }),
    exited: new Promise((resolve) => { resolveExited = resolve }),
    kill() {
      if (!ended) process.stdin.end()
    },
  }
  return {
    process,
    messages,
    get ended() { return ended },
    ...controls,
  }
}

interface Controls {
  emit(text: string): void
  respond(id: number | undefined, result: unknown, split?: boolean): void
  error(id: number | undefined, code: number, message: string, data?: unknown): void
}

function thread(id: string) {
  return {
    id,
    name: null,
    preview: id,
    updatedAt: 1,
    cwd: "/project",
    gitInfo: null,
    turns: [],
  }
}
