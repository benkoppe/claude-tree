import type { Effect } from "effect"

import type { TerminalScreen } from "../../domain/model"
import type { TerminalLaunch } from "../../services/provider"

export interface TerminalSurfaceCallbacks {
  readonly onData: (data: Uint8Array, source: "input" | "response") => void
  readonly onResize: (cols: number, rows: number) => void
  readonly onScreenChange: () => void
}

export interface TerminalSurface {
  readonly id: string
  write(data: Uint8Array): void
  screen(): TerminalScreen
  focus(): void
  blur(): void
  setActive(active: boolean): void
  release(): void
}

export interface TerminalRenderer {
  readonly columns: number
  readonly rows: number
  createSurface(id: string, callbacks: TerminalSurfaceCallbacks): TerminalSurface
  clearSelection(): void
  copyToClipboard(text: string): void
  onSelection(listener: (surface: TerminalSurface, text: string) => void): () => void
}

export interface TerminalProcessCallbacks {
  readonly onOutput: (data: Uint8Array) => void
  readonly onPtyClosed: () => void
}

export interface TerminalProcess {
  readonly pid: number
  readonly processGroupId: number
  readonly exited: Promise<number>
  readonly ptyDrained: Promise<void>
  readonly exitCode: number | null
  readonly ptyOpen: boolean
  write(data: Uint8Array): void
  resize(cols: number, rows: number): void
  signalGroup(signal: NodeJS.Signals): void
  isGroupAlive(): boolean
  waitForGroupExit(timeoutMs: number): Effect.Effect<boolean>
  closePty(): void
  unref(): void
}

export interface TerminalProcessFactory {
  spawn(
    launch: TerminalLaunch,
    dimensions: { readonly columns: number; readonly rows: number },
    callbacks: TerminalProcessCallbacks,
  ): TerminalProcess
}

export class TerminalSpawnCleanupError extends Error {
  readonly name = "TerminalSpawnCleanupError"

  constructor(
    readonly processGroupId: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
