import { Cause, Effect, Exit } from "effect"

export type ProcessGroupCleanupStage = "term" | "wait" | "kill" | "verify"

export interface ProcessGroupCleanupIssue {
  readonly stage: ProcessGroupCleanupStage
  readonly message: string
  readonly cause?: unknown
}

export interface ProcessGroupHandle {
  readonly processGroupId: number
  signalGroup(signal: NodeJS.Signals): void
  isGroupAlive(): boolean
  waitForGroupExit(timeoutMs: number): Effect.Effect<boolean>
}

export interface ProcessGroupCleanupOptions {
  readonly gracePeriodMs: number
  readonly killPeriodMs: number
}

export interface ProcessGroupCleanupResult {
  readonly status: "absent" | "alive" | "unknown"
  readonly issues: readonly ProcessGroupCleanupIssue[]
}

export function cleanupProcessGroup(
  group: ProcessGroupHandle,
  options: ProcessGroupCleanupOptions,
): Effect.Effect<ProcessGroupCleanupResult> {
  return Effect.gen(function*() {
    const issues: ProcessGroupCleanupIssue[] = []
    let liveness = inspectLiveness(group, issues)
    if (liveness === "absent") return { status: "absent", issues }

    signal(group, "SIGTERM", "term", issues)
    yield* wait(group, options.gracePeriodMs, issues)
    liveness = inspectLiveness(group, issues)
    if (liveness === "absent") return { status: "absent", issues }

    signal(group, "SIGKILL", "kill", issues)
    yield* wait(group, options.killPeriodMs, issues)
    liveness = inspectLiveness(group, issues)
    if (liveness === "absent") return { status: "absent", issues }
    if (liveness === "alive") {
      issues.push({
        stage: "verify",
        message: `Process group ${group.processGroupId} did not stop`,
      })
    }
    return { status: liveness, issues }
  })
}

function signal(
  group: ProcessGroupHandle,
  signalName: NodeJS.Signals,
  stage: "term" | "kill",
  issues: ProcessGroupCleanupIssue[],
): void {
  try {
    group.signalGroup(signalName)
  } catch (cause) {
    issues.push({
      stage,
      message: `Unable to send ${signalName} to process group ${group.processGroupId}`,
      cause,
    })
  }
}

function wait(
  group: ProcessGroupHandle,
  timeoutMs: number,
  issues: ProcessGroupCleanupIssue[],
): Effect.Effect<void> {
  return Effect.exit(
    Effect.interruptible(Effect.suspend(() => group.waitForGroupExit(timeoutMs))).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.succeed(false),
      }),
    ),
  ).pipe(
    Effect.map((exit) => {
      if (Exit.isFailure(exit)) {
        issues.push({
          stage: "wait",
          message: `Unable to wait for process group ${group.processGroupId}`,
          cause: Cause.squash(exit.cause),
        })
      }
    }),
  )
}

function inspectLiveness(
  group: ProcessGroupHandle,
  issues: ProcessGroupCleanupIssue[],
): "alive" | "absent" | "unknown" {
  try {
    return group.isGroupAlive() ? "alive" : "absent"
  } catch (cause) {
    issues.push({
      stage: "verify",
      message: `Unable to verify process group ${group.processGroupId}`,
      cause,
    })
    return "unknown"
  }
}
