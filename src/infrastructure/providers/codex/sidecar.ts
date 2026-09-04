import { randomUUID as nodeRandomUUID } from "node:crypto"
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Cause, Data, Effect, Exit, FiberSet, Scope } from "effect"

import { cleanupProcessGroup, type ProcessGroupHandle } from "../../process-group"

const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000
const DEFAULT_ACQUISITION_TIMEOUT_MS = 5_000
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
  readonly stderr: Effect.Effect<string>
  readonly close: () => Effect.Effect<void, CodexSidecarError>
}

export interface CodexSidecarDependencies {
  readonly makeTemporaryDirectory?: (prefix: string) => Promise<string>
  readonly writeToken?: (
    path: string,
    token: string,
    options: { readonly mode: number; readonly flush: boolean; readonly signal: AbortSignal },
  ) => Promise<void>
  readonly setTokenMode?: (path: string, mode: number) => Promise<void>
  readonly syncToken?: (path: string, directory: string, signal: AbortSignal) => Promise<void>
  readonly openFile?: (path: string) => Promise<CodexSidecarFileHandle>
  readonly removeDirectory?: (path: string) => Promise<void>
  readonly reportCleanupFailure?: (error: CodexSidecarError) => void
  readonly allocatePort?: (signal?: AbortSignal) => Promise<number>
  readonly randomUUID?: () => string
  readonly spawn?: (command: readonly string[]) => CodexSidecarProcess
  readonly signalProcessGroup?: (process: CodexSidecarProcess, signal: NodeJS.Signals) => void
}

export interface CodexSidecarFileHandle {
  sync(): Promise<void>
  close(): Promise<void>
}

export interface CodexSidecarLaunchOptions {
  readonly acquisitionTimeoutMs?: number
  readonly cleanupTimeoutMs?: number
}

