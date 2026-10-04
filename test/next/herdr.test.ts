import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { makeInitialApplicationState, projectApplicationViewModel, type ApplicationViewModel } from "../../src/application"
import { makeHerdrCommandExecutor, makeLiveHerdrReporter, reportApplicationToHerdr, HERDR_PROCESS_CLEANUP_PERIOD_MS, type HerdrCommandProcess } from "../../src/infrastructure/herdr"
import { HERDR_COMMAND_TIMEOUT_MS, HERDR_HEARTBEAT_INTERVAL_MS, NULL_HERDR_REPORTER, validHerdrResumeArgv } from "../../src/services/herdr"

const env = { HERDR_ENV: "1", HERDR_BIN_PATH: "/tmp/herdr", HERDR_PANE_ID: "pane-7", HERDR_SOCKET_PATH: "/tmp/herdr.sock" }
const resume = { workspaceId: "workspace", argv: ["claude-tree", "--codex", "--resume", "workspace", "/project"], destination: "terminal:one" }
function eventually(condition: () => boolean): Effect.Effect<void> {
  return Effect.gen(function*() { for (let i = 0; i < 1_000; i++) { if (condition()) return; yield* Effect.yieldNow }; return yield* Effect.die("Condition not reached") })
}
test("reports state, workspace resume command, increasing sequence, and releases once", async () => {
  const calls: string[][] = []
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const reporter = yield* makeLiveHerdrReporter({ env, execute: (argv) => Effect.sync(() => { calls.push([...argv]) }) })
    reporter.report("working", resume)
    yield* eventually(() => calls.length === 1)
    reporter.report("working", { ...resume, destination: "terminal:two" })
    yield* eventually(() => calls.length === 2)
    reporter.report("blocked", resume)
    yield* eventually(() => calls.length === 3)
    yield* reporter.shutdown
    yield* reporter.shutdown
    reporter.report("idle", resume)
  })))
  expect(calls).toHaveLength(4)
  for (const call of calls.slice(0, 3)) {
    expect(call.slice(0, 10)).toEqual(["/tmp/herdr", "pane", "report-agent", "pane-7", "--source", "custom:claude-tree-lifecycle", "--agent", "claude-tree", "--state", call[9]!])
    expect(call.slice(call.indexOf("--agent-session-id"))).toEqual(["--agent-session-id", "workspace", "--", ...resume.argv])
  }
  const sequences = calls.map((call) => Number(call[call.indexOf("--seq") + 1]))
  expect(sequences.every((seq, index) => Number.isSafeInteger(seq) && (index === 0 || seq > sequences[index - 1]!))).toBeTrue()
  expect(calls[3]![2]).toBe("release-agent")
})
test("sequence timestamps remain ordered across reporter restarts", async () => {
  const sequences: number[] = []
  for (let i = 0; i < 2; i++) await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const reporter = yield* makeLiveHerdrReporter({ env, execute: (argv) => Effect.sync(() => { sequences.push(Number(argv[argv.indexOf("--seq") + 1])) }) })
    reporter.report("idle", resume)
    yield* eventually(() => sequences.length === i * 2 + 1)
  })))
  expect(sequences[2]!).toBeGreaterThan(sequences[1]!)
})
for (const missing of ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"]) test(`disabled with missing ${missing}`, async () => {
  const incomplete: NodeJS.ProcessEnv = { ...env }
  delete incomplete[missing]
  expect(await Effect.runPromise(Effect.scoped(makeLiveHerdrReporter({ env: incomplete, execute: () => Effect.die("must not execute") })))).toBe(NULL_HERDR_REPORTER)
})
test("invalid resume arguments never prevent ordinary state and release reporting", async () => {
  const calls: readonly string[][] = []
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const reporter = yield* makeLiveHerdrReporter({ env, execute: (argv) => Effect.sync(() => { (calls as string[][]).push([...argv]) }) })
    reporter.report("live", { ...resume, argv: ["claude-tree", "project's directory"] })
    yield* eventually(() => calls.length === 1)
  })))
  expect(calls[0]).toContain("Live")
  expect(calls[0]).not.toContain("--agent-session-id")
  expect(calls[1]![2]).toBe("release-agent")
})
test("validates Herdr resume argv restrictions", () => {
  expect(validHerdrResumeArgv(resume.argv)).toBeTrue()
  for (const argv of [[], ["/usr/bin/claude-tree"], ["./claude-tree"], ["claude-tree", "a'b"], ["claude-tree", "\n"],
    ["claude-tree", "x".repeat(8192)], Array.from({ length: 65 }, () => "claude-tree")]) expect(validHerdrResumeArgv(argv)).toBeFalse()
})
test("coalesces queued reports and heartbeats only the latest state and destination", async () => {
  const calls: string[][] = []
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const reporter = yield* makeLiveHerdrReporter({ env, execute: (argv) => Effect.gen(function*() {
      calls.push([...argv])
      if (calls.length === 1) { yield* Deferred.succeed(started, undefined); yield* Deferred.await(release) }
    }) })
    reporter.report("working", resume)
    yield* Deferred.await(started)
    reporter.report("blocked", resume)
    reporter.report("idle", { ...resume, destination: "roots" })
    yield* Deferred.succeed(release, undefined)
    yield* eventually(() => calls.length === 2)
    expect(calls[1]![9]).toBe("idle")
    yield* TestClock.adjust(HERDR_HEARTBEAT_INTERVAL_MS)
    yield* eventually(() => calls.length === 3)
    expect(calls[2]![9]).toBe("idle")
  })).pipe(Effect.provide(TestClock.layer())))
})
test("state reports follow the displayed surface rather than unrelated background agents", async () => {
  const base = projectApplicationViewModel(makeInitialApplicationState())
  const views: ApplicationViewModel[] = [base,
    { ...base, surface: { _tag: "Graph", familySessionId: "tree", title: "Tree", nodes: [], selectedNodeId: null, status: "blocked", warnings: [], worldWidth: 0, worldHeight: 0 } },
    { ...base, surface: { _tag: "Terminal", sessionId: "other", title: "Other", status: "working", draft: undefined } },
    { ...base, shuttingDown: true },
  ]
  const reports: string[] = []
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    yield* reportApplicationToHerdr({ report: (status) => { reports.push(status) }, shutdown: Effect.void }, Stream.fromIterable(views), resume)
    yield* eventually(() => reports.length === 3)
  })))
  expect(reports).toEqual(["idle", "blocked", "working"])
})
test("bounds and detaches an unresponsive Herdr child without blocking later reporting", async () => {
  const signals: (number | NodeJS.Signals)[] = []
  let unrefs = 0
  let started = false
  const subprocess: HerdrCommandProcess = { exitCode: null, exited: new Promise(() => {}), kill(signal = "SIGTERM") { signals.push(signal) }, unref() { unrefs++ } }
  await Effect.runPromise(Effect.gen(function*() {
    const execute = makeHerdrCommandExecutor(() => { started = true; return subprocess })
    const fiber = yield* Effect.forkChild(execute(["herdr"]).pipe(Effect.timeoutOrElse({ duration: HERDR_COMMAND_TIMEOUT_MS, orElse: () => Effect.void })))
    yield* eventually(() => started)
    yield* TestClock.adjust(HERDR_COMMAND_TIMEOUT_MS)
    yield* eventually(() => signals.length === 1)
    yield* TestClock.adjust(HERDR_PROCESS_CLEANUP_PERIOD_MS)
    yield* eventually(() => signals.length === 2)
    yield* TestClock.adjust(HERDR_PROCESS_CLEANUP_PERIOD_MS)
    yield* Fiber.await(fiber)
  }).pipe(Effect.provide(TestClock.layer())))
  expect(signals).toEqual(["SIGTERM", "SIGKILL"])
  expect(unrefs).toBe(1)
})
