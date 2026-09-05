import { expect, test } from "bun:test"

import {
  claudeActivityFromTitle,
  ClaudeTerminalObserver,
  observeClaudeActivity,
  observeClaudeDraft,
} from "../../src/infrastructure/providers/claude/terminal-observer"
import type { TerminalScreen } from "../../src/domain/model"

const dialogScreen = (lines: readonly string[]): TerminalScreen => ({
  lines, cursor: { x: 0, y: 0, visible: false },
})
const rewindInput = (observer: ClaudeTerminalObserver, input = "\r") => observer.observeInput(new TextEncoder().encode(input))

for (const content of [
  ["Rewind"],
  ["Restore and fork the conversation to the", "point before…"],
  ["Restore the code and/or conversation to the point before…"],
  ["Confirm you want to restore the conversation"],
]) {
  test(`dialog-like composer contents remain drafts and submit normally: ${content.join(" / ")}`, () => {
    const observer = new ClaudeTerminalObserver()
    const lines = ["Explain these menu labels:", ...content.map((line) => `  ${line}`)]
    const screen = {
      lines: ["────────────────", `❯ ${lines[0]}`, ...lines.slice(1), "────────────────"],
      cursor: { x: 8, y: lines.length, visible: true },
    }
    const text = lines.join("\n")
    expect(observer.observeScreen(screen)).toBe("idle")
    expect(observer.observeDraft(screen)).toEqual({ text, exact: false })
    expect(rewindInput(observer)).toEqual({ _tag: "Submission", text })
    expect(observer.takeObservations()).toEqual([])
  })
}

for (const visible of [true, false]) {
  test(`a real wrapped dialog with a selection marker is not a composer (cursor visible: ${visible})`, () => {
    const observer = new ClaudeTerminalObserver()
    const picker = {
      lines: ["────────────────", "Rewind", "Restore and fork the conversation to the", "point before…", "❯ target", "────────────────"],
      cursor: { x: 4, y: 4, visible },
    }
    observer.observeScreen(picker)
    expect(observer.observeDraft(picker)).toBeUndefined()
    expect(rewindInput(observer)).toBeUndefined()
    expect(observer.takeObservations()).toEqual([])
    observer.observeScreen(dialogScreen(["unknown"]))
    expect(observer.takeObservations()).toEqual([{ _tag: "Rewind" }])
  })
}

test("a restored hidden-cursor composer containing Rewind is not a lingering dialog heading", () => {
  const observer = new ClaudeTerminalObserver()
  observer.observeScreen(dialogScreen(["Confirm you want to restore the conversation", "❯ Restore conversation"]))
  rewindInput(observer)
  const restored = dialogScreen(["────────────────", "❯ Explain these menu labels:", "  Rewind", "────────────────"])
  observer.observeScreen(restored)
  expect(observer.takeObservations()).toEqual([{ _tag: "Rewind" }])
  expect(observer.observeDraft(restored)).toEqual({
    text: "Explain these menu labels:\n  Rewind", exact: false, rewind: true,
    rewindTarget: "Explain these menu labels:\n  Rewind", rewindTargetLines: ["Explain these menu labels:", "  Rewind"],
  })
})

test("excluding an input box does not hide a real confirmation elsewhere on the screen", () => {
  const observer = new ClaudeTerminalObserver()
  const screen = {
    lines: ["Confirm you want to restore the conversation", "❯ Restore conversation", "────────────────",
      "❯ Explain these menu labels:", "  Rewind", "────────────────"],
    cursor: { x: 4, y: 1, visible: true },
  }
  observer.observeScreen(screen)
  expect(observer.observeDraft(screen)).toBeUndefined()
  expect(rewindInput(observer)).toBeUndefined()
  observer.observeScreen(dialogScreen(["unknown"]))
  expect(observer.takeObservations()).toEqual([{ _tag: "Rewind" }])
})

for (const prompt of ["earlier prompt", "Restore files from backup", "Never mind"]) {
  test(`wrapped one-stage restore treats ${JSON.stringify(prompt)} as a message, not an action`, () => {
    const observer = new ClaudeTerminalObserver()
    const picker = dialogScreen([
      "│ Rewind │", "│ Restore and fork the conversation to the │", "│ point before… │", `│ ❯ ${prompt} │`,
    ])
    observer.observeScreen(picker)
    expect(observer.observeDraft(picker)).toBeUndefined()
    expect(rewindInput(observer)).toBeUndefined()
    expect(observer.takeObservations()).toEqual([])
    observer.observeScreen(picker)
    expect(observer.takeObservations()).toEqual([])
    const restored = dialogScreen(["────────────────", `❯ ${prompt}`, "────────────────"])
    observer.observeScreen(restored)
    expect(observer.takeObservations()).toEqual([{ _tag: "Rewind" }])
    expect(observer.observeDraft(restored)).toEqual({ text: prompt, exact: false, rewind: true, rewindTarget: prompt })
    observer.observeScreen(restored)
    expect(observer.takeObservations()).toEqual([])
  })
}

