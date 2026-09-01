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

test("marks a restored composer as a rewind after Claude's undo command", () => {
  const observer = new ClaudeTerminalObserver()
  observer.observeInput(new TextEncoder().encode("/undo\r"))

  expect(observer.observeDraft({
    text: "",
    lines: ["❯ restored prompt", "────────────────"],
    columns: 40,
    rows: 2,
    cursor: { x: 18, y: 0, visible: true },
  })).toEqual({
    text: "restored prompt",
    exact: false,
    rewind: true,
    rewindTarget: "restored prompt",
  })
})

test("retains the rewind target when the restored Claude prompt is edited", () => {
  const observer = new ClaudeTerminalObserver()
  observer.observeInput(new TextEncoder().encode("/undo\r"))
  observer.observeScreen({
    text: "",
    lines: ["❯ restored prompt", "────────────────"],
    columns: 40,
    rows: 2,
    cursor: { x: 18, y: 0, visible: true },
  })

  expect(observer.observeDraft({
    text: "",
    lines: ["❯ edited prompt", "────────────────"],
    columns: 40,
    rows: 2,
    cursor: { x: 16, y: 0, visible: true },
  })).toEqual({
    text: "edited prompt",
    exact: false,
    rewind: true,
    rewindTarget: "restored prompt",
  })
})

test("replaces a captured rewind target when Claude is rewound again", () => {
  const observer = new ClaudeTerminalObserver()
  const encoder = new TextEncoder()
  const firstRestored = {
    text: "",
    lines: ["❯ later historical prompt", "────────────────"],
    columns: 40,
    rows: 2,
    cursor: { x: 26, y: 0, visible: true },
  }
  observer.observeInput(encoder.encode("/undo\r"))
  observer.observeScreen(firstRestored)
  expect(observer.observeDraft(firstRestored)?.rewindTarget).toBe("later historical prompt")

  observer.observeInput(encoder.encode("\u0015/undo\r"))
  expect(observer.observeDraft(firstRestored)).toEqual({
    text: "later historical prompt",
    exact: false,
  })
  const picker = {
    text: "",
    lines: ["Rewind conversation to a message", "❯ candidate", "────────────────"],
    columns: 40,
    rows: 3,
    cursor: { x: 11, y: 1, visible: true },
  }
  observer.observeScreen(picker)
  observer.observeInput(encoder.encode("\r"))
  const secondRestored = {
    ...firstRestored,
    lines: ["❯ earlier historical prompt", "────────────────"],
    cursor: { x: 28, y: 0, visible: true },
  }
  observer.observeScreen(secondRestored)

  expect(observer.observeDraft(secondRestored)).toEqual({
    text: "earlier historical prompt",
    exact: false,
    rewind: true,
    rewindTarget: "earlier historical prompt",
  })
})

test("replaces a captured rewind target after another double-Escape shortcut", () => {
  const observer = new ClaudeTerminalObserver()
  const encoder = new TextEncoder()
  const firstRestored = {
    text: "",
    lines: ["❯ later prompt", "────────────────"],
    columns: 40,
    rows: 2,
    cursor: { x: 14, y: 0, visible: true },
  }
  observer.observeInput(encoder.encode("/undo\r"))
  observer.observeScreen(firstRestored)
  observer.observeInput(encoder.encode("\u001b\u001b"))
  expect(observer.observeDraft(firstRestored)?.rewind).toBeUndefined()

  const secondRestored = {
    ...firstRestored,
    lines: ["❯ earlier prompt", "────────────────"],
    cursor: { x: 16, y: 0, visible: true },
  }
  observer.observeScreen(secondRestored)
  expect(observer.observeDraft(secondRestored)?.rewindTarget).toBe("earlier prompt")
})

test("retains a submitted rewind boundary until Claude finishes the turn", () => {
  const observer = new ClaudeTerminalObserver()
  const encoder = new TextEncoder()
  const restored = {
    text: "",
    lines: ["❯ restored prompt", "────────────────"],
    columns: 40,
    rows: 2,
    cursor: { x: 18, y: 0, visible: true },
  }
  observer.observeInput(encoder.encode("/undo\r"))
  observer.observeScreen(restored)
  observer.observeInput(encoder.encode("edited prompt\r"))

  expect(observer.observeDraft(restored)).toEqual({
    text: "restored prompt",
    exact: false,
    rewind: true,
    rewindTarget: "restored prompt",
    submitted: true,
  })

  observer.observeOutput(encoder.encode(
    "\u001b]0;⠋ Claude Code\u0007\u001b]0;✳ Claude Code\u0007",
  ))
  expect(observer.observeDraft({
    ...restored,
    lines: ["❯ next prompt", "────────────────"],
    cursor: { x: 13, y: 0, visible: true },
  })).toEqual({ text: "next prompt", exact: false })
})

