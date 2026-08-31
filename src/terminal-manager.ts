import {
  CliRenderEvents,
  EmbeddedTerminalRenderable,
  type CliRenderer,
  type EmbeddedTerminalScreen,
  type Selection,
} from "@opentui/core"

import { Osc52Forwarder } from "./clipboard"
import { OscSequenceParser } from "./osc"

interface ManagedTerminal {
  sessionId: string
  process: Bun.Subprocess
  pty: Bun.Terminal
  terminal: EmbeddedTerminalRenderable
  exitCode: number | null
  draftPreview?: DraftPreview
  inputObserved: boolean
  generating: boolean
}

export type TerminalLaunch =
  | { kind: "new"; sessionId: string; prefillText?: string }
  | { kind: "resume"; sessionId: string; prefillText?: string }

export interface DraftPreview {
  text: string
  exact: boolean
}

export interface TerminalExitEvent {
  sessionId: string
  exitCode: number
  wasActive: boolean
}

export interface TerminalActivityEvent {
  sessionId: string
  generating: boolean
}

export class TerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>()
  private activeSessionId: string | null = null
  private shuttingDown = false

  constructor(
    private readonly renderer: CliRenderer,
    private readonly projectPath: string,
    private readonly claudeExecutable: string,
    private readonly onProcessExited: (event: TerminalExitEvent) => void,
    private readonly onActivityChanged: (event: TerminalActivityEvent) => void = () => undefined,
  ) {
    renderer.on(CliRenderEvents.SELECTION, this.onSelection)
  }

  async show(launch: TerminalLaunch): Promise<void> {
    if (this.shuttingDown) {
      throw new Error("Cannot open a Claude session while claude-tree is shutting down")
    }
    let managed = this.terminals.get(launch.sessionId)
    if (managed && managed.exitCode !== null) {
      this.destroyTerminal(managed)
      this.terminals.delete(launch.sessionId)
      managed = undefined
    }
    if (!managed) {
      managed = this.spawn(launch)
      this.terminals.set(launch.sessionId, managed)
    }

    if (this.activeSessionId) {
      const active = this.terminals.get(this.activeSessionId)
      this.activeSessionId = null
      this.renderer.clearSelection()
      if (active) this.captureDraft(active)
      active?.terminal.blur()
      if (active) active.terminal.visible = false
    }

    managed.terminal.visible = true
    managed.terminal.focus()
    this.activeSessionId = managed.sessionId
  }

  hideActive(): string | null {
    const previous = this.activeSessionId
    this.activeSessionId = null
    this.renderer.clearSelection()
    if (previous) {
      const managed = this.terminals.get(previous)
      if (managed) this.captureDraft(managed)
      managed?.terminal.blur()
      if (managed) managed.terminal.visible = false
    }
    this.pruneExited()
    return previous
  }

  runningSessionIds(): Set<string> {
    return new Set(
      [...this.terminals.values()]
        .filter((managed) => managed.exitCode === null)
        .map((managed) => managed.sessionId),
    )
  }

  draftPreviews(): Map<string, DraftPreview> {
    return new Map(
      [...this.terminals.values()]
        .filter((managed) => managed.exitCode === null && managed.draftPreview !== undefined)
        .map((managed) => [managed.sessionId, managed.draftPreview!]),
    )
  }

  generatingSessionIds(): Set<string> {
    return new Set(
      [...this.terminals.values()]
        .filter((managed) => managed.exitCode === null && managed.generating)
        .map((managed) => managed.sessionId),
    )
  }

  async shutdown(gracePeriodMs = 1_500): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.renderer.off(CliRenderEvents.SELECTION, this.onSelection)
    this.hideActive()

    const running = [...this.terminals.values()].filter((managed) => managed.exitCode === null)
    for (const managed of running) managed.process.kill("SIGTERM")

    if (running.length > 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled(running.map((managed) => managed.process.exited)),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, gracePeriodMs)
        }),
      ])
      if (timeout) clearTimeout(timeout)
    }

    for (const managed of running) {
      if (managed.exitCode === null) managed.process.kill("SIGKILL")
    }
    await Promise.allSettled(running.map((managed) => managed.process.exited))

    for (const managed of this.terminals.values()) this.destroyTerminal(managed)
    this.terminals.clear()
  }

  private spawn(launch: TerminalLaunch): ManagedTerminal {
    if (launch.prefillText?.includes("\0")) {
      throw new Error("Claude prompt prefill cannot contain a null byte")
    }
    const cols = Math.max(1, this.renderer.terminalWidth)
    const rows = Math.max(1, this.renderer.terminalHeight)
    let pty: Bun.Terminal | undefined
    const osc52 = new Osc52Forwarder()
    const activityObserver = new ClaudeActivityObserver()
    const renderer = this.renderer
    const manager = this
    let resolvePtyClosed!: () => void
    const ptyClosed = new Promise<void>((resolve) => {
      resolvePtyClosed = resolve
    })

    let managed: ManagedTerminal | undefined
    const terminal = new EmbeddedTerminalRenderable(this.renderer, {
      id: `claude-session-${launch.sessionId}`,
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 10,
      visible: false,
      cols,
      rows,
      maxScrollback: 1_000_000,
      onData(data, source) {
        if (source === "input" && managed) managed.inputObserved = true
        if (pty && !pty.closed) pty.write(data)
      },
      onTerminalResize(nextCols, nextRows) {
        if (pty && !pty.closed) pty.resize(nextCols, nextRows)
      },
      onScreenChange() {
        if (!managed) return
        const generating = observeClaudeGenerating(terminal.screen())
        if (generating !== undefined) manager.setGenerating(managed, generating)
      },
    })
    this.renderer.root.add(terminal)

    const args =
      launch.kind === "new"
        ? [this.claudeExecutable, "--session-id", launch.sessionId]
        : [this.claudeExecutable, "--resume", launch.sessionId]
    if (launch.prefillText !== undefined) args.push(`--prefill=${launch.prefillText}`)

    let process: Bun.Subprocess
    try {
      process = Bun.spawn(args, {
        cwd: this.projectPath,
        env: {
          ...globalThis.process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
        terminal: {
          cols,
          rows,
          data(childPty, data) {
            pty = childPty
            const clipboardWrites = osc52.observe(data)
            const generating = activityObserver.observe(data)
            if (managed && generating !== undefined) manager.setGenerating(managed, generating)
            if (manager.activeSessionId === launch.sessionId) {
              for (const text of clipboardWrites) renderer.copyToClipboardOSC52(text)
            }
            terminal.write(data)
          },
          exit() {
            resolvePtyClosed()
          },
        },
      })
    } catch (error) {
      this.renderer.root.remove(terminal)
      terminal.destroy()
      throw error
    }

    pty ??= process.terminal
    if (!pty) {
      process.kill()
      this.renderer.root.remove(terminal)
      terminal.destroy()
      throw new Error("Bun did not create a pseudo-terminal for Claude")
    }

    managed = {
      sessionId: launch.sessionId,
      process,
      pty,
      terminal,
      exitCode: null,
      ...(launch.prefillText === undefined
        ? {}
        : { draftPreview: { text: launch.prefillText.trim(), exact: true } }),
      inputObserved: false,
      generating: activityObserver.generating ?? false,
    }
    void process.exited.then(async (exitCode) => {
      managed.exitCode = exitCode
      await waitForPtyDrain(ptyClosed)
      if (this.terminals.get(managed.sessionId) !== managed) return
      const wasActive = this.activeSessionId === managed.sessionId
      if (wasActive) {
        this.activeSessionId = null
        this.renderer.clearSelection()
      }
      this.destroyTerminal(managed)
      this.terminals.delete(managed.sessionId)
      this.onProcessExited({ sessionId: managed.sessionId, exitCode, wasActive })
    })
    return managed
  }

  private captureDraft(managed: ManagedTerminal): void {
    const screen = managed.terminal.screen()
    if (!managed.inputObserved && managed.draftPreview?.exact) return
    const observed = observeClaudeDraft(screen)
    if (observed !== undefined) {
      managed.draftPreview = { text: observed, exact: false }
    } else if (managed.inputObserved) {
      delete managed.draftPreview
    }
    managed.inputObserved = false
  }

  private setGenerating(managed: ManagedTerminal, generating: boolean): void {
    if (managed.generating === generating) return
    managed.generating = generating
    this.onActivityChanged({ sessionId: managed.sessionId, generating })
  }

  private pruneExited(): void {
    for (const [sessionId, managed] of this.terminals) {
      if (managed.exitCode === null || sessionId === this.activeSessionId) continue
      this.destroyTerminal(managed)
      this.terminals.delete(sessionId)
    }
  }

  private destroyTerminal(managed: ManagedTerminal): void {
    managed.terminal.blur()
    if (!managed.pty.closed) managed.pty.close()
    if (managed.terminal.parent) managed.terminal.parent.remove(managed.terminal)
    managed.terminal.destroy()
  }

  private readonly onSelection = (selection: Selection | null) => {
    if (!this.activeSessionId) return
    const terminal = this.terminals.get(this.activeSessionId)?.terminal
    if (!terminal || !selection?.selectedRenderables.includes(terminal)) return
    const selectedText = selection.getSelectedText()
    if (selectedText.length > 0) this.renderer.copyToClipboardOSC52(selectedText)
  }
}

