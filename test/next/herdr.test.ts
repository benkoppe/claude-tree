import { expect, test } from "bun:test"

import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import {
  HERDR_PROCESS_CLEANUP_PERIOD_MS,
  makeHerdrCommandExecutor,
  makeLiveHerdrReporter,
  makeTerminalHerdrReporter,
  type HerdrCommandProcess,
} from "../../src/infrastructure/herdr"
import {
  HERDR_COMMAND_TIMEOUT_MS,
  NULL_HERDR_REPORTER,
  type HerdrCommandExecutor,
  type HerdrReporterApi,
} from "../../src/services/herdr"

const HERDR_ENV = {
  HERDR_ENV: "1",
  HERDR_BIN_PATH: "/tmp/herdr",
  HERDR_PANE_ID: "pane-7",
}

test("is disabled outside a Herdr pane", async () => {
  const reporter = await Effect.runPromise(
    Effect.scoped(makeLiveHerdrReporter({ env: {}, execute: () => Effect.void })),
  )

  expect(reporter).toBe(NULL_HERDR_REPORTER)
})

test("reports transitions serially with the Herdr lifecycle identity", async () => {
  const calls: string[][] = []

  await runWithReporter(
    (command) => Effect.sync(() => calls.push([...command])),
    (reporter) => Effect.gen(function*() {
      reporter.report("working")
      yield* waitFor(() => calls.length === 1)
      reporter.report("blocked")
      yield* waitFor(() => calls.length === 2)
      reporter.report("blocked")
    }),
  )

  expect(calls).toEqual([
    reportCommand("working"),
    reportCommand("blocked"),
    releaseCommand(),
  ])
})

test("coalesces queued reports to the latest state", async () => {
  const calls: string[][] = []

  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const firstStarted = yield* Deferred.make<void>()
    const unblockFirst = yield* Deferred.make<void>()
    const reporter = yield* makeLiveHerdrReporter({
      env: HERDR_ENV,
      execute: (command) => Effect.gen(function*() {
        calls.push([...command])
        if (calls.length === 1) {
          yield* Deferred.succeed(firstStarted, undefined)
          yield* Deferred.await(unblockFirst)
        }
      }),
    })

    reporter.report("working")
    yield* Deferred.await(firstStarted)
    reporter.report("blocked")
    reporter.report("idle")
    yield* Deferred.succeed(unblockFirst, undefined)
    yield* waitFor(() => calls.length === 2)

    expect(calls.slice(0, 2)).toEqual([
      reportCommand("working"),
      reportCommand("idle"),
    ])
  })))
})

test("reasserts at 250ms and 1500ms from the latest transition", async () => {
  const calls: string[][] = []

  await runWithTestClock(
    (command) => Effect.sync(() => calls.push([...command])),
    (reporter) => Effect.gen(function*() {
      reporter.report("working")
      yield* waitFor(() => calls.length === 1)

      yield* TestClock.adjust(249)
      expect(calls).toHaveLength(1)
      yield* TestClock.adjust(1)
      yield* waitFor(() => calls.length === 2)

      yield* TestClock.adjust(1_249)
      expect(calls).toHaveLength(2)
      yield* TestClock.adjust(1)
      yield* waitFor(() => calls.length === 3)
    }),
  )

  expect(calls.slice(0, 3)).toEqual([
    reportCommand("working"),
    reportCommand("working"),
    reportCommand("working"),
  ])
})

test("heartbeats the latest state every ten seconds", async () => {
  const calls: string[][] = []

  await runWithTestClock(
    (command) => Effect.sync(() => calls.push([...command])),
    (reporter) => Effect.gen(function*() {
      reporter.report("idle")
      yield* waitFor(() => calls.length === 1)
      yield* TestClock.adjust(1_500)
      yield* waitFor(() => calls.length === 3)

      yield* TestClock.adjust(8_499)
      expect(calls).toHaveLength(3)
      yield* TestClock.adjust(1)
      yield* waitFor(() => calls.length === 4)

      yield* TestClock.adjust(9_999)
      expect(calls).toHaveLength(4)
      yield* TestClock.adjust(1)
      yield* waitFor(() => calls.length === 5)
    }),
  )

  expect(calls.slice(0, 5)).toEqual([
    reportCommand("idle"),
    reportCommand("idle"),
    reportCommand("idle"),
    reportCommand("idle"),
    reportCommand("idle"),
  ])
})

