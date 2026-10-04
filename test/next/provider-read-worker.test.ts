import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"

import { Cause, Deferred, Effect, Exit, Fiber } from "effect"

import { makeProviderReads } from "../../src/infrastructure/providers/read-service"
import type { ProviderReadRequest, ProviderReadResponse } from "../../src/infrastructure/providers/read-worker-protocol"

class ControlledReadWorker extends EventEmitter {
  readonly requests: ProviderReadRequest[] = []
  private readonly posted = new Map<string, Deferred.Deferred<void>>()
  autoClose = true
  terminated = 0
  private signal(request: ProviderReadRequest) {
    const key = JSON.stringify(request)
    let signal = this.posted.get(key)
    if (!signal) { signal = Deferred.makeUnsafe<void>(); this.posted.set(key, signal) }
    return signal
  }
  waitFor(request: ProviderReadRequest) { return Deferred.await(this.signal(request)) }
  postMessage(request: ProviderReadRequest) {
    this.requests.push(request)
    Deferred.doneUnsafe(this.signal(request), Effect.void)
    if (request._tag === "Close" && this.autoClose) this.emit("message", { _tag: "Closed" })
  }
  terminate() { this.terminated++; this.emit("exit", 1); return Promise.resolve(1) }
  unref() {}
  send(response: ProviderReadResponse) { this.emit("message", response) }
  create = (): Worker => {
    queueMicrotask(() => this.send({ _tag: "Ready" }))
    return this as unknown as Worker
  }
}

test("read progress has backpressure and the final result reuses delivered histories", async () => {
  const worker = new ControlledReadWorker()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const reads = yield* makeProviderReads({ providerId: "claude", projectPath: "/project" }, worker.create)
    const progressStarted = yield* Deferred.make<void>()
    const releaseProgress = yield* Deferred.make<void>()
    const snapshot = { sessions: [{ id: "session", title: "Session", lastModified: 1 }],
      transcripts: new Map([["session", { _tag: "Available" as const, messages: [] }]]) }
    const read = yield* Effect.forkChild(reads.loadSnapshot(undefined, () =>
      Deferred.succeed(progressStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseProgress)))))
    yield* worker.waitFor({ _tag: "Read", id: 1 })
    worker.send({ _tag: "Progress", id: 1, sequence: 1, snapshot })
    yield* Deferred.await(progressStarted)
    expect(worker.requests.some((request) => request._tag === "Acknowledged")).toBeFalse()
    yield* Deferred.succeed(releaseProgress, undefined)
    yield* worker.waitFor({ _tag: "Acknowledged", id: 1, sequence: 1 })
    expect(worker.requests).toContainEqual({ _tag: "Acknowledged", id: 1, sequence: 1 })
    worker.send({ _tag: "Completed", id: 1 })
    const result = yield* Fiber.join(read)
    expect(result.transcripts.get("session")).toBe(snapshot.transcripts.get("session"))
    yield* reads.close
    yield* reads.close
    expect(worker.terminated).toBe(1)
  })))
})

test("interrupting a read cancels only that job while another read continues", async () => {
  const worker = new ControlledReadWorker()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const reads = yield* makeProviderReads({ providerId: "claude", projectPath: "/project" }, worker.create)
    const read = yield* Effect.forkChild(reads.loadSnapshot(["old"]))
    yield* worker.waitFor({ _tag: "Read", id: 1, sessionIds: ["old"] })
    const next = yield* Effect.forkChild(reads.loadSnapshot(["new"]))
    yield* worker.waitFor({ _tag: "Read", id: 2, sessionIds: ["new"] })
    yield* Fiber.interrupt(read)
    expect(worker.requests).toContainEqual({ _tag: "Cancel", id: 1 })
    expect(worker.requests).not.toContainEqual({ _tag: "Cancel", id: 2 })
    expect(worker.terminated).toBe(0)
    worker.send({ _tag: "Completed", id: 2 })
    expect((yield* Fiber.join(next)).transcripts.size).toBe(0)
  })))
})

