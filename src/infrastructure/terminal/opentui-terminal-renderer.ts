import {
  CliRenderEvents,
  EmbeddedTerminalRenderable,
  type CliRenderer,
  type Selection,
} from "@opentui/core"

import type {
  TerminalRenderer,
  TerminalSurface,
  TerminalSurfaceCallbacks,
} from "./types"

const ACTIVE_TERMINAL_Z_INDEX = 10
const INACTIVE_TERMINAL_Z_INDEX = 0

export class OpenTuiTerminalRenderer implements TerminalRenderer {
  private readonly surfaces = new Map<EmbeddedTerminalRenderable, OpenTuiTerminalSurface>()

  constructor(private readonly renderer: CliRenderer) {}

  get columns(): number {
    return Math.max(1, this.renderer.terminalWidth)
  }

  get rows(): number {
    return Math.max(1, this.renderer.terminalHeight)
  }

  createSurface(id: string, callbacks: TerminalSurfaceCallbacks): TerminalSurface {
    const terminal = new EmbeddedTerminalRenderable(this.renderer, {
      id,
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: INACTIVE_TERMINAL_Z_INDEX,
      visible: true,
      opacity: 0,
      cols: this.columns,
      rows: this.rows,
      maxScrollback: 1_000_000,
      onData: callbacks.onData,
      onTerminalResize: callbacks.onResize,
      onScreenChange: callbacks.onScreenChange,
    })
    const surface = new OpenTuiTerminalSurface(id, terminal, () => {
      this.surfaces.delete(terminal)
    })
    this.surfaces.set(terminal, surface)
    try {
      this.renderer.root.add(terminal)
    } catch (cause) {
      try {
        surface.release()
      } catch (rollbackCause) {
        throw new AggregateError([cause, rollbackCause], "Unable to create terminal surface")
      }
      throw cause
    }
    return surface
  }

  clearSelection(): void {
    this.renderer.clearSelection()
  }

  copyToClipboard(text: string): void {
    this.renderer.copyToClipboardOSC52(text)
  }

  onSelection(listener: (surface: TerminalSurface, text: string) => void): () => void {
    const handleSelection = (selection: Selection | null) => {
      if (!selection) return
      for (const renderable of selection.selectedRenderables) {
        if (!(renderable instanceof EmbeddedTerminalRenderable)) continue
        const surface = this.surfaces.get(renderable)
        if (!surface) continue
        const text = selection.getSelectedText()
        if (text.length > 0) listener(surface, text)
        return
      }
    }
    this.renderer.on(CliRenderEvents.SELECTION, handleSelection)
    return () => this.renderer.off(CliRenderEvents.SELECTION, handleSelection)
  }
}

class OpenTuiTerminalSurface implements TerminalSurface {
  private blurred = false
  private detached = false
  private destroyed = false
  private releaseNotified = false

  constructor(
    readonly id: string,
    private readonly terminal: EmbeddedTerminalRenderable,
    private readonly onRelease: () => void,
  ) {}

  write(data: Uint8Array): void {
    this.terminal.write(data)
  }

  screen() {
    const screen = this.terminal.screen()
    return { lines: screen.lines, cursor: screen.cursor }
  }

  focus(): void {
    this.terminal.focus()
  }

  blur(): void {
    this.terminal.blur()
  }

  setActive(active: boolean): void {
    this.terminal.zIndex = active ? ACTIVE_TERMINAL_Z_INDEX : INACTIVE_TERMINAL_Z_INDEX
    this.terminal.opacity = active ? 1 : 0
  }

  release(): void {
    const stages = [
      {
        complete: () => this.blurred,
        release: () => {
          this.terminal.blur()
          this.blurred = true
        },
      },
      {
        complete: () => this.detached,
        release: () => {
          if (this.terminal.parent) this.terminal.parent.remove(this.terminal)
          this.detached = true
        },
      },
      {
        complete: () => this.destroyed,
        release: () => {
          if (!this.terminal.isDestroyed) this.terminal.destroy()
          this.destroyed = true
        },
      },
      {
        complete: () => this.releaseNotified,
        release: () => {
          this.onRelease()
          this.releaseNotified = true
        },
      },
    ]
    const failures: unknown[] = []
    for (const stage of stages) {
      if (stage.complete()) continue
      try {
        stage.release()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, "Unable to release terminal surface")
  }
}
