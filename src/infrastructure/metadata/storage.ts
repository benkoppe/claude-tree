import { createHash } from "node:crypto"
import { dirname, isAbsolute, join } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { Schema } from "effect"

import type { PersistencePlatformApi } from "./platform"
import { isErrorCode } from "./platform"

export const PERSISTENCE_SCHEMA_VERSION = 2 as const
const LOCK_RETRY_MILLISECONDS = 10
const LOCK_TIMEOUT_MILLISECONDS = 2_000

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

export interface ProjectStoragePaths {
  readonly projectPath: string
  readonly projectDirectory: string
  readonly manifestPath: string
  readonly providerDirectory: string
  readonly statePath: string
  readonly stateLockPath: string
  readonly leasesDirectory: string
}

const ProjectManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(PERSISTENCE_SCHEMA_VERSION),
  projectPath: Schema.NonEmptyString,
})

export async function prepareProjectStorage(
  platform: PersistencePlatformApi,
  projectDirectory: string,
  providerId: string,
  stateHome?: string,
): Promise<ProjectStoragePaths> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(providerId)) {
    throw new Error(`Invalid provider ID: ${providerId}`)
  }

  const projectPath = await platform.realpath(projectDirectory)
  const resolvedStateHome = stateHome ?? platform.stateHome()
  if (!isAbsolute(resolvedStateHome)) {
    throw new Error("XDG state directory must be an absolute path")
  }

  const projectKey = createHash("sha256").update(projectPath).digest("hex")
  const projectStateDirectory = join(
    resolvedStateHome,
    "claude-tree",
    "v2",
    "projects",
    projectKey,
  )
  const providerDirectory = join(projectStateDirectory, "providers", providerId)
  const manifestPath = join(projectStateDirectory, "project.json")

  await platform.mkdir(projectStateDirectory, { recursive: true, mode: 0o700 })
  await withTransactionLock(platform, join(projectStateDirectory, "project.lock"), async () => {
    const manifest = await readJsonIfPresent(platform, manifestPath)
    if (manifest === undefined) {
      await writeJsonAtomically(platform, manifestPath, {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        projectPath,
      })
      return
    }
    const decoded = decodeStrict(ProjectManifestSchema, manifest)
    if (decoded.projectPath !== projectPath) {
      throw new Error(
        `State directory belongs to ${decoded.projectPath}, not ${projectPath}`,
      )
    }
  })

  await platform.mkdir(providerDirectory, { recursive: true, mode: 0o700 })
  const leasesDirectory = join(providerDirectory, "leases")
  await platform.mkdir(leasesDirectory, { recursive: true, mode: 0o700 })

  return {
    projectPath,
    projectDirectory: projectStateDirectory,
    manifestPath,
    providerDirectory,
    statePath: join(providerDirectory, "state.json"),
    stateLockPath: join(providerDirectory, "state.lock"),
    leasesDirectory,
  }
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

export async function readJsonIfPresent(
  platform: PersistencePlatformApi,
  path: string,
): Promise<unknown | undefined> {
  try {
    return JSON.parse(await platform.readFile(path)) as unknown
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined
    throw error
  }
}

export async function writeJsonAtomically(
  platform: PersistencePlatformApi,
  path: string,
  value: unknown,
): Promise<void> {
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

  await platform.remove(temporaryPath, { force: true }).catch(() => undefined)
  await syncParentDirectory(platform, path).catch(() => undefined)
}

