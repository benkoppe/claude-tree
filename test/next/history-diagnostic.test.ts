import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"

import { getSessionMessages, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { UNKNOWN_BUILD } from "../../src/build-info"
import { makeCliProgram } from "../../src/cli"
import { HistoryDiagnosticReportSchema, HistoryTrace, MAX_TRACE_EVENTS } from "../../src/diagnostics/history-trace"
import { runHistoryWorker, HISTORY_DIAGNOSTIC_TIMEOUT_MS } from "../../src/diagnostics/run-history"
import { ClaudeProvider } from "../../src/infrastructure/providers/claude/provider"

const SECRET = "PRIVATE_CHAT_CONTENT_AND_FIELD_7c5f39"
const PRIVATE_PATH = "/private/work/secret-project-7c5f39"

function fixture(available: boolean, contextFailure?: unknown) {
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
    importSessionToStore: async (id, store) => { reads.push("records"); await store.append({ projectKey: PRIVATE_PATH, sessionId: id }, entries) },
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
  const report = trace.finish(UNKNOWN_BUILD, observed.get(f.sessionId)!._tag)
  expect(HistoryDiagnosticReportSchema.safeParse(report).success).toBeTrue()
  const output = JSON.stringify(report)
  for (const privateValue of [SECRET, PRIVATE_PATH, f.sessionId, ...f.ids]) expect(output).not.toContain(privateValue)
  expect(report.events.some((event) => event.event === "parent-search")).toBeTrue()
  if (!available) {
    expect(report.failure?.code).toBe("ambiguous-preservation")
    expect(report.events.some((event) => event.event === "decision" && event.action === "no-parent" && event.record === report.failure?.related_record)).toBeTrue()
    expect(report.events.some((event) => event.event === "decision" && event.action === "no-parent" && event.candidates === 0)).toBeTrue()
    expect(report.events.some((event) => event.event === "lineage" && event.state === "end")).toBeTrue()
  }
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

test("worker timeout remains bounded and closes the read-only worker", async () => {
  let terminations = 0
  const ready = Deferred.makeUnsafe<void>()
  const worker = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null,
    send() { Deferred.doneUnsafe(ready, Effect.void) },
    kill() { terminations++; queueMicrotask(() => worker.emit("exit", 0)); return true }, unref() {},
  }) as unknown as ChildProcess
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const task = yield* Effect.forkChild(runHistoryWorker({ projectPath: PRIVATE_PATH, sessionId: SECRET, build: UNKNOWN_BUILD }, () => worker))
    yield* Deferred.await(ready)
    yield* TestClock.adjust(HISTORY_DIAGNOSTIC_TIMEOUT_MS)
    const report = yield* Fiber.join(task)
    expect(report.failure?.code).toBe("diagnostic-timeout")
    expect(terminations).toBe(1)
    expect(JSON.stringify(report)).not.toContain(SECRET)
  }).pipe(Effect.provide(TestClock.layer()))))
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
    const process = Bun.spawn([globalThis.process.execPath, "-e", script], { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
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
    await writeFile(join(transcripts, `${sessionId}.jsonl`), JSON.stringify({
      type: "user", uuid: messageId, sessionId, cwd: project, parentUuid: null,
      message: { role: "user", content: SECRET },
    }) + "\n")
    const before = (await readdir(root, { recursive: true })).sort()
    const process = Bun.spawn([globalThis.process.execPath, "src/cli.ts", "--diagnose-history", sessionId, project], {
      cwd: join(import.meta.dir, "../.."), env: { ...globalThis.process.env, DEBUG: "*", DEBUG_CLAUDE_AGENT_SDK: "1", CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: "fixture", XDG_STATE_HOME: state },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
    expect(code).toBe(0)
    expect(stderr).toBe("")
    const report = HistoryDiagnosticReportSchema.parse(JSON.parse(stdout))
    expect(report.outcome).toBe("Available")
    expect(report.message_count).toBe(1)
    expect(report.build.revision).toMatch(/^[0-9a-f]{40}$/)
    for (const value of [SECRET, project, root, sessionId, messageId]) expect(stdout).not.toContain(value)
    expect((await readdir(root, { recursive: true })).sort()).toEqual(before)
  } finally { await rm(root, { recursive: true, force: true }) }
})
