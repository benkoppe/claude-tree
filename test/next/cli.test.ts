import { EventEmitter } from "node:events"

import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"

import {
  makeCliProgram,
  makeShutdownSignals,
  makeTerminalEventBridge,
  reportCliFailures,
  runScopedApplication,
  SHUTDOWN_SIGNALS,
  type ShutdownSignalTarget,
} from "../../src/cli"
import { PROGRAM_NAME, PROGRAM_VERSION } from "../../src/program"
import type { TerminalActivityEvent } from "../../src/services/terminal-supervisor"

test("help and version bypass TTY and interactive composition", async () => {
  const output: string[] = []
  let runs = 0
  const run = (args: readonly string[]) => Effect.runPromise(makeCliProgram({
    args,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    writeStdout: (value) => output.push(value),
    runApplication: () => Effect.sync(() => {
      runs += 1
    }),
  }))

  await run(["--help"])
  await run(["--version"])

  expect(output[0]).toStartWith("claude-tree [--codex] [PROJECT]\n")
  expect(output[1]).toBe(`${PROGRAM_NAME} ${PROGRAM_VERSION}\n`)
  expect(runs).toBe(0)
})

test("non-interactive execution fails before composition", async () => {
  let runs = 0
  const exit = await Effect.runPromiseExit(makeCliProgram({
    args: [],
    stdinIsTTY: false,
    stdoutIsTTY: true,
    writeStdout() {},
    runApplication: () => Effect.sync(() => {
      runs += 1
    }),
  }))

  expect(Exit.isFailure(exit)).toBeTrue()
  expect(runs).toBe(0)
})

test("terminal callback bridge preserves events emitted during runtime startup", () => {
  const bridge = makeTerminalEventBridge()
  const observed: string[] = []
  bridge.events.onActivityChanged?.({
    sessionId: "startup",
    activity: "working",
    wasActive: true,
  })
  bridge.bind({
    onActivityChanged: (event) => observed.push(`${event.sessionId}:${event.activity}`),
  })
  bridge.events.onActivityChanged?.({
    sessionId: "running",
    activity: "idle",
    wasActive: false,
  } satisfies TerminalActivityEvent)

  expect(observed).toEqual(["startup:working", "running:idle"])
  expect(() => bridge.bind({})).toThrow("already bound")
})

test("all shutdown signals interrupt the scoped application and remove listeners", async () => {
  for (const signal of SHUTDOWN_SIGNALS) {
    const emitter = new EventEmitter()
    let acquired = 0
    let released = 0
    const application = Effect.acquireRelease(
      Effect.sync(() => {
        acquired += 1
      }),
      () => Effect.sync(() => {
        released += 1
      }),
    ).pipe(Effect.andThen(Effect.never))
    const running = Effect.runPromiseExit(
      runScopedApplication(application, makeShutdownSignals(emitter as ShutdownSignalTarget)),
    )
    while (acquired === 0) await Bun.sleep(1)

    emitter.emit(signal)
    const exit = await running

    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
    expect(released).toBe(1)
    expect(emitter.eventNames()).toEqual([])
  }
})

test("partial startup failure releases acquired resources exactly once", async () => {
  let releases = 0
  const application = Effect.acquireRelease(
    Effect.void,
    () => Effect.sync(() => {
      releases += 1
    }),
  ).pipe(
    Effect.andThen(Effect.fail(new Error("startup failed"))),
  )
  const signals = Effect.succeed({ wait: Effect.never as Effect.Effect<never> })

  const exit = await Effect.runPromiseExit(runScopedApplication(application, signals))

  expect(Exit.isFailure(exit)).toBeTrue()
  expect(releases).toBe(1)
})

test("failure reporting emits one concise line and preserves failure", async () => {
  const output: string[] = []
  const exit = await Effect.runPromiseExit(
    reportCliFailures(Effect.fail(new Error("broken startup")), (value) => output.push(value)),
  )

  expect(Exit.isFailure(exit)).toBeTrue()
  expect(output).toEqual([`${PROGRAM_NAME}: broken startup\n`])
})
