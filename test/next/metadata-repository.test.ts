import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { Cause, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { PersistenceError } from "../../src/domain/errors"
import type { NavigationState } from "../../src/domain/model"
import type { BranchRelation } from "../../src/domain/persistence"
import {
  PersistencePlatform,
  nativePersistencePlatform,
  type PersistencePlatformApi,
} from "../../src/infrastructure/metadata/platform"
import {
  makeProviderStateRepository,
  type ProviderStateRepositoryApi,
} from "../../src/services/provider-state-repository"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

describe("ProviderStateRepository schema v3", () => {
  test("creates one strict provider state in the existing location", async () => {
    const { project, state } = await fixture()
    const repository = await openRepository(project, state)
    const persisted = JSON.parse(await readFile(repository.statePath, "utf8"))
    const manifestPath = projectManifestPath(repository.statePath)

    expect(repository.statePath).toContain("/claude-tree/v2/projects/")
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual({
      schemaVersion: 3,
      projectPath: repository.projectPath,
    })
    expect(persisted).toEqual({
      schemaVersion: 3,
      relations: [],
      removals: [],
      navigations: [],
      terminalOwners: [],
      pendingIdentityAdoptions: [],
    })
    expect((await stat(repository.statePath)).mode & 0o777).toBe(0o600)
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600)
  })

  test("durably creates every missing state directory boundary", async () => {
    const { project, state } = await fixture()
    const syncedDirectories: string[] = []
    const platform = testPlatform({
      open: async (path, flags, mode) => {
        const handle = await nativePersistencePlatform.open(path, flags, mode)
        if (flags === "r") syncedDirectories.push(path)
        return handle
      },
    })
    const repository = await openRepository(project, state, platform)
    const providerDirectory = dirname(repository.statePath)
    const projectDirectory = dirname(dirname(providerDirectory))

    expect(syncedDirectories).toEqual(expect.arrayContaining([
      state,
      join(state, "claude-tree"),
      join(state, "claude-tree", "v2"),
      join(state, "claude-tree", "v2", "projects"),
      projectDirectory,
      join(projectDirectory, "providers"),
      providerDirectory,
    ]))
  })

  test("strictly rejects v2 state in place without changing or deleting it", async () => {
    const { project, state } = await fixture()
    const repository = await openRepository(project, state)
    const v2 = `${JSON.stringify({ schemaVersion: 2, relations: [], removals: [] })}\n`
    await writeFile(repository.statePath, v2)

    const error = await rejected(openRepositoryEffect(project, state))
    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).message).toContain("reset-only schema v3")
    expect((error as PersistenceError).message).toContain("Move or remove")
    expect((error as PersistenceError).message).toContain("automatic migration and deletion are disabled")
    expect(await readFile(repository.statePath, "utf8")).toBe(v2)
  })

  test("strictly rejects the separate v2 lease layout without deleting it", async () => {
    const { project, state } = await fixture()
    const repository = await openRepository(project, state)
    const leasesDirectory = join(dirname(repository.statePath), "leases")
    const marker = join(leasesDirectory, "old-lease.json")
    await mkdir(leasesDirectory)
    await writeFile(marker, "v2 lease")

    const error = await rejected(openRepositoryEffect(project, state))
    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).message).toContain("separate session lease layout")
    expect(await readFile(marker, "utf8")).toBe("v2 lease")
  })

  test("keeps navigation independently for each application instance", async () => {
    const { project, state } = await fixture()
    const first = await openRepository(project, state, testPlatform({ instanceId: "instance-a" }))
    const second = await openRepository(project, state, testPlatform({ instanceId: "instance-b" }))

    await saveNavigationState(first, { view: "terminal", sessionId: "session-a" })
    await saveNavigationState(second, {
      view: "roots",
      selectedSessionId: "session-b",
    })
    await saveRelation(first, relation("child", "root"))

    expect((await run(first.loadMetadata)).navigation).toEqual({
      view: "terminal",
      sessionId: "session-a",
    })
    expect((await run(second.loadMetadata)).navigation).toEqual({
      view: "roots",
      selectedSessionId: "session-b",
    })
    expect((await run(second.loadMetadata)).relations).toHaveLength(1)

    const persisted = JSON.parse(await readFile(first.statePath, "utf8"))
    expect(persisted.navigations).toEqual([
      {
        instanceId: "instance-a",
        navigation: { view: "terminal", sessionId: "session-a" },
      },
      {
        instanceId: "instance-b",
        navigation: { view: "roots", selectedSessionId: "session-b" },
      },
    ])
  })

  test("serializes concurrent metadata writers against the unified document", async () => {
    const { project, state } = await fixture()
    const first = await openRepository(project, state, testPlatform({ instanceId: "one" }))
    const second = await openRepository(project, state, testPlatform({ instanceId: "two" }))

    await Promise.all(Array.from({ length: 16 }, (_, index) =>
      saveRelation(
        index % 2 === 0 ? first : second,
        relation(`child-${index}`, "root"),
      )))

    expect((await run(first.loadMetadata)).relations).toHaveLength(16)
  })

  test("only the winning stale-lock reclaimer unlinks before a replacement lock", async () => {
    const { project, state } = await fixture()
    let interceptRace = false
    let staleRemoved = false
    let replacementHeld = false
    let winnerRemovedReplacement = false
    const claimCreated = deferred()
    const allowStaleRemoval = deferred()
    const replacementCreated = deferred()
    const allowReplacementRelease = deferred()
    const winnerCleanedClaim = deferred()
    const firstPlatform = testPlatform({
      pid: 9002,
      instanceId: "first-reclaimer",
      processLiveness: async (pid) => pid === 9001 ? "absent" : "alive",
      link: async (existingPath, newPath) => {
        await nativePersistencePlatform.link(existingPath, newPath)
        if (interceptRace && newPath.includes(".reclaim-")) {
          claimCreated.resolve()
          await allowStaleRemoval.promise
        }
      },
      remove: async (path, options) => {
        if (interceptRace && path.endsWith("state.lock") && !staleRemoved) {
          await nativePersistencePlatform.remove(path, options)
          staleRemoved = true
          await replacementCreated.promise
          return
        }
        if (replacementHeld && path.endsWith("state.lock")) winnerRemovedReplacement = true
        await nativePersistencePlatform.remove(path, options)
        if (interceptRace && path.includes(".reclaim-")) winnerCleanedClaim.resolve()
      },
    })
    const secondPlatform = testPlatform({
      pid: 9003,
      instanceId: "second-reclaimer",
      processLiveness: async (pid) => pid === 9001 ? "absent" : "alive",
      link: async (existingPath, newPath) => {
        await nativePersistencePlatform.link(existingPath, newPath)
        if (interceptRace && staleRemoved && newPath.endsWith("state.lock")) {
          replacementHeld = true
          replacementCreated.resolve()
          await allowReplacementRelease.promise
          replacementHeld = false
        }
      },
    })
    const first = await openRepository(project, state, firstPlatform)
    const second = await openRepository(project, state, secondPlatform)
    const lockPath = join(dirname(first.statePath), "state.lock")
    const lockOwner = {
      schemaVersion: 3,
      ownerToken: "stale-owner",
      ownerPid: 9001,
      createdAt: timestamp(0),
    }
    await writeFile(lockPath, `${JSON.stringify(lockOwner)}\n`, { mode: 0o600 })
    interceptRace = true

    const firstWrite = run(saveRelationEffect(first, relation("first-child", "root")))
    await claimCreated.promise
    const secondWrite = run(saveRelationEffect(second, relation("second-child", "root")))
    allowStaleRemoval.resolve()
    await replacementCreated.promise
    await winnerCleanedClaim.promise

    expect(JSON.parse(await readFile(lockPath, "utf8")).ownerPid).toBe(9003)
    expect(winnerRemovedReplacement).toBeFalse()
    allowReplacementRelease.resolve()
    await Promise.all([firstWrite, secondWrite])
    expect((await run(first.loadMetadata)).relations).toHaveLength(2)
  })

  test("fails closed after a bounded wait for an abandoned matching reclaim claim", async () => {
    const { project, state } = await fixture()
    const platform = testPlatform({
      pid: 9002,
      instanceId: "blocked-reclaimer",
      processLiveness: async (pid) => pid === 9001 ? "absent" : "alive",
    })
    const repository = await openRepository(project, state, platform)
    const lockPath = join(dirname(repository.statePath), "state.lock")
    const ownerToken = "abandoned-owner"
    const reclaimPath = `${lockPath}.reclaim-${createHash("sha256").update(ownerToken).digest("hex")}`
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 3,
      ownerToken,
      ownerPid: 9001,
      createdAt: timestamp(0),
    })}\n`)
    await nativePersistencePlatform.link(lockPath, reclaimPath)

    const result = await run(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.exit(
        saveRelationEffect(repository, relation("child", "root")),
      ))
      yield* TestClock.adjust(2_000)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer())))

    expect(Exit.isFailure(result)).toBeTrue()
    const error = Exit.isFailure(result) ? Cause.squash(result.cause) : undefined
    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).message).toContain("may have been abandoned")
    expect((error as PersistenceError).message).toContain("Automatic takeover is disabled")
    expect((error as PersistenceError).message).toContain(reclaimPath)
    expect(await exists(lockPath)).toBeTrue()
    expect(await exists(reclaimPath)).toBeTrue()
  })

  test("propagates stale-lock reclaimer cleanup failure", async () => {
    const { project, state } = await fixture()
    let failReclaimCleanup = false
    const platform = testPlatform({
      pid: 9002,
      processLiveness: async (pid) => pid === 9001 ? "absent" : "alive",
      remove: async (path, options) => {
        if (failReclaimCleanup && path.includes(".reclaim-")) {
          throw Object.assign(new Error("injected reclaimer cleanup failure"), { code: "EIO" })
        }
        await nativePersistencePlatform.remove(path, options)
      },
    })
    const repository = await openRepository(project, state, platform)
    const lockPath = join(dirname(repository.statePath), "state.lock")
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 3,
      ownerToken: "stale-owner",
      ownerPid: 9001,
      createdAt: timestamp(0),
    })}\n`)
    failReclaimCleanup = true

    const error = await rejected(saveRelationEffect(repository, relation("child", "root")))
    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).message).toContain("injected reclaimer cleanup failure")
    expect((await run(repository.loadMetadata)).relations).toEqual([])
  })

  test("waiting for a live lock is interruptible", async () => {
    const { project, state } = await fixture()
    const platform = testPlatform({
      pid: 9002,
      processLiveness: async () => "alive",
    })
    const repository = await openRepository(project, state, platform)
    const lockPath = join(dirname(repository.statePath), "state.lock")
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 3,
      ownerToken: "live-owner",
      ownerPid: 9001,
      createdAt: timestamp(0),
    })}\n`)

    await run(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(saveRelationEffect(repository, relation("child", "root")))
      yield* Effect.sleep(20)
      yield* Fiber.interrupt(fiber)
    }))
    await rm(lockPath, { force: true })
    expect((await run(repository.loadMetadata)).relations).toEqual([])
  })

  test("public reads lock and can interrupt a blocked liveness check", async () => {
    const { project, state } = await fixture()
    const platform = testPlatform({
      pid: 9002,
      processLiveness: () => new Promise(() => undefined),
    })
    const repository = await openRepository(project, state, platform)
    const lockPath = join(dirname(repository.statePath), "state.lock")
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 3,
      ownerToken: "unknown-owner",
      ownerPid: 9001,
      createdAt: timestamp(0),
    })}\n`)

    await run(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(repository.loadMetadata)
      yield* Effect.sleep(20)
      yield* Fiber.interrupt(fiber)
    }))
    expect(await exists(lockPath)).toBeTrue()
    await rm(lockPath)
  })

  test("recovers one failed same-process lock release without manual deletion", async () => {
    const { project, state } = await fixture()
    let failRelease = false
    const platform = testPlatform({
      remove: async (path, options) => {
        if (failRelease && path.endsWith("state.lock")) {
          failRelease = false
          throw Object.assign(new Error("injected lock release failure"), { code: "EIO" })
        }
        await nativePersistencePlatform.remove(path, options)
      },
    })
    const repository = await openRepository(project, state, platform)
    failRelease = true

    const error = await rejected(saveRelationEffect(repository, relation("child", "root")))
    expect(error).toBeInstanceOf(PersistenceError)
    expect((await run(repository.loadMetadata)).relations).toHaveLength(1)
    expect(await exists(join(dirname(repository.statePath), "state.lock"))).toBeFalse()
  })

  test("propagates file and directory fsync failures", async () => {
    const { project, state } = await fixture()
    let failure: "file" | "directory" | undefined
    let stateRenamed = false
    const platform = testPlatform({
      rename: async (oldPath, newPath) => {
        await nativePersistencePlatform.rename(oldPath, newPath)
        if (newPath.endsWith("state.json")) stateRenamed = true
      },
      open: async (path, flags, mode) => {
        const handle = await nativePersistencePlatform.open(path, flags, mode)
        const isDirectory = flags === "r"
        return {
          ...handle,
          sync: async () => {
            if (
              (failure === "file" && path.endsWith(".tmp")) ||
              (failure === "directory" && stateRenamed && isDirectory && path.endsWith("test-provider"))
            ) {
              throw Object.assign(new Error(`injected ${failure} fsync failure`), { code: "EIO" })
            }
            await handle.sync()
          },
        }
      },
    })
    const repository = await openRepository(project, state, platform)
    stateRenamed = false

    failure = "file"
    const fileError = await rejected(saveRelationEffect(repository, relation("file", "root")))
    expect(fileError).toBeInstanceOf(PersistenceError)
    failure = undefined
    expect((await run(repository.loadMetadata)).relations).toEqual([])

    stateRenamed = false
    failure = "directory"
    const directoryError = await rejected(saveRelationEffect(repository, relation("directory", "root")))
    expect(directoryError).toBeInstanceOf(PersistenceError)
    failure = undefined
    expect((await run(repository.loadMetadata)).relations.map((item) => item.childSessionId)).toEqual([
      "directory",
    ])
  })

  test("ignores only a known unsupported directory fsync result", async () => {
    const { project, state } = await fixture()
    let unsupported = false
    const platform = testPlatform({
      open: async (path, flags, mode) => {
        const handle = await nativePersistencePlatform.open(path, flags, mode)
        return flags === "r"
          ? {
              ...handle,
              sync: async () => {
                if (unsupported) {
                  throw Object.assign(new Error("directory fsync unsupported"), {
                    code: "EINVAL",
                  })
                }
                await handle.sync()
              },
            }
          : handle
      },
    })
    const repository = await openRepository(project, state, platform)
    unsupported = true

    await saveRelation(repository, relation("child", "root"))
    expect((await run(repository.loadMetadata)).relations).toHaveLength(1)
  })

  test("rejects strict and semantic corruption before another write", async () => {
    const { project, state } = await fixture()
    const repository = await openRepository(project, state)
    const original = JSON.parse(await readFile(repository.statePath, "utf8"))
    await writeFile(repository.statePath, `${JSON.stringify({ ...original, extra: true })}\n`)
    expect(await rejected(repository.loadMetadata)).toBeInstanceOf(PersistenceError)

    await writeFile(repository.statePath, `${JSON.stringify({
      ...original,
      relations: [relation("one", "two"), relation("two", "one")],
    })}\n`)
    const cycle = await rejected(repository.loadMetadata)
    expect(cycle).toBeInstanceOf(PersistenceError)
    expect((cycle as PersistenceError).message).toContain("cycle")

    await writeFile(repository.statePath, `${JSON.stringify({
      ...original,
      relations: [{
        ...relation("child", "root"),
        sourceMessageId: "later-source",
      }],
    })}\n`)
    const contradictory = await rejected(repository.loadMetadata)
    expect(contradictory).toBeInstanceOf(PersistenceError)
    expect((contradictory as PersistenceError).message).toContain("must end at the source message")
  })

  test("accepts the documented zero-prefix replay relation", async () => {
    const { project, state } = await fixture()
    const repository = await openRepository(project, state)
    const zeroPrefix = { ...relation("child", "root"), sharedMessages: [] }

    await saveRelation(repository, zeroPrefix)
    expect((await run(repository.loadMetadata)).relations).toEqual([zeroPrefix])
  })
})

