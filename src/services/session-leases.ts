import { createHash } from "node:crypto"
import { join } from "node:path"

import { Context, Effect, Layer, Schema } from "effect"

import { PersistenceError, SessionOwnedError } from "../domain/errors"
import {
  PersistencePlatform,
  PersistencePlatformLive,
  type PersistencePlatformApi,
} from "../infrastructure/metadata/platform"
import {
  PERSISTENCE_SCHEMA_VERSION,
  decodeStrict,
  opaqueIdFileName,
  prepareProjectStorage,
  readJsonIfPresent,
  removeDurably,
  withTransactionLock,
  writeJsonAtomically,
  writeJsonExclusively,
  type ProjectStoragePaths,
} from "../infrastructure/metadata/storage"

const SessionLeaseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(PERSISTENCE_SCHEMA_VERSION),
  projectPath: Schema.NonEmptyString,
  providerId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  ownerToken: Schema.NonEmptyString,
  ownerPid: Schema.Int,
  processGroupId: Schema.optionalKey(Schema.Int),
  acquiredAt: Schema.NonEmptyString,
  updatedAt: Schema.NonEmptyString,
})

interface PersistedSessionLease extends SessionLease {
  readonly schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION
  readonly projectPath: string
  readonly providerId: string
}

export interface SessionLeasesOptions {
  readonly projectDirectory: string
  readonly providerId: string
  readonly stateHome?: string
}

export interface AcquireSessionLeaseOptions {
  readonly processGroupId?: number
}

export interface UpdateSessionLeaseOptions {
  readonly processGroupId?: number | null
}

export interface SessionLease {
  readonly sessionId: string
  readonly ownerToken: string
  readonly ownerPid: number
  readonly processGroupId?: number
  readonly acquiredAt: string
  readonly updatedAt: string
}

export interface SessionLeasesApi {
  readonly projectPath: string
  readonly acquire: (
    sessionId: string,
    options?: AcquireSessionLeaseOptions,
  ) => Effect.Effect<SessionLease, PersistenceError | SessionOwnedError>
  readonly update: (
    lease: SessionLease,
    options: UpdateSessionLeaseOptions,
  ) => Effect.Effect<SessionLease, PersistenceError>
  readonly replaceSessionId: (
    lease: SessionLease,
    newSessionId: string,
  ) => Effect.Effect<SessionLease, PersistenceError | SessionOwnedError>
  readonly release: (lease: SessionLease) => Effect.Effect<void, PersistenceError>
}

export class SessionLeases extends Context.Service<SessionLeases, SessionLeasesApi>()(
  "claude-tree/SessionLeases",
) {}

export function makeSessionLeases(
  options: SessionLeasesOptions,
): Effect.Effect<SessionLeasesApi, PersistenceError, PersistencePlatform> {
  return Effect.gen(function* () {
    const platform = yield* PersistencePlatform
    const paths = yield* persistenceAttempt(
      "open session leases",
      options.projectDirectory,
      () =>
        prepareProjectStorage(
          platform,
          options.projectDirectory,
          options.providerId,
          options.stateHome,
        ),
    )
    return sessionLeasesApi(platform, paths, options.providerId)
  })
}

export function SessionLeasesLive(options: SessionLeasesOptions) {
  return Layer.effect(SessionLeases, makeSessionLeases(options)).pipe(
    Layer.provide(PersistencePlatformLive),
  )
}

