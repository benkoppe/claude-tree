import type {
  AgentActivity,
  DraftPreview,
  TerminalObserver,
  TerminalScreen,
} from "../../../domain/model"
import { OscSequenceParser } from "../../../osc"

type RewindPhase = "idle" | "armed" | "picker" | "awaitingComposer" | "captured"

export class ClaudeTerminalObserver implements TerminalObserver {
  private readonly parser = new OscSequenceParser()
  private titleActivity: AgentActivity | undefined
  private inputBuffer = ""
  private rewindPhase: RewindPhase = "idle"
  private rewindTarget: string | undefined
  private ignoredRewindTarget: string | undefined
  private rewindSubmitted = false
  private rewindWorkingSeen = false
  private lastStandaloneEscapeAt = 0

  observeInput(bytes: Uint8Array): void {
    const data = Buffer.from(bytes).toString("utf8")
    if (this.rewindPhase === "picker") {
      if (isStandaloneEscape(data)) {
        this.resetRewind()
      } else if (hasEnter(data)) {
        this.rewindPhase = "awaitingComposer"
      }
      return
    }
    if (this.rewindPhase === "armed") {
      if (hasEnter(data)) this.rewindPhase = "awaitingComposer"
      return
    }
    if (this.rewindPhase === "awaitingComposer") return

    const escapeCount = standaloneEscapeCount(data)
    if (escapeCount > 0) {
      const now = Date.now()
      if (escapeCount >= 2 || now - this.lastStandaloneEscapeAt <= 500) {
        this.armRewind()
        this.inputBuffer = ""
      }
      this.lastStandaloneEscapeAt = now
      return
    }
    this.lastStandaloneEscapeAt = 0

    const submissions = this.observeComposerSubmissions(data)
    if (this.rewindPhase === "captured") {
      if (submissions.some(isRewindCommand)) {
        this.armRewind()
      } else if (submissions.length > 0) {
        this.rewindSubmitted = true
      }
      return
    }
    if (submissions.some(isRewindCommand)) this.armRewind(false)
  }

  observeOutput(bytes: Uint8Array): readonly AgentActivity[] {
    const observed: AgentActivity[] = []
    for (const body of this.parser.observe(bytes)) {
      const title = decodeOscTitle(body)
      if (title === undefined) continue
      const activity = claudeActivityFromTitle(title)
      if (activity !== undefined) {
        observed.push(activity)
        this.observeRewindActivity(activity)
      }
    }
    if (observed.length > 0) this.titleActivity = observed.at(-1)
    return observed
  }

  observeScreen(screen: TerminalScreen): AgentActivity | undefined {
    const rewindMenuVisible = isClaudeRewindPicker(screen)
    if (rewindMenuVisible && (this.rewindPhase === "armed" || this.rewindPhase === "picker")) {
      this.rewindPhase = "picker"
      this.rewindTarget = undefined
    }
    if (
      !rewindMenuVisible &&
      (this.rewindPhase === "armed" || this.rewindPhase === "awaitingComposer") &&
      this.rewindTarget === undefined
    ) {
      const composer = observeClaudeDraft(screen)
      if (composer !== undefined && this.canCaptureRewindTarget(composer)) {
        this.rewindTarget = composer
        this.ignoredRewindTarget = undefined
        this.rewindPhase = "captured"
      }
    }
    const activity = observeClaudeActivity(screen)
    if (activity === "blocked" || activity === "working") return activity
    if (activity !== undefined && this.titleActivity !== undefined && activity !== this.titleActivity) {
      return undefined
    }
    this.observeRewindActivity(activity)
    return activity
  }

  observeDraft(screen: TerminalScreen): DraftPreview | undefined {
    if (isClaudeRewindPicker(screen)) return undefined
    const text = observeClaudeDraft(screen)
    if (
      text !== undefined &&
      this.rewindTarget === undefined &&
      (this.rewindPhase === "armed" || this.rewindPhase === "awaitingComposer") &&
      this.canCaptureRewindTarget(text)
    ) {
      this.rewindTarget = text
      this.ignoredRewindTarget = undefined
      this.rewindPhase = "captured"
    }
    return text === undefined
      ? undefined
      : {
          text,
          exact: false,
          ...(this.rewindPhase === "captured"
            ? {
                rewind: true,
                ...(this.rewindTarget === undefined ? {} : { rewindTarget: this.rewindTarget }),
                ...(this.rewindSubmitted ? { submitted: true } : {}),
              }
            : {}),
        }
  }

  private armRewind(ignoreCurrentTarget = true): void {
    this.ignoredRewindTarget = ignoreCurrentTarget ? this.rewindTarget : undefined
    this.rewindPhase = "armed"
    this.rewindTarget = undefined
    this.rewindSubmitted = false
    this.rewindWorkingSeen = false
  }