export function makeCodexSidecar(
  executable: string,
  dependencies: CodexSidecarDependencies = {},
  options: CodexSidecarLaunchOptions = {},
): Effect.Effect<CodexSidecar, CodexSidecarError, Scope.Scope> {
  const acquisitionTimeoutMs = positiveDuration(
    options.acquisitionTimeoutMs,
    DEFAULT_ACQUISITION_TIMEOUT_MS,
  )
  const cleanupTimeoutMs = positiveDuration(options.cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS)
  const removeDirectory = dependencies.removeDirectory ??
    ((path: string) => rm(path, { recursive: true, force: true }))
  const signal = dependencies.signalProcessGroup ?? signalProcessGroup
  const syncToken = dependencies.syncToken ?? ((path, parent, syncSignal) =>
    durablySyncToken(path, parent, syncSignal, dependencies.openFile))

  return Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
    const runPromise = yield* FiberSet.makeRuntimePromise<never>()
    let directoryRemoved = false
    let directory: string | undefined
    let process: CodexSidecarProcess | undefined
    let stderr: BoundedStderr | undefined
    let bearerToken = ""
    let remoteUrl = ""
    let rollbackStarted = false
    let lateDirectoryTask: Promise<void> | undefined
    let lateDirectoryFailure: CodexSidecarError | undefined
    const reportCleanupFailure = dependencies.reportCleanupFailure ?? ((error) => {
      console.error(`Late Codex sidecar cleanup failed: ${error.message}`, error.cause ?? "")
    })

    const acquisition = yield* Effect.exit(restore(Effect.gen(function*() {
      directory = yield* boundedAcquisitionPhase(Effect.tryPromise({
        try: () => {
          const creation = (dependencies.makeTemporaryDirectory ?? mkdtemp)(
            join(tmpdir(), "claude-tree-codex-"),
          )
          lateDirectoryTask = creation.then(async (path) => {
            directory = path
            if (!rollbackStarted || directoryRemoved) return
            await removeDirectory(path)
            directoryRemoved = true
          }).catch((cause) => {
            if (directory === undefined || !rollbackStarted) return
            lateDirectoryFailure = sidecarError(
              "cleanup",
              `Unable to remove late Codex token directory ${directory}`,
              cause,
            )
            try {
              reportCleanupFailure(lateDirectoryFailure)
            } catch (reportCause) {
              console.error("Unable to report late Codex sidecar cleanup failure", reportCause)
            }
          })
          return creation
        },
        catch: (cause) => sidecarError("temporary-directory", "Unable to create Codex token directory", cause),
      }), acquisitionTimeoutMs, "temporary-directory", "create Codex token directory")
      const tokenPath = join(directory, "token")
      bearerToken = yield* Effect.try({
        try: () => (dependencies.randomUUID ?? nodeRandomUUID)().replaceAll("-", ""),
        catch: (cause) => sidecarError("token", "Unable to create Codex capability token", cause),
      })
      yield* boundedAcquisitionPhase(Effect.tryPromise({
        try: (signal) => (dependencies.writeToken ?? writeTokenFile)(tokenPath, bearerToken, {
          mode: 0o600,
          flush: true,
          signal,
        }),
        catch: (cause) => sidecarError("token", "Unable to write Codex capability token", cause),
      }), acquisitionTimeoutMs, "token", "write Codex capability token")
      yield* boundedAcquisitionPhase(Effect.tryPromise({
        try: () => (dependencies.setTokenMode ?? chmod)(tokenPath, 0o600),
        catch: (cause) => sidecarError("token", "Unable to restrict Codex capability token", cause),
      }), acquisitionTimeoutMs, "token", "restrict Codex capability token")
      yield* boundedAcquisitionPhase(Effect.tryPromise({
        try: (signal) => syncToken(tokenPath, directory!, signal),
        catch: (cause) => sidecarError("token", "Unable to durably store Codex capability token", cause),
      }), acquisitionTimeoutMs, "token", "durably store Codex capability token")
      const port = yield* boundedAcquisitionPhase(Effect.tryPromise({
        try: (signal) => (dependencies.allocatePort ?? availableLoopbackPort)(signal),
        catch: (cause) => sidecarError("listen", "Unable to allocate a Codex loopback port", cause),
      }), acquisitionTimeoutMs, "listen", "allocate Codex loopback port")
      remoteUrl = `ws://127.0.0.1:${port}`
      process = yield* Effect.try({
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
      })
      yield* Effect.try({
        try: () => process!.unref(),
        catch: (cause) => sidecarError("spawn", "Unable to detach Codex app-server sidecar", cause),
      })
      stderr = yield* Effect.try({
        try: () => makeBoundedStderr(process!.stderr, STDERR_LIMIT_BYTES, cleanupTimeoutMs),
        catch: (cause) => sidecarError("stderr", "Unable to observe Codex sidecar stderr", cause),
      })
    })))

    const cleanup = () => cleanupSidecarResources({
      process,
      stderr,
      directory,
      signal,
      cleanupTimeoutMs,
      inspectProcessGroup: dependencies.signalProcessGroup === undefined,
      removeDirectory,
      lateDirectoryTask,
      lateDirectoryFailure: () => lateDirectoryFailure,
      directoryRemoved: () => directoryRemoved,
      markDirectoryRemoved: () => {
        directoryRemoved = true
      },
    })

    if (Exit.isFailure(acquisition)) {
      rollbackStarted = true
      const rollback = yield* Effect.exit(cleanup())
      if (Exit.isFailure(rollback)) {
        return yield* Effect.fail(sidecarError(
          "acquire-rollback",
          "Codex sidecar acquisition failed and rollback was incomplete",
          new AggregateError([
            Cause.squash(acquisition.cause),
            Cause.squash(rollback.cause),
          ]),
        ))
      }
      return yield* Effect.failCause(acquisition.cause)
    }

    let cleanupTask: Promise<void> | undefined
    const close = (): Effect.Effect<void, CodexSidecarError> => Effect.tryPromise({
      try: () => {
        cleanupTask ??= runPromise(cleanup()).catch((cause) => {
          cleanupTask = undefined
          throw cause
        })
        return cleanupTask
      },
      catch: (cause) => cause instanceof CodexSidecarError
        ? cause
        : sidecarError("cleanup", "Unable to clean up Codex app-server sidecar", cause),
    })
    yield* Effect.addFinalizer(() => close().pipe(Effect.orDie))
    return {
      remoteUrl,
      bearerToken,
      process: process!,
      stderr: Effect.sync(() => stderr!.snapshot()),
      close,
    }
  }))
}

interface SidecarCleanupResources {
  readonly process: CodexSidecarProcess | undefined
  readonly stderr: BoundedStderr | undefined
  readonly directory: string | undefined
  readonly signal: (process: CodexSidecarProcess, signal: NodeJS.Signals) => void
  readonly cleanupTimeoutMs: number
  readonly inspectProcessGroup: boolean
  readonly removeDirectory: (path: string) => Promise<void>
  readonly lateDirectoryTask: Promise<void> | undefined
  readonly lateDirectoryFailure: () => CodexSidecarError | undefined
  readonly directoryRemoved: () => boolean
  readonly markDirectoryRemoved: () => void
}

