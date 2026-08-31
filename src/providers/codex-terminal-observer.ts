import type { EmbeddedTerminalScreen } from "@opentui/core"

import type { AgentActivity, TerminalObserver } from "../agent-provider"
import { OscSequenceParser } from "../osc"

const ACTIVE_TITLE_STATUSES = new Set(["Starting", "Working", "Thinking", "Waiting"])
const IDLE_TITLE_STATUSES = new Set(["Ready", "Idle"])
const CODEX_SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?:\s|$)/u

type CodexScreenSignal = "blocker" | "composer" | "status"

interface CodexScreenObservation {
  activity: AgentActivity
  signal: CodexScreenSignal
}

export class CodexTerminalObserver implements TerminalObserver {
  private readonly parser = new OscSequenceParser()
  private titleActivity: AgentActivity | undefined
  private sawActiveTitle = false

  observeOutput(bytes: Uint8Array): AgentActivity | undefined {
    let observed: AgentActivity | undefined
    for (const body of this.parser.observe(bytes)) {
      const title = decodeOscTitle(body)
      if (title === undefined) continue

      const explicitActivity = codexActivityFromTitle(title)
      if (explicitActivity === "working") {
        this.sawActiveTitle = true
        observed = "working"
      } else if (explicitActivity === "idle") {
        this.sawActiveTitle = false
        observed = "idle"
      } else if (this.sawActiveTitle) {
        this.sawActiveTitle = false
        observed = "idle"
      }
    }
    if (observed !== undefined) this.titleActivity = observed
    return observed
  }

  observeScreen(screen: EmbeddedTerminalScreen): AgentActivity | undefined {
    const observation = observeCodexScreen(screen)
    if (observation === undefined) return undefined
    if (observation.signal === "blocker") return "working"
    if (
      this.titleActivity !== undefined &&
      observation.activity !== this.titleActivity
    ) {
      return undefined
    }
    return observation.activity
  }

  observeDraft(screen: EmbeddedTerminalScreen): string | undefined {
    return observeCodexDraft(screen)
  }
}

export function observeCodexDraft(screen: EmbeddedTerminalScreen): string | undefined {
  const composer = observeCodexComposer(screen)
  return composer && composer.length > 0 ? composer : undefined
}

export function observeCodexActivity(screen: EmbeddedTerminalScreen): AgentActivity | undefined {
  return observeCodexScreen(screen)?.activity
}

export function codexActivityFromTitle(title: string): AgentActivity | undefined {
  if (CODEX_SPINNER.test(title)) return "working"
  if (/\bAction Required\b/u.test(title)) return "working"

  const statusSegments = title.split(/\s(?:[|·—]|-)\s/u).map((segment) => segment.trim())
  if (statusSegments.some((segment) => ACTIVE_TITLE_STATUSES.has(segment))) return "working"
  if (statusSegments.some((segment) => IDLE_TITLE_STATUSES.has(segment))) return "idle"
  return undefined
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

function observeCodexScreen(screen: EmbeddedTerminalScreen): CodexScreenObservation | undefined {
  if (isCodexTranscriptViewer(screen.lines)) return undefined

  const afterLastPrompt = linesAfterLastPrompt(screen.lines)
  if (isCodexTrustPrompt(screen.lines) || isCodexBlocker(afterLastPrompt)) {
    return { activity: "working", signal: "blocker" }
  }

  if (observeCodexComposer(screen) !== undefined) {
    return { activity: "idle", signal: "composer" }
  }

  const bottomLines = screen.lines.filter((line) => line.trim().length > 0).slice(-3)
  if (
    !bottomLines.some((line) => line.includes("■ Conversation interrupted")) &&
    bottomLines.some(isCodexActiveStatusRow)
  ) {
    return { activity: "working", signal: "status" }
  }
  return undefined
}

function observeCodexComposer(screen: EmbeddedTerminalScreen): string | undefined {
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
  return (
    text.includes("↑/↓ to scroll") &&
    text.includes("pgup/pgdn to") &&
    text.includes("home/end to jump") &&
    text.includes("q to quit") &&
    (text.includes("esc to edit prev") || text.includes("esc/← to edit prev"))
  )
}

function isCodexTrustPrompt(lines: readonly string[]): boolean {
  const text = lines.slice(0, 20).join("\n")
  return (
    /^\s*> You are in \S/um.test(text) &&
    /Do\s+you\s+trust\s+the\s+contents\s+of\s+this\s+directory\?/iu.test(text)
  )
}

function isCodexBlocker(lines: readonly string[]): boolean {
  const text = lines.join("\n")
  const lower = text.toLowerCase()
  if (lower.includes("press enter to confirm or esc to cancel")) return true
  if (lower.includes("enter to submit answer") || lower.includes("enter to submit all")) return true
  if (lower.includes("allow command?")) return true
  if (lower.includes("[y/n]") || lower.includes("yes (y)")) return true
  return (
    (lower.includes("do you want to") || lower.includes("would you like to")) &&
    (lower.includes("yes") || text.includes("❯"))
  )
}

function isCodexFooterBoundary(line: string): boolean {
  const trimmed = line.trim()
  if (/\? for shortcuts\b/u.test(trimmed)) return true
  if (/\b\d{1,3}% context left\b/u.test(trimmed)) return true
  if (/\b(?:tab to queue message|enter to send)\b/u.test(trimmed)) return true
  if (/(?:^|\s[·•]\s)(?:~?\/|[A-Za-z]:[\\/])\S*\s*$/u.test(trimmed)) return true
  return /^(?:gpt-\S+|o\d(?:-\S+)?)\s+\S.*\s[·•]\s/u.test(trimmed)
}
