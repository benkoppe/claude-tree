import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { PersistenceError } from "../../src/domain/errors"
import {
  makeMetadataRepository,
  type MetadataRepositoryApi,
} from "../../src/services/metadata-repository"
import {
  PersistencePlatform,
  nativePersistencePlatform,
  type PersistencePlatformApi,
} from "../../src/infrastructure/metadata/platform"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("MetadataRepository", () => {
  test("creates fresh strict v2 project and consolidated provider state", async () => {
    const { project, state } = await fixture()
    const legacyDirectory = join(state, "claude-tree", "projects", "legacy")
    await mkdir(legacyDirectory, { recursive: true })
    await writeFile(join(legacyDirectory, "project.json"), "not json")

    const repository = await openRepository(project, state)
    const persisted = JSON.parse(await readFile(repository.statePath, "utf8"))
    const manifestPath = join(dirname(dirname(dirname(repository.statePath))), "project.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))

    expect(repository.statePath).toContain("/claude-tree/v2/projects/")
    expect(manifest).toEqual({ schemaVersion: 2, projectPath: repository.projectPath })
    expect(persisted).toEqual({ schemaVersion: 2, relations: [], removals: [] })
    expect((await stat(repository.statePath)).mode & 0o777).toBe(0o600)
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600)
  })

  test("canonically round-trips relations, removals, and semantic navigation", async () => {
    const { project, state } = await fixture()
    const repository = await openRepository(project, state)

    await run(
      repository.update(() => ({
        relations: [relation("z-child", "root"), relation("a-child", "root")],
        removals: [
          {
            kind: "tree",
            rootSessionId: "root",
            memberSessionIds: ["root", "a-child"],
            createdAt: timestamp(1),
          },
          {
            kind: "subtree",
            target: {
              kind: "message",
              aliases: [
                { sessionId: "z-child", messageId: "copy" },
                { sessionId: "root", messageId: "source" },
              ],
            },
            createdAt: timestamp(2),
          },
        ],
        navigation: {
          view: "graph",
          familySessionId: "root",
          target: {
            kind: "message",
            preferred: { sessionId: "z-child", messageId: "copy" },
            aliases: [
              { sessionId: "z-child", messageId: "copy" },
              { sessionId: "root", messageId: "source" },
            ],
          },
        },
      })),
    )

    const loaded = await run(repository.load)
    expect(loaded.relations.map((candidate) => candidate.childSessionId)).toEqual([
      "a-child",
      "z-child",
    ])
    const messageRemoval = loaded.removals.find(
      (removal) => removal.kind === "subtree" && removal.target.kind === "message",
    )
    expect(
      messageRemoval?.kind === "subtree" && messageRemoval.target.kind === "message"
        ? messageRemoval.target.aliases
        : undefined,
    ).toEqual([
      { sessionId: "root", messageId: "source" },
      { sessionId: "z-child", messageId: "copy" },
    ])
    expect(
      loaded.navigation?.view === "graph" && loaded.navigation.target.kind === "message"
        ? loaded.navigation.target.aliases
        : undefined,
    ).toEqual([
      { sessionId: "root", messageId: "source" },
      { sessionId: "z-child", messageId: "copy" },
    ])
  })

  test("fails closed on excess properties and semantic corruption", async () => {
    const { project, state } = await fixture()
    const repository = await openRepository(project, state)
    const original = JSON.parse(await readFile(repository.statePath, "utf8"))
    await writeFile(
      repository.statePath,
      `${JSON.stringify({ ...original, unexpected: true })}\n`,
    )

    const excessError = await rejected(repository.load)
    expect(excessError).toBeInstanceOf(PersistenceError)

    await writeFile(
      repository.statePath,
      `${JSON.stringify({
        schemaVersion: 2,
        relations: [relation("one", "two"), relation("two", "one")],
        removals: [],
      })}\n`,
    )
    const cycleError = await rejected(repository.load)
    expect(cycleError).toBeInstanceOf(PersistenceError)
    expect((cycleError as PersistenceError).message).toContain("cycle")
  })

  test("rejects invalid mappings, removals, and navigation before writing", async () => {
    const { project, state } = await fixture()
    const repository = await openRepository(project, state)

    const invalidStates = [
      {
        relations: [{ ...relation("child", "parent"), unexpected: true }],
        removals: [],
      },
      {
        relations: [
          {
            ...relation("child", "parent"),
            sharedMessages: [
              { parentMessageId: "same", childMessageId: "one" },
              { parentMessageId: "same", childMessageId: "two" },
            ],
          },
        ],
        removals: [],
      },
      {
        relations: [],
        removals: [
          {
            kind: "tree" as const,
            rootSessionId: "root",
            memberSessionIds: ["child"],
            createdAt: timestamp(0),
          },
        ],
      },
      {
        relations: [],
        removals: [],
        navigation: {
          view: "graph" as const,
          familySessionId: "root",
          target: {
            kind: "message" as const,
            preferred: { sessionId: "root", messageId: "missing" },
            aliases: [{ sessionId: "root", messageId: "present" }],
          },
        },
      },
    ]

    for (const invalid of invalidStates) {
      expect(await rejected(repository.update(() => invalid))).toBeInstanceOf(PersistenceError)
      expect(await run(repository.load)).toEqual({ relations: [], removals: [] })
    }
  })

  test("serializes concurrent writers and rereads state inside the lock", async () => {
    const { project, state } = await fixture()
    const first = await openRepository(project, state)
    const second = await openRepository(project, state)

    await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const repository = index % 2 === 0 ? first : second
        return run(repository.saveRelation(relation(`child-${index}`, "root")))
      }),
    )

    expect((await run(first.load)).relations).toHaveLength(12)
  })

  test("recovers a transaction lock only after its owner is absent", async () => {
    const { project, state } = await fixture()
    const platform = testPlatform({
      pid: 9002,
      processLiveness: async (pid) => (pid === 9001 ? "absent" : "alive"),
    })
    const repository = await openRepository(project, state, platform)
    await writeFile(
      `${repository.statePath.slice(0, -"state.json".length)}state.lock`,
      `${JSON.stringify({
        schemaVersion: 2,
        ownerToken: "stale-owner",
        ownerPid: 9001,
        createdAt: timestamp(0),
      })}\n`,
      { mode: 0o600 },
    )

    await run(repository.saveRelation(relation("child", "root")))
    expect((await run(repository.load)).relations).toHaveLength(1)
  })

  test("allows only one simultaneous reclaimer to unlink an observed stale lock", async () => {
    const { project, state } = await fixture()
    let reclaimAttempts = 0
    let releaseReclaimers!: () => void
    const reclaimersReady = new Promise<void>((resolve) => {
      releaseReclaimers = resolve
    })
    const platform = testPlatform({
      pid: 9002,
      processLiveness: async (pid) => (pid === 9001 ? "absent" : "alive"),
      link: async (oldPath, newPath) => {
        if (newPath.includes(".reclaim-")) {
          reclaimAttempts += 1
          if (reclaimAttempts === 2) releaseReclaimers()
          await reclaimersReady
        }
        await nativePersistencePlatform.link(oldPath, newPath)
      },
    })
    const first = await openRepository(project, state, platform)
    const second = await openRepository(project, state, platform)
    const lockPath = `${first.statePath.slice(0, -"state.json".length)}state.lock`
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 2,
        ownerToken: "stale-owner",
        ownerPid: 9001,
        createdAt: timestamp(0),
      })}\n`,
      { mode: 0o600 },
    )

    await Promise.all([
      run(first.saveRelation(relation("first", "root"))),
      run(second.saveRelation(relation("second", "root"))),
    ])

    expect(reclaimAttempts).toBeGreaterThanOrEqual(2)
    expect((await run(first.load)).relations).toHaveLength(2)
  })

  test("keeps the previous state when an atomic rename fails", async () => {
    const { project, state } = await fixture()
    const repository = await openRepository(project, state)
    const faulty = testPlatform({
      rename: async (oldPath, newPath) => {
        if (newPath === repository.statePath) throw Object.assign(new Error("injected rename"), { code: "EIO" })
        await nativePersistencePlatform.rename(oldPath, newPath)
      },
    })
    const faultyRepository = await openRepository(project, state, faulty)

    const error = await rejected(faultyRepository.saveRelation(relation("child", "root")))
    expect(error).toBeInstanceOf(PersistenceError)
    expect(await run(repository.load)).toEqual({ relations: [], removals: [] })
    const temporaryFiles = Array.from(
      new Bun.Glob("*.tmp").scanSync({ cwd: dirname(repository.statePath) }),
    )
    expect(temporaryFiles).toEqual([])
  })

  test("returns committed state when rename reports an error after replacing it", async () => {
    const { project, state } = await fixture()
    const repository = await openRepository(project, state)
    const faulty = testPlatform({
      rename: async (oldPath, newPath) => {
        await nativePersistencePlatform.rename(oldPath, newPath)
        if (newPath === repository.statePath) {
          throw Object.assign(new Error("injected post-rename failure"), { code: "EIO" })
        }
      },
    })
    const faultyRepository = await openRepository(project, state, faulty)

    const saved = await run(faultyRepository.saveRelation(relation("child", "root")))
    expect(saved.childSessionId).toBe("child")
    expect((await run(repository.load)).relations).toHaveLength(1)
  })

  test("keeps the protected outcome when lock unlink or directory sync reports failure", async () => {
    const { project, state } = await fixture()
    let failLockRelease = false
    const platform = testPlatform({
      open: async (path, flags, mode) => {
        const handle = await nativePersistencePlatform.open(path, flags, mode)
        return flags === "r"
          ? {
              ...handle,
              sync: async () => {
                await handle.sync()
                throw Object.assign(new Error("injected post-sync failure"), { code: "EIO" })
              },
            }
          : handle
      },
      remove: async (path, options) => {
        await nativePersistencePlatform.remove(path, options)
        if (failLockRelease && path.endsWith("state.lock")) {
          throw Object.assign(new Error("injected post-unlink failure"), { code: "EIO" })
        }
      },
    })
    const repository = await openRepository(project, state, platform)
    failLockRelease = true

    await run(repository.saveRelation(relation("child", "root")))
    expect((await run(repository.load)).relations).toHaveLength(1)

    const primary = await rejected(
      repository.update(() => {
        throw new Error("primary transform failure")
      }),
    )
    expect(primary).toBeInstanceOf(PersistenceError)
    expect((primary as PersistenceError).message).toContain("primary transform failure")
  })

  test("atomically rewrites every persisted session reference", async () => {
    const { project, state } = await fixture()
    const repository = await openRepository(project, state)
    await run(
      repository.update(() => ({
        relations: [relation("temporary", "parent"), relation("child", "temporary")],
        removals: [
          {
            kind: "tree",
            rootSessionId: "temporary",
            memberSessionIds: ["temporary", "real", "child"],
            createdAt: timestamp(1),
          },
          {
            kind: "subtree",
            target: {
              kind: "message",
              aliases: [
                { sessionId: "temporary", messageId: "same" },
                { sessionId: "real", messageId: "same" },
              ],
            },
            createdAt: timestamp(2),
          },
          {
            kind: "subtree",
            target: {
              kind: "endpoint",
              sessionId: "temporary",
              afterMessageId: null,
            },
            createdAt: timestamp(3),
          },
        ],
        navigation: {
          view: "graph",
          familySessionId: "temporary",
          target: {
            kind: "message",
            preferred: { sessionId: "temporary", messageId: "same" },
            aliases: [
              { sessionId: "temporary", messageId: "same" },
              { sessionId: "real", messageId: "same" },
            ],
          },
        },
      })),
    )

    const replaced = await run(repository.replaceSessionId("temporary", "real"))
    expect(JSON.stringify(replaced)).not.toContain("temporary")
    expect(replaced.relations).toEqual([
      relation("child", "real"),
      relation("real", "parent"),
    ])
    expect(replaced.removals[0]).toMatchObject({
      kind: "subtree",
      target: { kind: "endpoint", sessionId: "real" },
    })
    const tree = replaced.removals.find((removal) => removal.kind === "tree")
    expect(tree?.kind === "tree" ? tree.memberSessionIds : undefined).toEqual([
      "child",
      "real",
    ])
    expect(
      replaced.navigation?.view === "graph" &&
        replaced.navigation.target.kind === "message"
        ? replaced.navigation.target.aliases
        : undefined,
    ).toEqual([{ sessionId: "real", messageId: "same" }])
  })

  test("validates the existing project manifest strictly", async () => {
    const { project, state } = await fixture()
    const repository = await openRepository(project, state)
    const manifestPath = join(dirname(dirname(dirname(repository.statePath))), "project.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, extra: true })}\n`)

    expect(await rejected(openRepositoryEffect(project, state))).toBeInstanceOf(PersistenceError)
  })
})

function relation(childSessionId: string, parentSessionId: string) {
  return {
    childSessionId,
    parentSessionId,
    sourceMessageId: "source",
    sharedMessages: [] as const,
    createdAt: timestamp(0),
  }
}

function timestamp(offset: number): string {
  return new Date(Date.UTC(2026, 7, 30, 12, offset)).toISOString()
}

async function fixture(): Promise<{ project: string; state: string }> {
  const root = await mkdtemp(join(tmpdir(), "claude-tree-next-metadata-"))
  temporaryDirectories.push(root)
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  return { project, state }
}

function testPlatform(
  overrides: Partial<PersistencePlatformApi>,
): PersistencePlatformApi {
  return { ...nativePersistencePlatform, ...overrides }
}

function openRepositoryEffect(
  project: string,
  state: string,
  platform: PersistencePlatformApi = nativePersistencePlatform,
) {
  return makeMetadataRepository({
    projectDirectory: project,
    providerId: "test-provider",
    stateHome: state,
  }).pipe(Effect.provideService(PersistencePlatform, platform))
}

function openRepository(
  project: string,
  state: string,
  platform?: PersistencePlatformApi,
): Promise<MetadataRepositoryApi> {
  return run(openRepositoryEffect(project, state, platform))
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
