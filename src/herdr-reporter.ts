import type { AgentActivity } from "./agent-provider"

const HERDR_SOURCE = "custom:claude-tree-lifecycle"
const HERDR_AGENT = "claude-tree"
const REPORT_TIMEOUT_MS = 1_000
const REASSERT_DELAYS_MS = [250, 1_500] as const
const HEARTBEAT_INTERVAL_MS = 10_000

export interface HerdrReporter {
  report(activity: AgentActivity): void
  shutdown(): Promise<void>
}

export const NULL_HERDR_REPORTER: HerdrReporter = {
  report() {},
  async shutdown() {},
}

interface HerdrReporterDependencies {
  env?: NodeJS.ProcessEnv
  run?: (command: string[]) => Promise<void>
}

export function createHerdrReporter(
  dependencies: HerdrReporterDependencies = {},
): HerdrReporter {
  const env = dependencies.env ?? process.env
  const executable = env.HERDR_BIN_PATH
  const paneId = env.HERDR_PANE_ID
  if (env.HERDR_ENV !== "1" || !executable || !paneId) return NULL_HERDR_REPORTER
  return new CliHerdrReporter(
    executable,
    paneId,
    dependencies.run ?? runHerdrCommand,
  )
}

class CliHerdrReporter implements HerdrReporter {
  private readonly queue: AgentActivity[] = []
  private readonly reassertTimers = new Set<ReturnType<typeof setTimeout>>()
  private worker: Promise<void> | undefined
  private shutdownPromise: Promise<void> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private currentActivity: AgentActivity | undefined
  private stopping = false

  constructor(
    private readonly executable: string,
    private readonly paneId: string,
    private readonly run: (command: string[]) => Promise<void>,
  ) {}

  report(activity: AgentActivity): void {
    if (this.stopping || activity === this.currentActivity) return
    this.currentActivity = activity
    this.enqueue(activity)
    this.scheduleReassertions()
    this.startHeartbeat()
  }

  private enqueue(activity: AgentActivity): void {
    this.queue.push(activity)
    this.startWorker()
  }

  private scheduleReassertions(): void {
    for (const timer of this.reassertTimers) clearTimeout(timer)
    this.reassertTimers.clear()
    for (const delay of REASSERT_DELAYS_MS) {
      const timer = setTimeout(() => {
        this.reassertTimers.delete(timer)
        if (!this.stopping && this.currentActivity) this.enqueue(this.currentActivity)
      }, delay)
      timer.unref()
      this.reassertTimers.add(timer)
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      if (this.currentActivity) this.enqueue(this.currentActivity)
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref()
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown()
    return this.shutdownPromise
  }

  private startWorker(): void {
    if (this.worker) return
    this.worker = this.drain().finally(() => {
      this.worker = undefined
      if (!this.stopping && this.queue.length > 0) this.startWorker()
    })
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      const activity = this.queue.shift()
      if (!activity) return
      await this.run([
        this.executable,
        "pane",
        "report-agent",
        this.paneId,
        "--source",
        HERDR_SOURCE,
        "--agent",
        HERDR_AGENT,
        "--state",
        activity,
      ]).catch(() => undefined)
    }
  }

  private async performShutdown(): Promise<void> {
    this.stopping = true
    for (const timer of this.reassertTimers) clearTimeout(timer)
    this.reassertTimers.clear()
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.queue.length = 0
    await this.worker?.catch(() => undefined)
    await this.run([
      this.executable,
      "pane",
      "release-agent",
      this.paneId,
      "--source",
      HERDR_SOURCE,
      "--agent",
      HERDR_AGENT,
    ]).catch(() => undefined)
  }
}

async function runHerdrCommand(command: string[]): Promise<void> {
  const subprocess = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const exitCode = await Promise.race([
      subprocess.exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Herdr report timed out")), REPORT_TIMEOUT_MS)
      }),
    ])
    if (exitCode !== 0) {
      const stderr = await new Response(subprocess.stderr).text()
      throw new Error(stderr.trim() || `Herdr exited with status ${exitCode}`)
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    if (subprocess.exitCode === null) subprocess.kill()
  }
}