function saveRelationEffect(
  repository: ProviderStateRepositoryApi,
  value: BranchRelation,
) {
  return repository.updateMetadata((metadata) => ({
    ...metadata,
    relations: [...metadata.relations, value],
  }))
}

async function saveRelation(
  repository: ProviderStateRepositoryApi,
  value: BranchRelation,
): Promise<void> {
  await run(saveRelationEffect(repository, value))
}

async function saveNavigationState(
  repository: ProviderStateRepositoryApi,
  navigation: NavigationState,
): Promise<void> {
  await run(repository.updateMetadata((metadata) => ({ ...metadata, navigation })))
}

function relation(childSessionId: string, parentSessionId: string) {
  return {
    childSessionId,
    parentSessionId,
    sourceMessageId: "source",
    sharedMessages: [{ parentMessageId: "source", childMessageId: `${childSessionId}-source` }],
    createdAt: timestamp(0),
  }
}

function timestamp(offset: number): string {
  return new Date(Date.UTC(2026, 7, 30, 12, offset)).toISOString()
}

async function fixture(): Promise<{ project: string; state: string }> {
  const root = await mkdtemp(join(tmpdir(), "claude-tree-v3-metadata-"))
  temporaryDirectories.push(root)
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  return { project, state }
}

function projectManifestPath(statePath: string): string {
  return join(dirname(dirname(dirname(statePath))), "project.json")
}

function testPlatform(overrides: Partial<PersistencePlatformApi>): PersistencePlatformApi {
  return { ...nativePersistencePlatform, ...overrides }
}

function deferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function openRepositoryEffect(
  project: string,
  state: string,
  platform: PersistencePlatformApi = nativePersistencePlatform,
) {
  return makeProviderStateRepository({
    projectDirectory: project,
    providerId: "test-provider",
    stateHome: state,
    instanceId: platform.instanceId,
  }).pipe(Effect.provideService(PersistencePlatform, platform))
}

function openRepository(
  project: string,
  state: string,
  platform?: PersistencePlatformApi,
): Promise<ProviderStateRepositoryApi> {
  return run(openRepositoryEffect(project, state, platform))
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as { readonly code?: string }).code === "ENOENT") return false
    throw error
  }
}

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect)
}

async function rejected(effect: Effect.Effect<unknown, unknown> | Promise<unknown>): Promise<unknown> {
  try {
    if (effect instanceof Promise) await effect
    else await Effect.runPromise(effect)
    throw new Error("Expected operation to fail")
  } catch (error) {
    return error
  }
}
