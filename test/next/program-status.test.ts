import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, Stream } from "effect"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { makeInitialApplicationState, projectApplicationViewModel, type ApplicationViewModel } from "../../src/application"
import { projectDisplayedStatus } from "../../src/application/displayed-status"
import type { SessionStatus } from "../../src/domain/session-status"
import { makeOpenTuiProgramStatusReporter, reportApplicationToProgramStatus } from "../../src/infrastructure/program-status"
import { reportApplicationToHerdr } from "../../src/infrastructure/herdr"
import { CLEAR_PROGRAM_STATUS, encodeProgramStatus, makeProgramStatusReporter } from "../../src/services/program-status"

const base = () => projectApplicationViewModel(makeInitialApplicationState())
const terminal = (status: SessionStatus, sessionId = "one"): ApplicationViewModel => ({
  ...base(), surface: { _tag: "Terminal", sessionId, title: "Terminal", status, draft: undefined },
})
const graph = (status: SessionStatus): ApplicationViewModel => ({
  ...base(), surface: { _tag: "Graph", familySessionId: "tree", title: "Tree", nodes: [], selectedNodeId: null,
    status, warnings: [], worldWidth: 0, worldHeight: 0 },
})

function eventually(condition: () => boolean): Effect.Effect<void> {
  return Effect.gen(function*() {
    for (let i = 0; i < 1_000; i++) { if (condition()) return; yield* Effect.yieldNow }
    return yield* Effect.die("Condition not reached")
  })
}

test("encodes complete, bounded root records with OSC 7501 states and base64 messages", () => {
  const cases: readonly [SessionStatus, string, string | undefined][] = [
    ["idle", "idle", undefined], ["live", "idle", "Live"], ["working", "working", "Working"],
    ["blocked", "blocked", "Needs user"], ["unviewed", "done", "New updates"],
  ]
  for (const [status, state, message] of cases) {
    const sequence = encodeProgramStatus(status)
    const body = `state=${state}:app=claude-tree${message ? `:msg=${Buffer.from(message).toString("base64")}` : ""}`
    expect(sequence).toBe(`\x1b]7501;${body}\x1b\\`)
    expect(Buffer.byteLength(sequence)).toBeLessThanOrEqual(4096)
    for (const pair of body.split(":")) {
      const [key, ...value] = pair.split("=")
      expect(key).toMatch(/^[a-z]{1,16}$/)
      expect(value.join("=")).toMatch(/^[A-Za-z0-9_.,+/=-]*$/)
    }
    if (message) {
      expect(Buffer.byteLength(message)).toBeLessThanOrEqual(2048)
      expect(Buffer.byteLength(Buffer.from(message).toString("base64"))).toBeLessThanOrEqual(2732)
      expect(message).not.toMatch(/[\x00-\x1f\x7f-\x9f]/u)
    }
    expect(sequence).not.toContain(":id=")
    expect(sequence).not.toContain(":kind=")
    expect(sequence).not.toContain(":progress=")
  }
  expect(CLEAR_PROGRAM_STATUS).toBe("\x1b]7501;state=clear\x1b\\")
})

test("deduplicates records, replaces done with idle, and clears once on explicit shutdown", () => {
  const writes: string[] = []
  const reporter = makeProgramStatusReporter((sequence) => { writes.push(sequence) })
  for (const activity of ["working", "working", "blocked", "unviewed", "live", "idle"] as const) reporter.report(activity)
  reporter.shutdown()
  reporter.shutdown()
  reporter.report("working")
  expect(writes).toEqual([...(["working", "blocked", "unviewed", "live", "idle"] as const).map(encodeProgramStatus), CLEAR_PROGRAM_STATUS])
})

test("output failures are non-fatal and do not deduplicate a report that was not written", () => {
  let fail = true
  const writes: string[] = []
  const reporter = makeProgramStatusReporter((sequence) => {
    if (fail || sequence === CLEAR_PROGRAM_STATUS) throw new Error("Output unavailable")
    writes.push(sequence)
  })
  reporter.report("working")
  fail = false
  reporter.report("working")
  reporter.report("working")
  reporter.shutdown()
  expect(writes).toEqual([encodeProgramStatus("working")])
})

test("Herdr and OSC share visible-surface authority and preserve Herdr resume destinations", async () => {
  const views = [base(), graph("blocked"), graph("unviewed"), terminal("working"), terminal("live", "two"), base()]
  const reports: SessionStatus[] = []
  const destinations: (string | undefined)[] = []
  const writes: string[] = []
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const reporter = makeProgramStatusReporter((sequence) => { writes.push(sequence) })
    yield* reportApplicationToProgramStatus(reporter, Stream.fromIterable(views))
    yield* reportApplicationToHerdr({ report: (activity, resume) => {
      reports.push(activity); destinations.push(resume?.destination)
    }, shutdown: Effect.void }, Stream.fromIterable(views), { workspaceId: "workspace", argv: ["claude-tree"] })
    yield* eventually(() => reports.length === views.length && writes.length === views.length)
    reporter.shutdown()
  })))
  expect(reports).toEqual(["idle", "blocked", "unviewed", "working", "live", "idle"])
  expect(writes).toEqual([...reports.map(encodeProgramStatus), CLEAR_PROGRAM_STATUS])
  expect(destinations).toEqual(["roots:", "graph:tree", "graph:tree", "terminal:one", "terminal:two", "roots:"])
  const roots = base()
  expect(projectDisplayedStatus({ ...roots, surface: { _tag: "Roots",
    roots: [{ sessionId: "hidden", title: "Hidden", status: "blocked", activation: "open", history: { _tag: "Ready" },
      lastModified: 0, memberSessionIds: ["hidden"], messageCount: 0 }], selectedSessionId: "hidden" },
  })).toEqual({ activity: "idle", destination: "roots:hidden" })
})

