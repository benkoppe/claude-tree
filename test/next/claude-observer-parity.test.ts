import { expect, test } from "bun:test"

import {
  claudeActivityFromTitle,
  ClaudeTerminalObserver,
  observeClaudeActivity,
  observeClaudeDraft,
} from "../../src/infrastructure/providers/claude/terminal-observer"

test("observes only a cursor-local Claude composer bounded by its rule", () => {
  expect(
    observeClaudeDraft({
      lines: ["old output", "────────────────", "❯ first line", "  second line", "────────────────", "status"],
      cursor: { x: 8, y: 3, visible: true },
    }),
  ).toBe("first line\n  second line")
  expect(
    observeClaudeDraft({
      lines: ["❯ transcript text", "not a composer"],
      cursor: { x: 5, y: 0, visible: true },
    }),
  ).toBeUndefined()
  expect(
    observeClaudeDraft({
      lines: ["❯ hidden cursor", "────────────────"],
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

test("hidden-cursor rewind capture requires a complete idle composer after confirmation", () => {
  const observer = new ClaudeTerminalObserver()
  const encoder = new TextEncoder()
  const restored = { lines: ["────────────────", "❯ restored", "────────────────"], cursor: { x: 0, y: 0, visible: false } }
  expect(observer.observeDraft(restored)).toBeUndefined()
  observer.observeInput(encoder.encode("/rewind\r"))
  expect(observer.observeDraft(restored)).toBeUndefined()
  observer.observeScreen({ ...restored, lines: ["Confirm you want to restore the conversation"] })
  observer.observeInput(encoder.encode("\r"))
  expect(observer.observeDraft({ ...restored, lines: ["❯ historical text", "────────────────"] })).toBeUndefined()
  expect(observer.observeDraft({ ...restored, lines: [...restored.lines, "✻ Cogitating… (12s · esc to interrupt)"] })).toBeUndefined()
  expect(observer.observeDraft(restored)).toEqual({ text: "restored", exact: false, rewind: true, rewindTarget: "restored" })
})

test("marks a restored composer as a rewind after Claude's undo command", () => {
  const observer = new ClaudeTerminalObserver()
  observer.observeInput(new TextEncoder().encode("/undo\r"))

  expect(observer.observeDraft({
    lines: ["❯ restored prompt", "────────────────"],
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
    lines: ["❯ restored prompt", "────────────────"],
    cursor: { x: 18, y: 0, visible: true },
  })

  expect(observer.observeDraft({
    lines: ["❯ edited prompt", "────────────────"],
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
    lines: ["❯ later historical prompt", "────────────────"],
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
    lines: ["Rewind conversation to a message", "❯ candidate", "────────────────"],
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
    lines: ["❯ later prompt", "────────────────"],
    cursor: { x: 14, y: 0, visible: true },
  }
  observer.observeInput(encoder.encode("/undo\r"))
  observer.observeScreen(firstRestored)
  observer.observeInput(encoder.encode("\u001b\u001b"))
  expect(observer.observeDraft(firstRestored)?.rewind).toBeUndefined()
  observer.observeScreen({ ...firstRestored, lines: ["Rewind conversation to a message"] })
  observer.observeInput(encoder.encode("\r"))

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
    lines: ["❯ restored prompt", "────────────────"],
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
    lines: ["Rewind conversation to a message", "❯ candidate", "────────────────"],
    cursor: { x: 11, y: 1, visible: true },
  }
  observer.observeScreen(picker)
  expect(observer.observeDraft(picker)).toBeUndefined()
  observer.observeInput(encoder.encode("\u001b[A"))
  observer.observeInput(encoder.encode("\u001b[A"))
  observer.observeInput(encoder.encode("\r"))
  const restored = {
    lines: ["❯ selected historical prompt", "────────────────"],
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
    lines: ["Rewind conversation to a message", "❯ candidate", "────────────────"],
    cursor: { x: 11, y: 1, visible: true },
  })
  observer.observeInput(encoder.encode("\u001b"))

  expect(observer.observeDraft({
    lines: ["❯ ordinary prompt", "────────────────"],
    cursor: { x: 17, y: 0, visible: true },
  })).toEqual({ text: "ordinary prompt", exact: false })
})

test("does not arm rewind from ordinary conversation text or expose the picker as a draft", () => {
  const observer = new ClaudeTerminalObserver()
  const screen = {
    lines: ["Please rewind the conversation to a message", "❯ ordinary", "────────────────"],
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
  observer.observeScreen({ lines: ["Rewind conversation to a message"], cursor: { x: 0, y: 0, visible: false } })
  observer.observeInput(encoder.encode("\r"))

  expect(observer.observeDraft({
    lines: ["❯ restored", "────────────────"],
    cursor: { x: 10, y: 0, visible: true },
  })?.rewind).toBeTrue()
})

test("recognizes batched and CSI-u double-Escape rewind shortcuts", () => {
  const encoder = new TextEncoder()
  for (const input of ["\u001b\u001b", "\u001b[27u\u001b[27u"]) {
    const observer = new ClaudeTerminalObserver()
    observer.observeInput(encoder.encode(input))
    expect(observer.observeDraft({ lines: ["❯ ordinary", "────────────────"], cursor: { x: 2, y: 0, visible: true } })?.rewind).toBeUndefined()
    observer.observeScreen({ lines: ["Rewind conversation to a message"], cursor: { x: 0, y: 0, visible: false } })
    observer.observeInput(encoder.encode("\r"))
    expect(observer.observeDraft({
      lines: ["❯ restored", "────────────────"],
      cursor: { x: 10, y: 0, visible: true },
    })?.rewind).toBeTrue()
  }
})

test("does not mark an ordinary Claude draft as a rewind", () => {
  const observer = new ClaudeTerminalObserver()

  expect(observer.observeDraft({
    lines: ["❯ ordinary draft", "────────────────"],
    cursor: { x: 16, y: 0, visible: true },
  })).toEqual({ text: "ordinary draft", exact: false })
})

test("distinguishes an unknown screen from a known empty composer", () => {
  const observer = new ClaudeTerminalObserver()
  expect(observer.observeDraft({ lines: ["output"], cursor: { x: 0, y: 0, visible: false } })).toBeUndefined()
  expect(observer.observeDraft({ lines: ["❯ ", "────────────────"], cursor: { x: 2, y: 0, visible: true } })).toBeNull()
})

for (const choice of ["Restore code", "Restore files only", "Never mind"]) {
  test(`${choice} and confirmation redraws do not create a conversation rewind`, () => {
    const observer = new ClaudeTerminalObserver()
    const confirmation = {
      lines: ["│ Confirm you want to restore the conversation │", `│ ❯ ${choice} │`],
      cursor: { x: 0, y: 1, visible: false },
    }
    observer.observeScreen(confirmation)
    observer.observeInput(new TextEncoder().encode("\r"))
    observer.observeScreen(confirmation)
    const composer = { lines: ["❯ unchanged", "────────────────"], cursor: { x: 2, y: 0, visible: true } }
    observer.observeScreen(composer)
    expect(observer.observeDraft(composer)).toEqual({ text: "unchanged", exact: false })
  })
}

test("tracks a bare-Enter restored submission and its next cancelled send", () => {
  const observer = new ClaudeTerminalObserver()
  const encoder = new TextEncoder()
  observer.observeScreen({ lines: ["Confirm you want to restore the conversation", "❯ Restore conversation"], cursor: { x: 0, y: 1, visible: false } })
  observer.observeInput(encoder.encode("\r"))
  const restored = { lines: ["❯ restored", "────────────────"], cursor: { x: 2, y: 0, visible: true } }
  observer.observeScreen(restored)
  expect(observer.observeInput(encoder.encode("\r"))).toEqual({ _tag: "Submission", text: "restored" })
  observer.observeScreen({ lines: ["✻ Cogitating… (12s · esc to interrupt)"], cursor: { x: 0, y: 0, visible: false } })
  observer.observeInput(encoder.encode("\u001b"))
  observer.observeScreen(restored)
  expect(observer.observeDraft(restored)).toEqual({ text: "restored", exact: false, rewind: true, rewindTarget: "restored" })
})

test("paste newlines are not submissions and CSI-u Enter submits the full composer", () => {
  const observer = new ClaudeTerminalObserver()
  const encoder = new TextEncoder()
  expect(observer.observeInput(encoder.encode("\u001b[200~first\nsecond\u001b[201~"))).toBeUndefined()
  expect(observer.observeInput(encoder.encode("\u001b[13u"))).toEqual({ _tag: "Submission", text: "first\nsecond" })
})

test("submission without observed text does not invent a draft payload", () => {
  expect(new ClaudeTerminalObserver().observeInput(new TextEncoder().encode("\r"))).toEqual({ _tag: "Submission" })
})

test("completed hidden-cursor resubmissions return unknown or empty, never the submitted rewind draft", () => {
  const observer = new ClaudeTerminalObserver()
  const encoder = new TextEncoder()
  observer.observeScreen({ lines: ["Confirm you want to restore the conversation"], cursor: { x: 0, y: 0, visible: false } })
  observer.observeInput(encoder.encode("\r"))
  const restored = { lines: ["────────────────", "❯ restored", "────────────────"], cursor: { x: 0, y: 0, visible: false } }
  observer.observeScreen(restored)
  expect(observer.observeDraft(restored)?.rewind).toBeTrue()
  expect(observer.observeInput(encoder.encode("\r"))).toEqual({ _tag: "Submission", text: "restored" })
  expect(observer.observeDraft(restored)).toBeUndefined()
  observer.observeOutput(encoder.encode("\u001b]0;⠋ Claude Code\u0007\u001b]0;✳ Claude Code\u0007"))
  expect(observer.observeDraft(restored)).toBeUndefined()
  const empty = { ...restored, lines: ["────────────────", "❯ ", "────────────────"] }
  observer.observeScreen(empty)
  expect(observer.observeDraft(empty)).toBeUndefined()
  expect(observer.observeDraft({ ...empty, cursor: { x: 2, y: 1, visible: true } })).toBeNull()
})

test("repeated pre-input snapshots do not erase unpainted composer edits", () => {
  const observer = new ClaudeTerminalObserver()
  const encoder = new TextEncoder()
  const screen = { lines: ["❯ restored", "────────────────"], cursor: { x: 10, y: 0, visible: true } }
  observer.observeDraft(screen)
  observer.observeInput(encoder.encode(" first"))
  observer.observeDraft(screen)
  observer.observeInput(encoder.encode(" second"))
  observer.observeDraft(screen)
  expect(observer.observeInput(encoder.encode("\r"))).toEqual({ _tag: "Submission", text: "restored first second" })
})

test("an unchanged pre-Escape composer is not proof of a cancelled send", () => {
  const observer = new ClaudeTerminalObserver()
  const encoder = new TextEncoder()
  const screen = { lines: ["❯ prompt", "────────────────"], cursor: { x: 8, y: 0, visible: true } }
  observer.observeScreen(screen)
  observer.observeInput(encoder.encode("\r"))
  observer.observeInput(encoder.encode("\u001b"))
  observer.observeScreen(screen)
  expect(observer.observeDraft(screen)?.rewind).toBeUndefined()
})

test("an empty confirmed composer cannot make a later ordinary edit a rewind", () => {
  const observer = new ClaudeTerminalObserver()
  observer.observeScreen({ lines: ["Confirm you want to restore the conversation"], cursor: { x: 0, y: 0, visible: false } })
  observer.observeInput(new TextEncoder().encode("\r"))
  const screen = { lines: ["❯ ", "────────────────"], cursor: { x: 2, y: 0, visible: true } }
  expect(observer.observeDraft(screen)).toBeNull()
  expect(observer.observeDraft({ ...screen, lines: ["❯ ordinary", "────────────────"] })?.rewind).toBeUndefined()
})

test("does not let a stale composer override working title activity", () => {
  const observer = new ClaudeTerminalObserver()
  expect(
    observer.observeOutput(new TextEncoder().encode("\u001b]0;⠋ Claude Code\u0007")),
  ).toEqual(["working"])
  expect(
    observer.observeScreen({
      lines: ["❯ ", "────────────────"],
      cursor: { x: 2, y: 0, visible: true },
    }),
  ).toBeUndefined()
})

test("a completed screen clears Working even when Claude never sends an idle title", () => {
  const observer = new ClaudeTerminalObserver()
  const stale = { lines: ["❯ ", "────────────────"], cursor: { x: 2, y: 0, visible: true } }
  observer.observeScreen(stale)
  observer.observeOutput(new TextEncoder().encode("\u001b]0;⠋ Claude Code\u0007"))
  expect(observer.observeScreen(stale)).toBeUndefined()
  const completed = { ...stale, lines: ["Finished the requested change.", "❯ ", "────────────────"], cursor: { x: 2, y: 1, visible: true } }
  expect(observer.observeScreen(completed)).toBe("idle")
  expect(observer.observeScreen(completed)).toBe("idle")
})

test("a working footer followed by a composer clears a pinned working title", () => {
  const observer = new ClaudeTerminalObserver()
  observer.observeOutput(new TextEncoder().encode("\u001b]0;⠋ Claude Code\u0007"))
  expect(observer.observeScreen({ lines: ["✻ Cogitating… (12s · esc to interrupt)"], cursor: { x: 0, y: 0, visible: false } })).toBe("working")
  expect(observer.observeScreen({ lines: ["❯ ", "────────────────"], cursor: { x: 2, y: 0, visible: true } })).toBe("idle")
})

test("does not let a stale working footer above the live composer override idle activity", () => {
  const observer = new ClaudeTerminalObserver()
  expect(
    observer.observeOutput(new TextEncoder().encode("\u001b]0;✳ Claude Code\u0007")),
  ).toEqual(["idle"])
  expect(
    observer.observeScreen({
      lines: ["✻ Cogitating… (12s · esc to interrupt)", "❯ ", "────────────────"],
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
      lines: ["✻ Cogitating… (12s · esc to interrupt)"],
      cursor: { x: 0, y: 0, visible: false },
    }),
  ).toBe("working")
})

test("treats a working footer below the submitted prompt as live", () => {
  expect(
    observeClaudeActivity({
      lines: [
        "❯ implement the change",
        "",
        "✻ Cogitating… (12s · esc to interrupt)",
        "────────────────",
      ],
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
      lines: ["✻ Cogitating… (12s · esc to interrupt)"],
      cursor: { x: 0, y: 0, visible: false },
    }),
  ).toBe("working")
  expect(
    observeClaudeActivity({
      lines: ["❯ ", "────────────────"],
      cursor: { x: 2, y: 0, visible: true },
    }),
  ).toBe("idle")
  expect(
    observeClaudeActivity({
      lines: ["historical output"],
      cursor: { x: 0, y: 0, visible: false },
    }),
  ).toBeUndefined()
})

test("reports visible Claude permission prompts as blocked", () => {
  expect(
    observeClaudeActivity({
      lines: [
        "Bash command",
        "Do you want to proceed?",
        "❯ 1. Yes",
        "  2. No",
        "Tab to amend · Esc to cancel",
      ],
      cursor: { x: 2, y: 2, visible: true },
    }),
  ).toBe("blocked")

  expect(
    observeClaudeActivity({
      lines: [
        "Would you like to proceed?",
        "❯ 1. Allow once",
        "  2. Deny",
        "Esc to cancel",
      ],
      cursor: { x: 2, y: 1, visible: true },
    }),
  ).toBe("blocked")
})
