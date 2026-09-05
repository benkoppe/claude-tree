import { createHash } from "node:crypto"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { Cause, Clock, Effect, Exit, Schema } from "effect"

import type { PersistencePlatformApi } from "./platform"
import { isErrorCode } from "./platform"

export const PERSISTENCE_SCHEMA_VERSION = 3 as const
const STATE_LAYOUT_DIRECTORY = "v2"
const LOCK_RETRY_MILLISECONDS = 10
const LOCK_TIMEOUT_MILLISECONDS = 2_000
const LOCK_WAIT_IO_TIMEOUT_MILLISECONDS = 250

const recoverableLockOwners = new Set<string>()

const LockOwnerSchema = Schema.Struct({
  schemaVersion: Schema.Literal(PERSISTENCE_SCHEMA_VERSION),
  ownerToken: Schema.NonEmptyString,
  ownerPid: Schema.Int,
  createdAt: Schema.NonEmptyString,
})

interface LockOwner {
  readonly schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION
  readonly ownerToken: string
  readonly ownerPid: number
  readonly createdAt: string
}

type StaleLockReclaimOutcome = "reclaimed" | "changed" | "contended"

export interface ProjectStoragePaths {
  readonly projectPath: string
  readonly projectDirectory: string
  readonly manifestPath: string
  readonly providerDirectory: string
  readonly statePath: string
  readonly stateLockPath: string
}

const ProjectManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(PERSISTENCE_SCHEMA_VERSION),
  projectPath: Schema.NonEmptyString,
})

export function prepareProjectStorage(
  platform: PersistencePlatformApi,
  projectDirectory: string,
  providerId: string,
  stateHome?: string,
): Effect.Effect<ProjectStoragePaths, unknown> {
  return Effect.gen(function*() {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(providerId)) {
      return yield* Effect.fail(new Error(`Invalid provider ID: ${providerId}`))
    }

    const projectPath = yield* promiseEffect(() => platform.realpath(projectDirectory))
    const resolvedStateHome = stateHome ?? platform.stateHome()
    if (!isAbsolute(resolvedStateHome)) {
      return yield* Effect.fail(new Error("XDG state directory must be an absolute path"))
    }

    const projectKey = createHash("sha256").update(projectPath).digest("hex")
    const projectStateDirectory = join(
      resolvedStateHome,
      "claude-tree",
      STATE_LAYOUT_DIRECTORY,
      "projects",
      projectKey,
    )
    const providerDirectory = join(projectStateDirectory, "providers", providerId)
    const manifestPath = join(projectStateDirectory, "project.json")
    const statePath = join(providerDirectory, "state.json")
    const leasesDirectory = join(providerDirectory, "leases")

    // Reject old documents before creating a v3 manifest or lock beside them.
    const existingManifest = yield* readJsonIfPresent(platform, manifestPath)
    if (existingManifest !== undefined) {
      yield* syncEffect(() =>
        requireSchemaVersion(existingManifest, "project manifest", projectStateDirectory))
    }
    const existingState = yield* readJsonIfPresent(platform, statePath)
    if (existingState !== undefined) {
      yield* syncEffect(() =>
        requireSchemaVersion(existingState, "provider state", projectStateDirectory))
    }
    if (yield* directoryExists(platform, leasesDirectory)) {
      return yield* Effect.fail(resetRequiredError(
        "separate session lease layout",
        "v2",
        projectStateDirectory,
      ))
    }

    yield* createDirectoryDurably(platform, projectStateDirectory)
    yield* withTransactionLock(
      platform,
      join(projectStateDirectory, "project.lock"),
      Effect.gen(function*() {
        const manifest = yield* readJsonIfPresent(platform, manifestPath)
        if (manifest === undefined) {
          yield* writeJsonAtomically(platform, manifestPath, {
            schemaVersion: PERSISTENCE_SCHEMA_VERSION,
            projectPath,
          })
          return
        }
        const decoded = yield* syncEffect(() => {
          requireSchemaVersion(manifest, "project manifest", projectStateDirectory)
          return decodeStrict(ProjectManifestSchema, manifest)
        })
        if (decoded.projectPath !== projectPath) {
          return yield* Effect.fail(new Error(
            `State directory belongs to ${decoded.projectPath}, not ${projectPath}`,
          ))
        }
      }),
    )

    yield* createDirectoryDurably(platform, providerDirectory)

    return {
      projectPath,
      projectDirectory: projectStateDirectory,
      manifestPath,
      providerDirectory,
      statePath,
      stateLockPath: join(providerDirectory, "state.lock"),
    }
  })
}