function cleanupSidecarResources(
  resources: SidecarCleanupResources,
): Effect.Effect<void, CodexSidecarError> {
  return Effect.gen(function*() {
    const failures: unknown[] = []
    if (resources.process) {
      yield* cleanupProcess(
        resources.process,
        resources.signal,
        resources.cleanupTimeoutMs,
        resources.inspectProcessGroup,
      ).pipe(Effect.catch((error) => Effect.sync(() => failures.push(error))))
    }
    if (resources.stderr) {
      yield* resources.stderr.close().pipe(
        Effect.timeoutOrElse({
          duration: resources.cleanupTimeoutMs,
          orElse: () => Effect.fail(sidecarError(
            "cleanup",
            "Timed out stopping Codex sidecar stderr reader",
          )),
        }),
        Effect.catch((error) => Effect.sync(() => failures.push(error))),
      )
    }
    if (!resources.directory && resources.lateDirectoryTask) {
      yield* Effect.promise(() => resources.lateDirectoryTask!).pipe(
        Effect.timeoutOrElse({
          duration: resources.cleanupTimeoutMs,
          orElse: () => Effect.fail(sidecarError(
            "cleanup",
            `Timed out waiting for Codex token directory creation after ${resources.cleanupTimeoutMs}ms`,
          )),
        }),
        Effect.catch((error) => Effect.sync(() => failures.push(error))),
      )
      const lateFailure = resources.lateDirectoryFailure()
      if (lateFailure !== undefined) failures.push(lateFailure)
    }
    if (resources.directory) {
      yield* removeTokenDirectory(
        resources.directory,
        resources.removeDirectory,
        resources.directoryRemoved,
        resources.markDirectoryRemoved,
        resources.cleanupTimeoutMs,
      ).pipe(Effect.catch((error) => Effect.sync(() => failures.push(error))))
    }
    if (failures.length > 0) {
      return yield* Effect.fail(sidecarError(
        "cleanup",
        "Unable to clean up Codex app-server sidecar",
        failures.length === 1 ? failures[0] : new AggregateError(failures),
      ))
    }
  })
}

function cleanupProcess(
  process: CodexSidecarProcess,
  signal: (process: CodexSidecarProcess, signal: NodeJS.Signals) => void,
  timeoutMs: number,
  inspectProcessGroup: boolean,
): Effect.Effect<void, CodexSidecarError> {
  const group = sidecarProcessGroup(process, signal, inspectProcessGroup)
  return Effect.gen(function*() {
    const result = yield* cleanupProcessGroup(group, {
      gracePeriodMs: timeoutMs,
      killPeriodMs: timeoutMs,
    })
    const failures: unknown[] = result.issues.map(
      (issue) => issue.cause ?? new Error(issue.message),
    )
    if (result.status !== "absent" && !result.issues.some((issue) => issue.stage === "verify")) {
      failures.push(new Error("Codex app-server did not stop after SIGKILL"))
    }
    try {
      process.unref()
    } catch (cause) {
      failures.push(cause)
    }
    if (failures.length > 0) {
      return yield* Effect.fail(sidecarError(
        "cleanup",
        "Unable to stop Codex app-server sidecar",
        failures.length === 1 ? failures[0] : new AggregateError(failures),
      ))
    }
  })
}

function sidecarProcessGroup(
  process: CodexSidecarProcess,
  signal: (process: CodexSidecarProcess, signal: NodeJS.Signals) => void,
  inspectProcessGroup: boolean,
): ProcessGroupHandle {
  return {
    processGroupId: process.pid,
    signalGroup: (signalName) => signal(process, signalName),
    isGroupAlive: () => inspectProcessGroup
      ? isProcessGroupAlive(process.pid)
      : process.exitCode === null,
    waitForGroupExit: (timeoutMs) => inspectProcessGroup
      ? Effect.promise(() => waitForProcessGroupExit(process.pid, timeoutMs))
      : Effect.promise(() => settlesWithin(process.exited, timeoutMs)),
  }
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
  } catch (cause) {
    if (isNoSuchProcessError(cause)) return
    if (child.exitCode === null) child.kill(signal)
  }
}

async function availableLoopbackPort(signal?: AbortSignal): Promise<number> {
  const server = createServer()
  server.unref()
  return new Promise<number>((resolve, reject) => {
    let settled = false
    const finish = (effect: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      server.removeListener("error", onError)
      effect()
    }
    const onError = (cause: unknown) => finish(() => reject(cause))
    const onAbort = () => {
      try {
        server.close()
      } catch {}
      finish(() => reject(signal?.reason ?? new Error("Codex loopback port allocation was interrupted")))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => finish(() => reject(new Error("No loopback address was allocated"))))
        return
      }
      server.close((error) => finish(() => error ? reject(error) : resolve(address.port)))
    })
  })
}

function writeTokenFile(
  path: string,
  token: string,
  options: { readonly mode: number; readonly flush: boolean; readonly signal: AbortSignal },
): Promise<void> {
  return writeFile(path, token, options)
}

