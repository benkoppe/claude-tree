import { Effect, Layer, Scope } from "effect"

import {
  HerdrReporter,
  makeHerdrReporter,
  type HerdrCommandExecutor,
  type HerdrReporterApi,
} from "../../services/herdr"
import type { TerminalHerdrReporter } from "../../services/terminal-supervisor"

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

export const runHerdrCommand: HerdrCommandExecutor = (command) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => Bun.spawn([...command], { stdout: "ignore", stderr: "ignore" }),
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
    (subprocess) =>
      Effect.try({
        try: () => {
          if (subprocess.exitCode === null) subprocess.kill()
        },
        catch: toError,
      }).pipe(Effect.ignore),
  )

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}
