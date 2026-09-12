import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"

import { Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { makeNavigationPersistenceWorker, NAVIGATION_WORKER_CLOSE_TIMEOUT_MS } from "../../src/infrastructure/metadata/navigation-persistence"
import type { NavigationWorkerRequest } from "../../src/infrastructure/metadata/navigation-protocol"
import { nativePersistencePlatform, PersistencePlatform } from "../../src/infrastructure/metadata/platform"
import { makeProviderStateRepository } from "../../src/services/provider-state-repository"

test("navigation worker preserves shared metadata, terminal owners, and other instances' cursors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-tree-navigation-worker-"))
  const projectDirectory = join(directory, "project")
  await mkdir(projectDirectory)
  const options = { projectDirectory, stateHome: join(directory, "state"), providerId: "claude", instanceId: "foreground" }
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const repository = yield* makeProviderStateRepository(options)
      const other = yield* makeProviderStateRepository({ ...options, instanceId: "other" })
      const otherNavigation = { view: "roots" as const, selectedSessionId: "other-root" }
      yield* other.saveNavigation(otherNavigation)
      const relation = { parentSessionId: "parent", childSessionId: "child", sourceMessageId: "message",
        sharedMessages: [{ parentMessageId: "message", childMessageId: "copy" }], createdAt: "2026-09-11T00:00:00.000Z" }
      yield* repository.updateMetadata((state) => ({ ...state, relations: [relation] }))
      const owner = yield* repository.reserve("live-session")
      const worker = yield* makeNavigationPersistenceWorker(options)
      const navigation = { view: "roots" as const, selectedSessionId: "parent" }
      yield* worker.saveNavigation(navigation)
      yield* worker.saveNavigation({ view: "roots", selectedSessionId: "child" })
      yield* worker.close
      yield* worker.close
      const saved = yield* repository.load
      expect(saved.relations).toEqual([relation])
      expect(saved.terminalOwners).toEqual([owner])
      expect((yield* repository.loadMetadata).navigation).toEqual({ view: "roots", selectedSessionId: "child" })
      expect((yield* other.loadMetadata).navigation).toEqual(otherNavigation)
      const closed = yield* Effect.flip(worker.saveNavigation(navigation))
      expect(closed.message).toContain("closing")
      yield* repository.release(owner)
    }).pipe(Effect.provideService(PersistencePlatform, nativePersistencePlatform))))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("typed navigation saves reconcile a durable write whose acknowledgment failed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-tree-navigation-ack-"))
  const projectDirectory = join(directory, "project")
  await mkdir(projectDirectory)
  let rejectRename = false
  const platform = { ...nativePersistencePlatform, rename: async (from: string, to: string) => {
    await nativePersistencePlatform.rename(from, to)
    if (rejectRename) { rejectRename = false; throw new Error("lost write acknowledgment") }
  } }
  try {
    await Effect.runPromise(Effect.gen(function*() {
      const repository = yield* makeProviderStateRepository({ projectDirectory, stateHome: join(directory, "state"), providerId: "claude" })
      rejectRename = true
      yield* repository.saveNavigation({ view: "roots", selectedSessionId: "root" })
      expect((yield* repository.loadMetadata).navigation).toEqual({ view: "roots", selectedSessionId: "root" })
    }).pipe(Effect.provideService(PersistencePlatform, platform)))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.each(["incompatible", "missing"])("worker startup rejects %s state without replacing it", async (kind) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-tree-navigation-invalid-"))
  const projectDirectory = join(directory, "project")
  await mkdir(projectDirectory)
  const options = { projectDirectory, stateHome: join(directory, "state"), providerId: "claude", instanceId: "foreground" }
  try {
    const repository = await Effect.runPromise(makeProviderStateRepository(options).pipe(Effect.provideService(PersistencePlatform, nativePersistencePlatform)))
    const invalid = "{\"version\":1}"
    if (kind === "incompatible") await writeFile(repository.statePath, invalid)
    else await rm(repository.statePath)
    const error = await Effect.runPromise(Effect.scoped(Effect.flip(makeNavigationPersistenceWorker(options))))
    expect(error._tag).toBe("PersistenceError")
    if (kind === "incompatible") expect(await readFile(repository.statePath, "utf8")).toBe(invalid)
    else expect(await Bun.file(repository.statePath).exists()).toBeFalse()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

class ControlledWorker extends EventEmitter {
  readonly requests: NavigationWorkerRequest[] = []
  terminated = 0
  unreferenced = 0
  postMessage(message: NavigationWorkerRequest) { this.requests.push(message) }
  unref() { this.unreferenced++ }
  terminate() { this.terminated++; this.emit("exit", 1); return Promise.resolve(1) }
  create = (): Worker => {
    queueMicrotask(() => this.emit("message", { _tag: "Ready" }))
    return this as unknown as Worker
  }
}

test("worker exit settles in-flight requests and rejects further saves", async () => {
  const worker = new ControlledWorker()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const persistence = yield* makeNavigationPersistenceWorker({ projectDirectory: "/project", providerId: "claude", instanceId: "instance" }, worker.create)
    const save = yield* Effect.forkChild(Effect.exit(persistence.saveNavigation({ view: "roots", selectedSessionId: "root" })))
    yield* Effect.yieldNow
    worker.emit("error", new Error("worker crashed"))
    worker.emit("exit", 1)
    expect(Exit.isFailure(yield* Fiber.join(save))).toBeTrue()
    expect((yield* Effect.flip(persistence.saveNavigation({ view: "roots", selectedSessionId: "next" }))).message).toContain("worker crashed")
    yield* Effect.exit(persistence.close)
    expect(worker.requests.filter((request) => request._tag === "Save")).toHaveLength(1)
  })))
})

test("close never terminates a worker holding an unfinished transaction", async () => {
  const worker = new ControlledWorker()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const persistence = yield* makeNavigationPersistenceWorker({ projectDirectory: "/project", providerId: "claude", instanceId: "instance" }, worker.create)
    const save = yield* Effect.forkChild(persistence.saveNavigation({ view: "roots", selectedSessionId: "root" }))
    yield* Effect.yieldNow
    const closing = yield* Effect.forkChild(Effect.flip(persistence.close))
    yield* Effect.yieldNow
    yield* TestClock.adjust(NAVIGATION_WORKER_CLOSE_TIMEOUT_MS)
    expect((yield* Fiber.join(closing)).message).toContain("did not finish closing")
    expect(worker.terminated).toBe(0)
    expect(worker.unreferenced).toBe(1)
    const request = worker.requests.find((request) => request._tag === "Save")!
    worker.emit("message", { _tag: "Saved", id: request.id })
    worker.emit("message", { _tag: "Closed" })
    yield* Fiber.join(save)
    yield* persistence.close
    expect(worker.terminated).toBe(1)
  })).pipe(Effect.provide(TestClock.layer())))
})