test("shutdown publication clears immediately and rejects later publications", async () => {
  const writes: string[] = []
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const reporter = makeProgramStatusReporter((sequence) => { writes.push(sequence) })
    yield* reportApplicationToProgramStatus(reporter, Stream.fromIterable([
      terminal("working"), { ...base(), shuttingDown: true }, terminal("blocked"),
    ]))
    yield* eventually(() => writes.length === 2)
    reporter.shutdown()
  })))
  expect(writes).toEqual([encodeProgramStatus("working"), CLEAR_PROGRAM_STATUS])
})

for (const screenMode of ["alternate-screen", "split-footer"] as const)
test(`native feed output stays ordered and clears before renderer disposal (${screenMode})`, async () => {
  const output = new PassThrough()
  const chunks: Buffer[] = []
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
  const setup = await createTestRenderer({ width: 30, height: 8, bufferedOutput: "stdout",
    screenMode, footerHeight: 4,
    externalOutputMode: screenMode === "split-footer" ? "capture-stdout" : "passthrough",
    stdout: output as unknown as NodeJS.WriteStream })
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const reporter = yield* makeOpenTuiProgramStatusReporter(setup.renderer)
      reporter.report("working")
      yield* Effect.promise(() => setup.renderOnce())
      reporter.report("unviewed")
      setup.renderer.destroy()
      reporter.report("blocked")
    })))
    const text = Buffer.concat(chunks).toString("utf8")
    expect(text).toContain(encodeProgramStatus("working"))
    expect(text).toContain(encodeProgramStatus("unviewed"))
    expect(text.split(CLEAR_PROGRAM_STATUS)).toHaveLength(2)
    expect(text.indexOf(encodeProgramStatus("working"))).toBeLessThan(text.indexOf(encodeProgramStatus("unviewed")))
    expect(text.indexOf(encodeProgramStatus("unviewed"))).toBeLessThan(text.indexOf(CLEAR_PROGRAM_STATUS))
    expect(text).not.toContain(encodeProgramStatus("blocked"))
    expect(setup.externalOutput.takeText()).toBe("")
  } finally {
    setup.renderer.destroy()
    output.destroy()
  }
})

test("scope finalization clears persistent done and detaches the renderer destruction listener", async () => {
  const output = new PassThrough()
  const chunks: Buffer[] = []
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
  const setup = await createTestRenderer({ width: 30, height: 8, bufferedOutput: "stdout",
    stdout: output as unknown as NodeJS.WriteStream })
  const initialListeners = setup.renderer.listenerCount("destroy")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const reporter = yield* makeOpenTuiProgramStatusReporter(setup.renderer)
      expect(setup.renderer.listenerCount("destroy")).toBe(initialListeners + 1)
      reporter.report("unviewed")
    })))
    expect(setup.renderer.listenerCount("destroy")).toBe(initialListeners)
    await setup.renderOnce()
    setup.renderer.destroy()
    const outputText = Buffer.concat(chunks).toString("utf8")
    expect(outputText.match(/\x1b\]7501;[^\x1b]*\x1b\\/gu)).toEqual([
      encodeProgramStatus("unviewed"), CLEAR_PROGRAM_STATUS,
    ])
  } finally {
    setup.renderer.destroy()
    output.destroy()
  }
})

for (const useThread of [false, true]) test(`native stdout output preserves complete reports alongside render frames (thread=${useThread})`, async () => {
  const modulePath = fileURLToPath(new URL("../../src/infrastructure/program-status/index.ts", import.meta.url))
  const subprocess = Bun.spawn([process.execPath, "--eval", `
    import { createTestRenderer } from "@opentui/core/testing"
    import { Effect } from "effect"
    import { makeOpenTuiProgramStatusReporter } from ${JSON.stringify(modulePath)}
    const setup = await createTestRenderer({ width: 30, height: 8, stdout: process.stdout,
      bufferedOutput: "stdout", screenMode: "alternate-screen", useThread: ${useThread} })
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const reporter = yield* makeOpenTuiProgramStatusReporter(setup.renderer)
      reporter.report("working")
      yield* Effect.promise(() => setup.renderOnce())
      reporter.report("blocked")
      yield* Effect.promise(() => setup.renderOnce())
      reporter.report("unviewed")
      setup.renderer.destroy()
      reporter.report("working")
    })))
  `], { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdout: "pipe", stderr: "pipe" })
  try {
    const [output, error, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited,
    ])
    expect(exitCode).toBe(0)
    expect(error).toBe("")
    expect(output.match(/\x1b\]7501;[^\x1b]*\x1b\\/gu)).toEqual([
      encodeProgramStatus("working"), encodeProgramStatus("blocked"), encodeProgramStatus("unviewed"), CLEAR_PROGRAM_STATUS,
    ])
    expect(output.replace(/\x1b\]7501;[^\x1b]*\x1b\\/gu, "")).not.toBe("")
  } finally {
    if (subprocess.exitCode === null) subprocess.kill()
    await subprocess.exited
    subprocess.unref()
  }
})

test("a disposed renderer cannot be used for reporting or clearing", async () => {
  const setup = await createTestRenderer({ width: 30, height: 8 })
  setup.renderer.destroy()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const reporter = yield* makeOpenTuiProgramStatusReporter(setup.renderer)
    reporter.report("working")
    reporter.shutdown()
  })))
})
