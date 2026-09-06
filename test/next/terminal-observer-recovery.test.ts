import { expect, test } from "bun:test"

import { ClaudeTerminalObserver } from "../../src/infrastructure/providers/claude/terminal-observer"
import { CodexTerminalObserver } from "../../src/infrastructure/providers/codex/terminal-observer"

const encoder = new TextEncoder()
for (const provider of [
  {
    name: "Claude", create: () => new ClaudeTerminalObserver(), title: "⠋ Claude Code",
    lines: ["────────────────", "❯ ", "────────────────"],
    working: "✻ Cogitating… (12s · esc to interrupt)",
    blocker: "Enter to confirm · Esc to cancel",
    cursor: { x: 2, y: 1, visible: false },
  },
  {
    name: "Codex", create: () => new CodexTerminalObserver(), title: "⠋ project",
    lines: ["› ", "", "? for shortcuts"],
    working: "• Working (12s • esc to interrupt)",
    blocker: "press enter to confirm or esc to cancel",
    cursor: { x: 2, y: 0, visible: true },
  },
]) {
  const idle = { lines: provider.lines, cursor: provider.cursor }
  const activeTitle = encoder.encode(`\u001b]0;${provider.title}\u0007`)

  test(`${provider.name}: title observation recovers from malformed and cancelled OSC sequences`, () => {
    for (const prefix of ["\u001b]0;unfinished", "\u001b]0;unfinished\u0018", "\u001b]0;unfinished\u001a", "\u001b]0;unfinished\u001b\u0018", "\u001b]0;unfinished\u001b\u001a"]) {
      const bytes = encoder.encode(`${prefix}\u001b]0;${provider.title}\u0007`)
      for (let split = 0; split <= bytes.length; split += 1) {
        const observer = provider.create()
        expect([...observer.observeOutput(bytes.slice(0, split)), ...observer.observeOutput(bytes.slice(split))])
          .toEqual(["working"])
      }
    }
  })

  test(`${provider.name}: fresh idle screens override stale working titles`, () => {
    const observer = provider.create()
    expect(observer.observeScreen(idle)).toBe("idle")
    observer.observeOutput(activeTitle)
    expect(observer.observeScreen(idle)).toBeUndefined()
    expect(observer.observeScreen({
      lines: ["Completed response", ...idle.lines], cursor: { ...idle.cursor, y: idle.cursor.y + 1 },
    })).toBe("idle")
  })

  test(`${provider.name}: only a second matching explicit snapshot releases prepaint suppression`, () => {
    const observer = provider.create()
    observer.observeScreen(idle)
    observer.observeOutput(activeTitle)
    for (let count = 0; count < 3; count += 1) expect(observer.observeScreen(idle)).toBeUndefined()
    expect(observer.reconcileScreen(idle, "sample")).toBeUndefined()
    for (let count = 0; count < 3; count += 1) expect(observer.observeScreen(idle)).toBeUndefined()
    expect(observer.reconcileScreen(idle, "confirm")).toBe("idle")
    expect(observer.observeScreen(idle)).toBe("idle")
    observer.observeOutput(activeTitle)
    expect(observer.reconcileScreen(idle, "sample")).toBeUndefined()
    expect(observer.reconcileScreen(idle, "confirm")).toBe("idle")
  })

  for (const reset of ["title", "input", "output", "changed screen"]) {
    test(`${provider.name}: ${reset} resets explicit recovery confirmation`, () => {
      const observer = provider.create()
      observer.observeScreen(idle)
      observer.observeOutput(activeTitle)
      expect(observer.reconcileScreen(idle, "sample")).toBeUndefined()
      if (reset === "title") observer.observeOutput(activeTitle)
      if (reset === "input") observer.observeInput(encoder.encode("x"))
      if (reset === "output") observer.observeOutput(encoder.encode("new output"))
      if (reset === "changed screen") observer.observeScreen({ ...idle, lines: ["unknown"] })
      expect(observer.reconcileScreen(idle, "confirm")).toBeUndefined()
      expect(observer.reconcileScreen(idle, "confirm")).toBeUndefined()
      expect(observer.reconcileScreen(idle, "sample")).toBeUndefined()
      expect(observer.reconcileScreen(idle, "confirm")).toBe("idle")
    })
  }

  test(`${provider.name}: every new probe samples afresh instead of confirming an abandoned candidate`, () => {
    const observer = provider.create()
    observer.observeScreen(idle)
    observer.observeOutput(activeTitle)
    expect(observer.reconcileScreen(idle, "sample")).toBeUndefined()
    expect(observer.observeScreen(idle)).toBeUndefined()
    expect(observer.reconcileScreen(idle, "sample")).toBeUndefined()
    expect(observer.reconcileScreen(idle, "confirm")).toBe("idle")
  })

  test(`${provider.name}: an invalidated confirmation cannot leak into the next probe`, () => {
    const observer = provider.create()
    observer.observeScreen(idle)
    observer.observeOutput(activeTitle)
    expect(observer.reconcileScreen(idle, "sample")).toBeUndefined()
    observer.observeOutput(activeTitle)
    expect(observer.reconcileScreen(idle, "confirm")).toBeUndefined()
    expect(observer.reconcileScreen(idle, "sample")).toBeUndefined()
    expect(observer.reconcileScreen(idle, "confirm")).toBe("idle")
  })

  test(`${provider.name}: confirm without a sample never establishes a recovery candidate`, () => {
    const observer = provider.create()
    observer.observeScreen(idle)
    observer.observeOutput(activeTitle)
    expect(observer.reconcileScreen(idle, "confirm")).toBeUndefined()
    expect(observer.reconcileScreen(idle, "confirm")).toBeUndefined()
    expect(observer.reconcileScreen(idle, "sample")).toBeUndefined()
    expect(observer.reconcileScreen(idle, "confirm")).toBe("idle")
  })

  for (const signal of ["working", "blocked", "unknown"] as const) {
    test(`${provider.name}: explicit recovery never turns ${signal} into idle`, () => {
      const observer = provider.create()
      observer.observeScreen(idle)
      observer.observeOutput(activeTitle)
      observer.reconcileScreen(idle, "sample")
      const screen = { ...idle, lines: signal === "unknown" ? ["ordinary output"] :
        [...idle.lines, signal === "working" ? provider.working : provider.blocker] }
      for (let count = 0; count < 3; count += 1) {
        expect(observer.reconcileScreen(screen, count === 0 ? "sample" : "confirm")).toBe(signal === "unknown" ? undefined : signal)
      }
    })
  }
}
