import { EventEmitter } from "node:events"

import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect"

import {
  composeApplicationLifecycle,
  makeCliProgram,
  makeShutdownSignals,
  makeTerminalEventBridge,
  reportCliFailures,
  runPresentationLifecycle,
  runScopedApplication,
  SHUTDOWN_SIGNALS,
  type ShutdownSignalTarget,
} from "../../src/cli"
import { PROGRAM_NAME, PROGRAM_VERSION } from "../../src/program"
import { TerminalCleanupError, type TerminalActivityEvent } from "../../src/services/terminal-supervisor"

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
  expect(output[0]).toContain("Message tree:")
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
    ownerId: "owner-startup",
    sequenceId: 1,
    sessionId: "startup",
    activity: "working",
    wasActive: true,
  })
  bridge.events.onObservation?.({
    ownerId: "owner-startup", sequenceId: 2, sessionId: "startup", wasActive: true,
    observation: { _tag: "Submission", text: "replacement" },
  })
  bridge.bind({
    onActivityChanged: (event) => observed.push(`${event.sessionId}:${event.activity}`),
    onObservation: (event) => observed.push(`${event.sessionId}:${event.observation._tag}`),
  })
  bridge.events.onActivityChanged?.({
    ownerId: "owner-running",
    sequenceId: 1,
    sessionId: "running",
    activity: "idle",
    wasActive: false,
  } satisfies TerminalActivityEvent)

  bridge.events.onObservation?.({
    ownerId: "owner-running", sequenceId: 2, sessionId: "running", wasActive: false,
    observation: { _tag: "Draft", draft: null },
  })
  expect(observed).toEqual(["startup:working", "startup:Submission", "running:idle", "running:Draft"])
  expect(() => bridge.bind({})).toThrow("already bound")
})

test("all shutdown signals interrupt the scoped application and remove listeners", async () => {
  for (const signal of SHUTDOWN_SIGNALS) {
    const stderr: string[] = []
    const emitter = new EventEmitter()
    let acquired = 0
    let released = 0
    const ready = Deferred.makeUnsafe<void>()
    const application = Effect.acquireRelease(
      Effect.sync(() => {
        acquired += 1
        Deferred.doneUnsafe(ready, Effect.void)
      }),
      () => Effect.sync(() => {
        released += 1
      }),
    ).pipe(Effect.andThen(Effect.never))
    const running = Effect.runPromiseExit(
      reportCliFailures(runScopedApplication(application, makeShutdownSignals(emitter as ShutdownSignalTarget)), (text) => stderr.push(text)),
    )
    await Effect.runPromise(Deferred.await(ready))

    emitter.emit(signal)
    const exit = await running

    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
    expect(released).toBe(1)
    expect(emitter.eventNames()).toEqual([])
    expect(stderr).toEqual([])
  }
})

test("presentation interruption invokes direct runtime shutdown before teardown", async () => {
  const started = Deferred.makeUnsafe<void, never>()
  const shutdownStarted = Deferred.makeUnsafe<void, never>()
  const finishShutdown = Deferred.makeUnsafe<void, never>()
  let shutdowns = 0

  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const lifecycle = yield* Effect.forkScoped(runPresentationLifecycle(
      Deferred.succeed(started, undefined),
      Effect.never,
      Effect.gen(function*() {
        shutdowns += 1
        yield* Deferred.succeed(shutdownStarted, undefined)
        yield* Deferred.await(finishShutdown)
      }),
    ))
    yield* Deferred.await(started)
    const interruption = yield* Effect.forkScoped(Fiber.interrupt(lifecycle))
    yield* Deferred.await(shutdownStarted)
    expect(interruption.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(finishShutdown, undefined)
    yield* Fiber.join(interruption)
    return yield* Fiber.await(lifecycle)
  })))

  expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBeTrue()
  expect(shutdowns).toBe(1)
})