export function observeClaudeDraft(screen: EmbeddedTerminalScreen): string | undefined {
  const composer = observeClaudeComposer(screen)
  return composer && composer.length > 0 ? composer : undefined
}

export function observeClaudeGenerating(screen: EmbeddedTerminalScreen): boolean | undefined {
  const recentLines = screen.lines.filter((line) => line.trim().length > 0).slice(-12)
  if (
    recentLines.some(
      (line) =>
        /^\s*[⏸⏵].*esc to interrupt(?:\s|·|$)/u.test(line) ||
        /^\s*[*·✢✶✻✽]\s+\S.*…(?:\s+\(\d+[smh](?:\s|·)|\s*$)/u.test(line),
    )
  ) {
    return true
  }
  return observeClaudeComposer(screen) !== undefined ? false : undefined
}

export function claudeGeneratingFromTitle(title: string): boolean | undefined {
  if (/^[\u2800-\u28ff\u25d0-\u25d3] /u.test(title)) return true
  if (/^✳ /u.test(title)) return false
  return undefined
}

class ClaudeActivityObserver {
  private readonly parser = new OscSequenceParser()
  generating: boolean | undefined

  observe(bytes: Uint8Array): boolean | undefined {
    let observed: boolean | undefined
    for (const body of this.parser.observe(bytes)) {
      const title = decodeOscTitle(body)
      if (title === undefined) continue
      const generating = claudeGeneratingFromTitle(title)
      if (generating === undefined) continue
      this.generating = generating
      observed = generating
    }
    return observed
  }
}

function decodeOscTitle(body: readonly number[]): string | undefined {
  const separator = body.indexOf(0x3b)
  if (separator < 0) return undefined
  const command = Buffer.from(body.slice(0, separator)).toString("ascii")
  if (command !== "0" && command !== "2") return undefined
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(body.slice(separator + 1)),
    )
  } catch {
    return undefined
  }
}

