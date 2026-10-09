import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import { Deferred, Effect, Exit, Fiber, Queue } from "effect"
import { TestClock } from "effect/testing"

import { runMetadataWorker } from "../../src/infrastructure/metadata/worker-runtime"
import { makeMetadataWorker } from "../../src/infrastructure/metadata/worker-service"
import { PersistencePlatform, nativePersistencePlatform } from "../../src/infrastructure/metadata/platform"
import type { MetadataRequest, MetadataResponse } from "../../src/infrastructure/metadata/worker-protocol"
import type { ProviderStateRepositoryApi } from "../../src/services/provider-state-repository"
import { makeCloseOperation } from "../../src/services/close-operation"

const options = { projectDirectory: "/project", providerId: "claude", instanceId: "instance" }

test("metadata Close after Ready drains every admitted command before closing its repository", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const inbox = yield* Queue.unbounded<MetadataRequest>()
    const closeRequested = yield* Deferred.make<void>()
    const ready = yield* Deferred.make<void>()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const events: string[] = []
    const repository: ProviderStateRepositoryApi = {
      projectId: "project", scopeId: "scope", projectPath: "/project", statePath: "/state", instanceId: "instance",
      close: makeCloseOperation(Effect.sync(() => { events.push("close") })),
      saveNavigation: (navigation) => Effect.gen(function*() {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        if (navigation.view === "roots") events.push(navigation.selectedSessionId!)
      }),
      load: Effect.succeed({ relations: [], removals: [], navigations: [] }),
      loadMetadata: Effect.succeed({ relations: [], removals: [] }),
      saveRelation: (relation) => Effect.succeed(relation), removeExactRelation: () => Effect.void,
      updateMetadata: (transform) => Effect.sync(() => transform({ relations: [], removals: [] })),
      commitRemoval: (removal) => Effect.succeed(removal), replaceIdentity: () => Effect.void,
    }
    const acquire = Effect.addFinalizer(() => repository.close.pipe(Effect.orDie)).pipe(Effect.as(repository))
    const worker = yield* Effect.forkChild(runMetadataWorker(options, inbox, closeRequested, (response) => {
      if (response._tag === "Ready") Deferred.doneUnsafe(ready, Effect.void)
      if (response._tag === "Closed") events.push("closed")
    }, acquire))
    yield* Deferred.await(ready)
    for (const [index, selectedSessionId] of ["first", "second"].entries()) yield* Queue.offer(inbox, {
      _tag: "Command", id: index, command: { _tag: "SaveNavigation", navigation: { view: "roots", selectedSessionId }, revision: 0 },
    })
    yield* Deferred.await(entered)
    yield* Deferred.succeed(closeRequested, undefined)
    yield* Queue.offer(inbox, { _tag: "Close" })
    expect(worker.pollUnsafe()).toBeUndefined()
    expect(events).toEqual([])
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(worker)
    expect(events).toEqual(["first", "second", "close", "closed"])
  }).pipe(Effect.provideService(PersistencePlatform, nativePersistencePlatform)))
})

test("metadata Close interrupts pre-ready acquisition and waits for rollback", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const inbox = yield* Queue.unbounded<MetadataRequest>()
    const closeRequested = yield* Deferred.make<void>()
    const entered = yield* Deferred.make<void>()
    const rollback = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const responses: MetadataResponse[] = []
    const acquire = Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Deferred.succeed(rollback, undefined).pipe(Effect.andThen(Deferred.await(release))))
      yield* Deferred.succeed(entered, undefined)
      return yield* Effect.never
    })
    const worker = yield* Effect.forkChild(runMetadataWorker(options, inbox, closeRequested, (response) => responses.push(response), acquire))
    yield* Deferred.await(entered)
    yield* Deferred.succeed(closeRequested, undefined)
    yield* Queue.offer(inbox, { _tag: "Close" })
    yield* Deferred.await(rollback)
    expect(responses).toEqual([])
    expect(worker.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(worker)
    expect(responses).toEqual([{ _tag: "Closed" }])
  }).pipe(Effect.provideService(PersistencePlatform, nativePersistencePlatform)))
})

class ControlledMetadataWorker extends EventEmitter {
  requests: MetadataRequest[] = []
  terminated = 0
  unreferenced = 0
  failClose = false
  autoReady = true
  readonly created = Deferred.makeUnsafe<void>()
  readonly closePosted = Deferred.makeUnsafe<void>()
  postMessage(request: MetadataRequest) {
    if (request._tag === "Close" && this.failClose) throw new Error("close post failed")
    this.requests.push(request)
    if (request._tag === "Close") Deferred.doneUnsafe(this.closePosted, Effect.void)
  }
  terminate() { this.terminated++; this.emit("exit", 0); return Promise.resolve(0) }
  unref() { this.unreferenced++ }
  ready() {
    this.emit("message", { _tag: "Ready", location: {
      projectId: "project", scopeId: "scope", projectPath: "/project", statePath: "/state", instanceId: "instance",
    } })
  }
  create = (): Worker => {
    Deferred.doneUnsafe(this.created, Effect.void)
    if (this.autoReady) queueMicrotask(() => this.ready())
    return this as unknown as Worker
  }
}

