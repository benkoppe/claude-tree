import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventEmitter } from "node:events"
import { fork, type ChildProcess } from "node:child_process"

import { getSessionMessages, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { UNKNOWN_BUILD } from "../../src/build-info"
import { makeCliProgram } from "../../src/cli"
import { HistoryDiagnosticReportSchema, HistoryTrace, MAX_TRACE_EVENTS } from "../../src/diagnostics/history-trace"
import { runHistoryWorker } from "../../src/diagnostics/run-history"
import { HistoryProcessRequestSchema, type HistoryDiagnosticJob, type HistoryProcessRequest } from "../../src/diagnostics/history-protocol"
import { runHistoryProcess } from "../../src/diagnostics/history-runtime"
import { ClaudeProvider } from "../../src/infrastructure/providers/claude/provider"
import { runSubprocess } from "../subprocess"

const SECRET = "PRIVATE_CHAT_CONTENT_AND_FIELD_7c5f39"
const PRIVATE_PATH = "/private/work/secret-project-7c5f39"

function fixture(available: boolean, contextFailure?: unknown, mismatchedImport = false) {
  const sessionId = crypto.randomUUID()
  const ids = Array.from({ length: 5 }, () => crypto.randomUUID())
  const question: SessionStoreEntry = { type: "user", uuid: ids[0]!, parentUuid: null, sessionId, message: { role: "user", content: SECRET } }
  const answer: SessionStoreEntry = { type: "assistant", uuid: ids[1]!, parentUuid: ids[3], sessionId,
    message: { role: "assistant", content: [{ type: "text", text: SECRET }], usage: { input_tokens: 1 } } }
  const boundary: SessionStoreEntry = { type: "system", subtype: "compact_boundary", uuid: ids[2]!, parentUuid: null, sessionId,
    logicalParentUuid: ids[1], compactMetadata: { preservedMessages: { uuids: [ids[1]], anchorUuid: ids[3] } } }
  const summary: SessionStoreEntry = { type: "user", uuid: ids[3]!, parentUuid: ids[2], sessionId, isCompactSummary: true,
    message: { role: "user", content: SECRET } }
  const current: SessionStoreEntry = { type: "user", uuid: ids[4]!, parentUuid: ids[1], sessionId, message: { role: "user", content: PRIVATE_PATH } }
  const entries = [question, ...(available ? [{ ...answer, parentUuid: ids[0] }] : []), boundary, summary, answer, current]
  let mutations = 0
  const reads: string[] = []
  const make = () => new ClaudeProvider(PRIVATE_PATH, { sdk: {
    listSessions: async () => { throw new Error("Diagnostics must not discover other sessions") },
    getSessionInfo: async () => { throw new Error("Nonempty context needs no metadata lookup") },
    getSessionMessages: (id, options) => {
      reads.push("context")
      if (contextFailure !== undefined) return Promise.reject(contextFailure)
      return getSessionMessages(id, { ...options, sessionStore: { load: async () => entries, append: async () => { throw new Error("read only") } } })
    },
    importSessionToStore: async (id, store) => { reads.push("records"); await store.append({ projectKey: PRIVATE_PATH, sessionId: id },
      mismatchedImport ? entries.map((record) => record.uuid === answer.uuid ? { ...record, message: { role: "assistant", content: "changed" } } : record) : entries) },
    forkSession: async () => { mutations++; throw new Error(SECRET) },
  }, resolveExecutable: () => { throw new Error("Diagnostics must not prepare a terminal") } })
  return { sessionId, ids, entries, make, reads, mutations: () => mutations }
}

test.each([false, true])("diagnostics use the production read outcome and preserve read ordering (available: %s)", async (available) => {
  const f = fixture(available)
  const normal = await Effect.runPromise(f.make().readTranscripts([f.sessionId]))
  const normalReads = [...f.reads]
  f.reads.length = 0
  const trace = new HistoryTrace(f.sessionId)
  const observed = await Effect.runPromise(f.make().readTranscripts([f.sessionId], trace))
  expect(observed).toEqual(normal)
  expect(f.reads).toEqual(normalReads)
  expect(f.mutations()).toBe(0)
  const read = observed.get(f.sessionId)!
  expect(read._tag).toBe("Available")
  const report = trace.finish(UNKNOWN_BUILD, read._tag === "Available" && read.coverage ? "Limited" : read._tag)
  expect(HistoryDiagnosticReportSchema.safeParse(report).success).toBeTrue()
  const output = JSON.stringify(report)
  for (const privateValue of [SECRET, PRIVATE_PATH, f.sessionId, ...f.ids]) expect(output).not.toContain(privateValue)
  expect(report.events.some((event) => event.event === "parent-search")).toBeTrue()
  if (!available) {
    expect(report.outcome).toBe("Limited")
    expect(report.failure?.code).toBe("history-gap")
    expect(report.events.some((event) => event.event === "decision" && event.action === "no-parent" && event.record === report.failure?.related_record)).toBeTrue()
    expect(report.events.some((event) => event.event === "decision" && event.action === "no-parent" && event.candidates === 0)).toBeTrue()
    expect(report.events.some((event) => event.event === "lineage" && event.state === "end")).toBeTrue()
  }
})

test("a historical gap cannot admit SDK context whose payload changed before import", async () => {
  const f = fixture(false, undefined, true)
  const trace = new HistoryTrace(f.sessionId)
  const read = (await Effect.runPromise(f.make().readTranscripts([f.sessionId], trace))).get(f.sessionId)
  expect(read?._tag).toBe("Unavailable")
  expect(trace.finish(UNKNOWN_BUILD, "Unavailable").failure?.code).toBe("active-record-mismatch")
  expect(f.mutations()).toBe(0)
})

test("comparison diagnostics expose fixed field names, not field values or arbitrary payload keys", () => {
  const id = crypto.randomUUID(), scope = crypto.randomUUID()
  const expected = { type: "assistant", uuid: id, message: { content: SECRET, usage: { [SECRET]: 1 } } }
  const different = { ...expected, message: { content: SECRET, usage: { [SECRET]: 2 } } }
  const trace = new HistoryTrace(scope)
  trace.versions(expected, scope, id, [different], [])
  const report = trace.finish(UNKNOWN_BUILD, "Available")
  expect(report.events[0]).toMatchObject({ event: "versions", comparisons: [{ payload_matches: false, differences: ["message.usage"] }] })
  const output = JSON.stringify(report)
  for (const value of [SECRET, scope, id]) expect(output).not.toContain(value)
  expect(HistoryDiagnosticReportSchema.safeParse({ ...report, rawTranscript: SECRET }).success).toBeFalse()
  expect(HistoryDiagnosticReportSchema.safeParse({ ...report, events: [{ event: "stage", stage: SECRET, session: scope, state: "failed" }] }).success).toBeFalse()
})

test.each(["EACCES", "ENOENT", "PRIVATE_ERROR_CODE"])("SDK failures use allowlisted codes and never serialize their details (%s)", async (errno) => {
  const f = fixture(false, Object.assign(new Error(SECRET), { code: errno, path: PRIVATE_PATH }))
  const trace = new HistoryTrace(f.sessionId)
  const reads = await Effect.runPromise(f.make().readTranscripts([f.sessionId], trace))
  const report = trace.finish(UNKNOWN_BUILD, reads.get(f.sessionId)!._tag)
  expect(report.failure?.code).toBe(errno === "EACCES" ? "permission-denied" : errno === "ENOENT" ? "source-not-found" : "sdk-request-failed")
  const output = JSON.stringify(report)
  for (const value of [SECRET, PRIVATE_PATH, "PRIVATE_ERROR_CODE", f.sessionId]) expect(output).not.toContain(value)
})

test("trace truncation is explicit and retains the terminal failure classification", () => {
  const trace = new HistoryTrace("private-session")
  for (let index = 0; index < MAX_TRACE_EVENTS + 20; index++) trace.parent(`private-${index}`, null, null, "accepted", null)
  trace.fail("projection", "ambiguous-preservation", undefined, "private-failing-record")
  const report = trace.finish(UNKNOWN_BUILD, "Unavailable")
  expect(report.events).toHaveLength(MAX_TRACE_EVENTS)
  expect(report.omitted_events).toBe(20)
  expect(report.failure?.code).toBe("ambiguous-preservation")
  expect(JSON.stringify(report)).not.toContain("private-")
})

test("diagnostic CLI bypasses TTY and interactive composition and sanitizes unexpected failures", async () => {
  const output: string[] = []
  let interactive = 0
  await Effect.runPromise(makeCliProgram({
    args: ["--diagnose-history", "private-session", PRIVATE_PATH], stdinIsTTY: false, stdoutIsTTY: false,
    writeStdout: (value) => { output.push(value) },
    runApplication: () => Effect.sync(() => { interactive++ }),
    diagnoseHistory: () => Effect.die(new Error(SECRET + PRIVATE_PATH)),
  }))
  expect(interactive).toBe(0)
  expect(output).toHaveLength(1)
  expect(HistoryDiagnosticReportSchema.parse(JSON.parse(output[0]!)).failure?.code).toBe("unexpected-failure")
  for (const value of [SECRET, PRIVATE_PATH, "private-session"]) expect(output[0]).not.toContain(value)
})

class ControlledDiagnosticProcess extends EventEmitter {
  readonly pid = 12345
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly ready = Deferred.makeUnsafe<void>()
  readonly cancelling = Deferred.makeUnsafe<void>()
  readonly signalled = Deferred.makeUnsafe<void>()
  readonly requests: HistoryProcessRequest[] = []
  readonly signals: NodeJS.Signals[] = []
  autoCancel = false
  autoKill = false
  detached = false
  send(request: HistoryProcessRequest, callback: (error: Error | null) => void) {
    this.requests.push(request)
    if (request._tag === "Execute") Deferred.doneUnsafe(this.ready, Effect.void)
    else {
      Deferred.doneUnsafe(this.cancelling, Effect.void)
      if (this.autoCancel) queueMicrotask(() => this.finish())
    }
    callback(null)
  }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal)
    Deferred.doneUnsafe(this.signalled, Effect.void)
    if (this.autoKill) queueMicrotask(() => this.finish())
    return true
  }
  finish() { this.exitCode = 0; this.emit("exit", 0) }
  unref() { this.detached = true }
  create = () => this as unknown as ChildProcess
}

