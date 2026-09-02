import { randomUUID as nodeRandomUUID } from "node:crypto"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Data, Effect, Scope } from "effect"

const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000
const STDERR_LIMIT_BYTES = 8_192

export class CodexSidecarError extends Data.TaggedError("CodexSidecarError")<{
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export interface CodexSidecarProcess {
  readonly pid: number
  readonly exitCode: number | null
  readonly exited: Promise<number>
  readonly stderr: ReadableStream<Uint8Array>
  kill(signal?: number | NodeJS.Signals): void
  unref(): void
}

export interface CodexSidecar {
  readonly remoteUrl: string
  readonly bearerToken: string
  readonly process: CodexSidecarProcess
  readonly stderr: Promise<string>
}

export interface CodexSidecarDependencies {
  readonly makeTemporaryDirectory?: (prefix: string) => Promise<string>
  readonly writeToken?: (
    path: string,
    token: string,
    options: { readonly mode: number },
  ) => Promise<void>
  readonly setTokenMode?: (path: string, mode: number) => Promise<void>
  readonly removeDirectory?: (path: string) => Promise<void>
  readonly allocatePort?: () => Promise<number>
  readonly randomUUID?: () => string
  readonly spawn?: (command: readonly string[]) => CodexSidecarProcess
  readonly signalProcessGroup?: (process: CodexSidecarProcess, signal: NodeJS.Signals) => void
}

export interface CodexSidecarLaunchOptions {
  readonly cleanupTimeoutMs?: number
}

export function makeCodexSidecar(
  executable: string,
  dependencies: CodexSidecarDependencies = {},
  options: CodexSidecarLaunchOptions = {},
): Effect.Effect<CodexSidecar, CodexSidecarError, Scope.Scope> {
  const cleanupTimeoutMs = positiveDuration(options.cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS)
  const removeDirectory = dependencies.removeDirectory ??
    ((path: string) => rm(path, { recursive: true, force: true }))

  return Effect.gen(function*() {
    const directory = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => (dependencies.makeTemporaryDirectory ?? mkdtemp)(
          join(tmpdir(), "claude-tree-codex-"),
        ),
        catch: (cause) => sidecarError("temporary-directory", "Unable to create Codex token directory", cause),
      }),
      (path) => Effect.tryPromise({
        try: () => removeDirectory(path),
        catch: (cause) => sidecarError("cleanup", "Unable to remove Codex token directory", cause),
      }).pipe(Effect.orDie),
    )
    const tokenPath = join(directory, "token")
    const bearerToken = yield* Effect.try({
      try: () => (dependencies.randomUUID ?? nodeRandomUUID)().replaceAll("-", ""),
      catch: (cause) => sidecarError("token", "Unable to create Codex capability token", cause),
    })
    yield* Effect.tryPromise({
      try: async () => {
        await (dependencies.writeToken ?? writeFile)(tokenPath, bearerToken, { mode: 0o600 })
        await (dependencies.setTokenMode ?? chmod)(tokenPath, 0o600)
      },
      catch: (cause) => sidecarError("token", "Unable to write Codex capability token", cause),
    })
    const port = yield* Effect.tryPromise({
      try: dependencies.allocatePort ?? availableLoopbackPort,
      catch: (cause) => sidecarError("listen", "Unable to allocate a Codex loopback port", cause),
    })
    const remoteUrl = `ws://127.0.0.1:${port}`
    const process = yield* Effect.acquireRelease(
      Effect.try({
        try: () => (dependencies.spawn ?? spawnSidecar)([
          executable,
          "app-server",
          "--listen",
          remoteUrl,
          "--ws-auth",
          "capability-token",
          "--ws-token-file",
          tokenPath,
        ]),
        catch: (cause) => sidecarError("spawn", "Unable to start Codex app-server sidecar", cause),
      }),
      (process) => cleanupProcess(
        process,
        dependencies.signalProcessGroup ?? signalProcessGroup,
        cleanupTimeoutMs,
      ).pipe(Effect.orDie),
    )
    return {
      remoteUrl,
      bearerToken,
      process,
      stderr: readBoundedText(process.stderr, STDERR_LIMIT_BYTES),
    }
  })
}

function cleanupProcess(
  process: CodexSidecarProcess,
  signal: (process: CodexSidecarProcess, signal: NodeJS.Signals) => void,
  timeoutMs: number,
): Effect.Effect<void, CodexSidecarError> {
  return Effect.tryPromise({
    try: async () => {
      if (process.exitCode === null) signal(process, "SIGTERM")
      if (!await settlesWithin(process.exited, timeoutMs) && process.exitCode === null) {
        signal(process, "SIGKILL")
        await settlesWithin(process.exited, timeoutMs)
      }
      if (process.exitCode === null) {
        process.unref()
        throw new Error("Codex app-server did not stop after SIGKILL")
      }
    },
    catch: (cause) => sidecarError("cleanup", "Unable to stop Codex app-server sidecar", cause),
  })
}

function spawnSidecar(command: readonly string[]): CodexSidecarProcess {
  return Bun.spawn([...command], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
}

function signalProcessGroup(child: CodexSidecarProcess, signal: NodeJS.Signals): void {
  try {
    globalThis.process.kill(-child.pid, signal)
  } catch {
    if (child.exitCode === null) child.kill(signal)
  }
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer()
  server.unref()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  if (!address || typeof address === "string") throw new Error("No loopback address was allocated")
  return address.port
}

async function readBoundedText(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text = (text + decoder.decode(value, { stream: true })).slice(-limit)
    }
    return (text + decoder.decode()).trim().slice(-limit)
  } catch {
    return text.trim().slice(-limit)
  }
}

function sidecarError(operation: string, message: string, cause?: unknown): CodexSidecarError {
  return new CodexSidecarError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  })
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const settled = await Promise.race([promise.then(() => true, () => true), timeout])
  if (timer !== undefined) clearTimeout(timer)
  return settled
}
