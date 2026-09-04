#!/usr/bin/env bun

import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { BunRuntime } from "@effect/platform-bun"
import { Cause, Deferred, Effect, Scope } from "effect"

import { CLI_HELP } from "./cli-help"
import { parseCliArguments, resolveProjectDirectory, type CliOptions } from "./cli-options"
import { setProcessTitle } from "./process-title"
import { PROCESS_TITLE_PREFIX, PROGRAM_NAME, PROGRAM_VERSION } from "./program"
import { makeAppRuntime } from "./application"
import { PersistencePlatform, nativePersistencePlatform } from "./infrastructure/metadata/platform"
import { makeLiveHerdrReporter, makeTerminalHerdrReporter } from "./infrastructure/herdr"
import { makeClaudeProvider } from "./infrastructure/providers/claude"
import { createCodexProvider } from "./infrastructure/providers/codex"
import {
  BunPtyProcessFactory,
  OpenTuiTerminalRenderer,
} from "./infrastructure/terminal"
import { makeOpenTuiPresentation, presentationTheme } from "./presentation"
import type { AgentProviderApi } from "./services/provider"
import { makeProviderStateRepository } from "./services/provider-state-repository"
import {
  makeTerminalSupervisor,
  type TerminalSupervisorEvents,
} from "./services/terminal-supervisor"

export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const

export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number]

export interface ShutdownSignalTarget {
  readonly on: (signal: ShutdownSignal, listener: () => void) => unknown
  readonly off: (signal: ShutdownSignal, listener: () => void) => unknown
}

export interface ShutdownSignalResource {
  readonly wait: Effect.Effect<never>
}

export interface TerminalEventBridge {
  readonly events: TerminalSupervisorEvents
  readonly bind: (events: TerminalSupervisorEvents) => void
}

export interface CliProgramEnvironment {
  readonly args: readonly string[]
  readonly stdinIsTTY: boolean
  readonly stdoutIsTTY: boolean
  readonly writeStdout: (value: string) => void
  readonly runApplication: (
    options: Extract<CliOptions, { readonly command: "run" }>,
  ) => Effect.Effect<void, unknown>
}

export function makeCliProgram(environment: CliProgramEnvironment): Effect.Effect<void, unknown> {
  return Effect.gen(function*() {
    const options = yield* Effect.try({
      try: () => parseCliArguments(environment.args),
      catch: toError,
    })
    if (options.command === "help") {
      yield* Effect.sync(() => environment.writeStdout(CLI_HELP))
      return
    }
    if (options.command === "version") {
      yield* Effect.sync(() => environment.writeStdout(`${PROGRAM_NAME} ${PROGRAM_VERSION}\n`))
      return
    }
    if (!environment.stdinIsTTY || !environment.stdoutIsTTY) {
      return yield* Effect.fail(new Error("claude-tree requires an interactive terminal"))
    }
    yield* environment.runApplication(options)
  })
}

export function makeProductionApplication(
  options: Extract<CliOptions, { readonly command: "run" }>,
): Effect.Effect<void, unknown> {
  return runScopedApplication(composeProductionApplication(options), makeShutdownSignals())
}

export function composeProductionApplication(
  options: Extract<CliOptions, { readonly command: "run" }>,
): Effect.Effect<void, unknown, Scope.Scope> {
  return Effect.gen(function*() {
    yield* Effect.sync(() => setProcessTitle(PROCESS_TITLE_PREFIX))
    const projectPath = yield* Effect.tryPromise({
      try: () => resolveProjectDirectory(options.project),
      catch: toError,
    })
    const provider = yield* makeProvider(options.provider, projectPath)
    const renderer = yield* makeOpenTuiRenderer()
    const persistenceOptions = { projectDirectory: projectPath, providerId: provider.id }
    const repository = yield* makeProviderStateRepository(persistenceOptions).pipe(
      Effect.provideService(PersistencePlatform, nativePersistencePlatform),
    )
    const herdr = yield* makeLiveHerdrReporter()
    const bridge = makeTerminalEventBridge()
    const terminals = yield* makeTerminalSupervisor({
      renderer: new OpenTuiTerminalRenderer(renderer),
      processes: new BunPtyProcessFactory(),
      ownership: repository,
      events: bridge.events,
      herdr: makeTerminalHerdrReporter(herdr),
    })
    const appRuntime = yield* makeAppRuntime({ provider, metadata: repository, terminals })
    bridge.bind(appRuntime.terminalEvents)
    const presentation = yield* makeOpenTuiPresentation(renderer, appRuntime, provider, {
      setProcessTitle,
    })

    yield* runPresentationLifecycle(
      presentation.run,
      presentation.wait,
      appRuntime.shutdown,
    )
  })
}

