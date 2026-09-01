import { expect, test } from "bun:test"

import {
  codexActivityFromTitle,
  CodexTerminalObserver,
  observeCodexActivity,
  observeCodexDraft,
} from "../src/providers/codex-terminal-observer"

test("parses split Codex OSC title sequences incrementally", () => {
  const observer = new CodexTerminalObserver()
  const sequence = new TextEncoder().encode("noise\u001b]0;⠋ | claude-tree-codex\u001b\\")

  expect(observer.observeOutput(sequence.slice(0, 10))).toEqual([])
  expect(observer.observeOutput(sequence.slice(10, 16))).toEqual([])
  expect(observer.observeOutput(sequence.slice(16))).toEqual(["working"])
})

test("observes a non-active title as idle only after known activity", () => {
  const observer = new CodexTerminalObserver()
  const encode = (value: string) => new TextEncoder().encode(value)

  expect(observer.observeOutput(encode("\u001b]2;claude-tree-codex\u0007"))).toEqual([])
  expect(observer.observeOutput(encode("\u001b]2;⠹ | claude-tree-codex\u0007"))).toEqual(["working"])
  expect(observer.observeOutput(encode("\u001b]2;claude-tree-codex\u0007"))).toEqual(["idle"])
  expect(observer.observeOutput(encode("\u001b]2;another-project\u0007"))).toEqual([])
})

test("preserves ordered Codex activity transitions in one output chunk", () => {
  const observer = new CodexTerminalObserver()
  const output = new TextEncoder().encode(
    "\u001b]2;⠹ | claude-tree-codex\u0007\u001b]2;claude-tree-codex\u0007",
  )

  expect(observer.observeOutput(output)).toEqual(["working", "idle"])
})

test("recognizes action-required and explicit Codex title statuses conservatively", () => {
  expect(codexActivityFromTitle("[ ! ] Action Required | claude-tree-codex")).toBe("working")
  expect(codexActivityFromTitle("[ . ] Action Required | claude-tree-codex")).toBe("working")
  expect(codexActivityFromTitle("claude-tree-codex | Working")).toBe("working")
  expect(codexActivityFromTitle("claude-tree-codex | Thinking")).toBe("working")
  expect(codexActivityFromTitle("claude-tree-codex | Waiting")).toBe("working")
  expect(codexActivityFromTitle("claude-tree-codex | Ready")).toBe("idle")
  expect(codexActivityFromTitle("working-notes")).toBeUndefined()
  expect(codexActivityFromTitle("Thinking about tests")).toBeUndefined()
})

test("keeps action-required title activity authoritative over a stale status row", () => {
  const observer = new CodexTerminalObserver()
  expect(
    observer.observeOutput(
      new TextEncoder().encode("\u001b]0;[ ! ] Action Required | claude-tree-codex\u0007"),
    ),
  ).toEqual(["working"])
  expect(
    observer.observeScreen({
      text: "",
      lines: ["• Working (12s • esc to interrupt)"],
      columns: 60,
      rows: 1,
      cursor: { x: 0, y: 0, visible: false },
    }),
  ).toBe("working")
})

test("uses stock Codex status rows as visible activity fallbacks", () => {
  for (const status of ["Working", "Thinking", "Waiting"]) {
    expect(
      observeCodexActivity({
        text: "",
        lines: [`• ${status} (1m 02s • esc to interrupt)`],
        columns: 60,
        rows: 1,
        cursor: { x: 0, y: 0, visible: false },
      }),
    ).toBe("working")
  }

  expect(
    observeCodexActivity({
      text: "",
      lines: ["Working on the project documentation"],
      columns: 60,
      rows: 1,
      cursor: { x: 0, y: 0, visible: false },
    }),
  ).toBeUndefined()
})

test("ignores stale working rows above the live composer", () => {
  expect(
    observeCodexActivity({
      text: "",
      lines: [
        "• Working (12s • esc to interrupt)",
        "",
        "› Ask Codex to do anything",
        "",
        "  gpt-5.6-sol default · /tmp/project",
      ],
      columns: 80,
      rows: 5,
      cursor: { x: 2, y: 2, visible: true },
    }),
  ).toBe("idle")
})

