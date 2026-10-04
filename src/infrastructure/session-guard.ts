import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises"
import { dirname, join } from "node:path"
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
const LOCK_UN = 8
const LOCK_RETRY_MS = 10

type FileLocker = (fd: number, operation: number) => boolean
let nativeLocker: FileLocker | undefined

function fileLocker(): FileLocker {
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
export function makeSessionGuard(providerStatePath: string, providerId: string): SessionGuard {
  const root = join(dirname(providerStatePath), "session-guards")
  return {
    acquire: (sessionId, allowDuplicate = false) => {
      const directory = join(root, createHash("sha256").update(sessionId).digest("hex"))
      let acquiredHandle: FileHandle | undefined
      let acquiredPath: string | undefined
      const failure = (cause: unknown) => cause instanceof SessionOwnedError ? cause : new TerminalError({
        operation: "session-guard", sessionId, message: cause instanceof Error ? cause.message : String(cause), cause,
      })
      const tryAsync = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure })
      return Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
        const lock = yield* Effect.try({ try: fileLocker, catch: failure })
        yield* tryAsync(() => mkdir(directory, { recursive: true, mode: 0o700 }))
        const admission = yield* tryAsync(() => open(join(directory, "admission.lock"), "a", 0o600))
        const takeAdmission = Effect.gen(function*() {
          while (!(yield* Effect.try({ try: () => lock(admission.fd, LOCK_EX | LOCK_NB), catch: failure }))) yield* Effect.sleep(LOCK_RETRY_MS)
        })
        return yield* Effect.acquireUseRelease(restore(takeAdmission).pipe(
          Effect.onError(() => tryAsync(() => admission.close()).pipe(Effect.ignore))), () => Effect.gen(function*() {
          const files = yield* tryAsync(() => readdir(directory))
          for (const file of files) {
            if (!/^\d+-[a-f0-9-]+\.lock$/.test(file)) continue
            const occupied = yield* tryAsync(async () => {
              let handle: FileHandle
              try { handle = await open(join(directory, file), "r+") } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false
                throw cause
              }
              try {
                if (!lock(handle.fd, LOCK_EX | LOCK_NB)) return true
                lock(handle.fd, LOCK_UN)
                return false
              } finally { await handle.close() }
            })
            if (occupied && !allowDuplicate) return yield* Effect.fail(new SessionOwnedError({ providerId, sessionId, ownerPid: Number(file.split("-")[0]) }))
          }
          const path = join(directory, `${process.pid}-${randomUUID()}.lock`)
          const handle = yield* tryAsync(() => open(path, "wx", 0o600))
          acquiredHandle = handle
          acquiredPath = path
          yield* Effect.try({ try: () => {
            if (!lock(handle.fd, LOCK_EX | LOCK_NB)) throw new Error("Unable to acquire new session claim")
          }, catch: failure }).pipe(Effect.onError(() => tryAsync(() => handle.close()).pipe(Effect.ignore)))
          let released = false
          return { release: Effect.suspend(() => released ? Effect.void : tryAsync(async () => {
            await handle.close()
            released = true
            await unlink(path).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause })
          }).pipe(Effect.mapError((cause) => new TerminalError({ operation: "release-session-guard", sessionId, message: cause.message, cause })))) }
        }), () => Effect.tryPromise({ try: async () => {
          try { lock(admission.fd, LOCK_UN) } finally { await admission.close() }
        }, catch: failure }).pipe(Effect.orDie))
      })).pipe(Effect.onInterrupt(() => Effect.promise(async () => {
        if (acquiredHandle) await acquiredHandle.close().catch(() => {})
        if (acquiredPath) await unlink(acquiredPath).catch(() => {})
      })))
    },
  }
}
