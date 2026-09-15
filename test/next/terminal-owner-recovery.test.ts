import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { PersistenceError, SessionOwnedError } from "../../src/domain/errors"
import type { TerminalOwner } from "../../src/domain/persistence"
import { nativePersistencePlatform, PersistencePlatform, type PersistencePlatformApi, type ProcessLiveness } from "../../src/infrastructure/metadata/platform"
import { makeProviderStateRepository } from "../../src/services/provider-state-repository"
import { inspectOrphan } from "../../src/services/terminal-owner-recovery"
import { TerminalLaunchDirectory } from "../../src/services/provider"
import { makeCodexSidecar } from "../../src/infrastructure/providers/codex/sidecar"
import { runSubprocess } from "../subprocess"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

for (const status of ["running", "stopping", "cleanup-incomplete"] as const) {
  test(`recovers dead ${status} ownership without changing relationships or navigation`, async () => {
    const f = await fixture()
    const original = await f.open(101)
    const owner = await run(original.attach(await run(original.reserve("session")), 303, { resources: { kind: "local" } }))
    await run(original.mark(owner, status))
    await run(original.updateMetadata((metadata) => ({
      ...metadata,
      relations: [{
        parentSessionId: "parent", childSessionId: "session", sourceMessageId: "source",
        sharedMessages: [{ parentMessageId: "source", childMessageId: "copy" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    })))
    await run(original.saveNavigation({ view: "roots", selectedSessionId: "session" }))
    const before = await run(original.loadMetadata)
    f.application = "absent"
    const next = await f.open(process.pid)
    const replacement = await run(next.reserve("session"))
    expect(replacement.ownerToken).not.toBe(owner.ownerToken)
    expect(await run(original.loadMetadata)).toEqual(before)
    expect((await run(next.load)).terminalOwners).toEqual([replacement])
  })
}

test("a failed final ownership deletion recovers on a fresh invocation", async () => {
  const f = await fixture()
  let failRelease = false
  const original = await f.open(101, {
    rename: async (from, to) => {
      if (failRelease && to.endsWith("state.json")) throw new Error("injected state replacement failure")
      await nativePersistencePlatform.rename(from, to)
    },
  })
  const owner = await run(original.attach(await run(original.reserve("session")), 303, { resources: { kind: "local" } }))
  const stopping = await run(original.mark(owner, "stopping"))
  failRelease = true
  expect(await run(Effect.flip(original.release(stopping)))).toBeInstanceOf(PersistenceError)
  f.application = "absent"
  const next = await f.open(process.pid)
  expect(await run(next.recoverOrphanedOwners())).toEqual([{ sessionId: "session", ownerToken: owner.ownerToken }])
  expect((await run(next.load)).terminalOwners).toEqual([])
  await run(next.reserve("session"))
})

test("native liveness recovers a real PTY owner killed after process cleanup", async () => {
  const f = await fixture()
  const modulePath = (path: string) => JSON.stringify(new URL(`../../src/${path}`, import.meta.url).pathname)
  const script = `
    import { Effect } from "effect";
    import { mkdir, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import { NullTerminalObserver } from ${modulePath("domain/model.ts")};
    import { makeProviderStateRepository } from ${modulePath("services/provider-state-repository.ts")};
    import { PersistencePlatform, nativePersistencePlatform } from ${modulePath("infrastructure/metadata/platform.ts")};
    import { BunPtyProcessFactory } from ${modulePath("infrastructure/terminal/bun-pty-process.ts")};
    const run = Effect.runPromise;
    const repository = await run(makeProviderStateRepository({
      projectDirectory: ${JSON.stringify(f.project)}, stateHome: ${JSON.stringify(f.stateHome)}, providerId: "test-provider"
    }).pipe(Effect.provideService(PersistencePlatform, nativePersistencePlatform)));
    const reserved = await run(repository.reserve("real-session"));
    const terminal = new BunPtyProcessFactory().spawn({
      sessionId: "real-session", command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: ${JSON.stringify(f.project)}, observer: new NullTerminalObserver(),
    }, { columns: 80, rows: 24 }, { onOutput() {}, onPtyClosed() {} });
    try {
      const attached = await run(repository.attach(reserved, terminal.processGroupId, { resources: { kind: "local" } }));
      await run(repository.mark(attached, "stopping"));
      const directory = repository.launchDirectory(attached);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "token"), "orphan-artifact");
    } finally {
      terminal.signalGroup("SIGKILL");
      await terminal.exited;
      if (!await run(terminal.waitForGroupExit(500))) throw new Error("test PTY group survived");
      terminal.closePty();
      terminal.unref();
    }
    process.kill(process.pid, "SIGKILL");
  `
  const [code, , stderr] = await runSubprocess([process.execPath, "--eval", script])
  expect(code).not.toBe(0)
  expect(stderr).toBe("")
  const next = await f.open(process.pid, {
    processLiveness: nativePersistencePlatform.processLiveness,
    processGroupLiveness: nativePersistencePlatform.processGroupLiveness,
  })
  const orphan = (await run(next.load)).terminalOwners[0]!
  expect(orphan.status).toBe("stopping")
  const directory = next.launchDirectory(orphan)
  expect(await exists(directory)).toBeTrue()
  const replacement = await run(next.reserve("real-session"))
  expect(replacement.ownerToken).not.toBe(orphan.ownerToken)
  expect(await exists(directory)).toBeFalse()
})

test("preserves the reservation until both terminal and Codex sidecar are absent", async () => {
  const f = await fixture()
  const original = await f.open(101)
  const owner = await run(original.attach(await run(original.reserve("session")), 303, {
    resources: { kind: "codex", sidecarProcessGroupId: 404 },
  }))
  const directory = original.launchDirectory(owner)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "token"), "private-test-capability")
  f.application = "absent"
  const next = await f.open(process.pid)
  for (const liveness of ["alive", "unknown"] as const) {
    f.groups.set(404, liveness)
    const error = await run(Effect.flip(next.reserve("session")))
    expect(error).toBeInstanceOf(SessionOwnedError)
    expect(error.message).toContain(liveness === "alive" ? "sidecar" : "could not be verified")
    expect(await readFile(join(directory, "token"), "utf8")).toBe("private-test-capability")
  }
  f.groups.set(404, "absent")
  await run(next.reserve("session"))
  expect(await exists(directory)).toBeFalse()
})

test("incomplete acquisition is never inferred clean from a missing application or terminal", async () => {
  const f = await fixture()
  const original = await f.open(101)
  const owner = await run(original.attach(await run(original.reserve("session")), 303))
  const directory = original.launchDirectory(owner)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "token"), "possibly-in-use")
  f.application = "absent"
  const next = await f.open(process.pid)
  const error = await run(Effect.flip(next.reserve("session")))
  expect(error).toMatchObject({ reason: "acquisition-incomplete" })
  expect(await exists(directory)).toBeTrue()
  expect((await run(next.load)).terminalOwners).toEqual([owner])
})

