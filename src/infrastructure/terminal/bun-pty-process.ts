import { stripVTControlCharacters } from "node:util"

import { Effect } from "effect"
import { isProcessGroupAlive, waitForProcessGroupExit } from "../process-group"

import type { TerminalLaunch } from "../../services/provider"
import type {
  TerminalProcess,
  TerminalProcessCallbacks,
  TerminalProcessFactory,
  TerminalOutputSettlement,
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

const OUTPUT_TAIL_BYTES = 8 * 1_024

export class BunPtyProcessFactory implements TerminalProcessFactory {
  spawn(
    launch: TerminalLaunch,
    dimensions: { readonly columns: number; readonly rows: number },
    callbacks: TerminalProcessCallbacks,
  ): TerminalProcess {
    let pty: Bun.Terminal | undefined
    let outputTail = Buffer.alloc(0)
    let resolveOutput!: (settlement: TerminalOutputSettlement) => void
    let outputSettled = false
    const ptyOutput = new Promise<TerminalOutputSettlement>((resolve) => {
      resolveOutput = resolve
    })
    const settleOutput = (settlement: TerminalOutputSettlement) => {
      if (outputSettled) return
      outputSettled = true
      resolveOutput(settlement)
    }
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
          const combined = Buffer.concat([outputTail, data.subarray(-OUTPUT_TAIL_BYTES)])
          let start = Math.max(0, combined.length - OUTPUT_TAIL_BYTES)
          while (start < combined.length && (combined[start]! & 0xC0) === 0x80) start += 1
          outputTail = Buffer.from(combined.subarray(start))
          callbacks.onOutput(data)
        },
        exit(terminal, status) {
          // Bun also invokes exit on explicit close; that is not drain evidence.
          settleOutput(terminal.closed ? { _tag: "Closed" } : {
            _tag: "Ended", status: status === 0 ? "eof" : "error-or-hangup",
          })
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

    return new BunPtyProcess(subprocess, pty, ptyOutput, settleOutput, () => stripVTControlCharacters(outputTail.toString("utf8"))
      .replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim())
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals, failures: unknown[]): void {
  try {
    globalThis.process.kill(-pid, signal)
  } catch (error) {
    if (!isNoSuchProcessError(error)) failures.push(error)
  }
}

class BunPtyProcess implements TerminalProcess {
  constructor(
    private readonly subprocess: Bun.Subprocess,
    private readonly pty: Bun.Terminal,
    readonly ptyOutput: Promise<TerminalOutputSettlement>,
    private readonly settleOutput: (settlement: TerminalOutputSettlement) => void,
    private readonly readOutputTail: () => string,
  ) {}

  get outputTail(): string {
    return this.readOutputTail()
  }

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
    return isProcessGroupAlive(this.subprocess.pid)
  }

  waitForGroupExit(timeoutMs: number): Effect.Effect<boolean> {
    return waitForProcessGroupExit(() => this.isGroupAlive(), timeoutMs)
  }

  closePty(): void {
    if (!this.pty.closed) this.pty.close()
    if (this.pty.closed) this.settleOutput({ _tag: "Closed" })
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