  private resetRewind(): void {
    this.rewindPhase = "idle"
    this.rewindTarget = undefined
    this.ignoredRewindTarget = undefined
    this.rewindSubmitted = false
    this.rewindWorkingSeen = false
  }

  private observeRewindActivity(activity: AgentActivity | undefined): void {
    if (!this.rewindSubmitted || activity === undefined) return
    if (activity === "working") {
      this.rewindWorkingSeen = true
      return
    }
    if (this.rewindWorkingSeen) this.resetRewind()
  }

  private observeComposerSubmissions(data: string): string[] {
    const submissions: string[] = []
    const composerInput = data
      .replace(/\u001b\[200~/gu, "")
      .replace(/\u001b\[201~/gu, "")
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    for (const character of composerInput) {
      if (character === "\r" || character === "\n") {
        submissions.push(this.inputBuffer.trim())
        this.inputBuffer = ""
      } else if (character === "\u0015" || character === "\u0003") {
        this.inputBuffer = ""
      } else if (character === "\u007f" || character === "\b") {
        this.inputBuffer = this.inputBuffer.slice(0, -1)
      } else if (character >= " ") {
        this.inputBuffer += character
      }
    }
    return submissions
  }

  private canCaptureRewindTarget(composer: string): boolean {
    return !isRewindCommand(composer) && composer !== this.ignoredRewindTarget
  }
}

function isClaudeRewindPicker(screen: TerminalScreen): boolean {
  return screen.lines.some((line) => /^\s*Rewind\b.*\b(?:message|conversation)\b/iu.test(line))
}

function isRewindCommand(input: string): boolean {
  return /^\/(?:undo|rewind)(?:\s|$)/u.test(input)
}

function isStandaloneEscape(data: string): boolean {
  return standaloneEscapeCount(data) === 1
}

function standaloneEscapeCount(data: string): number {
  const tokens = data.match(/\u001b(?:\[27(?:;\d+)*u)?/gu) ?? []
  return tokens.join("") === data ? tokens.length : 0
}

function hasEnter(data: string): boolean {
  return /[\r\n]/u.test(data) || /\u001b\[13(?:;\d+)*u/u.test(data)
}

export function observeClaudeDraft(screen: TerminalScreen): string | undefined {
  const composer = observeClaudeComposer(screen)?.text
  return composer && composer.length > 0 ? composer : undefined
}

export function observeClaudeActivity(screen: TerminalScreen): AgentActivity | undefined {
  const recentRows = screen.lines
    .map((line, row) => ({ line, row }))
    .filter(({ line }) => line.trim().length > 0)
    .slice(-12)
  if (isClaudeBlocker(recentRows.map(({ line }) => line))) return "blocked"

  const composer = observeClaudeComposer(screen)
  const working = recentRows.findLast(({ line }) => isClaudeWorkingLine(line))
  if (working && (!composer || working.row > composer.promptRow)) return "working"
  return composer ? "idle" : undefined
}

function isClaudeWorkingLine(line: string): boolean {
  return (
    /^\s*[⏸⏵].*esc to interrupt(?:\s|·|$)/u.test(line) ||
    /^\s*[*·✢✶✻✽]\s+\S.*…(?:\s+\(\d+[smh](?:\s|·)|\s*$)/u.test(line)
  )
}

function isClaudeBlocker(lines: readonly string[]): boolean {
  const text = lines.join("\n")
  const lower = text.toLowerCase()
  if (
    lower.includes("esc to cancel") &&
    (lower.includes("enter to confirm") ||
      lower.includes("enter to select") ||
      lower.includes("run a dynamic workflow?"))
  ) {
    return true
  }
  if (
    (lower.includes("do you want to proceed?") || lower.includes("would you like to proceed?")) &&
    lower.includes("esc to cancel") &&
    /(?:^|\n)\s*❯?\s*(?:\d+\.\s*)?(?:yes|allow|deny|no)\b/iu.test(text)
  ) {
    return true
  }
  return (
    lower.includes("mcp server") &&
    lower.includes("requests your input") &&
    lower.includes("esc to cancel") &&
    /(?:^|\n)\s*❯?\s*(?:accept|decline)\b/iu.test(text)
  )
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

function observeClaudeComposer(
  screen: TerminalScreen,
): { text: string; promptRow: number } | undefined {
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

    return {
      text: [match[1] ?? "", ...screen.lines.slice(promptRow + 1, borderRow)].join("\n").trim(),
      promptRow,
    }
  }
  return undefined
}

function isHorizontalRule(line: string): boolean {
  return /^\s*[─━═-]{8,}\s*$/u.test(line)
}
