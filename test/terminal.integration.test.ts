import { expect, test } from "bun:test"

import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { OpenTuiTerminalRenderer } from "../src/infrastructure/terminal/opentui-terminal-renderer"
import { ClaudeTerminalObserver } from "../src/infrastructure/providers/claude/terminal-observer"
import { BunPtyProcessFactory, type TerminalProcess, type TerminalSurface } from "../src/infrastructure/terminal"
import { NullTerminalObserver } from "../src/domain/model"
import { cleanupProcessGroup } from "../src/infrastructure/process-group"

test("terminal reserves the return bar row on creation and resize", async () => {
  const setup = await createTestRenderer({ width: 60, height: 10 })
  const renderer = new OpenTuiTerminalRenderer(setup.renderer)
  const sizes: number[][] = []
  try {
    const surface = renderer.createSurface("sizing", {
      onData() {}, onScreenChange() {},
      onResize(columns, rows) { sizes.push([columns, rows]) },
    })
    surface.setActive(true)
    surface.write(new TextEncoder().encode("\u001b[999;1Hlast row"))
    await setup.renderOnce()
    expect(renderer.rows).toBe(9)
    expect(surface.screen().lines).toHaveLength(9)
    setup.resize(40, 8)
    await setup.renderOnce()
    surface.write(new TextEncoder().encode("\u001b[2J\u001b[999;1Hresized last row"))
    expect(renderer.columns).toBe(40)
    expect(renderer.rows).toBe(7)
    expect(surface.screen().lines).toHaveLength(7)
    expect(sizes).toContainEqual([40, 7])
  } finally {
    setup.renderer.destroy()
  }
})

test("production snapshots compose fresh text and cursor without publishing screen callbacks", async () => {
  const setup = await createTestRenderer({ width: 60, height: 10 })
  const renderer = new OpenTuiTerminalRenderer(setup.renderer)
  let callbacks = 0
  try {
    const surface = renderer.createSurface("snapshot", {
      onData() {}, onResize() {}, onScreenChange() {
        callbacks += 1
        surface.screen()
      },
    })
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
    try {
      const surface = renderer.createSurface("rewind", {
        onData() {}, onResize() {}, onScreenChange() { observer.observeScreen(surface.screen()) },
      })
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
  const processes: TerminalProcess[] = []
  try {
    const renderer = new OpenTuiTerminalRenderer(setup.renderer)
    const hiddenScreens = new Map<string, string>()
    const createSurface = (name: string) => {
      const surface = renderer.createSurface(name, {
        onData() {}, onResize() {},
        onScreenChange() { hiddenScreens.set(name, surface.screen().lines.join("\n")) },
      })
      surface.setActive(false)
      return surface
    }
    const first = createSurface("first")
    const second = createSurface("second")
    const firstProcess = spawnOutput(first, "first")
    processes.push(firstProcess.process)
    const secondProcess = spawnOutput(second, "second")
    processes.push(secondProcess.process)
    await within(Promise.all([firstProcess.ready, secondProcess.ready]), "both PTYs ready")
    await setup.renderOnce()
    expect(hiddenScreens.get("first")).toContain("first-ready")
    expect(hiddenScreens.get("second")).toContain("second-ready")
    expect(processes.map((child) => child.exitCode)).toEqual([null, null])

    firstProcess.process.write(new TextEncoder().encode("x"))
    expect(await within(Promise.all([
      firstProcess.process.exited, firstProcess.process.ptyDrained,
    ]), "first PTY exit and drain")).toEqual([0, undefined])
    expect(secondProcess.process.exitCode).toBeNull()
    secondProcess.process.write(new TextEncoder().encode("x"))
    expect(await within(Promise.all([
      secondProcess.process.exited, secondProcess.process.ptyDrained,
    ]), "second PTY exit and drain")).toEqual([0, undefined])
    first.setActive(true)
    await setup.renderOnce()
    expect(first.screen().lines.join("\n")).toContain("first-ready\nfirst-finished")
    first.setActive(false)
    second.setActive(true)
    await setup.renderOnce()
    expect(second.screen().lines.join("\n")).toContain("second-ready\nsecond-finished")
  } finally {
    try {
      const cleanup = await Promise.allSettled(processes.map(async (child) => {
        try {
          const result = await Effect.runPromise(cleanupProcessGroup(child, { gracePeriodMs: 100, killPeriodMs: 100 }))
          expect(result.status).toBe("absent")
          await within(child.exited, "child cleanup exit")
        } finally {
          try { child.closePty() } finally { child.unref() }
        }
      }))
      for (const result of cleanup) if (result.status === "rejected") throw result.reason
    } finally {
      setup.renderer.destroy()
    }
  }
})

function spawnOutput(
  terminal: TerminalSurface,
  name: string,
): { process: TerminalProcess; ready: Promise<void> } {
  let markReady!: () => void
  const ready = new Promise<void>((resolve) => { markReady = resolve })
  let output = ""
  const script = `process.stdin.setRawMode(true); process.stdin.once("data", () => {
    process.stdout.write("${name}-finished\\r\\n", () => process.exit(0))
  }); process.stdout.write("${name}-ready\\r\\n")`
  const child = new BunPtyProcessFactory().spawn({
    sessionId: name,
    command: [process.execPath, "-e", script],
    cwd: process.cwd(),
    observer: new NullTerminalObserver(),
  }, { columns: 40, rows: 8 }, {
    onOutput(data) {
      terminal.write(data)
      output += new TextDecoder().decode(data)
      if (output.includes(`${name}-ready`)) markReady()
    },
    onPtyClosed() {},
  })
  return { process: child, ready }
}

async function within<A>(promise: Promise<A>, label: string): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2_000)
    })])
  } finally {
    clearTimeout(timer)
  }
}