function sessionLeasesApi(
  platform: PersistencePlatformApi,
  paths: ProjectStoragePaths,
  providerId: string,
): SessionLeasesApi {
  const leasePath = (sessionId: string) => join(paths.leasesDirectory, opaqueIdFileName(sessionId))

  return {
    projectPath: paths.projectPath,
    acquire: (sessionId, options) => {
      const path = leasePath(sessionId)
      return acquireAttempt("acquire session lease", path, () =>
        withTransactionLock(platform, `${path}.lock`, async () => {
          requireNonEmpty(sessionId, "Session ID")
          requireProcessGroup(options?.processGroupId)
          const existingValue = await readJsonIfPresent(platform, path)
          if (existingValue !== undefined) {
            const existing = decodeLease(existingValue, paths.projectPath, providerId, sessionId)
            if (!(await ownerIsDefinitelyAbsent(platform, existing))) {
              throw new SessionOwnedError({
                providerId,
                sessionId,
                ownerPid: existing.ownerPid,
              })
            }
            await removeDurably(platform, path)
          }

          const now = platform.now()
          const lease: PersistedSessionLease = {
            schemaVersion: PERSISTENCE_SCHEMA_VERSION,
            projectPath: paths.projectPath,
            providerId,
            sessionId,
            ownerToken: platform.randomToken(),
            ownerPid: platform.pid,
            ...(options?.processGroupId === undefined
              ? {}
              : { processGroupId: options.processGroupId }),
            acquiredAt: now,
            updatedAt: now,
          }
          validateLease(lease)
          await writeJsonExclusively(platform, path, lease)
          return publicLease(lease)
        }),
      )
    },
    update: (lease, options) => {
      const path = leasePath(lease.sessionId)
      return persistenceAttempt("update session lease", path, () =>
        withTransactionLock(platform, `${path}.lock`, async () => {
          requireProcessGroup(options.processGroupId ?? undefined)
          const existingValue = await readJsonIfPresent(platform, path)
          if (existingValue === undefined) throw new Error("Session lease is missing")
          const existing = decodeLease(
            existingValue,
            paths.projectPath,
            providerId,
            lease.sessionId,
          )
          requireOwnerToken(existing, lease.ownerToken)
          const base = options.processGroupId === null ? withoutProcessGroup(existing) : existing
          const updated: PersistedSessionLease = {
            ...base,
            ...(options.processGroupId === undefined || options.processGroupId === null
              ? {}
              : { processGroupId: options.processGroupId }),
            updatedAt: platform.now(),
          }
          validateLease(updated)
          await writeJsonAtomically(platform, path, updated)
          return publicLease(updated)
        }),
      )
    },
    replaceSessionId: (lease, newSessionId) => {
      const sourcePath = leasePath(lease.sessionId)
      const destinationPath = leasePath(newSessionId)
      return acquireAttempt("replace session lease ID", destinationPath, () => {
        requireNonEmpty(lease.sessionId, "Session ID")
        requireNonEmpty(newSessionId, "New session ID")
        if (lease.sessionId === newSessionId) {
          throw new Error("Replacement session ID must be different")
        }
        validatePublicLease(lease)

        return withOrderedLocks(
          platform,
          `${sourcePath}.lock`,
          `${destinationPath}.lock`,
          async () => {
            const sourceValue = await readJsonIfPresent(platform, sourcePath)
            if (sourceValue === undefined) {
              const recovered = await recoverCommittedReplacement(
                platform,
                destinationPath,
                paths.projectPath,
                providerId,
                lease,
                newSessionId,
              )
              if (recovered !== undefined) return publicLease(recovered)
              throw new Error("Session lease is missing")
            }

            const source = decodeLease(
              sourceValue,
              paths.projectPath,
              providerId,
              lease.sessionId,
            )
            requireOwnerToken(source, lease.ownerToken)
            const replacementToken = replacementOwnerToken(
              source.ownerToken,
              source.sessionId,
              newSessionId,
            )
            let destination: PersistedSessionLease | undefined
            const destinationValue = await readJsonIfPresent(platform, destinationPath)
            if (destinationValue !== undefined) {
              const existing = decodeLease(
                destinationValue,
                paths.projectPath,
                providerId,
                newSessionId,
              )
              if (isCommittedReplacement(existing, source, replacementToken)) {
                destination = existing
              } else if (!(await ownerIsDefinitelyAbsent(platform, existing))) {
                throw new SessionOwnedError({
                  providerId,
                  sessionId: newSessionId,
                  ownerPid: existing.ownerPid,
                })
              } else {
                await removeDurably(platform, destinationPath)
              }
            }

            if (destination === undefined) {
              destination = replacementLease(
                source,
                newSessionId,
                replacementToken,
                platform.now(),
              )
              await writeJsonExclusively(platform, destinationPath, destination)
            }

            // Once the destination is committed it is the authoritative ownership record.
            // A retained source can be removed by retrying with the original lease.
            await removeDurably(platform, sourcePath).catch(() => undefined)
            return publicLease(destination)
          },
        )
      })
    },
    release: (lease) => {
      const path = leasePath(lease.sessionId)
      return Effect.asVoid(
        persistenceAttempt("release session lease", path, () =>
          withTransactionLock(platform, `${path}.lock`, async () => {
            const existingValue = await readJsonIfPresent(platform, path)
            if (existingValue === undefined) throw new Error("Session lease is missing")
            const existing = decodeLease(
              existingValue,
              paths.projectPath,
              providerId,
              lease.sessionId,
            )
            requireOwnerToken(existing, lease.ownerToken)
            await removeDurably(platform, path)
          }),
        ),
      )
    },
  }
}

async function withOrderedLocks<A>(
  platform: PersistencePlatformApi,
  firstPath: string,
  secondPath: string,
  use: () => Promise<A>,
): Promise<A> {
  const [first, second] =
    firstPath < secondPath ? [firstPath, secondPath] : [secondPath, firstPath]
  return withTransactionLock(platform, first, () =>
    withTransactionLock(platform, second, use),
  )
}

async function recoverCommittedReplacement(
  platform: PersistencePlatformApi,
  destinationPath: string,
  projectPath: string,
  providerId: string,
  source: SessionLease,
  newSessionId: string,
): Promise<PersistedSessionLease | undefined> {
  const destinationValue = await readJsonIfPresent(platform, destinationPath)
  if (destinationValue === undefined) return undefined
  const destination = decodeLease(
    destinationValue,
    projectPath,
    providerId,
    newSessionId,
  )
  const token = replacementOwnerToken(source.ownerToken, source.sessionId, newSessionId)
  return isCommittedReplacement(destination, source, token) ? destination : undefined
}