test("bounds TERM and KILL cleanup for an unresponsive Herdr command", async () => {
  const subprocess = new UnresponsiveHerdrProcess()
  const execute = makeHerdrCommandExecutor(() => {
    subprocess.started = true
    return subprocess
  })

  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(
          execute(["/tmp/herdr", "version"]).pipe(
            Effect.timeoutOrElse({
              duration: HERDR_COMMAND_TIMEOUT_MS,
              orElse: () => Effect.void,
            }),
          ),
        )
        yield* waitFor(() => subprocess.started)

        yield* TestClock.adjust(HERDR_COMMAND_TIMEOUT_MS)
        yield* waitFor(() => subprocess.signals.length === 1)
        expect(subprocess.signals).toEqual(["SIGTERM"])

        yield* TestClock.adjust(HERDR_PROCESS_CLEANUP_PERIOD_MS - 1)
        expect(subprocess.signals).toEqual(["SIGTERM"])
        yield* TestClock.adjust(1)
        yield* waitFor(() => subprocess.signals.length === 2)
        expect(subprocess.signals).toEqual(["SIGTERM", "SIGKILL"])

        yield* TestClock.adjust(HERDR_PROCESS_CLEANUP_PERIOD_MS)
        yield* Fiber.join(fiber)
      }),
      TestClock.layer(),
    ),
  )

  expect(subprocess.unrefCalls).toBe(1)
})

test("times out and ignores failed commands without blocking later state", async () => {
  const calls: string[][] = []

  await runWithTestClock(
    (command) => {
      calls.push([...command])
      if (calls.length === 1) return Effect.never
      if (calls.length === 2) return Effect.fail(new Error("Herdr unavailable"))
      return Effect.void
    },
    (reporter) => Effect.gen(function*() {
      reporter.report("working")
      yield* waitFor(() => calls.length === 1)
      reporter.report("blocked")

      yield* TestClock.adjust(1_000)
      yield* waitFor(() => calls.length === 2)
      reporter.report("idle")
      yield* waitFor(() => calls.length === 3)
    }),
  )

  expect(calls.slice(0, 3)).toEqual([
    reportCommand("working"),
    reportCommand("blocked"),
    reportCommand("idle"),
  ])
})

test("the terminal adapter releases once and ignores reports after shutdown", async () => {
  const calls: string[][] = []

  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const reporter = yield* makeLiveHerdrReporter({
      env: HERDR_ENV,
      execute: (command) => Effect.sync(() => calls.push([...command])),
    })
    const adapter = makeTerminalHerdrReporter(reporter)

    adapter.report("working")
    yield* waitFor(() => calls.length === 1)
    yield* adapter.shutdown
    adapter.report("blocked")
    yield* adapter.shutdown
  })))

  expect(calls).toEqual([
    reportCommand("working"),
    releaseCommand(),
  ])
})

function runWithReporter(
  execute: HerdrCommandExecutor,
  use: (reporter: HerdrReporterApi) => Effect.Effect<void>,
): Promise<void> {
  return Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const reporter = yield* makeLiveHerdrReporter({ env: HERDR_ENV, execute })
    yield* use(reporter)
  })))
}

function runWithTestClock(
  execute: HerdrCommandExecutor,
  use: (reporter: HerdrReporterApi) => Effect.Effect<void, never, TestClock.TestClock>,
): Promise<void> {
  return Effect.runPromise(
    Effect.provide(
      Effect.scoped(Effect.gen(function*() {
        const reporter = yield* makeLiveHerdrReporter({ env: HERDR_ENV, execute })
        yield* use(reporter)
      })),
      TestClock.layer(),
    ),
  )
}

function waitFor(condition: () => boolean): Effect.Effect<void> {
  return Effect.gen(function*() {
    while (!condition()) yield* Effect.yieldNow
  })
}

function reportCommand(activity: string): string[] {
  return [
    "/tmp/herdr",
    "pane",
    "report-agent",
    "pane-7",
    "--source",
    "custom:claude-tree-lifecycle",
    "--agent",
    "claude-tree",
    "--state",
    activity,
  ]
}

function releaseCommand(): string[] {
  return [
    "/tmp/herdr",
    "pane",
    "release-agent",
    "pane-7",
    "--source",
    "custom:claude-tree-lifecycle",
    "--agent",
    "claude-tree",
  ]
}

class UnresponsiveHerdrProcess implements HerdrCommandProcess {
  readonly exited = new Promise<number>(() => {})
  readonly signals: Array<number | NodeJS.Signals> = []
  exitCode: number | null = null
  started = false
  unrefCalls = 0

  kill(signal: number | NodeJS.Signals = "SIGTERM"): void {
    this.signals.push(signal)
  }

  unref(): void {
    this.unrefCalls += 1
  }
}
