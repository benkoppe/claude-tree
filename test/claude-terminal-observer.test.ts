import { expect, test } from "bun:test"

import {
  claudeActivityFromTitle,
  ClaudeTerminalObserver,
  observeClaudeActivity,
  observeClaudeDraft,
} from "../src/providers/claude-terminal-observer"

test("observes only a cursor-local Claude composer bounded by its rule", () => {
  expect(
    observeClaudeDraft({
      text: "",
      lines: ["old output", "────────────────", "❯ first line", "  second line", "────────────────", "status"],
      columns: 40,
      rows: 6,
      cursor: { x: 8, y: 3, visible: true },
    }),
  ).toBe("first line\n  second line")
  expect(
    observeClaudeDraft({
      text: "",
      lines: ["❯ transcript text", "not a composer"],
      columns: 40,
      rows: 2,
      cursor: { x: 5, y: 0, visible: true },
    }),
  ).toBeUndefined()
  expect(
    observeClaudeDraft({
      text: "",
      lines: ["❯ hidden cursor", "────────────────"],
      columns: 40,
      rows: 2,
      cursor: { x: 5, y: 0, visible: false },
    }),
  ).toBeUndefined()
})

test("recognizes Claude's working and idle terminal titles", () => {
  expect(claudeActivityFromTitle("⠋ Claude Code")).toBe("working")
  expect(claudeActivityFromTitle("◐ Claude Code")).toBe("working")
  expect(claudeActivityFromTitle("✳ Claude Code")).toBe("idle")
  expect(claudeActivityFromTitle("project shell")).toBeUndefined()
})

test("does not let a stale composer override working title activity", () => {
  const observer = new ClaudeTerminalObserver()
  expect(
    observer.observeOutput(new TextEncoder().encode("\u001b]0;⠋ Claude Code\u0007")),
  ).toEqual(["working"])
  expect(
    observer.observeScreen({
      text: "",
      lines: ["❯ ", "────────────────"],
      columns: 40,
      rows: 2,
      cursor: { x: 2, y: 0, visible: true },
    }),
  ).toBeUndefined()
})

test("does not let a stale working footer above the live composer override idle activity", () => {
  const observer = new ClaudeTerminalObserver()
  expect(
    observer.observeOutput(new TextEncoder().encode("\u001b]0;✳ Claude Code\u0007")),
  ).toEqual(["idle"])
  expect(
    observer.observeScreen({
      text: "",
      lines: ["✻ Cogitating… (12s · esc to interrupt)", "❯ ", "────────────────"],
      columns: 40,
      rows: 3,
      cursor: { x: 2, y: 1, visible: true },
    }),
  ).toBe("idle")
})

test("uses a live working footer when Claude pins its title to the idle glyph", () => {
  const observer = new ClaudeTerminalObserver()
  expect(
    observer.observeOutput(new TextEncoder().encode("\u001b]0;✳ Claude Code\u0007")),
  ).toEqual(["idle"])
  expect(
    observer.observeScreen({
      text: "",
      lines: ["✻ Cogitating… (12s · esc to interrupt)"],
      columns: 40,
      rows: 1,
      cursor: { x: 0, y: 0, visible: false },
    }),
  ).toBe("working")
})

test("treats a working footer below the submitted prompt as live", () => {
  expect(
    observeClaudeActivity({
      text: "",
      lines: [
        "❯ implement the change",
        "",
        "✻ Cogitating… (12s · esc to interrupt)",
        "────────────────",
      ],
      columns: 60,
      rows: 4,
      cursor: { x: 0, y: 2, visible: true },
    }),
  ).toBe("working")
})

test("preserves ordered Claude activity transitions in one output chunk", () => {
  const observer = new ClaudeTerminalObserver()
  const output = new TextEncoder().encode(
    "\u001b]0;⠋ Claude Code\u0007\u001b]0;✳ Claude Code\u0007",
  )

  expect(observer.observeOutput(output)).toEqual(["working", "idle"])
})

test("uses the visible Claude footer and composer as activity fallbacks", () => {
  expect(
    observeClaudeActivity({
      text: "",
      lines: ["✻ Cogitating… (12s · esc to interrupt)"],
      columns: 40,
      rows: 1,
      cursor: { x: 0, y: 0, visible: false },
    }),
  ).toBe("working")
  expect(
    observeClaudeActivity({
      text: "",
      lines: ["❯ ", "────────────────"],
      columns: 40,
      rows: 2,
      cursor: { x: 2, y: 0, visible: true },
    }),
  ).toBe("idle")
  expect(
    observeClaudeActivity({
      text: "",
      lines: ["historical output"],
      columns: 40,
      rows: 1,
      cursor: { x: 0, y: 0, visible: false },
    }),
  ).toBeUndefined()
})

test("reports visible Claude permission prompts as blocked", () => {
  expect(
    observeClaudeActivity({
      text: "",
      lines: [
        "Bash command",
        "Do you want to proceed?",
        "❯ 1. Yes",
        "  2. No",
        "Tab to amend · Esc to cancel",
      ],
      columns: 60,
      rows: 5,
      cursor: { x: 2, y: 2, visible: true },
    }),
  ).toBe("blocked")

  expect(
    observeClaudeActivity({
      text: "",
      lines: [
        "Would you like to proceed?",
        "❯ 1. Allow once",
        "  2. Deny",
        "Esc to cancel",
      ],
      columns: 60,
      rows: 4,
      cursor: { x: 2, y: 1, visible: true },
    }),
  ).toBe("blocked")
})