test("worker failure settles admitted reads and prevents further admission", async () => {
  const worker = new ControlledReadWorker()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const reads = yield* makeProviderReads({ providerId: "claude", projectPath: "/project" }, worker.create)
    const read = yield* Effect.forkChild(Effect.flip(reads.loadSnapshot()))
    yield* worker.waitFor({ _tag: "Read", id: 1 })
    worker.emit("error", new Error("worker failed"))
    expect((yield* Fiber.join(read)).message).toContain("worker failed")
    expect((yield* Effect.flip(reads.loadSnapshot())).message).toContain("worker failed")
    yield* Effect.exit(reads.close)
  })))
})

test.each(["failure", "close"] as const)("%s settles a read even while its progress consumer is stalled", async (mode) => {
  const worker = new ControlledReadWorker()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const reads = yield* makeProviderReads({ providerId: "claude", projectPath: "/project" }, worker.create)
    const started = yield* Deferred.make<void>()
    const read = yield* Effect.forkChild(Effect.flip(reads.loadSnapshot(undefined, () =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))))
    yield* worker.waitFor({ _tag: "Read", id: 1 })
    worker.send({ _tag: "Progress", id: 1, sequence: 1, snapshot: { sessions: [], transcripts: new Map() } })
    yield* Deferred.await(started)
    if (mode === "failure") worker.emit("error", new Error("worker failed"))
    else yield* reads.close
    expect((yield* Fiber.join(read)).message).toContain(mode === "failure" ? "worker failed" : "closing")
    yield* Effect.exit(reads.close)
  })))
})

test("interruption during worker creation installs cleanup and waits for provider drain", async () => {
  const worker = new ControlledReadWorker()
  worker.autoClose = false
  await Effect.runPromise(Effect.gen(function*() {
    const acquisition = yield* Effect.forkChild(Effect.scoped(Effect.withFiber((fiber) =>
      makeProviderReads({ providerId: "claude", projectPath: "/project" }, () => {
        fiber.interruptUnsafe()
        return worker.create()
      }))))
    yield* worker.waitFor({ _tag: "Close" })
    expect(worker.terminated).toBe(0)
    expect(acquisition.pollUnsafe()).toBeUndefined()
    worker.send({ _tag: "Closed" })
    const exit = yield* Fiber.await(acquisition)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
    expect(worker.terminated).toBe(1)
  }))
})

test("production worker reads real SDK transcripts, flushes a partial batch, and closes", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "claude-tree-read-worker-")))
  const projectPath = join(directory, "project-with-a-long-path-that-exceeds-the-sdk-project-key-override-limit")
  const config = join(directory, "claude")
  const projectKey = "read-worker-fixture"
  const sessionId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  await mkdir(projectPath)
  const transcripts = join(config, "projects", projectKey)
  await mkdir(transcripts, { recursive: true })
  await writeFile(join(transcripts, `${sessionId}.jsonl`), JSON.stringify({ type: "user", uuid: messageId, parentUuid: null,
    sessionId, timestamp: "2026-09-11T00:00:00.000Z", cwd: projectPath, isSidechain: false,
    message: { role: "user", content: "Worker question" },
  }) + "\n")
  const options = { providerId: "claude" as const, projectPath }
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const reads = yield* makeProviderReads(options, () => new Worker(new URL("../../src/infrastructure/providers/read-worker.ts", import.meta.url), {
        workerData: options, env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: projectKey },
      }))
      const progress: number[] = []
      const snapshot = yield* reads.loadSnapshot(undefined, (snapshot) => Effect.sync(() => progress.push(snapshot.transcripts.size)))
      expect(progress).toEqual([0, 1])
      expect(snapshot.sessions.map((session) => session.id)).toEqual([sessionId])
      const read = snapshot.transcripts.get(sessionId)
      expect(read?._tag).toBe("Available")
      if (read?._tag !== "Available") throw new Error("Expected readable SDK transcript")
      expect(read.messages.map((message) => message.id)).toEqual([messageId])
      expect(read.messages[0]?.preview).toBe("Worker question")
      expect(read.messages[0]).not.toHaveProperty("rawMessage")
      const targeted = yield* reads.loadSnapshot([sessionId])
      expect(targeted.transcripts.get(sessionId)).toEqual(read)
      expect((yield* reads.readTranscripts([sessionId])).get(sessionId)).toEqual(read)
      yield* reads.close
    })))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
