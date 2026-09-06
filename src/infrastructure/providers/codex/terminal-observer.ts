import type {
  AgentActivity,
  DraftPreview,
  TerminalObserver,
  TerminalScreen,
} from "../../../domain/model"
import { OscSequenceParser } from "../../../osc"

const CODEX_SPINNER = /(?<!\S)[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?!\S)/u

type CodexScreenSignal = "blocker" | "composer" | "status"

interface CodexScreenObservation {
  readonly activity: AgentActivity
  readonly signal: CodexScreenSignal
}

export class CodexTerminalObserver implements TerminalObserver {
  private readonly parser = new OscSequenceParser()
  private titleActivity: AgentActivity | undefined
  private activeProjectTitle: string | undefined
  private lastScreen: string | undefined
  private activeTitleScreen: string | undefined
  private awaitingActiveScreen = false
  private recoveryScreen: string | undefined

  observeInput(_bytes: Uint8Array): void {
    this.recoveryScreen = undefined
  }

  observeOutput(bytes: Uint8Array): readonly AgentActivity[] {
    if (bytes.length > 0) this.recoveryScreen = undefined
    const observed: AgentActivity[] = []
    for (const body of this.parser.observe(bytes)) {
      const title = decodeOscTitle(body)
      if (title === undefined) continue

      const signal = codexTitleSignal(title)
      const activity = signal?.activity ?? (title === this.activeProjectTitle ? "idle" : undefined)
      if (activity === "working" || activity === "blocked") {
        this.activeProjectTitle = signal?.remainingTitle
        if (!this.awaitingActiveScreen) this.activeTitleScreen = this.lastScreen
        this.awaitingActiveScreen = true
        observed.push(activity)
      } else if (activity === "idle") {
        this.activeProjectTitle = undefined
        this.awaitingActiveScreen = false
        observed.push("idle")
      } else this.activeProjectTitle = undefined
    }
    if (observed.length > 0) this.titleActivity = observed.at(-1)
    return observed
  }

  observeScreen(screen: TerminalScreen): AgentActivity | undefined {
    this.lastScreen = JSON.stringify([screen.lines, screen.cursor])
    if (this.recoveryScreen !== this.lastScreen) this.recoveryScreen = undefined
    const observation = observeCodexScreen(screen)
    if (observation?.activity !== "idle") this.recoveryScreen = undefined
    if (observation === undefined) return undefined
    if (this.awaitingActiveScreen && observation.signal !== "blocker" &&
      (observation.activity === "idle" || this.titleActivity === "blocked")) {
      this.activeTitleScreen ??= this.lastScreen
      if (this.activeTitleScreen === this.lastScreen) return undefined
    }
    this.awaitingActiveScreen = false
    return observation.activity
  }

  reconcileScreen(screen: TerminalScreen, phase: "sample" | "confirm"): AgentActivity | undefined {
    if (phase === "sample") this.recoveryScreen = undefined
    const activity = this.observeScreen(screen)
    if (activity !== undefined || observeCodexActivity(screen) !== "idle") return activity
    if (phase === "confirm" && this.recoveryScreen === this.lastScreen) {
      this.awaitingActiveScreen = false
      this.recoveryScreen = undefined
      return this.observeScreen(screen)
    }
    // Only a new probe's sample can establish its confirmation candidate.
    if (phase === "sample") this.recoveryScreen = this.lastScreen
    return undefined
  }

  observeDraft(screen: TerminalScreen): DraftPreview | undefined {
    const text = observeCodexDraft(screen)
    return text === undefined ? undefined : { text, exact: false }
  }
}

export function observeCodexDraft(screen: TerminalScreen): string | undefined {
  const composer = observeCodexComposer(screen)
  return composer && composer.length > 0 ? composer : undefined
}

export function observeCodexActivity(screen: TerminalScreen): AgentActivity | undefined {
  return observeCodexScreen(screen)?.activity
}

export function codexActivityFromTitle(title: string): AgentActivity | undefined {
  return codexTitleSignal(title)?.activity
}