test("metadata worker readiness has no default deadline", async () => {
  const worker = new ControlledMetadataWorker()
  worker.autoReady = false
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const startup = yield* Effect.forkChild(makeMetadataWorker(options, worker.create))
    yield* Deferred.await(worker.created)
    yield* TestClock.adjust(120_000)
    expect(startup.pollUnsafe()).toBeUndefined()
    expect(worker.requests).toEqual([])
    worker.ready()
    const repository = yield* Fiber.join(startup)
    const close = yield* Effect.forkChild(repository.close)
    yield* Deferred.await(worker.closePosted)
    worker.emit("message", { _tag: "Closed" })
    yield* Fiber.join(close)
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("interrupting metadata startup waits for rollback acknowledgment without terminating a lock holder", async () => {
  const worker = new ControlledMetadataWorker()
  worker.autoReady = false
  await Effect.runPromise(Effect.gen(function*() {
    const startup = yield* Effect.forkChild(Effect.scoped(makeMetadataWorker(options, worker.create)))
    yield* Deferred.await(worker.created)
    const cancellation = yield* Effect.forkChild(Fiber.interrupt(startup))
    yield* Deferred.await(worker.closePosted)
    yield* TestClock.adjust(120_000)
    expect(cancellation.pollUnsafe()).toBeUndefined()
    expect(worker.terminated).toBe(0)
    worker.emit("message", { _tag: "Closed" })
    yield* Fiber.join(cancellation)
    expect(worker.terminated).toBe(1)
  }).pipe(Effect.provide(TestClock.layer())))
})

test("unexpected metadata worker exit settles admitted callers and prohibits new writes", async () => {
  const worker = new ControlledMetadataWorker()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const repository = yield* makeMetadataWorker(options, worker.create)
    const save = yield* Effect.forkChild(Effect.flip(repository.saveNavigation({ view: "roots", selectedSessionId: "root" })))
    yield* Effect.yieldNow
    worker.emit("error", new Error("worker crashed"))
    worker.emit("exit", 1)
    expect((yield* Fiber.join(save)).message).toContain("worker crashed")
    expect((yield* Effect.flip(repository.saveNavigation({ view: "roots", selectedSessionId: "next" }))).message).toContain("worker crashed")
    yield* Effect.exit(repository.close)
    expect(worker.requests.filter((request) => request._tag === "Command")).toHaveLength(1)
  })))
})

test("metadata close timeout never kills an admitted command, and late drain remains observable", async () => {
  const worker = new ControlledMetadataWorker()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const repository = yield* makeMetadataWorker(options, worker.create, 2_000)
    const write = yield* Effect.forkChild(repository.saveNavigation({ view: "roots", selectedSessionId: null }))
    yield* Effect.yieldNow
    const close = yield* Effect.forkChild(Effect.exit(repository.close))
    yield* Effect.yieldNow
    yield* TestClock.adjust(2_000)
    expect(Exit.isFailure(yield* Fiber.join(close))).toBeTrue()
    expect(worker.terminated).toBe(0)
    expect(worker.unreferenced).toBe(1)
    worker.emit("message", { _tag: "Completed", id: 1, value: undefined })
    yield* Fiber.join(write)
    worker.emit("message", { _tag: "Closed" })
    yield* repository.close
    expect(worker.terminated).toBe(1)
    expect(worker.requests.filter((request) => request._tag === "Close")).toHaveLength(1)
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("graceful metadata close waits for drain without a default deadline", async () => {
  const worker = new ControlledMetadataWorker()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const repository = yield* makeMetadataWorker(options, worker.create)
    const close = yield* Effect.forkChild(repository.close)
    yield* Effect.yieldNow
    yield* TestClock.adjust(120_000)
    expect(close.pollUnsafe()).toBeUndefined()
    expect(worker.terminated).toBe(0)
    expect(worker.unreferenced).toBe(0)
    worker.emit("message", { _tag: "Closed" })
    yield* Fiber.join(close)
    yield* repository.close
    expect(worker.requests.filter((request) => request._tag === "Close")).toHaveLength(1)
    expect(worker.terminated).toBe(1)
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("a failed metadata Close post settles admitted callers and preserves the first failure", async () => {
  const worker = new ControlledMetadataWorker()
  worker.failClose = true
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const repository = yield* makeMetadataWorker(options, worker.create)
    const write = yield* Effect.forkChild(Effect.flip(repository.saveNavigation({ view: "roots", selectedSessionId: null })))
    yield* Effect.yieldNow
    expect((yield* Effect.flip(repository.close)).message).toContain("close post failed")
    expect((yield* Fiber.join(write)).message).toContain("close post failed")
    worker.emit("error", new Error("later failure"))
    expect((yield* Effect.flip(repository.load)).message).toContain("close post failed")
    worker.emit("exit", 1)
  })))
})