test("Codex acquires its capability file in the reserved owner directory and reports its group", async () => {
  const f = await fixture()
  const repository = await f.open(101)
  const owner = await run(repository.reserve("pending-codex"))
  const directory = repository.launchDirectory(owner)
  let exitCode: number | null = null
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((resolve) => { resolveExit = resolve })
  await run(Effect.scoped(Effect.gen(function*() {
    const sidecar = yield* makeCodexSidecar("codex", {
      allocatePort: async () => 12345,
      randomUUID: () => "test-capability",
      spawn: (command) => {
        expect(command).toContain(join(directory, "token"))
        return {
          pid: 404, get exitCode() { return exitCode }, exited,
          stderr: new ReadableStream({ start: (controller) => controller.close() }),
          kill() {}, unref() {},
        }
      },
      signalProcessGroup: () => { exitCode = 0; resolveExit(0) },
    })
    expect(sidecar.resources).toEqual({ kind: "codex", sidecarProcessGroupId: 404 })
    expect(yield* Effect.promise(() => readFile(join(directory, "token"), "utf8"))).toBe("testcapability")
    const saved = yield* repository.attach(owner, 303, { resources: sidecar.resources! })
    expect(saved.resources).toEqual(sidecar.resources!)
    yield* sidecar.close()
  })).pipe(Effect.provideService(TerminalLaunchDirectory, directory)))
  expect(await exists(directory)).toBeFalse()
})

