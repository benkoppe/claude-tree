import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import {
  PersistenceError,
  SessionOwnedError,
  SessionRemovedError,
} from "../../src/domain/errors"
import type { ProjectState, TerminalOwner } from "../../src/domain/persistence"
import {
  PersistencePlatform,
  nativePersistencePlatform,
  type PersistencePlatformApi,
  type ProcessLiveness,
} from "../../src/infrastructure/metadata/platform"
import {
  makeProviderStateRepository,
  replaceSessionIdInProjectState,
  type ProviderStateRepositoryApi,
} from "../../src/services/provider-state-repository"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

describe("ProviderStateRepository terminal ownership", () => {
  test("allows only one concurrent reservation", async () => {
    const { project, state } = await fixture()
    const first = await openProviderState(
      project,
      state,
      platformWithPid(101, "first", () => "alive"),
    )
    const second = await openProviderState(
      project,
      state,
      platformWithPid(202, "second", () => "alive"),
    )

    const outcomes = await Promise.all([
      outcome(first.reserve("same-session")),
      outcome(second.reserve("same-session")),
    ])
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1)
    const failure = outcomes.find((result) => !result.ok)
    expect(failure && !failure.ok ? failure.error : undefined).toBeInstanceOf(SessionOwnedError)
    expect((await run(first.load)).terminalOwners).toHaveLength(1)
  })

  test("reclaims only after both the owner process and process group are absent", async () => {
    const { project, state } = await fixture()
    const ownerRepository = await openProviderState(
      project,
      state,
      platformWithPid(101, "owner"),
    )
    const reserved = await run(ownerRepository.reserve("session-one"))
    await run(ownerRepository.attach(reserved, 303))

    const liveGroup = await openProviderState(
      project,
      state,
      platformWithPid(202, "contender", () => "absent", () => "alive"),
    )
    expect(await rejected(liveGroup.reserve("session-one"))).toBeInstanceOf(
      SessionOwnedError,
    )

    const stale = await openProviderState(
      project,
      state,
      platformWithPid(202, "contender", () => "absent", () => "absent"),
    )
    const reclaimed = await run(stale.reserve("session-one"))
    expect(reclaimed.ownerPid).toBe(202)
    expect(reclaimed.instanceId).toBe("contender")
  })

  test("retains an owner when process liveness is unknown", async () => {
    const { project, state } = await fixture()
    const owner = await openProviderState(project, state, platformWithPid(101, "owner"))
    await run(owner.reserve("session-one"))
    const contender = await openProviderState(
      project,
      state,
      platformWithPid(202, "contender", () => "unknown"),
    )

    expect(await rejected(contender.reserve("session-one"))).toBeInstanceOf(
      SessionOwnedError,
    )
  })

  test("does not reclaim a dead reserved owner without a persisted process group", async () => {
    const { project, state } = await fixture()
    const original = await openProviderState(
      project,
      state,
      platformWithPid(101, "owner"),
    )
    await run(original.reserve("session-one"))
    const contender = await openProviderState(
      project,
      state,
      platformWithPid(202, "contender", () => "absent", () => "absent"),
    )

    const error = await rejected(contender.reserve("session-one"))
    expect(error).toBeInstanceOf(SessionOwnedError)
    const retained = (await run(contender.load)).terminalOwners[0]!
    expect(retained).toMatchObject({
      ownerPid: 101,
      status: "reserved",
    })
    expect(retained.processGroupId).toBeUndefined()
  })

  test("recovers a committed reserve retry before reporting session ownership", async () => {
    const { project, state } = await fixture()
    let failCommit = false
    let failReconciliationRead = false
    let stateRenamed = false
    const platform = testPlatform({
      pid: 101,
      instanceId: "reserve-retry",
      rename: async (oldPath, newPath) => {
        await nativePersistencePlatform.rename(oldPath, newPath)
        if (failCommit && newPath.endsWith("state.json")) stateRenamed = true
      },
      readFile: async (path) => {
        if (failReconciliationRead && path.endsWith("state.json")) {
          failReconciliationRead = false
          throw Object.assign(new Error("injected reconciliation read failure"), { code: "EIO" })
        }
        return await nativePersistencePlatform.readFile(path)
      },
      open: async (path, flags, mode) => {
        const handle = await nativePersistencePlatform.open(path, flags, mode)
        return flags === "r" && path.endsWith("test-provider")
          ? {
              ...handle,
              sync: async () => {
                await handle.sync()
                if (failCommit && stateRenamed) {
                  failCommit = false
                  stateRenamed = false
                  failReconciliationRead = true
                  throw Object.assign(new Error("injected post-commit failure"), { code: "EIO" })
                }
              },
            }
          : handle
      },
    })
    const repository = await openProviderState(project, state, platform)
    failCommit = true

    expect(await rejected(repository.reserve("session-one", {
      mutationToken: "stable-reserve",
    }))).toBeInstanceOf(PersistenceError)
    const recovered = await run(repository.reserve("session-one", {
      mutationToken: "stable-reserve",
    }))

    expect(recovered).toMatchObject({
      instanceId: "reserve-retry",
      ownerPid: 101,
      ownerToken: "stable-reserve",
      lastMutationToken: "stable-reserve",
    })
    expect((await run(repository.load)).terminalOwners).toEqual([recovered])
  })

  test("attaches, marks stopping, verifies tokens, and releases", async () => {
    const { project, state } = await fixture()
    const repository = await openProviderState(project, state)
    const reserved = await run(repository.reserve("session-one"))
    const running = await run(repository.attach(reserved, 404))
    expect(running).toMatchObject({ status: "running", processGroupId: 404 })
    const stopping = await run(repository.mark(running, "stopping"))
    expect(stopping.status).toBe("stopping")

    const impostor: TerminalOwner = { ...stopping, ownerToken: "wrong" }
    expect(await rejected(repository.release(impostor))).toBeInstanceOf(PersistenceError)
    await run(repository.release(stopping))
    expect((await run(repository.load)).terminalOwners).toEqual([])
  })

  test("commits identity, metadata, every navigation, owner, and journal atomically", async () => {
    const { project, state } = await fixture()
    const first = await openProviderState(
      project,
      state,
      testPlatform({ instanceId: "instance-a" }),
    )
    const second = await openProviderState(
      project,
      state,
      testPlatform({ instanceId: "instance-b" }),
    )
    await run(first.updateMetadata(() => ({
      relations: [],
      removals: [],
      navigation: { view: "terminal", sessionId: "temporary" },
    })))
    await run(second.updateMetadata((metadata) => ({
      ...metadata,
      navigation: { view: "roots", selectedSessionId: "temporary" },
    })))
    const owner = await run(first.reserve("temporary"))
    const running = await run(first.attach(owner, 505))
    const branch = relation("provider-id", "parent")

    const committed = await run(first.commitIdentity({
      owner: running,
      sessionId: "provider-id",
      kind: "temporary-adoption",
      relation: branch,
      mutationToken: "adopt-temporary",
    }))

    expect(committed.owner).toMatchObject({
      sessionId: "provider-id",
      ownerToken: running.ownerToken,
      processGroupId: 505,
    })
    expect(committed.metadata.relations[0]?.childSessionId).toBe("provider-id")
    expect(JSON.stringify(committed.metadata)).not.toContain("temporary")
    expect((await run(second.loadMetadata)).navigation).toEqual({
      view: "roots",
      selectedSessionId: "provider-id",
    })

    const unified = await run(first.load)
    expect(unified.terminalOwners.map((candidate) => candidate.sessionId)).toEqual([
      "provider-id",
    ])
    expect(unified.pendingIdentityAdoptions).toEqual([committed.adoption])
    expect(unified.navigations.every((entry) =>
      !JSON.stringify(entry).includes("temporary"))).toBeTrue()

    const retried = await run(first.commitIdentity({
      owner: running,
      sessionId: "provider-id",
      kind: "temporary-adoption",
      relation: branch,
      mutationToken: "adopt-temporary",
    }))
    expect(retried.adoption.adoptionToken).toBe(committed.adoption.adoptionToken)
    expect((await run(first.pendingAdoptions))).toHaveLength(1)
    await run(first.ack(committed.adoption.adoptionToken))
    await run(first.ack(committed.adoption.adoptionToken))
    expect((await run(first.pendingAdoptions))).toEqual([])
  })

  test("leaves identity and metadata unchanged when the unified commit fails", async () => {
    const { project, state } = await fixture()
    let failCommit = false
    const platform = testPlatform({
      instanceId: "atomic-instance",
      rename: async (oldPath, newPath) => {
        if (failCommit && newPath.endsWith("state.json")) {
          throw Object.assign(new Error("injected identity commit failure"), { code: "EIO" })
        }
        await nativePersistencePlatform.rename(oldPath, newPath)
      },
    })
    const repository = await openProviderState(project, state, platform)
    const owner = await run(repository.reserve("temporary"))
    const running = await run(repository.attach(owner, 909))
    await run(repository.updateMetadata(() => ({
      relations: [],
      removals: [],
      navigation: { view: "terminal", sessionId: "temporary" },
    })))
    failCommit = true

    const error = await rejected(repository.commitIdentity({
      owner: running,
      sessionId: "provider-id",
      kind: "temporary-adoption",
      relation: relation("provider-id", "parent"),
    }))
    expect(error).toBeInstanceOf(PersistenceError)
    failCommit = false

    const unchanged = await run(repository.load)
    expect(unchanged.terminalOwners.map((candidate) => candidate.sessionId)).toEqual([
      "temporary",
    ])
    expect(unchanged.relations).toEqual([])
    expect(unchanged.navigations[0]?.navigation).toEqual({
      view: "terminal",
      sessionId: "temporary",
    })
    expect(unchanged.pendingIdentityAdoptions).toEqual([])
  })

  test("rejects identity adoption onto a live destination owner", async () => {
    const { project, state } = await fixture()
    const repository = await openProviderState(project, state)
    const source = await run(repository.reserve("temporary"))
    const running = await run(repository.attach(source, 808))
    await run(repository.reserve("occupied"))

    expect(await rejected(repository.commitIdentity({
      owner: running,
      sessionId: "occupied",
      kind: "temporary-adoption",
    }))).toBeInstanceOf(SessionOwnedError)
    expect((await run(repository.load)).terminalOwners.map((owner) => owner.sessionId)).toEqual([
      "occupied",
      "temporary",
    ])
  })

  test("never automatically reclaims cleanup-incomplete ownership", async () => {
    const { project, state } = await fixture()
    const original = await openProviderState(
      project,
      state,
      platformWithPid(101, "original"),
    )
    const reserved = await run(original.reserve("session-one"))
    const running = await run(original.attach(reserved, 303))
    const stopping = await run(original.mark(running, "stopping"))

    const contender = await openProviderState(
      project,
      state,
      platformWithPid(202, "contender", () => "absent", () => "absent"),
    )
    expect(await rejected(contender.reserve("session-one"))).toBeInstanceOf(
      SessionOwnedError,
    )
    const incomplete = await run(original.mark(stopping, "cleanup-incomplete"))
    expect(await rejected(contender.reserve("session-one"))).toBeInstanceOf(
      SessionOwnedError,
    )
    expect((await run(contender.load)).terminalOwners).toEqual([incomplete])
  })

  test("blocks release until the originating application acknowledges adoption", async () => {
    const { project, state } = await fixture()
    const repository = await openProviderState(project, state)
    const reserved = await run(repository.reserve("temporary"))
    const running = await run(repository.attach(reserved, 404))
    const committed = await run(repository.commitIdentity({
      owner: running,
      sessionId: "provider-id",
      kind: "temporary-adoption",
      mutationToken: "pending-release",
    }))

    expect(await rejected(repository.release(committed.owner))).toBeInstanceOf(PersistenceError)
    await run(repository.ack(committed.adoption.adoptionToken))
    await run(repository.release(committed.owner))
    expect((await run(repository.load)).terminalOwners).toEqual([])
  })

  test("preserves persisted source metadata for a native fork", async () => {
    const { project, state } = await fixture()
    const first = await openProviderState(
      project,
      state,
      testPlatform({ instanceId: "instance-a" }),
    )
    const second = await openProviderState(
      project,
      state,
      testPlatform({ instanceId: "instance-b" }),
    )
    await run(first.updateMetadata(() => ({
      relations: [relation("persisted-source", "root")],
      removals: [{
        kind: "subtree",
        target: { kind: "endpoint", sessionId: "unrelated", afterMessageId: null },
        createdAt: timestamp(1),
      }],
      navigation: {
        view: "graph",
        familySessionId: "persisted-source",
        target: {
          kind: "message",
          preferred: { sessionId: "persisted-source", messageId: "source" },
          aliases: [{ sessionId: "persisted-source", messageId: "source" }],
        },
      },
    })))
    await run(second.updateMetadata((metadata) => ({
      ...metadata,
      navigation: { view: "roots", selectedSessionId: "persisted-source" },
    })))
    const reserved = await run(first.reserve("persisted-source"))
    const running = await run(first.attach(reserved, 505))
    const forkRelation = relation("native-child", "persisted-source")

    const committed = await run(first.commitIdentity({
      owner: running,
      sessionId: "native-child",
      kind: "native-fork",
      relation: forkRelation,
      mutationToken: "native-fork",
    }))

    expect(committed.metadata.relations).toEqual([
      relation("native-child", "persisted-source"),
      relation("persisted-source", "root"),
    ])
    expect(committed.metadata.removals[0]).toMatchObject({
      target: { sessionId: "unrelated" },
    })
    expect(committed.metadata.navigation).toEqual({
      view: "graph",
      familySessionId: "native-child",
      target: {
        kind: "message",
        preferred: { sessionId: "native-child", messageId: "native-child-source" },
        aliases: [{ sessionId: "native-child", messageId: "native-child-source" }],
      },
    })
    expect((await run(second.loadMetadata)).navigation).toEqual({
      view: "roots",
      selectedSessionId: "persisted-source",
    })
    expect(committed.adoption.relation).toEqual(forkRelation)
  })

  test("persists temporary adoption followed by repeated native-fork relations and navigation", async () => {
    const { project, state } = await fixture()
    const repository = await openProviderState(project, state)
    await run(repository.updateMetadata(() => ({
      relations: [],
      removals: [],
      navigation: {
        view: "graph",
        familySessionId: "temporary",
        target: {
          kind: "message",
          preferred: { sessionId: "temporary", messageId: "source" },
          aliases: [{ sessionId: "temporary", messageId: "source" }],
        },
      },
    })))
    let owner = await run(repository.attach(
      await run(repository.reserve("temporary")),
      707,
    ))

    const adopted = await run(repository.commitIdentity({
      owner,
      sessionId: "real",
      kind: "temporary-adoption",
      mutationToken: "adopt-real",
    }))
    await run(repository.ack(adopted.adoption.adoptionToken))
    owner = adopted.owner

    const firstRelation = relation("fork-one", "real")
    const firstFork = await run(repository.commitIdentity({
      owner,
      sessionId: "fork-one",
      kind: "native-fork",
      relation: firstRelation,
      mutationToken: "fork-one",
    }))
    await run(repository.ack(firstFork.adoption.adoptionToken))
    owner = firstFork.owner

    const secondRelation = {
      childSessionId: "fork-two",
      parentSessionId: "fork-one",
      sourceMessageId: "fork-one-source",
      sharedMessages: [{
        parentMessageId: "fork-one-source",
        childMessageId: "fork-two-source",
      }],
      createdAt: timestamp(0),
    }
    const secondFork = await run(repository.commitIdentity({
      owner,
      sessionId: "fork-two",
      kind: "native-fork",
      relation: secondRelation,
      mutationToken: "fork-two",
    }))
    await run(repository.ack(secondFork.adoption.adoptionToken))

    const persisted = await run(repository.load)
    expect(persisted.relations).toEqual([firstRelation, secondRelation])
    expect(persisted.navigations).toEqual([{
      instanceId: repository.instanceId,
      navigation: {
        view: "graph",
        familySessionId: "fork-two",
        target: {
          kind: "message",
          preferred: { sessionId: "fork-two", messageId: "fork-two-source" },
          aliases: [{ sessionId: "fork-two", messageId: "fork-two-source" }],
        },
      },
    }])
    expect(persisted.terminalOwners).toEqual([secondFork.owner])
    expect(persisted.pendingIdentityAdoptions).toEqual([])
  })

  test("exposes and reconciles an orphan only after its PID and group are absent", async () => {
    const { project, state } = await fixture()
    const origin = await openProviderState(
      project,
      state,
      platformWithPid(101, "origin"),
    )
    const reserved = await run(origin.reserve("temporary"))
    const running = await run(origin.attach(reserved, 606))
    const committed = await run(origin.commitIdentity({
      owner: running,
      sessionId: "provider-id",
      kind: "temporary-adoption",
      mutationToken: "orphaned-adoption",
    }))

    const liveGroup = await openProviderState(
      project,
      state,
      platformWithPid(202, "recovery", () => "absent", () => "alive"),
    )
    expect(await run(liveGroup.orphanedAdoptions)).toEqual([])
    expect(
      await rejected(liveGroup.reconcileOrphanedAdoption(committed.adoption.adoptionToken)),
    ).toBeInstanceOf(PersistenceError)

    const absent = await openProviderState(
      project,
      state,
      platformWithPid(202, "recovery", () => "absent", () => "absent"),
    )
    expect(await run(absent.orphanedAdoptions)).toEqual([committed.adoption])
    await run(absent.reconcileOrphanedAdoption(committed.adoption.adoptionToken))
    const reclaimed = await run(absent.reserve("provider-id"))
    expect(reclaimed.instanceId).toBe("recovery")
  })

  test("reconciles ambiguous owner writes with caller-stable mutation tokens", async () => {
    const { project, state } = await fixture()
    let failNextStateDirectorySync = false
    let stateRenamed = false
    const platform = testPlatform({
      instanceId: "ambiguous-writes",
      rename: async (oldPath, newPath) => {
        await nativePersistencePlatform.rename(oldPath, newPath)
        if (newPath.endsWith("state.json")) stateRenamed = true
      },
      open: async (path, flags, mode) => {
        const handle = await nativePersistencePlatform.open(path, flags, mode)
        return flags === "r" && path.endsWith("test-provider")
          ? {
              ...handle,
              sync: async () => {
                await handle.sync()
                if (failNextStateDirectorySync && stateRenamed) {
                  failNextStateDirectorySync = false
                  stateRenamed = false
                  throw Object.assign(new Error("injected post-commit failure"), { code: "EIO" })
                }
              },
            }
          : handle
      },
    })
    const repository = await openProviderState(project, state, platform)

    stateRenamed = false
    failNextStateDirectorySync = true
    const reserved = await run(repository.reserve("temporary", { mutationToken: "reserve" }))
    expect(reserved.lastMutationToken).toBe("reserve")

    failNextStateDirectorySync = true
    const running = await run(repository.attach(reserved, 707, { mutationToken: "attach" }))
    expect(running.lastMutationToken).toBe("attach")

    failNextStateDirectorySync = true
    const stopping = await run(repository.mark(running, "stopping", {
      processGroupId: 707,
      mutationToken: "mark",
    }))
    expect(stopping.lastMutationToken).toBe("mark")

    failNextStateDirectorySync = true
    const committed = await run(repository.commitIdentity({
      owner: stopping,
      sessionId: "provider-id",
      kind: "temporary-adoption",
      mutationToken: "identity",
    }))
    expect(committed.owner.lastMutationToken).toBe("identity")

    stateRenamed = false
    failNextStateDirectorySync = true
    await run(repository.ack(committed.adoption.adoptionToken))

    stateRenamed = false
    failNextStateDirectorySync = true
    await run(repository.release(committed.owner, { mutationToken: "release" }))
    expect((await run(repository.load)).terminalOwners).toEqual([])
  })

  test("atomically rejects and idempotently commits removals", async () => {
    const { project, state } = await fixture()
    const ownerRepository = await openProviderState(
      project,
      state,
      platformWithPid(101, "owner"),
    )
    const contender = await openProviderState(
      project,
      state,
      platformWithPid(202, "contender"),
    )
    const removal = treeRemoval("root", ["root", "child"], 1)
    await run(ownerRepository.reserve("child"))

    const errors = await Promise.all([
      rejected(ownerRepository.commitRemoval(removal, ["root", "child"], "remove-a")),
      rejected(contender.commitRemoval(removal, ["root", "child"], "remove-b")),
    ])
    for (const error of errors) {
      expect(error).toBeInstanceOf(SessionOwnedError)
      expect(error).toMatchObject({ sessionId: "child", ownerPid: 101 })
    }
    expect((await run(contender.load)).removals).toEqual([])

    const owner = (await run(ownerRepository.load)).terminalOwners[0]!
    await run(ownerRepository.release(owner))
    const committed = await run(contender.commitRemoval(removal, ["root", "child"], "remove-c"))
    const retried = await run(ownerRepository.commitRemoval(
      treeRemoval("root", ["child", "root"], 2),
      ["child", "root"],
      "remove-d",
    ))
    expect(retried).toEqual(committed)
    expect((await run(contender.load)).removals).toEqual([committed])
  })

  for (const kind of ["tree", "subtree"] as const) {
    test(`rejects reserve after a concurrent ${kind} removal commits`, async () => {
      const { project, state } = await fixture()
      const barrier = stateWriteBarrier({ pid: 101, instanceId: "remover" })
      const remover = await openProviderState(project, state, barrier.platform)
      const contender = await openProviderState(
        project,
        state,
        platformWithPid(202, "contender"),
      )
      await run(remover.updateMetadata((metadata) => ({
        ...metadata,
        relations: [relation("child", "root")],
      })))
      const removal = removalAtRoot(kind)
      barrier.blockNextStateWrite()

      const removing = run(remover.commitRemoval(removal, ["root"], `remove-${kind}`))
      await barrier.entered.promise
      const reserving = rejected(contender.reserve("child"))
      barrier.release.resolve()

      await removing
      expect(await reserving).toBeInstanceOf(SessionRemovedError)
      expect((await run(contender.load)).terminalOwners).toEqual([])
    })

    test(`rejects a concurrent ${kind} removal after reserve commits`, async () => {
      const { project, state } = await fixture()
      const barrier = stateWriteBarrier({ pid: 101, instanceId: "owner" })
      const ownerRepository = await openProviderState(project, state, barrier.platform)
      const remover = await openProviderState(
        project,
        state,
        platformWithPid(202, "remover"),
      )
      await run(ownerRepository.updateMetadata((metadata) => ({
        ...metadata,
        relations: [relation("child", "root")],
      })))
      const removal = removalAtRoot(kind)
      barrier.blockNextStateWrite()

      const reserving = run(ownerRepository.reserve("child"))
      await barrier.entered.promise
      const removing = rejected(remover.commitRemoval(removal, ["root"], `remove-${kind}`))
      barrier.release.resolve()

      const owner = await reserving
      expect(await removing).toMatchObject({
        _tag: "SessionOwnedError",
        sessionId: "child",
        ownerPid: 101,
      })
      expect((await run(remover.load)).terminalOwners).toEqual([owner])
      expect((await run(remover.load)).removals).toEqual([])
    })

    test(`detects a native transition that commits before a concurrent ${kind} removal`, async () => {
      const { project, state } = await fixture()
      const barrier = stateWriteBarrier({ pid: 101, instanceId: "owner" })
      const ownerRepository = await openProviderState(project, state, barrier.platform)
      const remover = await openProviderState(
        project,
        state,
        platformWithPid(202, "remover"),
      )
      const reserved = await run(ownerRepository.reserve("root"))
      const running = await run(ownerRepository.attach(reserved, 303))
      const removal = removalAtRoot(kind)
      barrier.blockNextStateWrite()

      const transitioning = run(ownerRepository.commitIdentity({
        owner: running,
        sessionId: "child",
        kind: "native-fork",
        relation: relation("child", "root"),
        mutationToken: `transition-${kind}`,
      }))
      await barrier.entered.promise
      const removing = rejected(remover.commitRemoval(removal, ["root"], `remove-${kind}`))
      barrier.release.resolve()

      const committed = await transitioning
      expect(await removing).toMatchObject({
        _tag: "SessionOwnedError",
        sessionId: "child",
        ownerPid: 101,
      })
      expect((await run(remover.load)).terminalOwners).toEqual([committed.owner])
      expect((await run(remover.load)).removals).toEqual([])
    })

    test(`rejects a native transition after a concurrent ${kind} removal commits`, async () => {
      const { project, state } = await fixture()
      const barrier = stateWriteBarrier({ pid: 202, instanceId: "remover" })
      const remover = await openProviderState(project, state, barrier.platform)
      const ownerRepository = await openProviderState(
        project,
        state,
        platformWithPid(101, "owner"),
      )
      const reserved = await run(ownerRepository.reserve("source"))
      const running = await run(ownerRepository.attach(reserved, 303))
      const removal = removalAtDestination(kind)
      barrier.blockNextStateWrite()

      const removing = run(remover.commitRemoval(removal, ["child"], `remove-${kind}`))
      await barrier.entered.promise
      const transitioning = rejected(ownerRepository.commitIdentity({
        owner: running,
        sessionId: "child",
        kind: "native-fork",
        relation: relation("child", "source"),
        mutationToken: `transition-${kind}`,
      }))
      barrier.release.resolve()

      await removing
      expect(await transitioning).toBeInstanceOf(SessionRemovedError)
      expect((await run(remover.load)).terminalOwners.map((owner) => owner.sessionId)).toEqual([
        "source",
      ])
    })
  }

  test("derives removal ownership through a pending transition without a relation", async () => {
    const { project, state } = await fixture()
    const repository = await openProviderState(project, state)
    const reserved = await run(repository.reserve("source"))
    const running = await run(repository.attach(reserved, 303))
    const committed = await run(repository.commitIdentity({
      owner: running,
      sessionId: "child",
      kind: "native-fork",
      mutationToken: "transition-without-relation",
    }))
    const removal = {
      kind: "subtree" as const,
      target: {
        kind: "endpoint" as const,
        sessionId: "source",
        afterMessageId: null,
      },
      createdAt: timestamp(12),
    }

    expect(await rejected(repository.commitRemoval(
      removal,
      ["source"],
      "remove-after-transition",
    ))).toMatchObject({
      _tag: "SessionOwnedError",
      sessionId: "child",
    })
    expect((await run(repository.load)).terminalOwners).toEqual([committed.owner])
    expect((await run(repository.load)).removals).toEqual([])
  })

  test("recovers an ambiguous removal commit by semantic state on retry", async () => {
    const { project, state } = await fixture()
    let failCommit = false
    let failReconciliationRead = false
    let stateRenamed = false
    const platform = testPlatform({
      instanceId: "removal-retry",
      rename: async (oldPath, newPath) => {
        await nativePersistencePlatform.rename(oldPath, newPath)
        if (failCommit && newPath.endsWith("state.json")) stateRenamed = true
      },
      readFile: async (path) => {
        if (failReconciliationRead && path.endsWith("state.json")) {
          failReconciliationRead = false
          throw Object.assign(new Error("injected reconciliation read failure"), { code: "EIO" })
        }
        return await nativePersistencePlatform.readFile(path)
      },
      open: async (path, flags, mode) => {
        const handle = await nativePersistencePlatform.open(path, flags, mode)
        return flags === "r" && path.endsWith("test-provider")
          ? {
              ...handle,
              sync: async () => {
                await handle.sync()
                if (failCommit && stateRenamed) {
                  failCommit = false
                  stateRenamed = false
                  failReconciliationRead = true
                  throw Object.assign(new Error("injected post-commit failure"), { code: "EIO" })
                }
              },
            }
          : handle
      },
    })
    const repository = await openProviderState(project, state, platform)
    const removal = treeRemoval("root", ["root"], 1)
    failCommit = true

    expect(await rejected(repository.commitRemoval(
      removal,
      ["root"],
      "stable-removal",
    ))).toBeInstanceOf(PersistenceError)
    const recovered = await run(repository.commitRemoval(
      removal,
      ["root"],
      "stable-removal",
    ))
    expect(recovered).toEqual(removal)
    expect((await run(repository.load)).removals).toEqual([removal])
  })

  test("rewrites mapped native message navigation but preserves temporary message IDs", () => {
    const sourceRelation = relation("source", "root")
    const state: ProjectState = {
      relations: [sourceRelation],
      removals: [{
        kind: "subtree",
        target: { kind: "endpoint", sessionId: "source", afterMessageId: null },
        createdAt: timestamp(1),
      }],
      navigation: {
        view: "graph",
        familySessionId: "source",
        target: {
          kind: "message",
          preferred: { sessionId: "source", messageId: "source" },
          aliases: [{ sessionId: "source", messageId: "source" }],
        },
      },
    }
    const nativeRelation = relation("child", "source")

    const native = replaceSessionIdInProjectState(state, "source", "child", {
      kind: "native-fork",
      relation: nativeRelation,
    })
    expect(native.relations).toEqual(state.relations)
    expect(native.removals).toEqual(state.removals)
    expect(native.navigation).toMatchObject({
      familySessionId: "child",
      target: {
        preferred: { sessionId: "child", messageId: "child-source" },
        aliases: [{ sessionId: "child", messageId: "child-source" }],
      },
    })

    const temporary = replaceSessionIdInProjectState(state, "source", "child", {
      kind: "temporary-adoption",
      relation: nativeRelation,
    })
    expect(temporary.navigation).toMatchObject({
      target: {
        preferred: { sessionId: "child", messageId: "source" },
        aliases: [{ sessionId: "child", messageId: "source" }],
      },
    })
  })

  test("rejects a native-fork relation without a usable shared prefix", async () => {
    const { project, state } = await fixture()
    const repository = await openProviderState(project, state)
    const reserved = await run(repository.reserve("source"))
    const running = await run(repository.attach(reserved, 808))

    const error = await rejected(repository.commitIdentity({
      owner: running,
      sessionId: "child",
      kind: "native-fork",
      relation: { ...relation("child", "source"), sharedMessages: [] },
      mutationToken: "empty-native-prefix",
    }))
    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).message).toContain("must contain shared message mappings")
    expect((await run(repository.load)).relations).toEqual([])
  })

  test("rejects a journal whose relation does not match provider metadata", async () => {
    const { project, state } = await fixture()
    const repository = await openProviderState(project, state)
    const reserved = await run(repository.reserve("source"))
    const running = await run(repository.attach(reserved, 808))
    await run(repository.commitIdentity({
      owner: running,
      sessionId: "child",
      kind: "native-fork",
      relation: relation("child", "source"),
      mutationToken: "corrupt-journal",
    }))
    const persisted = JSON.parse(await readFile(repository.statePath, "utf8"))
    persisted.pendingIdentityAdoptions[0].relation.sharedMessages[0].childMessageId = "different"
    await writeFile(repository.statePath, `${JSON.stringify(persisted, null, 2)}\n`)

    const error = await rejected(repository.load)
    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).message).toContain("does not match")
  })

})

