import { expect, test } from "bun:test"

import {
  codexActivityFromTitle,
  CodexTerminalObserver,
  observeCodexActivity,
  observeCodexDraft,
} from "../../src/infrastructure/providers/codex/terminal-observer"

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

test("recognizes only structured Codex title activity, not configurable word-only fields", () => {
  expect(codexActivityFromTitle("[ ! ] Action Required | claude-tree-codex")).toBe("blocked")
  expect(codexActivityFromTitle("[ . ] Action Required | claude-tree-codex")).toBe("blocked")
  expect(codexActivityFromTitle("[ ! ] Action Required")).toBe("blocked")
  expect(codexActivityFromTitle("working-notes")).toBeUndefined()
  expect(codexActivityFromTitle("Thinking about tests")).toBeUndefined()
  for (const title of ["Working", "Thinking", "Waiting", "Ready", "Idle", "Action Required", "Action Required notes", "Working | project"]) {
    expect(codexActivityFromTitle(title)).toBeUndefined()
  }
  for (const word of ["Starting", "Working", "Thinking", "Waiting", "Ready", "Idle", "Action Required"]) {
    for (const title of [`project | ${word}`, `${word} | thread`, `project | ${word} | thread`]) {
      expect(codexActivityFromTitle(title)).toBeUndefined()
    }
  }
  for (const title of ["project ⠋suffix", "prefix⠋ project", "[ ! ] Action Required notes", "project | [ ! ] Action Required"]) {
    expect(codexActivityFromTitle(title)).toBeUndefined()
  }
})

for (const [active, idle] of [
  ["⠋ project", "project"], // Upstream 0.150.1 default: activity + project-name.
  ["project ⠹", "project"],
  ["project ⠸ thread", "project | thread"],
  ["codex | project ⠼ thread | branch", "codex | project | thread | branch"],
  ["⠴ | project", "project"],
  ["project | ⠦ | thread", "project | thread"],
  ["project | ⠧", "project"],
  ["⠇ Working", "Working"],
  ["Thinking ⠏ Ready", "Thinking | Ready"],
  ["[ ! ] Action Required | project", "project"],
  ["[ . ] Action Required | project | thread", "project | thread"],
] as const) {
  test(`recognizes configured title activity and its exact remaining-title transition: ${active}`, () => {
    const observer = new CodexTerminalObserver()
    const activity = active.startsWith("[") ? "blocked" : "working"
    expect(codexActivityFromTitle(active)).toBe(activity)
    expect(observer.observeOutput(new TextEncoder().encode(`\u001b]0;${active}\u0007\u001b]0;${idle}\u0007`)))
      .toEqual([activity, "idle"])
  })
}

test("unknown titles cannot complete activity without the recognized project transition", () => {
  const observer = new CodexTerminalObserver()
  const output = (title: string) => observer.observeOutput(new TextEncoder().encode(`\u001b]2;${title}\u0007`))
  expect(output("⠋ | project")).toEqual(["working"])
  expect(output("unrelated shell")).toEqual([])
  expect(output("project")).toEqual([])
  expect(output("project | Working")).toEqual([])
  expect(output("unrelated shell")).toEqual([])
  expect(output("⠋")).toEqual(["working"])
  expect(output("")).toEqual([])
  expect(output("project ⠋ ⠹")).toEqual(["working"])
  expect(output("project | ⠹")).toEqual(["working"])
})

test("live working footers override an idle Codex title and composer", () => {
  const observer = new CodexTerminalObserver()
  observer.observeOutput(new TextEncoder().encode("\u001b]0;⠋ project\u0007"))
  expect(observer.observeOutput(new TextEncoder().encode("\u001b]0;project\u0007"))).toEqual(["idle"])
  expect(observer.observeScreen({
    lines: ["› prompt", "? for shortcuts", "• Working (12s • esc to interrupt)"],
    cursor: { x: 8, y: 0, visible: true },
  })).toBe("working")
})

test("keeps action-required title activity authoritative over a stale status row", () => {
  const observer = new CodexTerminalObserver()
  expect(
    observer.observeOutput(
      new TextEncoder().encode("\u001b]0;[ ! ] Action Required | claude-tree-codex\u0007"),
    ),
  ).toEqual(["blocked"])
  expect(
    observer.observeScreen({
      lines: ["• Working (12s • esc to interrupt)"],
      cursor: { x: 0, y: 0, visible: false },
    }),
  ).toBeUndefined()
})

