import { Effect } from "effect"

import type { TerminalLaunch } from "../../services/provider"
import type {
  TerminalProcess,
  TerminalProcessCallbacks,
  TerminalProcessFactory,
} from "./types"
import { TerminalSpawnCleanupError } from "./types"

const NESTED_HERDR_ENVIRONMENT_KEYS = [
  "HERDR_ENV",
  "HERDR_BIN_PATH",
  "HERDR_SOCKET_PATH",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
] as const

export class BunPtyProcessFactory implements TerminalProcessFactory {
  spawn(
    launch: TerminalLaunch,
    dimensions: { readonly columns: number; readonly rows: number },
    callbacks: TerminalProcessCallbacks,
  ): TerminalProcess {
    let pty: Bun.Terminal | undefined
    let resolvePtyDrained!: () => void
    const ptyDrained = new Promise<void>((resolve) => {
      resolvePtyDrained = resolve
    })
    const environment: NodeJS.ProcessEnv = {
      ...globalThis.process.env,
      ...launch.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    }
    for (const key of NESTED_HERDR_ENVIRONMENT_KEYS) delete environment[key]

    const subprocess = Bun.spawn([...launch.command], {
      cwd: launch.cwd,
      detached: true,
      env: environment,
      terminal: {
        cols: dimensions.columns,
        rows: dimensions.rows,
        data(childPty, data) {
          pty = childPty
          callbacks.onOutput(data)
        },
        exit() {
          resolvePtyDrained()
          callbacks.onPtyClosed()
        },
      },
    })
    pty ??= subprocess.terminal
    if (!pty) {
      const failures: unknown[] = []
      signalGroup(subprocess.pid, "SIGTERM", failures)
      if (isProcessGroupAlive(subprocess.pid)) {
        signalGroup(subprocess.pid, "SIGKILL", failures)
      }
      if (isProcessGroupAlive(subprocess.pid)) {
        subprocess.unref()
        throw new TerminalSpawnCleanupError(
          subprocess.pid,
          `Bun did not create a pseudo-terminal and process group ${subprocess.pid} survived cleanup`,
          failures.length === 0
            ? undefined
            : { cause: failures.length === 1 ? failures[0] : new AggregateError(failures) },
        )
      }
      throw new Error("Bun did not create a pseudo-terminal for the agent")
    }

    return new BunPtyProcess(subprocess, pty, ptyDrained)
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals, failures: unknown[]): void {
  try {
    globalThis.process.kill(-pid, signal)
  } catch (error) {
    if (!isNoSuchProcessError(error)) failures.push(error)
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    globalThis.process.kill(-pid, 0)
    return true
  } catch (error) {
    return !isNoSuchProcessError(error)
  }
}

class BunPtyProcess implements TerminalProcess {
  constructor(
    private readonly subprocess: Bun.Subprocess,
    private readonly pty: Bun.Terminal,
    readonly ptyDrained: Promise<void>,
  ) {}

  get pid(): number {
    return this.subprocess.pid
  }

  get processGroupId(): number {
    return this.subprocess.pid
  }

  get exited(): Promise<number> {
    return this.subprocess.exited
  }

  get exitCode(): number | null {
    return this.subprocess.exitCode
  }

  get ptyOpen(): boolean {
    return !this.pty.closed
  }

  write(data: Uint8Array): void {
    if (!this.pty.closed) this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.pty.closed) this.pty.resize(cols, rows)
  }

  signalGroup(signal: NodeJS.Signals): void {
    try {
      globalThis.process.kill(-this.subprocess.pid, signal)
    } catch (error) {
      if (isNoSuchProcessError(error)) return
      throw error
    }
  }

  isGroupAlive(): boolean {
    try {
      globalThis.process.kill(-this.subprocess.pid, 0)
      return true
    } catch (error) {
      return !isNoSuchProcessError(error)
    }
  }

  waitForGroupExit(timeoutMs: number): Effect.Effect<boolean> {
    return Effect.promise(async () => {
      const deadline = performance.now() + timeoutMs
      while (this.isGroupAlive() && performance.now() < deadline) {
        await Bun.sleep(Math.min(10, Math.max(0, deadline - performance.now())))
      }
      return !this.isGroupAlive()
    })
  }

  closePty(): void {
    if (!this.pty.closed) this.pty.close()
  }

  unref(): void {
    if (this.subprocess.exitCode === null) this.subprocess.unref()
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  )
}