function observeClaudeComposer(screen: EmbeddedTerminalScreen): string | undefined {
  if (!screen.cursor.visible) return undefined
  const cursorRow = screen.cursor.y
  if (cursorRow < 0 || cursorRow >= screen.lines.length) return undefined

  for (let promptRow = cursorRow; promptRow >= Math.max(0, cursorRow - 20); promptRow -= 1) {
    const match = screen.lines[promptRow]?.match(/^\s*[❯>]\s?(.*)$/u)
    if (!match) continue

    let borderRow = -1
    for (let row = Math.max(promptRow + 1, cursorRow + 1); row < screen.lines.length; row += 1) {
      if (isHorizontalRule(screen.lines[row] ?? "")) {
        borderRow = row
        break
      }
    }
    if (borderRow < 0 || cursorRow >= borderRow) continue

    const lines = [match[1] ?? "", ...screen.lines.slice(promptRow + 1, borderRow)]
    const text = lines.join("\n").trim()
    return text
  }
  return undefined
}

function isHorizontalRule(line: string): boolean {
  return /^\s*[─━═-]{8,}\s*$/u.test(line)
}

async function waitForPtyDrain(ptyClosed: Promise<void>, timeoutMs = 250): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    ptyClosed,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs)
    }),
  ])
  if (timeout) clearTimeout(timeout)
}