function relation(childSessionId: string, parentSessionId: string) {
  return {
    childSessionId,
    parentSessionId,
    sourceMessageId: "source",
    sharedMessages: [{ parentMessageId: "source", childMessageId: `${childSessionId}-source` }],
    createdAt: timestamp(0),
  }
}

function treeRemoval(rootSessionId: string, memberSessionIds: readonly string[], offset: number) {
  return {
    kind: "tree" as const,
    rootSessionId,
    memberSessionIds,
    createdAt: timestamp(offset),
  }
}

function removalAtRoot(kind: "tree" | "subtree") {
  return kind === "tree"
    ? treeRemoval("root", ["root"], 10)
    : {
        kind: "subtree" as const,
        target: {
          kind: "message" as const,
          aliases: [{ sessionId: "root", messageId: "source" }],
        },
        createdAt: timestamp(10),
      }
}

function removalAtDestination(kind: "tree" | "subtree") {
  return kind === "tree"
    ? treeRemoval("removed-root", ["removed-root", "child"], 11)
    : {
        kind: "subtree" as const,
        target: {
          kind: "message" as const,
          aliases: [{ sessionId: "child", messageId: "child-source" }],
        },
        createdAt: timestamp(11),
      }
}

function timestamp(offset: number): string {
  return new Date(Date.UTC(2026, 7, 30, 12, offset)).toISOString()
}

