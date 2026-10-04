import { Context, Deferred, Effect, Fiber, Layer, Queue, Scope } from "effect"
import type { SessionStatus } from "../domain/session-status"
import { PROGRAM_NAME } from "../program"

export const HERDR_SOURCE = "custom:claude-tree-lifecycle"
export const HERDR_AGENT = PROGRAM_NAME
export const HERDR_COMMAND_TIMEOUT_MS = 1_000
export const HERDR_HEARTBEAT_INTERVAL_MS = 10_000
let lastSequence = 0

export interface HerdrResume {
  readonly workspaceId: string
  readonly argv: readonly string[]
  /** Changes in the displayed session must be reported even when activity is unchanged. */
  readonly destination: string
}
export type HerdrCommandExecutor = (command: readonly string[]) => Effect.Effect<void, unknown>
export interface HerdrReporterApi {
  readonly report: (activity: SessionStatus, resume?: HerdrResume) => void
  readonly shutdown: Effect.Effect<void>
}
export interface HerdrReporterOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly execute: HerdrCommandExecutor
}
export class HerdrReporter extends Context.Service<HerdrReporter, HerdrReporterApi>()("claude-tree/HerdrReporter") {}
export const NULL_HERDR_REPORTER: HerdrReporterApi = { report() {}, shutdown: Effect.void }

export function validHerdrResumeArgv(argv: readonly string[]): boolean {
  return argv.length > 0 && argv.length <= 64 && /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(argv[0]!) &&
    argv.every((argument) => !/['\x00-\x1f\x7f-\x9f]/u.test(argument)) &&
    Buffer.byteLength(argv.join("\0")) <= 8 * 1_024
}

export function makeHerdrReporter(options: HerdrReporterOptions): Effect.Effect<HerdrReporterApi, never, Scope.Scope> {
  const env = options.env ?? process.env
  const executable = env.HERDR_BIN_PATH
  const paneId = env.HERDR_PANE_ID
  if (env.HERDR_ENV !== "1" || !executable || !paneId || !env.HERDR_SOCKET_PATH) return Effect.succeed(NULL_HERDR_REPORTER)
  return Effect.gen(function*() {
    type Report = { readonly activity: SessionStatus; readonly resume?: HerdrResume }
    const reports = yield* Queue.sliding<Report>(1)
    let current: Report | undefined
    let currentKey: string | undefined
    let stopping = false
    const nextSequence = () => String(lastSequence = Math.max(Date.now() * 1_000, lastSequence + 1))
    const run = (command: readonly string[]) => options.execute(command).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.timeoutOrElse({ duration: HERDR_COMMAND_TIMEOUT_MS, orElse: () => Effect.void }),
    )
    const command = ({ activity, resume }: Report): readonly string[] => [
      executable, "pane", "report-agent", paneId, "--source", HERDR_SOURCE, "--agent", HERDR_AGENT,
      "--state", activity === "live" || activity === "unviewed" ? "idle" : activity,
      "--seq", nextSequence(),
      ...(activity === "live" ? ["--message", "Live"] : activity === "unviewed" ? ["--message", "New updates"] : []),
      ...(resume && validHerdrResumeArgv(resume.argv) ? ["--agent-session-id", resume.workspaceId, "--", ...resume.argv] : []),
    ]
    const worker = yield* Effect.forkScoped(Effect.forever(Queue.take(reports).pipe(Effect.andThen((report) => run(command(report))))))
    const heartbeat = yield* Effect.forkScoped(Effect.forever(Effect.sleep(HERDR_HEARTBEAT_INTERVAL_MS).pipe(Effect.andThen(Effect.sync(() => {
      if (!stopping && current) Queue.offerUnsafe(reports, current)
    })))))
    const complete = yield* Deferred.make<void>()
    const shutdown = Effect.uninterruptible(Effect.suspend(() => {
      if (stopping) return Deferred.await(complete)
      stopping = true
      return Effect.gen(function*() {
        yield* Fiber.interrupt(heartbeat)
        yield* Fiber.interrupt(worker)
        yield* run([executable, "pane", "release-agent", paneId, "--source", HERDR_SOURCE, "--agent", HERDR_AGENT, "--seq", nextSequence()])
        yield* Deferred.succeed(complete, undefined)
      })
    }))
    yield* Effect.addFinalizer(() => shutdown)
    return {
      report(activity, resume) {
        const key = JSON.stringify([activity, resume])
        if (stopping || currentKey === key) return
        currentKey = key
        current = { activity, ...(resume ? { resume } : {}) }
        Queue.offerUnsafe(reports, current)
      }, shutdown,
    }
  })
}
export function HerdrReporterLayer(options: HerdrReporterOptions): Layer.Layer<HerdrReporter> {
  return Layer.effect(HerdrReporter, makeHerdrReporter(options))
}