test("keeps rewind pending across picker navigation and selection", () => {
  const observer = new ClaudeTerminalObserver()
  const encoder = new TextEncoder()
  observer.observeInput(encoder.encode("/undo\r"))
  const picker = {
    text: "",
    lines: ["Rewind conversation to a message", "❯ candidate", "────────────────"],
    columns: 40,
    rows: 3,
    cursor: { x: 11, y: 1, visible: true },
  }
  observer.observeScreen(picker)
  expect(observer.observeDraft(picker)).toBeUndefined()
  observer.observeInput(encoder.encode("\u001b[A"))
  observer.observeInput(encoder.encode("\u001b[A"))
  observer.observeInput(encoder.encode("\r"))
  const restored = {
    text: "",
    lines: ["❯ selected historical prompt", "────────────────"],
    columns: 40,
    rows: 2,
    cursor: { x: 29, y: 0, visible: true },
  }
  observer.observeScreen(restored)

  expect(observer.observeDraft(restored)).toEqual({
    text: "selected historical prompt",
    exact: false,
    rewind: true,
    rewindTarget: "selected historical prompt",
  })
})

test("clears a pending rewind when the picker is cancelled", () => {
  const observer = new ClaudeTerminalObserver()
  const encoder = new TextEncoder()
  observer.observeInput(encoder.encode("/undo\r"))
  observer.observeScreen({
    text: "",
    lines: ["Rewind conversation to a message", "❯ candidate", "────────────────"],
    columns: 40,
    rows: 3,
    cursor: { x: 11, y: 1, visible: true },
  })
  observer.observeInput(encoder.encode("\u001b"))

  expect(observer.observeDraft({
    text: "",
    lines: ["❯ ordinary prompt", "────────────────"],
    columns: 40,
    rows: 2,
    cursor: { x: 17, y: 0, visible: true },
  })).toEqual({ text: "ordinary prompt", exact: false })
})

test("does not arm rewind from ordinary conversation text or expose the picker as a draft", () => {
  const observer = new ClaudeTerminalObserver()
  const screen = {
    text: "",
    lines: ["Please rewind the conversation to a message", "❯ ordinary", "────────────────"],
    columns: 40,
    rows: 3,
    cursor: { x: 11, y: 1, visible: true },
  }

  observer.observeScreen(screen)
  expect(observer.observeDraft(screen)).toEqual({ text: "ordinary", exact: false })
})

test("recognizes rewind commands around terminal control sequences", () => {
  const observer = new ClaudeTerminalObserver()
  const encoder = new TextEncoder()
  observer.observeInput(encoder.encode("\u001b[I"))
  observer.observeInput(encoder.encode("discarded\u0015/rewind\r"))

  expect(observer.observeDraft({
    text: "",
    lines: ["❯ restored", "────────────────"],
    columns: 40,
    rows: 2,
    cursor: { x: 10, y: 0, visible: true },
  })?.rewind).toBeTrue()
})

test("recognizes batched and CSI-u double-Escape rewind shortcuts", () => {
  const encoder = new TextEncoder()
  for (const input of ["\u001b\u001b", "\u001b[27u\u001b[27u"]) {
    const observer = new ClaudeTerminalObserver()
    observer.observeInput(encoder.encode(input))
    expect(observer.observeDraft({
      text: "",
      lines: ["❯ restored", "────────────────"],
      columns: 40,
      rows: 2,
      cursor: { x: 10, y: 0, visible: true },
    })?.rewind).toBeTrue()
  }
})

test("does not mark an ordinary Claude draft as a rewind", () => {
  const observer = new ClaudeTerminalObserver()

  expect(observer.observeDraft({
    text: "",
    lines: ["❯ ordinary draft", "────────────────"],
    columns: 40,
    rows: 2,
    cursor: { x: 16, y: 0, visible: true },
  })).toEqual({ text: "ordinary draft", exact: false })
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