test("recorded process identities cannot be replaced by a later ownership mutation", async () => {
  const f = await fixture()
  const repository = await f.open(101)
  const owner = await run(repository.attach(await run(repository.reserve("session")), 303, {
    resources: { kind: "codex", sidecarProcessGroupId: 404 },
  }))
  const before = await readFile(repository.statePath, "utf8")
  expect(await run(Effect.flip(repository.attach(owner, 505)))).toBeInstanceOf(PersistenceError)
  expect(await run(Effect.flip(repository.mark(owner, "stopping", {
    resources: { kind: "local" },
  })))).toBeInstanceOf(PersistenceError)
  expect(await readFile(repository.statePath, "utf8")).toBe(before)
})

test("artifact failure retains ownership and a later retry finishes cleanup", async () => {
  const f = await fixture()
  const original = await f.open(101)
  const owner = await run(original.attach(await run(original.reserve("session")), 303, { resources: { kind: "local" } }))
  let fail = true
  const next = await f.open(process.pid, {
    remove: async (path, options) => {
      if (fail && path === original.launchDirectory(owner)) throw new Error("injected artifact failure")
      await nativePersistencePlatform.remove(path, options)
    },
  })
  f.application = "absent"
  expect(await run(Effect.flip(next.reserve("session")))).toMatchObject({ reason: "artifact-cleanup-failed" })
  expect((await run(next.load)).terminalOwners).toEqual([owner])
  fail = false
  await run(next.reserve("session"))
})

test("orphan recovery settles adoption forward-only, preserving its owner-derived directory", async () => {
  const f = await fixture()
  const original = await f.open(101)
  const owner = await run(original.attach(await run(original.reserve("temporary")), 303, { resources: { kind: "local" } }))
  await run(original.saveNavigation({ view: "terminal", sessionId: "temporary" }))
  const committed = await run(original.commitIdentity({ owner, sessionId: "actual", kind: "temporary-adoption" }))
  await run(original.mark(committed.owner, "cleanup-incomplete"))
  expect(original.launchDirectory(committed.owner)).toBe(original.launchDirectory(owner))
  const before = await run(original.load)
  f.application = "absent"
  const next = await f.open(process.pid)
  await run(next.recoverOrphanedOwners())
  const after = await run(next.load)
  expect(after.pendingIdentityAdoptions).toEqual([])
  expect(after.terminalOwners).toEqual([])
  expect(after.navigations).toEqual(before.navigations)
  expect(after.navigations[0]?.navigation).toEqual({ view: "terminal", sessionId: "actual" })
  expect(after.relations).toEqual(before.relations)
})

test("simultaneous recovery admits only one replacement owner", async () => {
  const f = await fixture()
  const original = await f.open(101)
  await run(original.attach(await run(original.reserve("session")), 303, { resources: { kind: "local" } }))
  f.application = "absent"
  const first = await f.open(process.pid)
  const second = await f.open(process.pid)
  const outcomes = await Promise.allSettled([run(first.reserve("session")), run(second.reserve("session"))])
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
  const failed = outcomes.find((outcome) => outcome.status === "rejected")
  expect(failed?.status === "rejected" && failed.reason).toBeInstanceOf(SessionOwnedError)
  expect((await run(first.load)).terminalOwners).toHaveLength(1)
})

test("a stale owner does not permanently block navigator removal", async () => {
  const f = await fixture()
  const original = await f.open(101)
  const owner = await run(original.attach(await run(original.reserve("session")), 303, { resources: { kind: "local" } }))
  await run(original.mark(owner, "stopping"))
  f.application = "absent"
  const next = await f.open(process.pid)
  const removal = {
    kind: "tree" as const, rootSessionId: "session", memberSessionIds: ["session"],
    createdAt: "2026-01-01T00:00:00.000Z",
  }
  await run(next.commitRemoval(removal, ["session"]))
  const state = await run(next.load)
  expect(state.terminalOwners).toEqual([])
  expect(state.removals).toEqual([removal])
})

test("live and PID-reused applications retain ownership before any artifact cleanup", async () => {
  const f = await fixture()
  const original = await f.open(101)
  const owner = await run(original.attach(await run(original.reserve("session")), 303, { resources: { kind: "local" } }))
  const next = await f.open(process.pid, {
    remove: async (path, options) => {
      expect(path).not.toBe(original.launchDirectory(owner))
      await nativePersistencePlatform.remove(path, options)
    },
  })
  expect(await run(Effect.flip(next.reserve("session")))).toMatchObject({ reason: "application-present" })
  expect((await run(next.load)).terminalOwners).toEqual([owner])
})

