import { randomBytes } from "node:crypto"

import { Effect, PubSub, Semaphore, type Scope } from "effect"

import { ProviderCleanupError } from "../../../domain/errors"

const TOKEN_ENV = "CLAUDE_TREE_HOOK_TOKEN"
const HOOK_PATH = "/lifecycle"
const MAX_BODY_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 750
// Leave margin inside the supervisor's 500ms explicit-close and scope deadlines.
const CLEANUP_TIMEOUT_MS = 200
const MAX_REQUESTS = 4

export interface ClaudeLifecycleHooks {
  readonly settings: string
  readonly env: Readonly<Record<string, string>>
  readonly activityHints: PubSub.PubSub<"reconcile">
  readonly close: Effect.Effect<void, ProviderCleanupError>
}

type HookServer = Pick<Bun.Server<undefined>, "port" | "stop">
type ServeHooks = (fetch: (request: Request) => Promise<Response>) => HookServer

export function makeClaudeLifecycleHooks(
  sessionId: string,
  serve: ServeHooks = (fetch) => Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 1,
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch,
  }),
): Effect.Effect<ClaudeLifecycleHooks | undefined, never, Scope.Scope> {
  return Effect.uninterruptible(Effect.gen(function*() {
    const token = randomBytes(32).toString("hex")
    const activityHints = yield* PubSub.dropping<"reconcile">(1)
    const readers = new Set<() => void>()
    let closing = false
    let stopped = false
    const server = yield* Effect.try(() => serve(async (request) => {
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 })
      if (request.method !== "POST") return new Response(null, { status: 405 })
      if (new URL(request.url).pathname !== HOOK_PATH) return new Response(null, { status: 404 })
      if (closing) return new Response(null, { status: 503 })
      if (readers.size >= MAX_REQUESTS) return new Response(null, { status: 429 })
      if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return new Response(null, { status: 413 })
      const reader = request.body?.getReader()
      if (!reader) return new Response(null, { status: 400 })
      const cancel = () => { void reader.cancel().catch(() => undefined) }
      readers.add(cancel)
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; cancel() }, REQUEST_TIMEOUT_MS)
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true })
        let text = ""
        let bytes = 0
        while (true) {
          const chunk = await reader.read()
          if (timedOut) return new Response(null, { status: 408 })
          if (closing) return new Response(null, { status: 503 })
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > MAX_BODY_BYTES) return new Response(null, { status: 413 })
          text += decoder.decode(chunk.value, { stream: true })
        }
        const payload: unknown = JSON.parse(text + decoder.decode())
        if (typeof payload !== "object" || payload === null || Array.isArray(payload) ||
          !("session_id" in payload) || payload.session_id !== sessionId ||
          "agent_id" in payload || !("hook_event_name" in payload) ||
          (payload.hook_event_name !== "Stop" && payload.hook_event_name !== "StopFailure")) {
          return new Response(null, { status: 400 })
        }
        // Hooks only wake screen reconciliation; they never establish completion.
        PubSub.publishUnsafe(activityHints, "reconcile")
        return Response.json({})
      } catch {
        return new Response(null, { status: 400 })
      } finally {
        clearTimeout(timer)
        cancel()
        readers.delete(cancel)
      }
    })).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (server === undefined) {
      yield* PubSub.shutdown(activityHints)
      return undefined
    }
    const cleanupError = () => new ProviderCleanupError({
      providerId: "claude",
      operation: "closeLaunch",
      message: "Unable to close Claude lifecycle hooks",
    })
    const cleanupLock = Semaphore.makeUnsafe(1)
    const close = Effect.uninterruptible(cleanupLock.withPermit(Effect.gen(function*() {
      closing = true
      yield* PubSub.shutdown(activityHints)
      if (stopped) return
      for (const cancel of readers) cancel()
      yield* Effect.tryPromise({
        try: () => server.stop(true),
        catch: cleanupError,
      }).pipe(Effect.timeoutOrElse({
        duration: CLEANUP_TIMEOUT_MS,
        orElse: () => Effect.fail(cleanupError()),
      }))
      stopped = true
    })))
    yield* Effect.addFinalizer(() => close.pipe(Effect.orDie))
    const hook = {
      type: "http",
      url: `http://127.0.0.1:${server.port}${HOOK_PATH}`,
      timeout: 1,
      headers: { Authorization: `Bearer \${${TOKEN_ENV}}` },
      allowedEnvVars: [TOKEN_ENV],
    }
    return {
      settings: JSON.stringify({ hooks: {
        Stop: [{ hooks: [hook] }],
        StopFailure: [{ hooks: [hook] }],
      } }),
      env: { [TOKEN_ENV]: token },
      activityHints,
      close,
    }
  }))
}