async function fixture(): Promise<{ project: string; state: string }> {
  const root = await mkdtemp(join(tmpdir(), "claude-tree-v3-provider-state-"))
  temporaryDirectories.push(root)
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  return { project, state }
}

function platformWithPid(
  pid: number,
  instanceId: string,
  processLiveness: (pid: number) => ProcessLiveness = (candidate) =>
    candidate === pid ? "alive" : "absent",
  processGroupLiveness: (processGroupId: number) => ProcessLiveness = () => "absent",
): PersistencePlatformApi {
  return testPlatform({
    pid,
    instanceId,
    processLiveness: async (candidate) => processLiveness(candidate),
    processGroupLiveness: async (processGroupId) => processGroupLiveness(processGroupId),
  })
}

function testPlatform(overrides: Partial<PersistencePlatformApi>): PersistencePlatformApi {
  return { ...nativePersistencePlatform, ...overrides }
}

function stateWriteBarrier(overrides: Partial<PersistencePlatformApi>): {
  readonly platform: PersistencePlatformApi
  readonly entered: ReturnType<typeof deferred>
  readonly release: ReturnType<typeof deferred>
  readonly blockNextStateWrite: () => void
} {
  const entered = deferred()
  const release = deferred()
  let blockNext = false
  const platform = testPlatform({
    ...overrides,
    rename: async (oldPath, newPath) => {
      if (blockNext && newPath.endsWith("state.json")) {
        blockNext = false
        entered.resolve()
        await release.promise
      }
      await nativePersistencePlatform.rename(oldPath, newPath)
    },
  })
  return {
    platform,
    entered,
    release,
    blockNextStateWrite: () => {
      blockNext = true
    },
  }
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

function openProviderState(
  project: string,
  state: string,
  platform: PersistencePlatformApi = nativePersistencePlatform,
): Promise<ProviderStateRepositoryApi> {
  return run(makeProviderStateRepository({
    projectDirectory: project,
    providerId: "test-provider",
    stateHome: state,
    instanceId: platform.instanceId,
  }).pipe(Effect.provideService(PersistencePlatform, platform)))
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

async function outcome<A>(effect: Effect.Effect<A, unknown>): Promise<
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: unknown }
> {
  try {
    return { ok: true, value: await Effect.runPromise(effect) }
  } catch (error) {
    return { ok: false, error }
  }
}
