import { expect, test } from "bun:test"

import { EmbeddedTerminalRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { OpenTuiTerminalRenderer } from "../src/infrastructure/terminal/opentui-terminal-renderer"
import { ClaudeTerminalObserver } from "../src/infrastructure/providers/claude/terminal-observer"

test("production snapshots compose fresh text and cursor without publishing screen callbacks", async () => {
  const setup = await createTestRenderer({ width: 60, height: 10 })
  const renderer = new OpenTuiTerminalRenderer(setup.renderer)
  let callbacks = 0
  const surface = renderer.createSurface("snapshot", {
    onData() {}, onResize() {}, onScreenChange() {
      callbacks += 1
      surface.screen()
    },
  })
  try {
    await setup.renderOnce()
    const before = callbacks
    surface.write(new TextEncoder().encode("\u001b[2J\u001b[Hfresh composer\u001b[1;6H\u001b[?25h"))
    const screen = surface.screen()
    expect(screen.lines[0]?.trim()).toBe("fresh composer")
    expect(screen.cursor).toEqual({ x: 5, y: 0, visible: true })
    expect(callbacks).toBe(before)
    surface.screen()
    expect(callbacks).toBe(before)
    await setup.renderOnce()
    expect(callbacks).toBeGreaterThan(before)
  } finally {
    setup.renderer.destroy()
  }
})

for (const visibleCursor of [true, false]) {
  test(`captures a restored composer from the production terminal surface (cursor visible: ${visibleCursor})`, async () => {
    const setup = await createTestRenderer({ width: 60, height: 10 })
    const observer = new ClaudeTerminalObserver()
    const renderer = new OpenTuiTerminalRenderer(setup.renderer)
    const surface = renderer.createSurface("rewind", {
      onData() {}, onResize() {}, onScreenChange() { observer.observeScreen(surface.screen()) },
    })
    try {
      await setup.renderOnce()
      observer.observeInput(new TextEncoder().encode("/rewind\r"))
      surface.write(new TextEncoder().encode("\u001b[2J\u001b[HRewind\r\nRestore and fork the conversation to the point before…"))
      await setup.renderOnce()
      observer.observeInput(new TextEncoder().encode("\r"))
      surface.write(new TextEncoder().encode(`\u001b[2J\u001b[H────────────────────────────────\r\n❯ restored question\r\n────────────────────────────────\r\n  ? for shortcuts\u001b[2;20H\u001b[?25${visibleCursor ? "h" : "l"}`))
      if (!visibleCursor) await setup.renderOnce()
      // A hide/capture may occur before another renderer frame. Text and cursor
      // must describe the same VT state, and a software cursor is not an empty draft.
      expect(observer.observeDraft(surface.screen())).toEqual({ text: "restored question", exact: false, rewind: true, rewindTarget: "restored question" })
    } finally {
      setup.renderer.destroy()
    }
  })
}

test("hidden emulators keep processing output from independent Bun PTYs", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const first = new EmbeddedTerminalRenderable(setup.renderer, {
    id: "first",
    width: 40,
    height: 8,
    visible: false,
  })
  const second = new EmbeddedTerminalRenderable(setup.renderer, {
    id: "second",
    width: 40,
    height: 8,
    visible: false,
  })
  setup.renderer.root.add(first)
  setup.renderer.root.add(second)

  const firstProcess = spawnOutput(first, "first")
  const secondProcess = spawnOutput(second, "second")

  try {
    await Promise.all([firstProcess.process.exited, secondProcess.process.exited])

    first.visible = true
    await setup.renderOnce()
    expect(first.screen().text).toContain("first-ready")
    expect(first.screen().text).toContain("first-finished")

    first.visible = false
    second.visible = true
    await setup.renderOnce()
    expect(second.screen().text).toContain("second-ready")
    expect(second.screen().text).toContain("second-finished")
  } finally {
    firstProcess.pty?.close()
    secondProcess.pty?.close()
    setup.renderer.destroy()
  }
})

function spawnOutput(
  terminal: EmbeddedTerminalRenderable,
  name: string,
): { process: Bun.Subprocess; pty: Bun.Terminal | undefined } {
  let pty: Bun.Terminal | undefined
  const script = `process.stdout.write("\\x1b[32m${name}-ready\\x1b[0m\\r\\n"); await Bun.sleep(20); process.stdout.write("${name}-finished\\r\\n")`
  const childProcess = Bun.spawn([globalThis.process.execPath, "-e", script], {
    terminal: {
      cols: 40,
      rows: 8,
      data(childPty, data) {
        pty = childPty
        terminal.write(data)
      },
    },
  })
  pty ??= childProcess.terminal
  return {
    process: childProcess,
    get pty() {
      return pty
    },
  }
}