export function decodeStrict<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): S["Type"] {
  return Schema.decodeUnknownSync(schema, {
    errors: "all",
    onExcessProperty: "error",
  })(input)
}

export function readJsonIfPresent(
  platform: PersistencePlatformApi,
  path: string,
): Effect.Effect<unknown | undefined, unknown> {
  return promiseEffect(async () => {
    try {
      return JSON.parse(await platform.readFile(path)) as unknown
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return undefined
      throw error
    }
  })
}

export function writeJsonAtomically(
  platform: PersistencePlatformApi,
  path: string,
  value: unknown,
): Effect.Effect<void, unknown> {
  return promiseEffect(async () => {
    const temporaryPath = `${path}.${platform.pid}.${platform.randomToken()}.tmp`
    const handle = await platform.open(temporaryPath, "wx", 0o600)
    let closed = false
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
      await handle.sync()
      await handle.close()
      closed = true
      try {
        await platform.rename(temporaryPath, path)
      } catch (error) {
        if (!(await jsonFileEquals(platform, path, value))) throw error
      }
    } catch (error) {
      if (!closed) await handle.close().catch(() => undefined)
      await platform.remove(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
    await syncParentDirectory(platform, path)
  })
}

export function writeJsonExclusively(
  platform: PersistencePlatformApi,
  path: string,
  value: unknown,
): Effect.Effect<void, unknown> {
  return promiseEffect(async () => {
    const temporaryPath = `${path}.${platform.pid}.${platform.randomToken()}.tmp`
    const handle = await platform.open(temporaryPath, "wx", 0o600)
    let closed = false
    let committed = false
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
      await handle.sync()
      await handle.close()
      closed = true
      try {
        await platform.link(temporaryPath, path)
        committed = true
      } catch (error) {
        if (!(await jsonFileEquals(platform, path, value))) throw error
        committed = true
      }
      await platform.remove(temporaryPath)
      await syncParentDirectory(platform, path)
    } catch (error) {
      if (!closed) await handle.close().catch(() => undefined)
      await platform.remove(temporaryPath, { force: true }).catch(() => undefined)
      if (!committed) throw error
      throw error
    }
  })
}

export function removeDurably(
  platform: PersistencePlatformApi,
  path: string,
): Effect.Effect<void, unknown> {
  return promiseEffect(async () => {
    try {
      await platform.remove(path)
    } catch (error) {
      if (!(await pathIsMissing(platform, path))) throw error
    }
    await syncParentDirectory(platform, path)
  })
}

export function withTransactionLock<A, E, R>(
  platform: PersistencePlatformApi,
  lockPath: string,
  use: Effect.Effect<A, E, R>,
  options?: { readonly interruptibleUse?: boolean },
): Effect.Effect<A, E | unknown, R> {
  const owner: LockOwner = {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    ownerToken: platform.randomToken(),
    ownerPid: platform.pid,
    createdAt: platform.now(),
  }

  return Effect.uninterruptibleMask((restore) =>
    Effect.acquireUseRelease(
      acquireTransactionLock(platform, lockPath, owner, restore),
      () => options?.interruptibleUse === true ? restore(use) : use,
      () => releaseTransactionLock(platform, lockPath, owner),
    ))
}

