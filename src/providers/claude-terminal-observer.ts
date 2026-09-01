import type { EmbeddedTerminalScreen } from "@opentui/core"

import type { AgentActivity, TerminalObserver } from "../agent-provider"
import { OscSequenceParser } from "../osc"

export class ClaudeTerminalObserver implements TerminalObserver {
  private readonly parser = new OscSequenceParser()
  private titleActivity: AgentActivity | undefined

  observeOutput(bytes: Uint8Array): readonly AgentActivity[] {
    const observed: AgentActivity[] = []
    for (const body of this.parser.observe(bytes)) {
      const title = decodeOscTitle(body)
      if (title === undefined) continue
      const activity = claudeActivityFromTitle(title)
      if (activity !== undefined) observed.push(activity)
    }
    if (observed.length > 0) this.titleActivity = observed.at(-1)
    return observed
  }

  observeScreen(screen: EmbeddedTerminalScreen): AgentActivity | undefined {
    const activity = observeClaudeActivity(screen)
    if (activity !== undefined && this.titleActivity !== undefined && activity !== this.titleActivity) {
      return undefined
    }
    return activity
  }

  observeDraft(screen: EmbeddedTerminalScreen): string | undefined {
    return observeClaudeDraft(screen)
  }
}

export function observeClaudeDraft(screen: EmbeddedTerminalScreen): string | undefined {
  const composer = observeClaudeComposer(screen)
  return composer && composer.length > 0 ? composer : undefined
}

export function observeClaudeActivity(screen: EmbeddedTerminalScreen): AgentActivity | undefined {
  const recentLines = screen.lines.filter((line) => line.trim().length > 0).slice(-12)
  if (
    recentLines.some(
      (line) =>
        /^\s*[⏸⏵].*esc to interrupt(?:\s|·|$)/u.test(line) ||
        /^\s*[*·✢✶✻✽]\s+\S.*…(?:\s+\(\d+[smh](?:\s|·)|\s*$)/u.test(line),
    )
  ) {
    return "working"
  }
  return observeClaudeComposer(screen) !== undefined ? "idle" : undefined
}

export function claudeActivityFromTitle(title: string): AgentActivity | undefined {
  if (/^[\u2800-\u28ff\u25d0-\u25d3] /u.test(title)) return "working"
  if (/^✳ /u.test(title)) return "idle"
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

    return [match[1] ?? "", ...screen.lines.slice(promptRow + 1, borderRow)].join("\n").trim()
  }
  return undefined
}

function isHorizontalRule(line: string): boolean {
  return /^\s*[─━═-]{8,}\s*$/u.test(line)
}
