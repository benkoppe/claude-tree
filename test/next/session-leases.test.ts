import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { PersistenceError, SessionOwnedError } from "../../src/domain/errors"
import {
  makeSessionLeases,
  type SessionLease,
  type SessionLeasesApi,
} from "../../src/services/session-leases"
import {
  PersistencePlatform,
  nativePersistencePlatform,
  type PersistencePlatformApi,
  type ProcessLiveness,
} from "../../src/infrastructure/metadata/platform"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("SessionLeases", () => {
  test("acquires exclusively and rejects a live cross-process owner", async () => {
    const { project, state } = await fixture()
    const owner = await openLeases(project, state, platformWithPid(101))
    const contender = await openLeases(
      project,
      state,
      platformWithPid(202, () => "alive"),
    )
    const lease = await run(owner.acquire("session-one"))

    const error = await rejected(contender.acquire("session-one"))
    expect(error).toBeInstanceOf(SessionOwnedError)
    expect(error).toMatchObject({
      providerId: "test-provider",
      sessionId: "session-one",
      ownerPid: 101,
    })

    await run(owner.release(lease))
  })

  test("recovers only when both the owner PID and process group are absent", async () => {
    const { project, state } = await fixture()
    const owner = await openLeases(project, state, platformWithPid(101))
    await run(owner.acquire("session-one", { processGroupId: 303 }))

    const groupStillAlive = await openLeases(
      project,
      state,
      platformWithPid(202, () => "absent", () => "alive"),
    )
    expect(await rejected(groupStillAlive.acquire("session-one"))).toBeInstanceOf(
      SessionOwnedError,
    )

    const staleRecovery = await openLeases(
      project,
      state,
      platformWithPid(202, () => "absent", () => "absent"),
    )
    const recovered = await run(staleRecovery.acquire("session-one"))
    expect(recovered.ownerPid).toBe(202)
    expect(recovered.ownerToken).not.toBe("")
    await run(staleRecovery.release(recovered))
  })

  test("retains leases when owner liveness is uncertain", async () => {
    const { project, state } = await fixture()
    const owner = await openLeases(project, state, platformWithPid(101))
    await run(owner.acquire("session-one"))
    const contender = await openLeases(
      project,
      state,
      platformWithPid(202, () => "unknown"),
    )

    expect(await rejected(contender.acquire("session-one"))).toBeInstanceOf(
      SessionOwnedError,
    )
  })

  test("verifies owner tokens on update and release", async () => {
    const { project, state } = await fixture()
    const leases = await openLeases(project, state)
    const lease = await run(leases.acquire("session-one"))
    const impostor: SessionLease = { ...lease, ownerToken: "wrong-token" }

    expect(await rejected(leases.update(impostor, { processGroupId: 404 }))).toBeInstanceOf(
      PersistenceError,
    )
    expect(await rejected(leases.release(impostor))).toBeInstanceOf(PersistenceError)

    const updated = await run(leases.update(lease, { processGroupId: 404 }))
    expect(updated.processGroupId).toBe(404)
    const cleared = await run(leases.update(updated, { processGroupId: null }))
    expect(cleared.processGroupId).toBeUndefined()
    await run(leases.release(cleared))
    expect((await run(leases.acquire("session-one"))).ownerToken).not.toBe(lease.ownerToken)
  })

  test("scopes identical session IDs by project and provider", async () => {
    const first = await fixture()
    const second = await fixture()
    const firstProvider = await openLeases(first.project, first.state)
    const otherProvider = await openLeases(first.project, first.state, undefined, "other-provider")
    const otherProject = await openLeases(second.project, first.state)

    const leases = await Promise.all([
      run(firstProvider.acquire("same-session")),
      run(otherProvider.acquire("same-session")),
      run(otherProject.acquire("same-session")),
    ])
    expect(new Set(leases.map((lease) => lease.ownerToken)).size).toBe(3)
  })

  test("fails closed on malformed lease records", async () => {
    const { project, state } = await fixture()
    const leases = await openLeases(project, state)
    await run(leases.acquire("session-one"))
    const [leasePath] = leaseFiles(state)
    expect(leasePath).toBeDefined()
    const value = JSON.parse(await readFile(leasePath!, "utf8"))
    await writeFile(leasePath!, `${JSON.stringify({ ...value, extra: true })}\n`)

    expect(await rejected(leases.acquire("session-one"))).toBeInstanceOf(PersistenceError)
  })

  test("keeps the prior lease when an update rename fails", async () => {
    const { project, state } = await fixture()
    const leases = await openLeases(project, state)
    const lease = await run(leases.acquire("session-one"))
    const faultyPlatform = testPlatform({
      rename: async (oldPath, newPath) => {
        if (newPath.includes("/leases/")) {
          throw Object.assign(new Error("injected rename"), { code: "EIO" })
        }
        await nativePersistencePlatform.rename(oldPath, newPath)
      },
    })
    const faulty = await openLeases(project, state, faultyPlatform)

    expect(await rejected(faulty.update(lease, { processGroupId: 505 }))).toBeInstanceOf(
      PersistenceError,
    )
    await run(leases.release(lease))
    expect(leaseFiles(state).some((path) => path.endsWith(".tmp"))).toBeFalse()
  })

  test("returns ownership when exclusive link and directory sync fail after commit", async () => {
    const { project, state } = await fixture()
    const platform = testPlatform({
      link: async (oldPath, newPath) => {
        await nativePersistencePlatform.link(oldPath, newPath)
        throw Object.assign(new Error("injected post-link failure"), { code: "EIO" })
      },
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
    })
    const leases = await openLeases(project, state, platform)

    const lease = await run(leases.acquire("session-one"))
    expect(lease.sessionId).toBe("session-one")
    expect(leaseFiles(state)).toHaveLength(1)
  })

  test("treats an exception after unlink as a successful release", async () => {
    const { project, state } = await fixture()
    let failAfterLeaseUnlink = false
    const platform = testPlatform({
      remove: async (path, options) => {
        await nativePersistencePlatform.remove(path, options)
        if (failAfterLeaseUnlink && path.endsWith(".json")) {
          throw Object.assign(new Error("injected post-unlink failure"), { code: "EIO" })
        }
      },
    })
    const leases = await openLeases(project, state, platform)
    const lease = await run(leases.acquire("session-one"))
    failAfterLeaseUnlink = true

    await run(leases.release(lease))
    failAfterLeaseUnlink = false
    expect((await run(leases.acquire("session-one"))).ownerToken).not.toBe(
      lease.ownerToken,
    )
  })

  test("replaces a lease identity and rejects a live destination", async () => {
    const { project, state } = await fixture()
    const leases = await openLeases(project, state)
    const source = await run(leases.acquire("temporary", { processGroupId: 707 }))
    const destination = await run(leases.acquire("occupied"))

    expect(
      await rejected(leases.replaceSessionId(source, "occupied")),
    ).toBeInstanceOf(SessionOwnedError)

    const replaced = await run(leases.replaceSessionId(source, "real"))
    expect(replaced).toMatchObject({
      sessionId: "real",
      ownerPid: source.ownerPid,
      processGroupId: 707,
      acquiredAt: source.acquiredAt,
    })
    expect(replaced.ownerToken).not.toBe(source.ownerToken)
    expect(leaseFiles(state)).toHaveLength(2)
    expect(await rejected(leases.update(source, {}))).toBeInstanceOf(PersistenceError)
    await run(leases.release(replaced))
    await run(leases.release(destination))
  })

  test("recovers a partial replacement after destination commit", async () => {
    const { project, state } = await fixture()
    const leases = await openLeases(project, state)
    const source = await run(leases.acquire("temporary"))
    let failSourceRemoval = false
    const faultyPlatform = testPlatform({
      remove: async (path, options) => {
        if (failSourceRemoval && path.endsWith(".json")) {
          try {
            const value = JSON.parse(await readFile(path, "utf8"))
            if (value.sessionId === "temporary") {
              throw Object.assign(new Error("injected source removal failure"), {
                code: "EIO",
              })
            }
          } catch (error) {
            if ((error as { code?: string }).code === "EIO") throw error
          }
        }
        await nativePersistencePlatform.remove(path, options)
      },
    })
    const faulty = await openLeases(project, state, faultyPlatform)
    failSourceRemoval = true

    const committed = await run(faulty.replaceSessionId(source, "real"))
    expect(committed.sessionId).toBe("real")
    expect(leaseFiles(state)).toHaveLength(2)

    failSourceRemoval = false
    const recovered = await run(faulty.replaceSessionId(source, "real"))
    expect(recovered.ownerToken).toBe(committed.ownerToken)
    expect(leaseFiles(state)).toHaveLength(1)
    await run(faulty.release(recovered))
  })

  test("orders opposite replacement locks without deadlock", async () => {
    const { project, state } = await fixture()
    const leases = await openLeases(project, state)
    const first = await run(leases.acquire("first"))
    const second = await run(leases.acquire("second"))

    const outcomes = await Promise.all([
      rejected(leases.replaceSessionId(first, "second")),
      rejected(leases.replaceSessionId(second, "first")),
    ])
    expect(outcomes.every((outcome) => outcome instanceof SessionOwnedError)).toBeTrue()
    await run(leases.release(first))
    await run(leases.release(second))
  })

  test("uses private strict lease documents", async () => {
    const { project, state } = await fixture()
    const leases = await openLeases(project, state)
    const lease = await run(leases.acquire("opaque/session:id", { processGroupId: 606 }))
    const [leasePath] = leaseFiles(state)
    expect(leasePath?.split("/").at(-1)).toMatch(/^[a-f0-9]{64}\.json$/)
    const value = JSON.parse(await readFile(leasePath!, "utf8"))
    expect(value).toMatchObject({
      schemaVersion: 2,
      projectPath: leases.projectPath,
      providerId: "test-provider",
      sessionId: "opaque/session:id",
      ownerToken: lease.ownerToken,
      ownerPid: process.pid,
      processGroupId: 606,
    })
    expect(Object.keys(value).sort()).toEqual([
      "acquiredAt",
      "ownerPid",
      "ownerToken",
      "processGroupId",
      "projectPath",
      "providerId",
      "schemaVersion",
      "sessionId",
      "updatedAt",
    ])
  })
})