function acquireTransactionLock(
  platform: PersistencePlatformApi,
  lockPath: string,
  owner: LockOwner,
  restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
): Effect.Effect<void, unknown> {
  return Effect.gen(function*() {
    const startedAt = yield* Clock.currentTimeMillis
    const deadline = startedAt + LOCK_TIMEOUT_MILLISECONDS

    while (true) {
      const acquired = yield* Effect.exit(writeJsonExclusively(platform, lockPath, owner))
      if (Exit.isSuccess(acquired)) return
      const acquisitionError = failureFromExit(acquired)
      if (!isErrorCode(acquisitionError, "EEXIST")) {
        const possibleOwner = yield* restore(lockWaitEffect(
          readJsonIfPresent(platform, lockPath),
          `read transaction lock ${lockPath}`,
        ))
        const acquiredBeforeFailure = possibleOwner === undefined
          ? false
          : yield* syncEffect(() =>
              decodeLockOwner(possibleOwner, lockPath).ownerToken === owner.ownerToken)
        if (acquiredBeforeFailure) {
          yield* Effect.exit(releaseTransactionLock(platform, lockPath, owner))
        }
        return yield* Effect.fail(acquisitionError)
      }

      const existingValue = yield* restore(lockWaitEffect(
        readJsonIfPresent(platform, lockPath),
        `read transaction lock ${lockPath}`,
      ))
      if (existingValue === undefined) continue
      const existing = yield* syncEffect(() => decodeLockOwner(existingValue, lockPath))
      if (recoverableLockOwners.has(existing.ownerToken)) {
        yield* reclaimRecoverableLock(platform, lockPath, existing)
        continue
      }
      const liveness = yield* restore(lockWaitEffect(
        promiseEffect(() => platform.processLiveness(existing.ownerPid)),
        `check transaction lock owner PID ${existing.ownerPid}`,
      ))
      if (liveness === "absent") {
        const reclaim = yield* reclaimStaleLock(platform, lockPath, existing)
        if (reclaim === "contended") {
          const now = yield* Clock.currentTimeMillis
          if (now >= deadline) {
            const reclaimPath = staleLockReclaimPath(lockPath, existing)
            return yield* Effect.fail(new Error(
              `Timed out waiting for stale transaction lock reclaim owned by PID ${existing.ownerPid}. ` +
                `A matching reclaim claim at ${reclaimPath} may have been abandoned. ` +
                `Automatic takeover is disabled because it cannot safely distinguish that claim from an active ` +
                `reclaimer and could unlink a replacement lock. After verifying no claude-tree process is using ` +
                `this state, remove ${lockPath} and ${reclaimPath}, then retry.`,
            ))
          }
          yield* restore(Effect.sleep(LOCK_RETRY_MILLISECONDS))
        }
        continue
      }

      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) {
        return yield* Effect.fail(new Error(
          `Timed out waiting for transaction lock owned by PID ${existing.ownerPid}`,
        ))
      }
      yield* restore(Effect.sleep(LOCK_RETRY_MILLISECONDS))
    }
  })
}