async function durablySyncToken(
  path: string,
  directory: string,
  signal: AbortSignal,
  openFile: ((path: string) => Promise<CodexSidecarFileHandle>) | undefined,
): Promise<void> {
  const openReadOnly = openFile ?? ((target: string) => open(target, "r"))
  await syncFile(path, signal, openReadOnly)
  await syncFile(directory, signal, openReadOnly)
}

async function syncFile(
  path: string,
  signal: AbortSignal,
  openFile: (path: string) => Promise<CodexSidecarFileHandle>,
): Promise<void> {
  const handle = await openFile(path)
  try {
    if (signal.aborted) throw signal.reason ?? new Error("Codex token fsync was interrupted")
    await rejectOnAbort(handle.sync(), signal)
  } finally {
    await handle.close()
  }
}

function rejectOnAbort<A>(promise: Promise<A>, signal: AbortSignal): Promise<A> {
  if (signal.aborted) {
    void promise.catch(() => undefined)
    return Promise.reject(signal.reason ?? new Error("Codex filesystem operation was interrupted"))
  }
  return new Promise<A>((resolve, reject) => {
    const onAbort = () => reject(
      signal.reason ?? new Error("Codex filesystem operation was interrupted"),
    )
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

interface BoundedStderr {
  snapshot(): string
  close(): Effect.Effect<void, CodexSidecarError>
}

function makeBoundedStderr(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  cleanupTimeoutMs: number,
): BoundedStderr {
  const reader = stream.getReader()
  let bytes = new Uint8Array()
  let closed = false
  const task = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        bytes = appendBounded(bytes, value, limit)
      }
    } catch {
      // Stderr is diagnostic only; the process lifecycle remains authoritative.
    }
  })()
  return {
    snapshot: () => new TextDecoder().decode(bytes).trim(),
    close: () => Effect.tryPromise({
      try: async () => {
        if (closed) return
        const cancellation = await settlementWithin(
          Promise.resolve().then(() => reader.cancel()),
          cleanupTimeoutMs,
        )
        if (cancellation._tag === "Rejected") throw cancellation.cause
        if (cancellation._tag === "TimedOut") throw new Error("Codex sidecar stderr cancellation timed out")
        const settled = await settlementWithin(task, cleanupTimeoutMs)
        if (settled._tag === "Rejected") throw settled.cause
        if (settled._tag === "TimedOut") throw new Error("Codex sidecar stderr reader did not stop")
        closed = true
      },
      catch: (cause) => sidecarError("cleanup", "Unable to stop Codex sidecar stderr reader", cause),
    }),
  }
}

function appendBounded(
  current: Uint8Array,
  chunk: Uint8Array,
  limit: number,
): Uint8Array<ArrayBuffer> {
  if (chunk.byteLength >= limit) {
    const retained = new Uint8Array(limit)
    retained.set(chunk.subarray(chunk.byteLength - limit))
    return retained
  }
  const retained = Math.min(current.byteLength, limit - chunk.byteLength)
  const next = new Uint8Array(retained + chunk.byteLength)
  next.set(current.slice(current.byteLength - retained))
  next.set(chunk, retained)
  return next
}

function removeTokenDirectory(
  path: string,
  remove: (path: string) => Promise<void>,
  removed: () => boolean,
  markRemoved: () => void,
  timeoutMs: number,
): Effect.Effect<void, CodexSidecarError> {
  if (removed()) return Effect.void
  return Effect.tryPromise({
    try: async () => {
      await remove(path)
      markRemoved()
    },
    catch: (cause) => sidecarError("cleanup", "Unable to remove Codex token directory", cause),
  }).pipe(Effect.timeoutOrElse({
    duration: timeoutMs,
    orElse: () => Effect.fail(sidecarError(
      "cleanup",
      `Timed out removing Codex token directory after ${timeoutMs}ms`,
    )),
  }))
}

function boundedAcquisitionPhase<A>(
  effect: Effect.Effect<A, CodexSidecarError>,
  timeoutMs: number,
  operation: string,
  description: string,
): Effect.Effect<A, CodexSidecarError> {
  return effect.pipe(Effect.timeoutOrElse({
    duration: timeoutMs,
    orElse: () => Effect.fail(sidecarError(
      operation,
      `Timed out attempting to ${description} after ${timeoutMs}ms`,
    )),
  }))
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

function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  while (isProcessGroupAlive(processGroupId) && performance.now() < deadline) {
    await Bun.sleep(Math.min(10, Math.max(0, deadline - performance.now())))
  }
  return !isProcessGroupAlive(processGroupId)
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    globalThis.process.kill(-processGroupId, 0)
    return true
  } catch (cause) {
    return !isNoSuchProcessError(cause)
  }
}