test("only treats a working row near the bottom as current", () => {
  expect(
    observeCodexActivity({
      text: "",
      lines: [
        "• Working (12s • esc to interrupt)",
        "older output",
        "more output",
        "more output",
        "more output",
      ],
      columns: 80,
      rows: 5,
      cursor: { x: 0, y: 4, visible: false },
    }),
  ).toBeUndefined()
})

test("keeps visible Codex confirmation and trust prompts active", () => {
  const confirmation = {
    text: "",
    lines: [
      "› update dependencies",
      "Would you like to run this command?  1. Yes  2. No",
      "press enter to confirm or esc to cancel",
    ],
    columns: 80,
    rows: 3,
    cursor: { x: 0, y: 2, visible: true },
  }
  expect(observeCodexActivity(confirmation)).toBe("working")

  expect(
    observeCodexActivity({
      ...confirmation,
      lines: ["› update dependencies", "Do you want to proceed?", "❯ 1. Yes", "  2. No"],
      rows: 4,
      cursor: { x: 0, y: 2, visible: true },
    }),
  ).toBe("working")

  const observer = new CodexTerminalObserver()
  expect(
    observer.observeOutput(new TextEncoder().encode("\u001b]0;project | Ready\u0007")),
  ).toEqual(["idle"])
  expect(observer.observeScreen(confirmation)).toBe("working")

  expect(
    observeCodexActivity({
      text: "",
      lines: [
        "> You are in /tmp/project",
        "Do you trust the contents of this directory?",
        "  1. Yes",
      ],
      columns: 80,
      rows: 3,
      cursor: { x: 2, y: 2, visible: true },
    }),
  ).toBe("working")
})

test("does not infer activity from stale rows in Codex's transcript viewer", () => {
  expect(
    observeCodexActivity({
      text: "",
      lines: [
        "• Working (12s • esc to interrupt)",
        "↑/↓ to scroll · pgup/pgdn to page · home/end to jump",
        "esc to edit prev · q to quit",
      ],
      columns: 80,
      rows: 3,
      cursor: { x: 0, y: 2, visible: true },
    }),
  ).toBeUndefined()
})

test("recognizes an idle stock composer without capturing its placeholder", () => {
  const screen = {
    text: "",
    lines: ["› Ask Codex to do anything", "", "  gpt-5.6-sol default · /tmp/project"],
    columns: 80,
    rows: 3,
    cursor: { x: 2, y: 0, visible: true },
  }

  expect(observeCodexActivity(screen)).toBe("idle")
  expect(observeCodexDraft(screen)).toBeUndefined()
})

test("extracts an approximate cursor-local Codex draft bounded by the footer", () => {
  const screen = {
    text: "",
    lines: [
      "• Previous response",
      "",
      "› first line",
      "  second line",
      "",
      "  gpt-5.6-sol default · /tmp/project",
    ],
    columns: 80,
    rows: 6,
    cursor: { x: 8, y: 3, visible: true },
  }

  expect(observeCodexActivity(screen)).toBe("idle")
  expect(observeCodexDraft(screen)).toBe("first line\n  second line")
})

test("fails closed for malformed or non-local composer-like screens", () => {
  expect(
    observeCodexDraft({
      text: "",
      lines: ["› transcript request", "assistant response"],
      columns: 60,
      rows: 2,
      cursor: { x: 20, y: 0, visible: true },
    }),
  ).toBeUndefined()
  expect(
    observeCodexDraft({
      text: "",
      lines: ["› hidden draft", "", "  gpt-5.6-sol default · /tmp/project"],
      columns: 60,
      rows: 3,
      cursor: { x: 14, y: 0, visible: false },
    }),
  ).toBeUndefined()
  expect(
    observeCodexDraft({
      text: "",
      lines: ["› draft", "  › transcript request", "  gpt-5.6-sol default · /tmp/project"],
      columns: 60,
      rows: 3,
      cursor: { x: 7, y: 0, visible: true },
    }),
  ).toBeUndefined()
})