function replacementLease(
  source: PersistedSessionLease,
  sessionId: string,
  ownerToken: string,
  updatedAt: string,
): PersistedSessionLease {
  const replacement = { ...source, sessionId, ownerToken, updatedAt }
  validateLease(replacement)
  return replacement
}

function replacementOwnerToken(
  ownerToken: string,
  sourceSessionId: string,
  destinationSessionId: string,
): string {
  return createHash("sha256")
    .update(
      `${ownerToken.length}:${ownerToken}${sourceSessionId.length}:${sourceSessionId}${destinationSessionId}`,
    )
    .digest("hex")
}

function isCommittedReplacement(
  destination: PersistedSessionLease,
  source: SessionLease,
  replacementToken: string,
): boolean {
  return (
    destination.ownerToken === replacementToken &&
    destination.ownerPid === source.ownerPid &&
    destination.processGroupId === source.processGroupId &&
    destination.acquiredAt === source.acquiredAt
  )
}

async function ownerIsDefinitelyAbsent(
  platform: PersistencePlatformApi,
  lease: PersistedSessionLease,
): Promise<boolean> {
  const ownerLiveness = await platform.processLiveness(lease.ownerPid)
  if (ownerLiveness !== "absent") return false
  if (lease.processGroupId === undefined) return true
  return (await platform.processGroupLiveness(lease.processGroupId)) === "absent"
}

function decodeLease(
  input: unknown,
  projectPath: string,
  providerId: string,
  sessionId: string,
): PersistedSessionLease {
  const lease = decodeStrict(SessionLeaseSchema, input) as PersistedSessionLease
  validateLease(lease)
  if (
    lease.projectPath !== projectPath ||
    lease.providerId !== providerId ||
    lease.sessionId !== sessionId
  ) {
    throw new Error("Session lease does not match its project, provider, or session key")
  }
  return lease
}

function validateLease(lease: PersistedSessionLease): void {
  if (!Number.isSafeInteger(lease.ownerPid) || lease.ownerPid <= 0) {
    throw new Error("Session lease owner PID must be a positive integer")
  }
  requireProcessGroup(lease.processGroupId)
  requireCanonicalDate(lease.acquiredAt)
  requireCanonicalDate(lease.updatedAt)
}

function validatePublicLease(lease: SessionLease): void {
  requireNonEmpty(lease.sessionId, "Session ID")
  requireNonEmpty(lease.ownerToken, "Owner token")
  if (!Number.isSafeInteger(lease.ownerPid) || lease.ownerPid <= 0) {
    throw new Error("Session lease owner PID must be a positive integer")
  }
  requireProcessGroup(lease.processGroupId)
  requireCanonicalDate(lease.acquiredAt)
  requireCanonicalDate(lease.updatedAt)
}

function requireOwnerToken(lease: PersistedSessionLease, ownerToken: string): void {
  if (lease.ownerToken !== ownerToken) {
    throw new Error("Session lease owner token does not match")
  }
}

function requireProcessGroup(processGroupId: number | undefined): void {
  if (
    processGroupId !== undefined &&
    (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)
  ) {
    throw new Error("Process group ID must be a positive integer")
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} cannot be empty`)
}

function requireCanonicalDate(value: string): void {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    throw new Error(`Invalid canonical timestamp: ${value}`)
  }
}

function publicLease(lease: PersistedSessionLease): SessionLease {
  return lease.processGroupId === undefined
    ? {
        sessionId: lease.sessionId,
        ownerToken: lease.ownerToken,
        ownerPid: lease.ownerPid,
        acquiredAt: lease.acquiredAt,
        updatedAt: lease.updatedAt,
      }
    : {
        sessionId: lease.sessionId,
        ownerToken: lease.ownerToken,
        ownerPid: lease.ownerPid,
        processGroupId: lease.processGroupId,
        acquiredAt: lease.acquiredAt,
        updatedAt: lease.updatedAt,
      }
}

function withoutProcessGroup(
  lease: PersistedSessionLease,
): Omit<PersistedSessionLease, "processGroupId"> {
  const { processGroupId: _, ...without } = lease
  return without
}

function acquireAttempt<A>(
  operation: string,
  path: string,
  run: () => Promise<A>,
): Effect.Effect<A, PersistenceError | SessionOwnedError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => {
      if (cause instanceof SessionOwnedError || cause instanceof PersistenceError) return cause
      return new PersistenceError({
        operation,
        path,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      })
    },
  })
}

function persistenceAttempt<A>(
  operation: string,
  path: string,
  run: () => Promise<A>,
): Effect.Effect<A, PersistenceError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof PersistenceError
        ? cause
        : new PersistenceError({
            operation,
            path,
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  })
}
