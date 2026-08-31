import { expect, test } from "bun:test"

import { EmbeddedTerminalRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

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