test("wrapped two-stage restore requires action confirmation and emits once without a readable composer", () => {
  const observer = new ClaudeTerminalObserver()
  const picker = dialogScreen([
    "┃ Rewind ┃", "┃ Restore the code and/or conversation ┃", "┃ to the point before… ┃", "┃ ❯ Restore files from backup ┃",
  ])
  const confirmation = dialogScreen([
    "┃ Rewind ┃", "┃ Confirm you want to ┃", "┃ restore the conversation to the point ┃", "┃ before you sent this message: ┃",
    "┃ ❯ Restore code and ┃", "┃ conversation ┃", "┃ Never mind ┃",
  ])
  const unknown = dialogScreen(["Restored history; composer not visible"])
  observer.observeScreen(picker)
  rewindInput(observer)
  expect(observer.takeObservations()).toEqual([])
  observer.observeScreen(confirmation)
  expect(observer.observeDraft(confirmation)).toBeUndefined()
  expect(observer.takeObservations()).toEqual([])
  rewindInput(observer)
  observer.observeScreen(confirmation)
  observer.observeScreen(dialogScreen(["╭── Rewind ──╮"]))
  expect(observer.takeObservations()).toEqual([])
  observer.observeScreen(unknown)
  expect(observer.observeDraft(unknown)).toBeUndefined()
  expect(observer.takeObservations()).toEqual([{ _tag: "Rewind" }])
  observer.observeScreen(unknown)
  expect(observer.takeObservations()).toEqual([])
  expect(rewindInput(observer, "replacement\r")).toEqual({ _tag: "Submission", text: "replacement" })
})

test("leaving a two-stage picker without confirming is not a rewind", () => {
  const observer = new ClaudeTerminalObserver()
  observer.observeScreen(dialogScreen(["Rewind", "Restore the code and/or conversation to the point before…", "❯ target"]))
  rewindInput(observer)
  const restored = dialogScreen(["────────────────", "❯ target", "────────────────"])
  observer.observeScreen(restored)
  expect(observer.takeObservations()).toEqual([])
  expect(observer.observeDraft(restored)).toBeUndefined()
})

test("confirmation without a readable selected action does not imply a conversation restore", () => {
  const observer = new ClaudeTerminalObserver()
  observer.observeScreen(dialogScreen(["Rewind", "Confirm you want to restore the conversation"]))
  rewindInput(observer)
  observer.observeScreen(dialogScreen(["unknown"]))
  expect(observer.takeObservations()).toEqual([])
})

test("recognizes native instructions wrapped across more than four bordered rows", () => {
  const observer = new ClaudeTerminalObserver()
  observer.observeScreen(dialogScreen([
    "╭── Rewind ──╮", "│ Restore and │", "│ fork the │", "│ conversation │", "│ to the point │", "│ before… │", "│ ❯ prompt │",
  ]))
  rewindInput(observer)
  observer.observeScreen(dialogScreen(["unknown"]))
  expect(observer.takeObservations()).toEqual([{ _tag: "Rewind" }])
})

for (const action of ["Restore code", "Restore files only", "Never mind", "Summarize from here", "Summarize up to here"]) {
  test(`${action} cannot emit a rewind on dialog exit`, () => {
    const observer = new ClaudeTerminalObserver()
    const confirmation = dialogScreen(["Rewind", "Confirm you want to restore the conversation", `❯ ${action}`])
    observer.observeScreen(confirmation)
    rewindInput(observer)
    observer.observeScreen(confirmation)
    observer.observeScreen(dialogScreen(["unreadable composer"]))
    expect(observer.takeObservations()).toEqual([])
  })
}

for (const confirmBeforeEscape of [false, true]) {
  test(`Escape cancels restore observation even after Enter: ${confirmBeforeEscape}`, () => {
    const observer = new ClaudeTerminalObserver()
    const confirmation = dialogScreen(["Confirm you want to restore the conversation", "❯ Restore conversation"])
    observer.observeScreen(confirmation)
    if (confirmBeforeEscape) rewindInput(observer)
    rewindInput(observer, "\u001b")
    observer.observeScreen(confirmation)
    observer.observeScreen(dialogScreen(["unknown"]))
    expect(observer.takeObservations()).toEqual([])
  })
}

