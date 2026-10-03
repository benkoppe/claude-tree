import { createConnection, type Socket } from "node:net"

export async function stopTestServer(server: ReturnType<typeof Bun.serve>): Promise<void> {
  const port = server.port!
  let probe: Socket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const stopped = server.stop(true)
    // Bun can close the listener without settling stop() after WebSocket use.
    await Promise.race([stopped, new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Test server cleanup timed out")), 1_000)
      probe = createConnection({ host: "127.0.0.1", port })
      probe.once("connect", () => reject(new Error("Test server listener remained open")))
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED") resolve()
        else reject(error)
      })
    })])
  } finally {
    clearTimeout(timer)
    probe?.destroy()
    server.unref()
  }
}