test("production lifecycle starts presentation before deferred runtime discovery completes", async () => {
  const discoveryStarted = Deferred.makeUnsafe<void, never>()
  const releaseDiscovery = Deferred.makeUnsafe<void, never>()
  const presentationStarted = Deferred.makeUnsafe<void, never>()
  const shutdownStarted = Deferred.makeUnsafe<void, never>()

  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const lifecycle = yield* Effect.forkScoped(composeApplicationLifecycle(
      Effect.gen(function*() {
        yield* Effect.forkScoped(Effect.gen(function*() {
          yield* Deferred.succeed(discoveryStarted, undefined)
          yield* Deferred.await(releaseDiscovery)
        }))
        return {
          shutdown: Deferred.succeed(shutdownStarted, undefined),
        }
      }),
      () => Effect.succeed({
        run: Deferred.succeed(presentationStarted, undefined),
        wait: Effect.never,
      }),
    ))
    yield* Deferred.await(discoveryStarted)
    yield* Deferred.await(presentationStarted)
    expect(Option.isNone(yield* Deferred.poll(releaseDiscovery))).toBeTrue()
    const interruption = yield* Effect.forkScoped(Fiber.interrupt(lifecycle))
    yield* Deferred.await(shutdownStarted)
    yield* Deferred.succeed(releaseDiscovery, undefined)
    yield* Fiber.join(interruption)
    return yield* Fiber.await(lifecycle)
  })))

  expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBeTrue()
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

test("successful CLI completion stays silent and blank errors get a fallback", async () => {
  const output: string[] = []
  await Effect.runPromise(reportCliFailures(Effect.void, (text) => output.push(text)))
  expect(output).toEqual([])
  const error = new Error(" \n ")
  const exit = await Effect.runPromiseExit(reportCliFailures(Effect.fail(error), (text) => output.push(text)))
  expect(Exit.findErrorOption(exit).pipe(Option.getOrThrow)).toBe(error)
  expect(output).toEqual([`${PROGRAM_NAME}: Error\n`])
})

test("CLI reporting retains compound failures and prints a repeated backstop error only once", async () => {
  const first = new Error("application failed")
  const second = new Error("scope cleanup failed")
  for (const finalizerError of [first, second]) {
    const output: string[] = []
    const failure = Effect.fail(first).pipe(Effect.ensuring(Effect.die(finalizerError)))
    const exit = await Effect.runPromiseExit(reportCliFailures(failure, (text) => output.push(text)))
    expect(Exit.isFailure(exit)).toBeTrue()
    if (Exit.isFailure(exit)) expect(exit.cause.reasons).toHaveLength(2)
    expect(output).toEqual([finalizerError === first
      ? `${PROGRAM_NAME}: application failed\n`
      : `${PROGRAM_NAME}: application failed\nscope cleanup failed\n`])
  }
})

test("signal interruption accompanied by scoped cleanup failure reports the failure", async () => {
  const emitter = new EventEmitter()
  const ready = Deferred.makeUnsafe<void>()
  const output: string[] = []
  const cleanup = new TerminalCleanupError({ operation: "shutdown", issues: [{
    ownerId: "owner", sessionId: "signal-session", stage: "verify", message: "Process group 123 did not stop",
  }] })
  const lifecycle = Effect.gen(function*() {
    yield* Effect.addFinalizer(() => Effect.die(cleanup))
    yield* Deferred.succeed(ready, undefined)
    yield* Effect.never
  })
  const running = Effect.runPromiseExit(reportCliFailures(
    runScopedApplication(lifecycle, makeShutdownSignals(emitter as ShutdownSignalTarget)),
    (text) => output.push(text),
  ))
  await Effect.runPromise(Deferred.await(ready))
  emitter.emit("SIGTERM")
  const exit = await running
  expect(Exit.isFailure(exit)).toBeTrue()
  expect(output).toHaveLength(1)
  expect(output[0]).toContain("signal-session [verify]")
  expect(output[0]).toContain("Process group 123 did not stop")
  expect(emitter.eventNames()).toEqual([])
})