export function runPresentationLifecycle<E, E2>(
  start: Effect.Effect<void, E>,
  wait: Effect.Effect<void, E>,
  shutdown: Effect.Effect<void, E2>,
): Effect.Effect<void, E | E2> {
  return start.pipe(
    Effect.andThen(wait),
    Effect.onInterrupt(() => shutdown),
  )
}

export function runScopedApplication<E>(
  application: Effect.Effect<void, E, Scope.Scope>,
  signals: Effect.Effect<ShutdownSignalResource, unknown, Scope.Scope>,
): Effect.Effect<void, E | unknown> {
  return Effect.scoped(Effect.gen(function*() {
    const shutdown = yield* signals
    yield* Effect.raceFirst(application, shutdown.wait)
  }))
}

export function makeShutdownSignals(
  target: ShutdownSignalTarget = process,
): Effect.Effect<ShutdownSignalResource, Error, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.try({
      try: () => {
        const requested = Deferred.makeUnsafe<ShutdownSignal>()
        const handlers = new Map<ShutdownSignal, () => void>()
        try {
          for (const signal of SHUTDOWN_SIGNALS) {
            const handler = () => {
              Deferred.doneUnsafe(requested, Effect.succeed(signal))
            }
            handlers.set(signal, handler)
            target.on(signal, handler)
          }
        } catch (error) {
          for (const [signal, handler] of handlers) target.off(signal, handler)
          throw error
        }
        return { requested, handlers }
      },
      catch: toError,
    }),
    ({ handlers }) => Effect.sync(() => {
      for (const [signal, handler] of handlers) target.off(signal, handler)
    }),
  ).pipe(
    Effect.map(({ requested }) => ({
      wait: Deferred.await(requested).pipe(Effect.andThen(Effect.interrupt)),
    })),
  )
}

export function makeTerminalEventBridge(): TerminalEventBridge {
  let target: TerminalSupervisorEvents | undefined
  const pending: Array<(events: TerminalSupervisorEvents) => void> = []
  const forward = (dispatch: (events: TerminalSupervisorEvents) => void) => {
    if (target) dispatch(target)
    else pending.push(dispatch)
  }
  return {
    events: {
      onProcessExited: (event) => forward((events) => events.onProcessExited?.(event)),
      onActivityChanged: (event) => forward((events) => events.onActivityChanged?.(event)),
      onSessionChanged: (event) => forward((events) => events.onSessionChanged?.(event)),
      onSessionTransitionError: (event) =>
        forward((events) => events.onSessionTransitionError?.(event)),
      onCleanupError: (error) => forward((events) => events.onCleanupError?.(error)),
    },
    bind(events) {
      if (target) throw new Error("Terminal event bridge is already bound")
      target = events
      for (const dispatch of pending.splice(0)) dispatch(events)
    },
  }
}

export function reportCliFailures<E, A>(
  effect: Effect.Effect<A, E>,
  writeStderr: (value: string) => void = (value) => process.stderr.write(value),
): Effect.Effect<A, E> {
  return Effect.catchCause(effect, (cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
    return Effect.sync(() => {
      writeStderr(`${PROGRAM_NAME}: ${failureMessage(Cause.squash(cause))}\n`)
    }).pipe(Effect.andThen(Effect.failCause(cause)))
  })
}

function makeProvider(
  provider: "claude" | "codex",
  projectPath: string,
): Effect.Effect<AgentProviderApi, unknown> {
  return provider === "codex"
    ? createCodexProvider(projectPath)
    : Effect.succeed(makeClaudeProvider(projectPath))
}

function makeOpenTuiRenderer(): Effect.Effect<CliRenderer, Error, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => createCliRenderer({
        exitOnCtrlC: false,
        exitSignals: [],
        useMouse: true,
        useKittyKeyboard: { events: true },
        backgroundColor: presentationTheme.background,
      }),
      catch: toError,
    }),
    (renderer) => Effect.sync(() => {
      if (!renderer.isDestroyed) renderer.destroy()
    }),
  )
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message)
  }
  return String(error)
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

if (import.meta.main) {
  const program = makeCliProgram({
    args: process.argv.slice(2),
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    writeStdout: (value) => process.stdout.write(value),
    runApplication: makeProductionApplication,
  })
  BunRuntime.runMain(reportCliFailures(program), { disableErrorReporting: true })
}