test("repeated restores emit separate occurrences, including an empty restored composer", () => {
  const observer = new ClaudeTerminalObserver()
  for (let index = 0; index < 2; index += 1) {
    observer.observeScreen(dialogScreen(["Restore and fork the conversation to the point before…", "❯ target"]))
    rewindInput(observer)
    const empty = dialogScreen(["────────────────", "❯ ", "────────────────"])
    observer.observeScreen(empty)
    expect(observer.observeDraft(empty)).toBeNull()
    expect(observer.takeObservations()).toEqual([{ _tag: "Rewind" }])
    observer.observeScreen(empty)
    expect(observer.takeObservations()).toEqual([])
  }
})

test("cancelling confirmation back to message selection allows a subsequent confirmed restore", () => {
  const observer = new ClaudeTerminalObserver()
  const confirmation = dialogScreen(["Confirm you want to restore the conversation", "❯ Restore conversation"])
  observer.observeScreen(confirmation)
  rewindInput(observer, "\u001b")
  observer.observeScreen(dialogScreen(["Restore the code and/or conversation to the point before…", "❯ target"]))
  rewindInput(observer)
  observer.observeScreen(confirmation)
  rewindInput(observer)
  observer.observeScreen(dialogScreen(["unknown"]))
  expect(observer.takeObservations()).toEqual([{ _tag: "Rewind" }])
})

test("preserves complete original composer rows through edits without erasing within-row whitespace", () => {
  const observer = new ClaudeTerminalObserver()
  observer.observeScreen(dialogScreen(["Confirm you want to restore the conversation", "❯ Restore conversation"]))
  rewindInput(observer)
  observer.observeScreen(dialogScreen(["composer not yet visible"]))
  rewindInput(observer, "\u001b[I")
  const restored = dialogScreen(["────────────────", "❯ use  veryLongIdenti", "  fier with  care", "────────────────"])
  observer.observeScreen(restored)
  const original = observer.observeDraft(restored)
  expect(original).toEqual({
    text: "use  veryLongIdenti\n  fier with  care", exact: false, rewind: true,
    rewindTarget: "use  veryLongIdenti\n  fier with  care", rewindTargetLines: ["use  veryLongIdenti", "  fier with  care"],
  })
  const edited = dialogScreen(["────────────────", "❯ edited", "────────────────"])
  observer.observeScreen(edited)
  expect(observer.observeDraft(edited)).toEqual({ ...original!, text: "edited" })
  rewindInput(observer)
  expect(original?.rewindTargetLines).toEqual(["use  veryLongIdenti", "  fier with  care"])
  observer.observeScreen(dialogScreen(["Confirm you want to restore the conversation", "❯ Restore conversation"]))
  rewindInput(observer)
  observer.observeScreen(edited)
  expect(observer.observeDraft(edited)?.rewindTargetLines).toBeUndefined()
  expect(observer.observeDraft(edited)?.rewindTarget).toBe("edited")
})

for (const rows of [
  ["❯ clipped start", "  remainder", "────────────────"],
  ["────────────────", "❯ clipped end", "  remainder"],
  ["────────────────", "❯ [Pasted text #1 +4 lines]", "  remainder", "────────────────"],
  ["────────────────", "❯ [Image #1]", "  remainder", "────────────────"],
  ["────────────────", "❯ truncated…", "  remainder", "────────────────"],
  ["────────────────", "❯ ↑ 3 more lines", "  remainder", "────────────────"],
]) {
  test(`incomplete composer evidence supplies no original row matching: ${JSON.stringify(rows)}`, () => {
    const observer = new ClaudeTerminalObserver()
    observer.observeScreen(dialogScreen(["Confirm you want to restore the conversation", "❯ Restore conversation"]))
    rewindInput(observer)
    const screen = { ...dialogScreen(rows), cursor: { x: 2, y: 1, visible: true } }
    observer.observeScreen(screen)
    expect(observer.observeDraft(screen)?.rewindTargetLines).toBeUndefined()
    expect(observer.takeObservations()).toEqual([{ _tag: "Rewind" }])
  })
}

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
  observer.observeScreen({ ...restored, lines: ["Confirm you want to restore the conversation", "❯ Restore conversation"] })
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
  observer.observeScreen({ lines: ["Confirm you want to restore the conversation", "❯ Restore conversation"], cursor: { x: 0, y: 0, visible: false } })
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
  observer.observeScreen({ lines: ["Confirm you want to restore the conversation", "❯ Restore conversation"], cursor: { x: 0, y: 0, visible: false } })
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