test("revalidates the exact owner after artifact cleanup without holding the transaction lock", async () => {
  const f = await fixture()
  const original = await f.open(101)
  const owner = await run(original.attach(await run(original.reserve("session")), 303, { resources: { kind: "local" } }))
  f.application = "absent"
  const next = await f.open(process.pid, {
    remove: async (path, options) => {
      if (path === original.launchDirectory(owner)) {
        // This transaction can finish only if artifact cleanup holds no state lock.
        await run(original.mark(owner, "stopping"))
      }
      await nativePersistencePlatform.remove(path, options)
    },
  })
  expect(await run(next.recoverOrphanedOwners())).toEqual([
    { sessionId: "session", ownerToken: owner.ownerToken, reason: "owner-changed" },
  ])
  expect((await run(next.load)).terminalOwners).toHaveLength(1)
})

test("a crash after artifact deletion but before the recovery write is retryable", async () => {
  const f = await fixture()
  const original = await f.open(101)
  const owner = await run(original.attach(await run(original.reserve("session")), 303, { resources: { kind: "local" } }))
  const directory = original.launchDirectory(owner)
  await mkdir(directory, { recursive: true })
  f.application = "absent"
  let fail = false
  const interrupted = await f.open(process.pid, {
    rename: async (from, to) => {
      if (fail && to.endsWith("state.json")) throw new Error("recovery interrupted")
      await nativePersistencePlatform.rename(from, to)
    },
  })
  fail = true
  expect(await run(Effect.flip(interrupted.recoverOrphanedOwners()))).toBeInstanceOf(PersistenceError)
  expect(await exists(directory)).toBeFalse()
  expect((await run(original.load)).terminalOwners).toEqual([owner])
  const next = await f.open(process.pid)
  await run(next.reserve("session"))
})

test("rejects resource-less saved owners in place instead of assuming they are local", async () => {
  const f = await fixture()
  const original = await f.open(101)
  await run(original.reserve("session"))
  const document = JSON.parse(await readFile(original.statePath, "utf8"))
  delete document.terminalOwners[0].resources
  const bytes = JSON.stringify(document)
  await writeFile(original.statePath, bytes)
  await expect(f.open(process.pid)).rejects.toBeInstanceOf(PersistenceError)
  expect(await readFile(original.statePath, "utf8")).toBe(bytes)
})

test("a stalled liveness probe is unknown, never evidence of absence", async () => {
  const owner: TerminalOwner = {
    instanceId: "gone", ownerToken: "owner", sessionId: "session", ownerPid: 101,
    resources: { kind: "local" }, processGroupId: 303, status: "stopping",
    reservedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }
  await run(Effect.gen(function*() {
    const started = Deferred.makeUnsafe<void>()
    const fiber = yield* Effect.forkChild(inspectOrphan({
      ...nativePersistencePlatform,
      processLiveness: () => {
        Deferred.doneUnsafe(started, Effect.void)
        return new Promise(() => {})
      },
    }, owner).pipe(Effect.uninterruptible))
    yield* Deferred.await(started)
    yield* TestClock.adjust(250)
    expect(yield* Fiber.join(fiber)).toBe("liveness-unknown")
  }).pipe(Effect.provide(TestClock.layer())))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-tree-owner-recovery-"))
  directories.push(root)
  const project = join(root, "project")
  await mkdir(project)
  const fixture = {
    project,
    stateHome: join(root, "state"),
    application: "alive" as ProcessLiveness,
    groups: new Map<number, ProcessLiveness>(),
    open: (pid: number, overrides: Partial<PersistencePlatformApi> = {}) => run(makeProviderStateRepository({
      projectDirectory: project, providerId: "test-provider", stateHome: join(root, "state"), instanceId: crypto.randomUUID(),
    }).pipe(Effect.provideService(PersistencePlatform, {
      ...nativePersistencePlatform, pid,
      processLiveness: async (candidate) => candidate === 101 ? fixture.application : "alive",
      processGroupLiveness: async (group) => fixture.groups.get(group) ?? "absent",
      ...overrides,
    }))),
  }
  return fixture
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, (error) => {
    if (error.code === "ENOENT") return false
    throw error
  })
}

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect)
}