test("an explicitly requested execution timeout cooperatively closes the read-only worker", async () => {
  const worker = new ControlledDiagnosticProcess()
  worker.autoCancel = true
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const task = yield* Effect.forkChild(runHistoryWorker({ projectPath: PRIVATE_PATH, sessionId: SECRET, build: UNKNOWN_BUILD }, worker.create, 30_000))
    yield* Deferred.await(worker.ready)
    yield* TestClock.adjust(30_000)
    const report = yield* Fiber.join(task)
    expect(report.failure?.code).toBe("diagnostic-timeout")
    expect(worker.signals).toEqual([])
    expect(worker.requests.map((request) => request._tag)).toEqual(["Execute", "Cancel"])
    expect(JSON.stringify(report)).not.toContain(SECRET)
  }).pipe(Effect.provide(TestClock.layer()))))
})

test.each([false, true])("default diagnostic waits beyond its former budget and remains cancellable (cancel: %s)", async (cancel) => {
  const worker = new ControlledDiagnosticProcess()
  worker.autoCancel = true
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const task = yield* Effect.forkChild(runHistoryWorker({ projectPath: PRIVATE_PATH, sessionId: SECRET, build: UNKNOWN_BUILD }, worker.create))
    yield* Deferred.await(worker.ready)
    yield* TestClock.adjust(120_000)
    expect(task.pollUnsafe()).toBeUndefined()
    expect(worker.signals).toEqual([])
    if (cancel) {
      yield* Fiber.interrupt(task)
      expect(Exit.isFailure(yield* Fiber.await(task))).toBeTrue()
    }
    else {
      worker.emit("message", new HistoryTrace("read-only").finish(UNKNOWN_BUILD, "Missing"))
      yield* Effect.yieldNow
      expect(task.pollUnsafe()).toBeUndefined()
      worker.finish()
      expect((yield* Fiber.join(task)).outcome).toBe("Missing")
    }
    expect(worker.signals).toEqual([])
    expect(worker.eventNames()).toEqual([])
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("diagnostic cancellation escalates but waits for actual late exit without a default deadline", async () => {
  const worker = new ControlledDiagnosticProcess()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const task = yield* Effect.forkChild(runHistoryWorker({ projectPath: PRIVATE_PATH, sessionId: SECRET, build: UNKNOWN_BUILD }, worker.create))
    yield* Deferred.await(worker.ready)
    yield* TestClock.adjust(120_000)
    expect(task.pollUnsafe()).toBeUndefined()
    const cancellation = yield* Effect.forkChild(Fiber.interrupt(task))
    yield* Deferred.await(worker.cancelling)
    yield* TestClock.adjust(1_000)
    expect(worker.signals).toEqual(["SIGTERM"])
    yield* TestClock.adjust(1_000)
    expect(worker.signals).toEqual(["SIGTERM", "SIGKILL"])
    yield* TestClock.adjust(120_000)
    expect(cancellation.pollUnsafe()).toBeUndefined()
    expect(worker.detached).toBeFalse()
    worker.finish()
    yield* Fiber.join(cancellation)
    expect(Exit.isFailure(yield* Fiber.await(task))).toBeTrue()
    expect(worker.eventNames()).toEqual([])
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("an explicit diagnostic cleanup deadline retains late exit observation without repeating escalation", async () => {
  const worker = new ControlledDiagnosticProcess()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const task = yield* Effect.forkChild(runHistoryWorker({ projectPath: PRIVATE_PATH, sessionId: SECRET, build: UNKNOWN_BUILD }, worker.create, undefined, 100))
    yield* Deferred.await(worker.ready)
    worker.emit("message", new HistoryTrace("read-only").finish(UNKNOWN_BUILD, "Missing"))
    yield* TestClock.adjust(100)
    expect((yield* Fiber.join(task)).failure?.code).toBe("cleanup-failed")
    expect(worker.detached).toBeTrue()
    expect(worker.listenerCount("exit")).toBe(1)
    yield* TestClock.adjust(900)
    expect(worker.signals).toEqual(["SIGTERM"])
    yield* TestClock.adjust(1_000)
    expect(worker.signals).toEqual(["SIGTERM", "SIGKILL"])
    worker.finish()
    yield* Effect.yieldNow
    expect(worker.eventNames()).toEqual([])
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("child exit does not discard a report still buffered in IPC", async () => {
  const worker = new ControlledDiagnosticProcess()
  await Effect.runPromise(Effect.gen(function*() {
    const task = yield* Effect.forkChild(runHistoryWorker({ projectPath: PRIVATE_PATH, sessionId: SECRET, build: UNKNOWN_BUILD }, worker.create))
    yield* Deferred.await(worker.ready)
    worker.finish()
    yield* Effect.yieldNow
    expect(task.pollUnsafe()).toBeUndefined()
    worker.emit("message", new HistoryTrace("read-only").finish(UNKNOWN_BUILD, "Missing"))
    expect((yield* Fiber.join(task)).outcome).toBe("Missing")
    expect(worker.signals).toEqual([])
  }))
})

test("diagnostic IPC disconnect without a report cancels and verifies the remaining child", async () => {
  const worker = new ControlledDiagnosticProcess()
  worker.autoKill = true
  await Effect.runPromise(Effect.gen(function*() {
    const task = yield* Effect.forkChild(runHistoryWorker({ projectPath: PRIVATE_PATH, sessionId: SECRET, build: UNKNOWN_BUILD }, worker.create))
    yield* Deferred.await(worker.ready)
    worker.emit("disconnect")
    yield* Deferred.await(worker.cancelling)
    yield* TestClock.adjust(1_000)
    expect((yield* Fiber.join(task)).failure?.code).toBe("worker-failed")
    expect(worker.signals).toEqual(["SIGTERM"])
    expect(worker.eventNames()).toEqual([])
  }).pipe(Effect.provide(TestClock.layer())))
})

test.each([false, true])("diagnostic child finalizes owned reads before report or cancellation completion (cancel: %s)", async (cancel) => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const job = yield* Deferred.make<HistoryDiagnosticJob>()
    const cancelled = yield* Deferred.make<void>()
    const reading = yield* Deferred.make<void>()
    const finishRead = yield* Deferred.make<void>()
    const finalizing = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const reports: unknown[] = []
    const child = yield* Effect.forkChild(runHistoryProcess(job, cancelled, (report) => Effect.sync(() => { reports.push(report) }),
      () => Effect.addFinalizer(() => Deferred.succeed(finalizing, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(
        Effect.andThen(Deferred.succeed(reading, undefined)),
        Effect.andThen(Deferred.await(finishRead)),
        Effect.as(new HistoryTrace("read-only").finish(UNKNOWN_BUILD, "Missing")),
      )))
    yield* Deferred.succeed(job, { projectPath: PRIVATE_PATH, sessionId: SECRET, build: UNKNOWN_BUILD })
    yield* Deferred.await(reading)
    if (cancel) yield* Deferred.succeed(cancelled, undefined)
    else yield* Deferred.succeed(finishRead, undefined)
    yield* Deferred.await(finalizing)
    yield* TestClock.adjust(120_000)
    expect(child.pollUnsafe()).toBeUndefined()
    expect(reports).toEqual([])
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(child)
    expect(reports).toHaveLength(cancel ? 0 : 1)
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("diagnostic cancellation before Execute admits no read", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const job = yield* Deferred.make<HistoryDiagnosticJob>()
    const cancelled = yield* Deferred.make<void>()
    yield* Deferred.succeed(cancelled, undefined)
    let reads = 0
    yield* runHistoryProcess(job, cancelled, () => Effect.die("unexpected report"), () => {
      reads++
      return Effect.never
    })
    expect(reads).toBe(0)
  }))
})

test("diagnostic child validates its private lifecycle protocol without accepting arbitrary fields", () => {
  expect(HistoryProcessRequestSchema.safeParse({ _tag: "Cancel" }).success).toBeTrue()
  expect(HistoryProcessRequestSchema.safeParse({ _tag: "Execute", job: { projectPath: PRIVATE_PATH, sessionId: SECRET, build: UNKNOWN_BUILD } }).success).toBeTrue()
  for (const value of [null, {}, { _tag: "Cancel", payload: SECRET }, { _tag: "Execute", job: { projectPath: PRIVATE_PATH } }]) {
    expect(HistoryProcessRequestSchema.safeParse(value).success).toBeFalse()
  }
})

test("failed diagnostic signal dispatch remains a cleanup failure even after verified exit", async () => {
  const worker = new ControlledDiagnosticProcess()
  worker.kill = () => { throw new Error(SECRET) }
  await Effect.runPromise(Effect.gen(function*() {
    const task = yield* Effect.forkChild(runHistoryWorker({ projectPath: PRIVATE_PATH, sessionId: SECRET, build: UNKNOWN_BUILD }, worker.create))
    yield* Deferred.await(worker.ready)
    worker.emit("message", new HistoryTrace("read-only").finish(UNKNOWN_BUILD, "Missing"))
    yield* TestClock.adjust(2_000)
    expect(task.pollUnsafe()).toBeUndefined()
    worker.finish()
    const report = yield* Fiber.join(task)
    expect(report.failure?.code).toBe("cleanup-failed")
    expect(JSON.stringify(report)).not.toContain(SECRET)
  }).pipe(Effect.provide(TestClock.layer())))
})

test("a failed diagnostic spawn settles without awaiting a nonexistent child exit", async () => {
  const report = await Effect.runPromise(runHistoryWorker({ projectPath: PRIVATE_PATH, sessionId: SECRET, build: UNKNOWN_BUILD },
    () => fork("unused.ts", [], { execPath: `/tmp/opencode/nonexistent-diagnostic-${crypto.randomUUID()}`, stdio: ["ignore", "ignore", "ignore", "ipc"] })))
  expect(report.failure?.code).toBe("worker-failed")
  expect(JSON.stringify(report)).not.toContain(PRIVATE_PATH)
})

test.each(["cancel", "disconnect"])("real diagnostic child exits cleanly when %s arrives before Execute", async (mode) => {
  const script = `import { fork } from "node:child_process";
    const child = fork("./src/diagnostics/history-process.ts", [], {execPath: process.execPath, stdio: ["ignore", "ignore", "ignore", "ipc"]});
    const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({code, signal})));
    ${mode === "cancel" ? 'child.send({_tag: "Cancel"});' : 'child.disconnect();'}
    console.log(JSON.stringify(await exit));`
  const [code, stdout, stderr] = await runSubprocess([process.execPath, "-e", script], { cwd: join(import.meta.dir, "../..") })
  expect(code).toBe(0)
  expect(stderr).toBe("")
  expect(JSON.parse(stdout)).toEqual({ code: 0, signal: null })
})

test.each(["valid", "invalid", "crash"])("worker output and exceptions cannot leak into CLI streams (%s)", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "claude-tree-diagnostic-worker-"))
  try {
    const report = new HistoryTrace("private-session").finish(UNKNOWN_BUILD, "Missing")
    const workerFile = join(root, "worker.ts")
    await writeFile(workerFile, `
      console.log(${JSON.stringify(SECRET)}); console.error(${JSON.stringify(PRIVATE_PATH)});
      ${mode === "crash" ? `throw new Error(${JSON.stringify(SECRET)});` : `process.send(${JSON.stringify(mode === "valid" ? report : { ...report, privateData: SECRET })}); process.disconnect();`}`)
    const script = `import { fork } from "node:child_process";
      import { Effect } from "effect";
      import { runHistoryWorker } from "./src/diagnostics/run-history.ts";
      const result = await Effect.runPromise(runHistoryWorker({projectPath: ${JSON.stringify(PRIVATE_PATH)}, sessionId: ${JSON.stringify(SECRET)}, build: ${JSON.stringify(UNKNOWN_BUILD)}},
        () => fork(${JSON.stringify(workerFile)}, [], {execPath: process.execPath, stdio: ["ignore", "ignore", "ignore", "ipc"]})));
      console.log(JSON.stringify(result));`
    const [code, stdout, stderr] = await runSubprocess([process.execPath, "-e", script], { cwd: join(import.meta.dir, "../..") })
    expect(code).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).not.toContain(SECRET)
    expect(stdout).not.toContain(PRIVATE_PATH)
    const result = HistoryDiagnosticReportSchema.parse(JSON.parse(stdout))
    expect(result.outcome).toBe(mode === "valid" ? "Missing" : "Unavailable")
    if (mode !== "valid") expect(result.failure?.code).toBe(mode === "crash" ? "worker-failed" : "invalid-diagnostic-report")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("real headless diagnostics create no app state and disclose no project or transcript data", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-tree-diagnostic-cli-"))
  const project = join(root, "private-project")
  const config = join(root, "claude")
  const state = join(root, "app-state")
  const sessionId = crypto.randomUUID(), messageId = crypto.randomUUID()
  try {
    await mkdir(project)
    const transcripts = join(config, "projects", "fixture")
    await mkdir(transcripts, { recursive: true })
    const transcriptPath = join(transcripts, `${sessionId}.jsonl`)
    const transcript = JSON.stringify({
      type: "user", uuid: messageId, sessionId, cwd: project, parentUuid: null,
      message: { role: "user", content: SECRET },
    }) + "\n"
    await writeFile(transcriptPath, transcript)
    const before = (await readdir(root, { recursive: true })).sort()
    const [code, stdout, stderr] = await runSubprocess([process.execPath, "src/cli.ts", "--diagnose-history", sessionId, project], {
      cwd: join(import.meta.dir, "../.."), env: { ...globalThis.process.env, DEBUG: "*", DEBUG_CLAUDE_AGENT_SDK: "1", CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: "fixture", XDG_STATE_HOME: state },
    })
    expect(code).toBe(0)
    expect(stderr).toBe("")
    const report = HistoryDiagnosticReportSchema.parse(JSON.parse(stdout))
    expect(report.outcome).toBe("Available")
    expect(report.message_count).toBe(1)
    expect(report.build.version).toBe(UNKNOWN_BUILD.version)
    for (const value of [SECRET, project, root, sessionId, messageId]) expect(stdout).not.toContain(value)
    expect((await readdir(root, { recursive: true })).sort()).toEqual(before)
    expect(await readFile(transcriptPath, "utf8")).toBe(transcript)
  } finally { await rm(root, { recursive: true, force: true }) }
})
