import { expect, test } from "bun:test"

import { createTestRenderer } from "@opentui/core/testing"

import { OpenLeafPicker } from "../src/open-leaf-picker"
import type { ReachableSessionEndpoint } from "../src/message-graph"
import { theme } from "../src/theme"

test("supports arrow, vim, and control-key selection", async () => {
  const setup = await createTestRenderer({ width: 80, height: 20 })
  let selected: ReachableSessionEndpoint | undefined
  const picker = new OpenLeafPicker(setup.renderer, (option) => {
    selected = option
  })
  setup.renderer.keyInput.on("keypress", (key) => {
    key.stopPropagation()
    picker.handleKeyPress(key)
  })
  const options = [option(1), option(2), option(3)]
  const activeSessionIds = new Set([options[1]!.endpoint.session.id])
  picker.open(options, undefined, activeSessionIds)

  try {
    await setup.renderOnce()
    const initialFrame = setup.captureCharFrame()
    expect(initialFrame).toContain("Open leaf")
    expect(initialFrame).toContain("esc")
    expect(initialFrame).not.toContain("┌")
    expect(initialFrame).toContain("• Leaf 2")
    expect(initialFrame).not.toContain("●")
    expect(coordinateOf(initialFrame, "Leaf 1").x).toBe(
      coordinateOf(initialFrame, "Leaf 2").x,
    )
    expect(setup.captureSpans().lines[0]?.spans[0]?.bg.equals(theme.background)).toBeFalse()
    expect(isSelected(setup, "Leaf 1")).toBeTrue()

    setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    expect(isSelected(setup, "Leaf 2")).toBeTrue()

    setup.mockInput.pressKey("k")
    await setup.renderOnce()
    expect(isSelected(setup, "Leaf 1")).toBeTrue()

    setup.mockInput.pressKey("j")
    await setup.renderOnce()
    setup.mockInput.pressKey("n", { ctrl: true })
    await setup.renderOnce()
    expect(isSelected(setup, "Leaf 3")).toBeTrue()

    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.renderOnce()
    expect(isSelected(setup, "Leaf 2")).toBeTrue()

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    expect(selected?.endpoint.session.title).toBe("Leaf 2")
    expect(setup.captureCharFrame()).not.toContain("Open leaf")

    picker.open(options, options[2]!.endpoint.session.id, activeSessionIds)
    await setup.renderOnce()
    expect(isSelected(setup, "Leaf 3")).toBeTrue()
    setup.mockInput.pressEscape()
    await Bun.sleep(20)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("Open leaf")
  } finally {
    setup.renderer.destroy()
  }
})

test("scrolls to and opens a mouse-selected option", async () => {
  const setup = await createTestRenderer({ width: 60, height: 12 })
  let selected: ReachableSessionEndpoint | undefined
  const picker = new OpenLeafPicker(setup.renderer, (option) => {
    selected = option
  })
  picker.open(Array.from({ length: 12 }, (_, index) => option(index + 1)))

  try {
    await setup.renderOnce()
    let frame = setup.captureCharFrame()
    expect(frame).toContain("Leaf 1")
    expect(frame).not.toContain("Leaf 12")

    const first = coordinateOf(frame, "Leaf 1")
    for (let index = 0; index < 8; index += 1) {
      await setup.mockMouse.scroll(first.x, first.y, "down")
      await setup.renderOnce()
    }
    frame = setup.captureCharFrame()
    const last = coordinateOf(frame, "Leaf 12")
    await setup.mockMouse.click(last.x, last.y)
    await setup.renderOnce()

    expect(selected?.endpoint.session.title).toBe("Leaf 12")
    expect(setup.captureCharFrame()).not.toContain("Open leaf")
  } finally {
    setup.renderer.destroy()
  }
})

function option(index: number): ReachableSessionEndpoint {
  const sessionId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
  return {
    distance: index,
    endpoint: {
      id: `endpoint:${sessionId}`,
      kind: "endpoint",
      parentId: null,
      childIds: [],
      session: {
        id: sessionId,
        title: `Leaf ${index}`,
        lastModified: index,
      },
    },
  }
}

function isSelected(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  text: string,
): boolean {
  return setup
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .some((span) => span.text.includes(text) && span.bg.equals(theme.selected))
}

function coordinateOf(frame: string, text: string): { x: number; y: number } {
  const lines = frame.split("\n")
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(text)
    if (x >= 0) return { x, y }
  }
  throw new Error(`Missing text in frame: ${text}\n${frame}`)
}
