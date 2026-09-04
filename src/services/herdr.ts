import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Queue,
  Scope,
} from "effect"

import type { AgentActivity } from "../domain/model"

export const HERDR_SOURCE = "custom:claude-tree-lifecycle"
export const HERDR_AGENT = "claude-tree"
export const HERDR_COMMAND_TIMEOUT_MS = 1_000
export const HERDR_REASSERT_DELAYS_MS = [250, 1_500] as const
export const HERDR_HEARTBEAT_INTERVAL_MS = 10_000

export type HerdrCommandExecutor = (
  command: readonly string[],
) => Effect.Effect<void, unknown>

export interface HerdrReporterApi {
  readonly report: (activity: AgentActivity) => void
  readonly shutdown: Effect.Effect<void>
}

export interface HerdrReporterOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly execute: HerdrCommandExecutor
}

export class HerdrReporter extends Context.Service<HerdrReporter, HerdrReporterApi>()(
  "claude-tree/HerdrReporter",
) {}

export const NULL_HERDR_REPORTER: HerdrReporterApi = {
  report() {},
  shutdown: Effect.void,
}

export function makeHerdrReporter(
  options: HerdrReporterOptions,
): Effect.Effect<HerdrReporterApi, never, Scope.Scope> {
  const env = options.env ?? process.env
  const executable = env.HERDR_BIN_PATH
  const paneId = env.HERDR_PANE_ID
  if (env.HERDR_ENV !== "1" || !executable || !paneId) {
    return Effect.succeed(NULL_HERDR_REPORTER)
  }

  return makeEnabledHerdrReporter(executable, paneId, options.execute)
}

export function HerdrReporterLayer(options: HerdrReporterOptions): Layer.Layer<HerdrReporter> {
  return Layer.effect(HerdrReporter, makeHerdrReporter(options))
}

function makeEnabledHerdrReporter(
  executable: string,
  paneId: string,
  execute: HerdrCommandExecutor,
): Effect.Effect<HerdrReporterApi, never, Scope.Scope> {
  return Effect.gen(function*() {
    const transitions = yield* Queue.unbounded<AgentActivity>()
    const reports = yield* Queue.sliding<AgentActivity>(1)
    const shutdownRequested = yield* Deferred.make<void>()
    const shutdownComplete = yield* Deferred.make<void>()
    let currentActivity: AgentActivity | undefined
    let stopping = false

    const reportCommand = (activity: AgentActivity): readonly string[] => [
      executable,
      "pane",
      "report-agent",
      paneId,
      "--source",
      HERDR_SOURCE,
      "--agent",
      HERDR_AGENT,
      "--state",
      activity,
    ]
    const releaseCommand: readonly string[] = [
      executable,
      "pane",
      "release-agent",
      paneId,
      "--source",
      HERDR_SOURCE,
      "--agent",
      HERDR_AGENT,
    ]
    const runCommand = (command: readonly string[]) =>
      execute(command).pipe(
        Effect.catch(() => Effect.void),
        Effect.timeoutOrElse({
          duration: HERDR_COMMAND_TIMEOUT_MS,
          orElse: () => Effect.void,
        }),
      )
    const enqueueCurrent = (activity: AgentActivity) =>
      Effect.sync(() => {
        if (!stopping && currentActivity === activity) Queue.offerUnsafe(reports, activity)
      })

    type TimerResult =
      | { readonly _tag: "Transition"; readonly activity: AgentActivity }
      | { readonly _tag: "Elapsed" }

    const transitionBefore = (delay: number): Effect.Effect<TimerResult> =>
      Effect.raceFirst(
        Queue.take(transitions).pipe(
          Effect.map((activity): TimerResult => ({ _tag: "Transition", activity })),
        ),
        Effect.sleep(delay).pipe(
          Effect.as<TimerResult>({ _tag: "Elapsed" }),
        ),
      )

    const scheduleTransition = (activity: AgentActivity): Effect.Effect<void> =>
      Effect.suspend(() =>
        enqueueCurrent(activity).pipe(
          Effect.andThen(transitionBefore(HERDR_REASSERT_DELAYS_MS[0])),
          Effect.flatMap((first) => {
            if (first._tag === "Transition") return scheduleTransition(first.activity)
            return enqueueCurrent(activity).pipe(
              Effect.andThen(
                transitionBefore(
                  HERDR_REASSERT_DELAYS_MS[1] - HERDR_REASSERT_DELAYS_MS[0],
                ),
              ),
              Effect.flatMap((second) => {
                if (second._tag === "Transition") return scheduleTransition(second.activity)
                return enqueueCurrent(activity).pipe(
                  Effect.andThen(Queue.take(transitions)),
                  Effect.flatMap(scheduleTransition),
                )
              }),
            )
          }),
        )
      )

    const transitionFiber = yield* Effect.forkScoped(
      Queue.take(transitions).pipe(Effect.flatMap(scheduleTransition)),
      { startImmediately: true },
    )
    const commandFiber = yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(reports).pipe(
          Effect.flatMap((activity) => runCommand(reportCommand(activity))),
        ),
      ),
      { startImmediately: true },
    )
    const heartbeatFiber = yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(HERDR_HEARTBEAT_INTERVAL_MS).pipe(
          Effect.andThen(
            Effect.sync(() => currentActivity).pipe(
              Effect.flatMap((activity) =>
                activity === undefined ? Effect.void : enqueueCurrent(activity)
              ),
            ),
          ),
        ),
      ),
      { startImmediately: true },
    )

    const performShutdown = Effect.gen(function*() {
      yield* Deferred.await(shutdownRequested)
      yield* Fiber.interrupt(transitionFiber)
      yield* Fiber.interrupt(heartbeatFiber)
      yield* Fiber.interrupt(commandFiber)
      yield* runCommand(releaseCommand)
      yield* Deferred.succeed(shutdownComplete, undefined)
    })
    yield* Effect.forkScoped(performShutdown, { startImmediately: true })

    const shutdown = Effect.sync(() => {
      stopping = true
    }).pipe(
      Effect.andThen(Deferred.succeed(shutdownRequested, undefined)),
      Effect.andThen(Deferred.await(shutdownComplete)),
    )
    const reporter: HerdrReporterApi = {
      report(activity) {
        if (stopping || activity === currentActivity) return
        currentActivity = activity
        Queue.offerUnsafe(transitions, activity)
      },
      shutdown,
    }

    yield* Effect.addFinalizer(() => shutdown)
    return reporter
  })
}
