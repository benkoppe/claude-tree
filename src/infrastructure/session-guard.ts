import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { dlopen, FFIType, read } from "bun:ffi"
import { Effect } from "effect"
import { SessionOwnedError, TerminalError } from "../domain/errors"

export interface SessionClaim {
  readonly release: Effect.Effect<void, TerminalError>
}
export interface SessionGuard {
  readonly acquire: (sessionId: string, allowDuplicate?: boolean) => Effect.Effect<SessionClaim, SessionOwnedError | TerminalError>
}

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_RETRY_MS = 10

type FileLocker = (fd: number, operation: number) => boolean
type GuardFileHandle = Pick<FileHandle, "fd" | "close">

export interface SessionGuardPlatform {
  readonly pid: number
  readonly randomToken: () => string
  readonly fileLocker: () => FileLocker
  readonly mkdir: (path: string) => Promise<unknown>
  readonly open: (path: string, flags: string, mode: number) => Promise<GuardFileHandle>
  readonly readdir: (path: string) => Promise<string[]>
  readonly unlink: (path: string) => Promise<void>
}

export const nativeSessionGuardPlatform: SessionGuardPlatform = {
  pid: process.pid, randomToken: randomUUID, fileLocker,
  mkdir: (path) => mkdir(path, { recursive: true, mode: 0o700 }),
  open, readdir, unlink,
}
let nativeLocker: FileLocker | undefined

export function fileLocker(): FileLocker {
  if (nativeLocker) return nativeLocker
  const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location"
  const candidates = process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"]
    : ["libc.so.6", `/lib/ld-musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`]
  let lastError: unknown
  for (const library of candidates) {
    try {
      const loaded = dlopen(library, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        [errnoSymbol]: { args: [], returns: FFIType.ptr },
      })
      nativeLocker = (fd, operation) => {
        if (loaded.symbols.flock!(fd, operation) === 0) return true
        const pointer = loaded.symbols[errnoSymbol]!()
        if (pointer === null) throw new Error("Unable to read flock error")
        const errno = read.i32(pointer)
        if ((operation & LOCK_NB) && errno === (process.platform === "darwin" ? 35 : 11)) return false
        throw new Error(`flock failed (errno ${errno})`)
      }
      return nativeLocker
    } catch (cause) { lastError = cause }
  }
  throw new Error("Unable to load OS session locking", { cause: lastError })
}

/** Locks belong only to this invocation. Crash leftovers are not recovery records. */
export function makeSessionGuard(guardRoot: string, providerId: string, platform: SessionGuardPlatform = nativeSessionGuardPlatform): SessionGuard {
  if (!isAbsolute(guardRoot)) throw new Error("Session guard root must be an absolute path")
  if (!/^[a-z0-9][a-z0-9-]*$/.test(providerId)) throw new Error("Invalid session guard provider identity")
  const root = join(guardRoot, providerId)
  return {
    acquire: (sessionId, allowDuplicate = false) => {
      const directory = join(root, createHash("sha256").update(sessionId).digest("hex"))
      const failure = (cause: unknown) => cause instanceof SessionOwnedError ? cause : new TerminalError({
        operation: "session-guard", sessionId, message: cause instanceof Error ? cause.message : String(cause), cause,
      })
      const tryAsync = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure })
      return Effect.uninterruptibleMask((restore) => Effect.suspend(() => {
        let claim: SessionClaim | undefined
        let admissionHandle: GuardFileHandle | undefined
        let admissionClosed = false
        const closeAdmission = tryAsync(async () => {
          if (admissionHandle && !admissionClosed) { await admissionHandle.close(); admissionClosed = true }
        }).pipe(Effect.orDie)
        return Effect.gen(function*() {
          if (!sessionId) return yield* Effect.fail(failure(new Error("Session identity must be nonempty")))
          const lock = yield* Effect.try({ try: platform.fileLocker, catch: failure })
          yield* tryAsync(() => platform.mkdir(directory))
          const openAdmission = tryAsync(() => platform.open(join(directory, "admission.lock"), "a", 0o600)).pipe(
            Effect.tap((handle) => Effect.sync(() => { admissionHandle = handle })))
          return yield* Effect.acquireUseRelease(openAdmission, (admission) => Effect.gen(function*() {
            yield* restore(Effect.gen(function*() {
              while (!(yield* Effect.try({ try: () => lock(admission.fd, LOCK_EX | LOCK_NB), catch: failure }))) yield* Effect.sleep(LOCK_RETRY_MS)
            }))
            const ownerPid = yield* tryAsync(() => inspectAndPruneClaims(directory, lock, platform))
            if (ownerPid !== undefined && !allowDuplicate) return yield* Effect.fail(new SessionOwnedError({ providerId, sessionId, ownerPid }))
            const path = join(directory, `${platform.pid}-${platform.randomToken()}.lock`)
            const handle = yield* tryAsync(() => platform.open(path, "wx", 0o600))
            claim = makeClaim(handle, path, sessionId, platform)
            yield* Effect.try({ try: () => {
              if (!lock(handle.fd, LOCK_EX | LOCK_NB)) throw new Error("Unable to acquire new session claim")
            }, catch: failure })
            return claim
          }), () => closeAdmission)
        }).pipe(Effect.onExit((exit) => exit._tag === "Failure"
          ? (claim ? claim.release.pipe(Effect.onError(() => claim!.release.pipe(Effect.orDie)), Effect.orDie) : Effect.void)
            .pipe(Effect.ensuring(closeAdmission)) : Effect.void))
      }))
    },
  }
}

/** Caller holds admission; never delete the admission inode or session directory. */
async function inspectAndPruneClaims(directory: string, lock: FileLocker, platform: SessionGuardPlatform): Promise<number | undefined> {
  let ownerPid: number | undefined
  for (const file of await platform.readdir(directory)) {
    if (!/^\d+-[a-f0-9-]+\.lock$/.test(file)) continue
    const path = join(directory, file)
    let handle: GuardFileHandle
    try { handle = await platform.open(path, "r+", 0o600) } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue
      throw cause
    }
    try {
      if (!lock(handle.fd, LOCK_EX | LOCK_NB)) ownerPid ??= Number(file.split("-")[0])
      else await unlinkIfPresent(platform, path)
    } finally { await handle.close() }
  }
  return ownerPid
}

async function unlinkIfPresent(platform: SessionGuardPlatform, path: string): Promise<void> {
  await platform.unlink(path).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause })
}

function makeClaim(handle: GuardFileHandle, path: string, sessionId: string, platform: SessionGuardPlatform): SessionClaim {
  let closed = false
  let removed = false
  let releasing: Promise<void> | undefined
  const cleanup = async () => {
    if (!closed) { await handle.close(); closed = true }
    if (!removed) { await unlinkIfPresent(platform, path); removed = true }
  }
  return { release: Effect.uninterruptible(Effect.tryPromise({
    try: () => releasing ??= cleanup().finally(() => { releasing = undefined }),
    catch: (cause) => new TerminalError({ operation: "release-session-guard", sessionId, message: cause instanceof Error ? cause.message : String(cause), cause }),
  })) }
}