function codexTitleSignal(title: string): { activity: AgentActivity; remainingTitle: string | undefined } | undefined {
  const blocked = title.match(/^\[ [!.] \] Action Required(?: \| (.+))?$/u)
  if (blocked) return { activity: "blocked", remainingTitle: blocked[1] }
  const spinner = CODEX_SPINNER.exec(title)
  if (!spinner) return undefined
  // Codex 0.150.1 joins activity with spaces, and all remaining fields with " | ".
  // Word-only run-state fields are indistinguishable from configured names.
  const before = title.slice(0, spinner.index).trim().replace(/ \|$|^\|$/u, "").trim()
  const after = title.slice(spinner.index + spinner[0].length).trim().replace(/^\| |^\|$/u, "").trim()
  const remainingTitle = [before, after].filter(Boolean).join(" | ")
  return {
    activity: "working",
    remainingTitle: remainingTitle && !CODEX_SPINNER.test(remainingTitle) ? remainingTitle : undefined,
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

function observeCodexScreen(screen: TerminalScreen): CodexScreenObservation | undefined {
  if (isCodexTranscriptViewer(screen.lines)) return undefined

  const afterLastPrompt = linesAfterLastPrompt(screen.lines)
  if (isCodexTrustPrompt(screen.lines) || isCodexBlocker(afterLastPrompt)) {
    return { activity: "blocked", signal: "blocker" }
  }
  const composer = observeCodexComposer(screen)
  const bottomLines = (composer === undefined ? screen.lines : afterLastPrompt)
    .filter((line) => line.trim().length > 0).slice(-3)
  if (
    !bottomLines.some((line) => line.includes("■ Conversation interrupted")) &&
    bottomLines.some(isCodexActiveStatusRow)
  ) {
    return { activity: "working", signal: "status" }
  }
  if (composer !== undefined) return { activity: "idle", signal: "composer" }
  return undefined
}

function observeCodexComposer(screen: TerminalScreen): string | undefined {
  if (!screen.cursor.visible) return undefined
  const cursorRow = screen.cursor.y
  if (cursorRow < 0 || cursorRow >= screen.lines.length) return undefined

  for (let promptRow = cursorRow; promptRow >= Math.max(0, cursorRow - 20); promptRow -= 1) {
    const promptLine = screen.lines[promptRow] ?? ""
    const match = promptLine.match(/^\s{0,2}›(?:\s?(.*))?$/u)
    if (!match) continue

    let footerRow = -1
    for (let row = Math.max(promptRow + 1, cursorRow + 1); row < screen.lines.length; row += 1) {
      if (isCodexFooterBoundary(screen.lines[row] ?? "")) {
        footerRow = row
        break
      }
      if (row - promptRow > 20) break
    }
    if (footerRow < 0 || cursorRow >= footerRow) continue

    const continuationLines = screen.lines.slice(promptRow + 1, footerRow)
    if (continuationLines.some((line) => /^\s{0,2}›(?:\s|$)/u.test(line))) continue

    const promptColumn = promptLine.indexOf("›")
    const textColumn = promptColumn + (promptLine[promptColumn + 1] === " " ? 2 : 1)
    if (cursorRow === promptRow && screen.cursor.x <= textColumn) return ""
    return [match[1] ?? "", ...continuationLines].join("\n").trim()
  }
  return undefined
}

function isCodexActiveStatusRow(line: string): boolean {
  return /^\s*(?:[•◦·]\s+)?(?:Working|Thinking|Waiting)\s+\([^()]*[•◦·]\s*esc to interrupt\)(?:\s+[·•]\s+.*)?\s*$/u.test(
    line,
  )
}

function linesAfterLastPrompt(lines: readonly string[]): string[] {
  const promptRow = lines.findLastIndex((line) => /^\s{0,2}›(?:\s|$)/u.test(line))
  return lines.slice(Math.max(0, promptRow + 1)).filter((line) => line.trim().length > 0)
}

function isCodexTranscriptViewer(lines: readonly string[]): boolean {
  const text = lines.join("\n").toLowerCase()
  return text.includes("↑/↓ to scroll") &&
    text.includes("pgup/pgdn to") &&
    text.includes("home/end to jump") &&
    text.includes("q to quit") &&
    (text.includes("esc to edit prev") || text.includes("esc/← to edit prev"))
}

function isCodexTrustPrompt(lines: readonly string[]): boolean {
  const text = lines.slice(0, 20).join("\n")
  return /^\s*> You are in \S/um.test(text) &&
    /Do\s+you\s+trust\s+the\s+contents\s+of\s+this\s+directory\?/iu.test(text)
}

function isCodexBlocker(lines: readonly string[]): boolean {
  const text = lines.join("\n")
  const lower = text.toLowerCase()
  if (lower.includes("press enter to confirm or esc to cancel")) return true
  if (lower.includes("enter to submit answer") || lower.includes("enter to submit all")) return true
  if (lower.includes("allow command?")) return true
  if (lower.includes("[y/n]") || lower.includes("yes (y)")) return true
  return (lower.includes("do you want to") || lower.includes("would you like to")) &&
    (lower.includes("yes") || text.includes("❯"))
}

function isCodexFooterBoundary(line: string): boolean {
  const trimmed = line.trim()
  if (/\? for shortcuts\b/u.test(trimmed)) return true
  if (/\b\d{1,3}% context left\b/u.test(trimmed)) return true
  if (/\b(?:tab to queue message|enter to send)\b/u.test(trimmed)) return true
  if (/(?:^|\s[·•]\s)(?:~?\/|[A-Za-z]:[\\/])\S*\s*$/u.test(trimmed)) return true
  return /^(?:gpt-\S+|o\d(?:-\S+)?)\s+\S.*\s[·•]\s/u.test(trimmed)
}
