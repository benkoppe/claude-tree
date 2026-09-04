import { Effect, Layer, Scope } from "effect"

import {
  HerdrReporter,
  makeHerdrReporter,
  type HerdrCommandExecutor,
  type HerdrReporterApi,
} from "../../services/herdr"
import type { TerminalHerdrReporter } from "../../services/terminal-supervisor"

export const HERDR_PROCESS_CLEANUP_PERIOD_MS = 100

export interface HerdrCommandProcess {
  readonly exitCode: number | null
  readonly exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
  unref(): void
}

export type HerdrCommandSpawner = (
  command: readonly string[],
) => HerdrCommandProcess

export interface HerdrLiveOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly execute?: HerdrCommandExecutor
}

export function makeLiveHerdrReporter(
  options: HerdrLiveOptions = {},
): Effect.Effect<HerdrReporterApi, never, Scope.Scope> {
  return makeHerdrReporter({
    ...(options.env === undefined ? {} : { env: options.env }),
    execute: options.execute ?? runHerdrCommand,
  })
}

export function HerdrReporterLive(options: HerdrLiveOptions = {}): Layer.Layer<HerdrReporter> {
  return Layer.effect(HerdrReporter, makeLiveHerdrReporter(options))
}

export function makeTerminalHerdrReporter(
  reporter: HerdrReporterApi,
): TerminalHerdrReporter {
  return {
    report: reporter.report,
    shutdown: reporter.shutdown,
  }
}

export function makeHerdrCommandExecutor(
  spawn: HerdrCommandSpawner = spawnHerdrCommand,
): HerdrCommandExecutor {
  return (command) =>
    Effect.acquireUseRelease(
      Effect.try({
        try: () => spawn(command),
        catch: toError,
      }),
      (subprocess) =>
        Effect.tryPromise({
          try: () => subprocess.exited,
          catch: toError,
        }).pipe(
          Effect.flatMap((exitCode) =>
            exitCode === 0
              ? Effect.void
              : Effect.fail(new Error(`Herdr exited with status ${exitCode}`))
          ),
        ),
      cleanupHerdrProcess,
    )
}

export const runHerdrCommand = makeHerdrCommandExecutor()

function spawnHerdrCommand(command: readonly string[]): HerdrCommandProcess {
  return Bun.spawn([...command], { stdout: "ignore", stderr: "ignore" })
}

function cleanupHerdrProcess(subprocess: HerdrCommandProcess): Effect.Effect<void, Error> {
  const terminate = Effect.gen(function*() {
    if (subprocess.exitCode === null) {
      yield* signal(subprocess, "SIGTERM")
      yield* waitForExit(subprocess)
    }
    if (subprocess.exitCode === null) {
      yield* signal(subprocess, "SIGKILL")
      yield* waitForExit(subprocess)
    }
    if (subprocess.exitCode === null) {
      return yield* Effect.fail(new Error("Herdr command did not exit after SIGKILL"))
    }
  })
  return terminate.pipe(
    Effect.ensuring(
      Effect.try({
        try: () => subprocess.unref(),
        catch: toError,
      }).pipe(Effect.ignore),
    ),
  )
}

function signal(
  subprocess: HerdrCommandProcess,
  signalName: NodeJS.Signals,
): Effect.Effect<void> {
  return Effect.try({
    try: () => subprocess.kill(signalName),
    catch: toError,
  }).pipe(Effect.ignore)
}

function waitForExit(subprocess: HerdrCommandProcess): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => subprocess.exited,
    catch: toError,
  }).pipe(
    Effect.asVoid,
    Effect.catch(() => Effect.void),
    Effect.timeoutOrElse({
      duration: HERDR_PROCESS_CLEANUP_PERIOD_MS,
      orElse: () => Effect.void,
    }),
  )
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}