function reclaimStaleLock(
  platform: PersistencePlatformApi,
  lockPath: string,
  existing: LockOwner,
): Effect.Effect<StaleLockReclaimOutcome, unknown> {
  return Effect.gen(function*() {
    const reclaimPath = staleLockReclaimPath(lockPath, existing)
    const claimExit = yield* Effect.exit(promiseEffect(() => platform.link(lockPath, reclaimPath)))
    if (Exit.isFailure(claimExit)) {
      const error = failureFromExit(claimExit)
      if (isErrorCode(error, "ENOENT")) return "changed"
      if (!isErrorCode(error, "EEXIST")) return yield* Effect.fail(error)

      // Only the process that atomically created the claim may unlink lockPath. If
      // that winner already moved past the unlink, this orphan is no longer a lock.
      const claimedValue = yield* readJsonIfPresent(platform, reclaimPath)
      if (claimedValue === undefined) return "changed"
      const claimedOwner = yield* syncEffect(() => decodeLockOwner(claimedValue, reclaimPath))
      if (claimedOwner.ownerToken !== existing.ownerToken) {
        return yield* Effect.fail(new Error("Stale-lock reclaim path belongs to another owner"))
      }
      const latestValue = yield* readJsonIfPresent(platform, lockPath)
      const latestOwner = latestValue === undefined
        ? undefined
        : yield* syncEffect(() => decodeLockOwner(latestValue, lockPath))
      if (latestOwner?.ownerToken !== existing.ownerToken) {
        yield* removeDurably(platform, reclaimPath)
        return "changed"
      }
      return "contended"
    }

    const reclaim = Effect.gen(function*() {
      const latestValue = yield* readJsonIfPresent(platform, lockPath)
      if (latestValue === undefined) return
      const latestOwner = yield* syncEffect(() => decodeLockOwner(latestValue, lockPath))
      if (latestOwner.ownerToken !== existing.ownerToken) return

      // The exclusive hard link keeps the observed stale inode alive. No other
      // conforming reclaimer can pass this point, so this cannot remove a replacement.
      yield* removeDurably(platform, lockPath)
    })
    const reclaimExit = yield* Effect.exit(reclaim)
    const cleanupExit = yield* Effect.exit(removeDurably(platform, reclaimPath))
    if (Exit.isFailure(reclaimExit)) {
      return yield* Effect.fail(failureFromExit(reclaimExit))
    }
    if (Exit.isFailure(cleanupExit)) {
      return yield* Effect.fail(failureFromExit(cleanupExit))
    }
    return "reclaimed"
  })
}

function staleLockReclaimPath(lockPath: string, owner: LockOwner): string {
  return `${lockPath}.reclaim-${opaqueId(owner.ownerToken)}`
}

function releaseTransactionLock(
  platform: PersistencePlatformApi,
  lockPath: string,
  owner: LockOwner,
): Effect.Effect<void, unknown> {
  return Effect.gen(function*() {
    const existingValue = yield* readJsonIfPresent(platform, lockPath)
    if (existingValue === undefined) return
    const existing = yield* syncEffect(() => decodeLockOwner(existingValue, lockPath))
    if (existing.ownerToken === owner.ownerToken) {
      const released = yield* Effect.exit(removeDurably(platform, lockPath))
      if (Exit.isFailure(released)) {
        const latest = yield* readJsonIfPresent(platform, lockPath)
        if (
          latest !== undefined &&
          (yield* syncEffect(() => decodeLockOwner(latest, lockPath))).ownerToken === owner.ownerToken
        ) {
          recoverableLockOwners.add(owner.ownerToken)
        }
        return yield* Effect.fail(failureFromExit(released))
      }
    }
  })
}

function reclaimRecoverableLock(
  platform: PersistencePlatformApi,
  lockPath: string,
  owner: LockOwner,
): Effect.Effect<void, unknown> {
  return Effect.gen(function*() {
    const latest = yield* readJsonIfPresent(platform, lockPath)
    if (latest === undefined) {
      recoverableLockOwners.delete(owner.ownerToken)
      return
    }
    if ((yield* syncEffect(() => decodeLockOwner(latest, lockPath))).ownerToken !== owner.ownerToken) {
      recoverableLockOwners.delete(owner.ownerToken)
      return
    }
    yield* removeDurably(platform, lockPath)
    recoverableLockOwners.delete(owner.ownerToken)
  })
}

function decodeLockOwner(input: unknown, path: string): LockOwner {
  requireSchemaVersion(input, "transaction lock", dirname(path))
  const owner = decodeStrict(LockOwnerSchema, input) as LockOwner
  if (!Number.isSafeInteger(owner.ownerPid) || owner.ownerPid <= 0) {
    throw new Error("Transaction lock owner PID must be a positive integer")
  }
  requireCanonicalDate(owner.createdAt, "Transaction lock timestamp")
  return owner
}

export function requireSchemaVersion(
  input: unknown,
  label: string,
  resetPath: string,
): void {
  if (
    typeof input !== "object" ||
    input === null ||
    !("schemaVersion" in input) ||
    (input as { readonly schemaVersion?: unknown }).schemaVersion !== PERSISTENCE_SCHEMA_VERSION
  ) {
    const version = typeof input === "object" && input !== null && "schemaVersion" in input
      ? String((input as { readonly schemaVersion?: unknown }).schemaVersion)
      : "missing"
    throw resetRequiredError(label, version, resetPath)
  }
}

