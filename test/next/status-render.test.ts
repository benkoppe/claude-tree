import { expect, test } from "bun:test"
import type { EndpointNodeViewModel } from "../../src/application/view-model"
import { renderGraph, statusMarker, statusLabel } from "../../src/presentation/render"
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
    expect(heading?.startsWith("  ")).toBeTrue()
    expect(heading?.endsWith(`${statusMarker(status, 0)} ${statusLabel(status)}`)).toBeTrue()
    expect(displayWidth(heading!)).toBe(width - 2)
    expect(detail).not.toContain(statusMarker(status, 0))
    if (status === "live" || status === "unviewed") expect(detail).toBe("  draft text")
  }
})