export async function writeJsonExclusively(
  platform: PersistencePlatformApi,
  path: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${path}.${platform.pid}.${platform.randomToken()}.tmp`
  const handle = await platform.open(temporaryPath, "wx", 0o600)
  let closed = false
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
    await handle.close()
    closed = true
    try {
      await platform.link(temporaryPath, path)
    } catch (error) {
      if (!(await jsonFileEquals(platform, path, value))) throw error
    }
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined)
    await platform.remove(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
  await platform.remove(temporaryPath, { force: true }).catch(() => undefined)
  await syncParentDirectory(platform, path).catch(() => undefined)
}

export async function removeDurably(
  platform: PersistencePlatformApi,
  path: string,
): Promise<void> {
  try {
    await platform.remove(path)
  } catch (error) {
    if (!(await pathIsMissing(platform, path))) throw error
  }
  await syncParentDirectory(platform, path).catch(() => undefined)
}

export async function withTransactionLock<A>(
  platform: PersistencePlatformApi,
  lockPath: string,
  use: () => Promise<A>,
): Promise<A> {
  const owner: LockOwner = {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    ownerToken: platform.randomToken(),
    ownerPid: platform.pid,
    createdAt: platform.now(),
  }
  const deadline = Date.now() + LOCK_TIMEOUT_MILLISECONDS

  while (true) {
    try {
      await writeJsonExclusively(platform, lockPath, owner)
      break
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error
    }

    const existingValue = await readJsonIfPresent(platform, lockPath)
    if (existingValue === undefined) continue
    const existing = decodeStrict(LockOwnerSchema, existingValue)
    validateLockOwner(existing)
    const liveness = await platform.processLiveness(existing.ownerPid)
    if (liveness === "absent") {
      // The token-specific hard link elects one reclaimer for this exact lock inode.
      // A contender that linked a replacement instead will fail the token check below.
      const reclaimPath = `${lockPath}.reclaim-${opaqueId(existing.ownerToken)}`
      let claimed = false
      try {
        await platform.link(lockPath, reclaimPath)
        claimed = true
      } catch (error) {
        if (isErrorCode(error, "ENOENT") || isErrorCode(error, "EEXIST")) {
          await waitForLock(platform, deadline, existing.ownerPid)
          continue
        }
        const claimedValue = await readJsonIfPresent(platform, reclaimPath).catch(
          () => undefined,
        )
        if (claimedValue === undefined || lockOwnerToken(claimedValue) !== existing.ownerToken) {
          throw error
        }
        claimed = true
      }

      if (claimed) {
        try {
          const latestValue = await readJsonIfPresent(platform, lockPath)
          if (latestValue !== undefined && lockOwnerToken(latestValue) === existing.ownerToken) {
            await removeDurably(platform, lockPath)
          }
        } finally {
          await removeDurably(platform, reclaimPath).catch(() => undefined)
        }
      }
      continue
    }

    await waitForLock(platform, deadline, existing.ownerPid)
  }

  try {
    const result = await use()
    await releaseTransactionLock(platform, lockPath, owner).catch(() => undefined)
    return result
  } catch (error) {
    await releaseTransactionLock(platform, lockPath, owner).catch(() => undefined)
    throw error
  }
}

export function opaqueIdFileName(id: string): string {
  return `${opaqueId(id)}.json`
}

async function releaseTransactionLock(
  platform: PersistencePlatformApi,
  lockPath: string,
  owner: LockOwner,
): Promise<void> {
  const existingValue = await readJsonIfPresent(platform, lockPath)
  if (existingValue === undefined) return
  if (lockOwnerToken(existingValue) === owner.ownerToken) {
    await removeDurably(platform, lockPath)
  }
}

async function waitForLock(
  platform: PersistencePlatformApi,
  deadline: number,
  ownerPid: number,
): Promise<void> {
  if (Date.now() >= deadline) {
    throw new Error(`Timed out waiting for transaction lock owned by PID ${ownerPid}`)
  }
  await platform.sleep(LOCK_RETRY_MILLISECONDS)
}

function lockOwnerToken(value: unknown): string {
  const owner = decodeStrict(LockOwnerSchema, value)
  validateLockOwner(owner)
  return owner.ownerToken
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

async function syncParentDirectory(
  platform: PersistencePlatformApi,
  path: string,
): Promise<void> {
  const directory = dirname(path)
  let handle: Awaited<ReturnType<PersistencePlatformApi["open"]>> | undefined
  try {
    handle = await platform.open(directory, "r")
    await handle.sync()
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function directorySyncUnsupported(error: unknown): boolean {
  return ["EINVAL", "ENOTSUP", "EISDIR", "EBADF", "EPERM", "EACCES"].some((code) =>
    isErrorCode(error, code),
  )
}

function validateLockOwner(owner: LockOwner): void {
  if (!Number.isSafeInteger(owner.ownerPid) || owner.ownerPid <= 0) {
    throw new Error("Transaction lock owner PID must be a positive integer")
  }
  const createdAt = new Date(owner.createdAt)
  if (Number.isNaN(createdAt.valueOf()) || createdAt.toISOString() !== owner.createdAt) {
    throw new Error("Transaction lock timestamp is invalid")
  }
}