function resetRequiredError(label: string, version: string, resetPath: string): Error {
  return new Error(
    `Unsupported ${label} schema version ${version}; claude-tree requires reset-only schema v${PERSISTENCE_SCHEMA_VERSION}. ` +
      `Move or remove ${resetPath} to reset. Existing state was left untouched; automatic migration and deletion are disabled.`,
  )
}

function promiseEffect<A>(run: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: run, catch: (cause) => cause })
}

function lockWaitEffect<A>(
  effect: Effect.Effect<A, unknown>,
  operation: string,
): Effect.Effect<A, unknown> {
  return effect.pipe(Effect.timeoutOrElse({
    duration: LOCK_WAIT_IO_TIMEOUT_MILLISECONDS,
    orElse: () => Effect.fail(new Error(`Timed out while attempting to ${operation}`)),
  }))
}

function syncEffect<A>(run: () => A): Effect.Effect<A, unknown> {
  return Effect.try({ try: run, catch: (cause) => cause })
}

function failureFromExit(exit: Exit.Exit<unknown, unknown>): unknown {
  if (Exit.isSuccess(exit)) throw new Error("Expected a failed effect")
  return Cause.squash(exit.cause)
}

function opaqueId(id: string): string {
  return createHash("sha256").update(id).digest("hex")
}

async function jsonFileEquals(
  platform: PersistencePlatformApi,
  path: string,
  value: unknown,
): Promise<boolean> {
  try {
    return isDeepStrictEqual(JSON.parse(await platform.readFile(path)), value)
  } catch {
    return false
  }
}

async function pathIsMissing(
  platform: PersistencePlatformApi,
  path: string,
): Promise<boolean> {
  try {
    await platform.readFile(path)
    return false
  } catch (error) {
    return isErrorCode(error, "ENOENT")
  }
}

function directoryExists(
  platform: PersistencePlatformApi,
  path: string,
): Effect.Effect<boolean, unknown> {
  return promiseEffect(async () => {
    try {
      await platform.readDirectory(path)
      return true
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return false
      throw error
    }
  })
}

async function syncParentDirectory(
  platform: PersistencePlatformApi,
  path: string,
): Promise<void> {
  let handle: Awaited<ReturnType<PersistencePlatformApi["open"]>> | undefined
  try {
    handle = await platform.open(dirname(path), "r")
    await handle.sync()
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error
  } finally {
    await handle?.close()
  }
}

function createDirectoryDurably(
  platform: PersistencePlatformApi,
  path: string,
): Effect.Effect<void, unknown> {
  return promiseEffect(async () => {
    const firstCreated = await platform.mkdir(path, { recursive: true, mode: 0o700 })
    if (firstCreated === undefined) return

    const first = resolve(firstCreated)
    const target = resolve(path)
    const suffix = relative(first, target)
    if (suffix.startsWith(`..${sep}`) || suffix === ".." || isAbsolute(suffix)) {
      throw new Error(`Created directory ${first} is not an ancestor of ${target}`)
    }

    await syncDirectory(platform, dirname(first))
    let current = first
    await syncDirectory(platform, current)
    if (suffix.length === 0) return
    for (const component of suffix.split(sep)) {
      current = join(current, component)
      await syncDirectory(platform, current)
    }
  })
}

async function syncDirectory(platform: PersistencePlatformApi, path: string): Promise<void> {
  let handle: Awaited<ReturnType<PersistencePlatformApi["open"]>> | undefined
  try {
    handle = await platform.open(path, "r")
    await handle.sync()
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error
  } finally {
    await handle?.close()
  }
}

function directorySyncUnsupported(error: unknown): boolean {
  return ["EINVAL", "ENOTSUP", "EISDIR"].some((code) => isErrorCode(error, code))
}

function requireCanonicalDate(value: string, label: string): void {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    throw new Error(`${label} is invalid`)
  }
}
