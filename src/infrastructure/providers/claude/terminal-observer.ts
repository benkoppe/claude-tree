import type {
  AgentActivity,
  DraftPreview,
  TerminalObserver,
  TerminalScreen,
  TerminalSubmissionObservation,
} from "../../../domain/model"
import { OscSequenceParser } from "../../../osc"

type RewindPhase = "idle" | "armed" | "picker" | "awaitingComposer" | "captured"

export class ClaudeTerminalObserver implements TerminalObserver {
  private readonly parser = new OscSequenceParser()
  private lastScreen: string | undefined
  private workingTitleScreen: string | undefined
  private awaitingWorkingScreen = false
  private inputBuffer = ""
  private pasting = false
  private composerScreen: string | undefined
  private rewindPhase: RewindPhase = "idle"
  private rewindTarget: string | undefined
  private ignoredRewindTarget: string | undefined
  private rewindSubmitted = false
  private rewindWorkingSeen = false
  private lastStandaloneEscapeAt = 0
  private lastSubmittedPrompt: string | undefined
  private cancelledPrompt: string | undefined
  private cancelledScreen: string | undefined
  private restoreConversation = true
  private dismissedDialog = false

  observeInput(bytes: Uint8Array): TerminalSubmissionObservation | void {
    const data = Buffer.from(bytes).toString("utf8")
    if (this.rewindPhase === "picker") {
      if (isStandaloneEscape(data)) {
        this.resetRewind()
        this.dismissedDialog = true
      } else if (hasEnter(data)) {
        if (this.restoreConversation) this.rewindPhase = "awaitingComposer"
        else {
          this.resetRewind()
          this.dismissedDialog = true
        }
      }
      return
    }
    if (this.rewindPhase === "armed") {
      if (isStandaloneEscape(data)) { this.resetRewind(); return }
      this.resetRewind()
    }
    if (this.rewindPhase === "awaitingComposer") {
      if (isStandaloneEscape(data) || (hasEnter(data) && !this.restoreConversation)) {
        this.resetRewind()
        this.dismissedDialog = true
      }
      return
    }

    const escapeCount = standaloneEscapeCount(data)
    if (escapeCount > 0) {
      this.cancelledPrompt = this.lastSubmittedPrompt
      this.cancelledScreen = this.lastScreen
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
    if (submissions.length > 0) {
      this.lastSubmittedPrompt = submissions.at(-1) || undefined
      this.cancelledPrompt = undefined
    }
    if (this.rewindPhase === "captured") {
      if (submissions.some(isRewindCommand)) {
        this.armRewind()
      } else if (submissions.length > 0) {
        this.rewindSubmitted = true
      }
      if (submissions.length > 0 && !submissions.some(isRewindCommand)) {
        return { _tag: "Submission", ...(this.lastSubmittedPrompt === undefined ? {} : { text: this.lastSubmittedPrompt }) }
      }
      return
    }
    if (submissions.some(isRewindCommand)) {
      this.armRewind(false)
      if (submissions.some((input) => /^\/rewind\b/u.test(input))) this.rewindPhase = "armed"
    }
    else if (submissions.length > 0) return {
      _tag: "Submission",
      ...(this.lastSubmittedPrompt === undefined ? {} : { text: this.lastSubmittedPrompt }),
    }
  }

  observeOutput(bytes: Uint8Array): readonly AgentActivity[] {
    const observed: AgentActivity[] = []
    for (const body of this.parser.observe(bytes)) {
      const title = decodeOscTitle(body)
      if (title === undefined) continue
      const activity = claudeActivityFromTitle(title)
      if (activity !== undefined) {
        if (activity === "working") {
          if (!this.awaitingWorkingScreen) this.workingTitleScreen = this.lastScreen
          this.awaitingWorkingScreen = true
        } else this.awaitingWorkingScreen = false
        observed.push(activity)
        this.observeRewindActivity(activity)
      }
    }
    return observed
  }

  observeScreen(screen: TerminalScreen): AgentActivity | undefined {
    this.lastScreen = JSON.stringify([screen.lines, screen.cursor])
    this.captureCancelledPrompt(screen)
    const rewindMenuVisible = isClaudeRewindPicker(screen)
    if (!rewindMenuVisible) this.dismissedDialog = false
    if (!rewindMenuVisible && this.rewindPhase === "picker") this.resetRewind()
    if (rewindMenuVisible && !this.dismissedDialog) {
      const selected = screen.lines.find((line) => /^\s*[│┃]?\s*❯/u.test(line)) ?? ""
      this.restoreConversation = !/never mind/iu.test(selected) &&
        !(/\b(?:restore|rewind)\b.*\b(?:code|files)\b/iu.test(selected) && !/\bconversation\b/iu.test(selected))
      if (this.rewindPhase !== "awaitingComposer") this.rewindPhase = "picker"
      this.rewindTarget = undefined
      this.ignoredRewindTarget = undefined
      this.cancelledPrompt = undefined
      this.rewindSubmitted = false
      this.rewindWorkingSeen = false
    }
    if (
      !rewindMenuVisible &&
      this.rewindPhase === "awaitingComposer" &&
      this.rewindTarget === undefined
    ) {
      const composer = this.readComposer(screen)?.text || undefined
      if (composer !== undefined && this.canCaptureRewindTarget(composer)) {
        this.rewindTarget = composer
        this.ignoredRewindTarget = undefined
        this.rewindPhase = "captured"
      }
    }
    const activity = claudeScreenActivity(screen, this.readComposer(screen))
    if (activity === "idle" && !rewindMenuVisible && !this.rewindSubmitted) {
      this.syncComposerInput(screen, this.readComposer(screen)!.text)
    }
    if (activity === "idle" && this.awaitingWorkingScreen &&
      !(this.rewindPhase === "captured" && !this.rewindSubmitted)) {
      // A title can arrive before its screen paint. Suppress only that unchanged
      // composer, not every subsequent idle screen until another OSC arrives.
      this.workingTitleScreen ??= this.lastScreen
      if (this.workingTitleScreen === this.lastScreen) return undefined
    }
    if (activity !== undefined) this.awaitingWorkingScreen = false
    this.observeRewindActivity(activity)
    return activity
  }

  observeDraft(screen: TerminalScreen): DraftPreview | null | undefined {
    if (isClaudeRewindPicker(screen)) return undefined
    const composer = this.readComposer(screen)
    if (!composer || claudeScreenActivity(screen, composer) !== "idle") return undefined
    const text = composer.text
    if (!this.rewindSubmitted) this.syncComposerInput(screen, text)
    if (text.length === 0 && this.rewindPhase === "awaitingComposer") this.resetRewind()
    if (
      text !== undefined &&
      this.rewindTarget === undefined &&
      this.rewindPhase === "awaitingComposer" &&
      this.canCaptureRewindTarget(text)
    ) {
      this.rewindTarget = text
      this.ignoredRewindTarget = undefined
      this.rewindPhase = "captured"
    }
    return text.length === 0
      ? null
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

  private captureCancelledPrompt(screen: TerminalScreen): void {
    if (this.cancelledPrompt === undefined || isRewindCommand(this.cancelledPrompt) || isClaudeRewindPicker(screen)) return
    if (this.lastScreen === this.cancelledScreen) return
    if (observeClaudeActivity(screen) !== "idle") return
    const composer = observeClaudeDraft(screen)
    if (composer !== this.cancelledPrompt) return
    this.rewindTarget = composer
    this.rewindPhase = "captured"
    this.rewindSubmitted = false
    this.rewindWorkingSeen = false
    this.cancelledPrompt = undefined
    this.composerScreen = undefined
  }

  private readComposer(screen: TerminalScreen): ClaudeComposer | undefined {
    const cursorComposer = observeClaudeComposer(screen)
    if (cursorComposer) return cursorComposer
    if ((this.rewindPhase !== "awaitingComposer" && (this.rewindPhase !== "captured" || this.rewindSubmitted)) ||
      isClaudeRewindPicker(screen)) return undefined
    const bordered = observeBorderedRewindComposer(screen)
    return bordered && claudeScreenActivity(screen, bordered) === "idle" ? bordered : undefined
  }

  private armRewind(ignoreCurrentTarget = true): void {
    this.composerScreen = undefined
    this.ignoredRewindTarget = ignoreCurrentTarget ? this.rewindTarget : undefined
    this.rewindPhase = ignoreCurrentTarget ? "armed" : "awaitingComposer"
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
    this.cancelledPrompt = undefined
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
    for (const part of data.split(/(\u001b\[20[01]~)/u)) {
      if (part === "\u001b[200~") { this.pasting = true; continue }
      if (part === "\u001b[201~") { this.pasting = false; continue }
      const composerInput = part
        .replace(/\u001b\[13(?:;\d+)*u/gu, "\r")
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
      for (const character of composerInput) {
        if (character === "\r" || character === "\n") {
          if (this.pasting) { this.inputBuffer += "\n"; continue }
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
    }
    return submissions
  }

  private syncComposerInput(screen: TerminalScreen, text: string): void {
    const key = JSON.stringify([screen.lines, screen.cursor])
    if (key === this.composerScreen) return
    this.composerScreen = key
    this.inputBuffer = text
  }

  private canCaptureRewindTarget(composer: string): boolean {
    return composer.length > 0 && !isRewindCommand(composer) && composer !== this.ignoredRewindTarget
  }
}

function isClaudeRewindPicker(screen: TerminalScreen): boolean {
  return screen.lines.map((line) => line.replace(/^[\s│┃]+|[\s│┃]+$/gu, "")).some((line) =>
    /^\s*Rewind\b.*\b(?:message|conversation)\b/iu.test(line) ||
    /^\s*Restore (?:the code and\/or conversation|and fork the conversation) to the point before[….]*\s*$/u.test(line) ||
    /^\s*Confirm you want to restore\b/u.test(line)
  )
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
  return claudeScreenActivity(screen, observeClaudeComposer(screen))
}

function claudeScreenActivity(screen: TerminalScreen, composer: ClaudeComposer | undefined): AgentActivity | undefined {
  const recentRows = screen.lines
    .map((line, row) => ({ line, row }))
    .filter(({ line }) => line.trim().length > 0)
    .slice(-12)
  if (isClaudeBlocker(recentRows.map(({ line }) => line))) return "blocked"

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

interface ClaudeComposer {
  readonly text: string
  readonly promptRow: number
}

function observeBorderedRewindComposer(screen: TerminalScreen): ClaudeComposer | undefined {
  const bottom = screen.lines.findLastIndex(isHorizontalRule)
  if (bottom < 2) return undefined
  let top = bottom - 1
  while (top >= 0 && !isHorizontalRule(screen.lines[top] ?? "")) top -= 1
  if (top < 0) return undefined
  const promptRow = top + 1
  const match = screen.lines[promptRow]?.match(/^\s*❯\s?(.*)$/u)
  if (!match || promptRow >= bottom) return undefined
  const continuation = screen.lines.slice(promptRow + 1, bottom)
  if (continuation.some((line) => /^\s*❯/u.test(line))) return undefined
  const text = [match[1] ?? "", ...continuation].join("\n").trim()
  return { text, promptRow }
}

function observeClaudeComposer(
  screen: TerminalScreen,
): ClaudeComposer | undefined {
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