async function fixture(): Promise<{ project: string; state: string }> {
  const root = await mkdtemp(join(tmpdir(), "claude-tree-next-leases-"))
  temporaryDirectories.push(root)
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  return { project, state }
}

function platformWithPid(
  pid: number,
  processLiveness: (pid: number) => ProcessLiveness = (candidate) =>
    candidate === pid ? "alive" : "absent",
  processGroupLiveness: (processGroupId: number) => ProcessLiveness = () => "absent",
): PersistencePlatformApi {
  return testPlatform({
    pid,
    processLiveness: async (candidate) => processLiveness(candidate),
    processGroupLiveness: async (processGroupId) => processGroupLiveness(processGroupId),
  })
}

function testPlatform(overrides: Partial<PersistencePlatformApi>): PersistencePlatformApi {
  return { ...nativePersistencePlatform, ...overrides }
}

function openLeases(
  project: string,
  state: string,
  platform: PersistencePlatformApi = nativePersistencePlatform,
  providerId = "test-provider",
): Promise<SessionLeasesApi> {
  return run(
    makeSessionLeases({ projectDirectory: project, providerId, stateHome: state }).pipe(
      Effect.provideService(PersistencePlatform, platform),
    ),
  )
}

function leaseFiles(state: string): string[] {
  return Array.from(
    new Bun.Glob("**/leases/*").scanSync({ cwd: state, absolute: true, onlyFiles: true }),
  ).filter((path) => !path.endsWith(".lock"))
}

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect)
}

async function rejected(effect: Effect.Effect<unknown, unknown>): Promise<unknown> {
  try {
    await Effect.runPromise(effect)
    throw new Error("Expected operation to fail")
  } catch (error) {
    return error
  }
}
