import { expect, test } from "bun:test"
import type { EndpointNodeViewModel } from "../../src/application/view-model"
import { renderGraph, renderRoots, statusMarker, statusLabel, statusColor } from "../../src/presentation/render"
import { presentationTheme as theme } from "../../src/presentation/theme"
import type { RGBA } from "@opentui/core"
import { displayWidth } from "../../src/presentation/text"

test.each([22, 32])("node status badges are right-aligned without overwriting descriptions at width %i", (width) => {
  for (const status of ["live", "unviewed", "working", "blocked", "idle"] as const) {
    const node: EndpointNodeViewModel = {
      _tag: "Endpoint", id: "endpoint", x: 0, y: 0, width, height: 2,
      parentIds: [], childIds: [], selected: true, reachableEndpoints: [],
      target: { kind: "endpoint", sessionId: "session" },
      session: { id: "session", title: "Session", lastModified: 0 },
      status, draft: { text: "draft text", exact: true }, fork: undefined,
    }
    const rendered = renderGraph({
      _tag: "Graph", familySessionId: "session", title: "Tree", nodes: [node],
      selectedNodeId: node.id, status, warnings: [], worldWidth: width, worldHeight: 2,
    }, width, 2, 0, { x: 0, y: 0 }, new Set(["session"]))
    const [heading, detail] = rendered.text.split("\n")
    const badge = rendered.content.chunks.find((chunk) => chunk.text.includes(`${statusMarker(status, 0)} ${statusLabel(status)}`))
    expect(badge?.fg?.equals(statusColor(status, true))).toBeTrue()
    expect(heading?.startsWith("  ")).toBeTrue()
    expect(heading?.endsWith(`${statusMarker(status, 0)} ${statusLabel(status)}`)).toBeTrue()
    expect(displayWidth(heading!)).toBe(width - 2)
    expect(detail).not.toContain(statusMarker(status, 0))
    if (status === "live" || status === "unviewed") expect(detail).toBe("  draft text")
  }
})

test("highlighted status colors have readable contrast and root rows use them", () => {
  const luminance = (color: RGBA) => {
    const [r, g, b] = color.toInts().slice(0, 3).map((value) => {
      const channel = value / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  for (const status of ["live", "unviewed", "working", "blocked", "idle"] as const) {
    const foreground = luminance(statusColor(status, true))
    const background = luminance(theme.selected)
    expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)).toBeGreaterThanOrEqual(4.5)
    const rendered = renderRoots([{ sessionId: "root", title: "Root", memberSessionIds: ["root"], lastModified: 0, selected: true, status }], "root", 1, 40)
    const marker = rendered.content.chunks.find((chunk) => chunk.text.includes(statusMarker(status, 0)))
    expect(marker?.fg?.equals(statusColor(status, true))).toBeTrue()
  }
})