test("uses stock Codex status rows as visible activity fallbacks", () => {
  for (const status of ["Working", "Thinking", "Waiting"]) {
    expect(
      observeCodexActivity({
        lines: [`• ${status} (1m 02s • esc to interrupt)`],
        cursor: { x: 0, y: 0, visible: false },
      }),
    ).toBe("working")
  }

  expect(
    observeCodexActivity({
      lines: ["Working on the project documentation"],
      cursor: { x: 0, y: 0, visible: false },
    }),
  ).toBeUndefined()
})

test("ignores stale working rows above the live composer", () => {
  expect(
    observeCodexActivity({
      lines: [
        "• Working (12s • esc to interrupt)",
        "",
        "› Ask Codex to do anything",
        "",
        "  gpt-5.6-sol default · /tmp/project",
      ],
      cursor: { x: 2, y: 2, visible: true },
    }),
  ).toBe("idle")
})

test("only treats a working row near the bottom as current", () => {
  expect(
    observeCodexActivity({
      lines: [
        "• Working (12s • esc to interrupt)",
        "older output",
        "more output",
        "more output",
        "more output",
      ],
      cursor: { x: 0, y: 4, visible: false },
    }),
  ).toBeUndefined()
})

test("keeps visible Codex confirmation and trust prompts active", () => {
  const confirmation = {
    lines: [
      "› update dependencies",
      "Would you like to run this command?  1. Yes  2. No",
      "press enter to confirm or esc to cancel",
    ],
    cursor: { x: 0, y: 2, visible: true },
  }
  expect(observeCodexActivity(confirmation)).toBe("blocked")

  expect(
    observeCodexActivity({
      ...confirmation,
      lines: ["› update dependencies", "Do you want to proceed?", "❯ 1. Yes", "  2. No"],
      cursor: { x: 0, y: 2, visible: true },
    }),
  ).toBe("blocked")

  const observer = new CodexTerminalObserver()
  expect(
    observer.observeOutput(new TextEncoder().encode("\u001b]0;project | Ready\u0007")),
  ).toEqual([])
  expect(observer.observeScreen(confirmation)).toBe("blocked")

  expect(
    observeCodexActivity({
      lines: [
        "> You are in /tmp/project",
        "Do you trust the contents of this directory?",
        "  1. Yes",
      ],
      cursor: { x: 2, y: 2, visible: true },
    }),
  ).toBe("blocked")
})

test("does not infer activity from stale rows in Codex's transcript viewer", () => {
  expect(
    observeCodexActivity({
      lines: [
        "• Working (12s • esc to interrupt)",
        "↑/↓ to scroll · pgup/pgdn to page · home/end to jump",
        "esc to edit prev · q to quit",
      ],
      cursor: { x: 0, y: 2, visible: true },
    }),
  ).toBeUndefined()
})

test("recognizes an idle stock composer without capturing its placeholder", () => {
  const screen = {
    lines: ["› Ask Codex to do anything", "", "  gpt-5.6-sol default · /tmp/project"],
    cursor: { x: 2, y: 0, visible: true },
  }

  expect(observeCodexActivity(screen)).toBe("idle")
  expect(observeCodexDraft(screen)).toBeUndefined()
})

test("extracts an approximate cursor-local Codex draft bounded by the footer", () => {
  const screen = {
    lines: [
      "• Previous response",
      "",
      "› first line",
      "  second line",
      "",
      "  gpt-5.6-sol default · /tmp/project",
    ],
    cursor: { x: 8, y: 3, visible: true },
  }

  expect(observeCodexActivity(screen)).toBe("idle")
  expect(observeCodexDraft(screen)).toBe("first line\n  second line")
})

test("fails closed for malformed or non-local composer-like screens", () => {
  expect(
    observeCodexDraft({
      lines: ["› transcript request", "assistant response"],
      cursor: { x: 20, y: 0, visible: true },
    }),
  ).toBeUndefined()
  expect(
    observeCodexDraft({
      lines: ["› hidden draft", "", "  gpt-5.6-sol default · /tmp/project"],
      cursor: { x: 14, y: 0, visible: false },
    }),
  ).toBeUndefined()
  expect(
    observeCodexDraft({
      lines: ["› draft", "  › transcript request", "  gpt-5.6-sol default · /tmp/project"],
      cursor: { x: 7, y: 0, visible: true },
    }),
  ).toBeUndefined()
})
