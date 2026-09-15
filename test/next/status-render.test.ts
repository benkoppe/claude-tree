import { expect, test } from "bun:test"
import type { EndpointNodeViewModel, RootViewModel } from "../../src/application/view-model"
import { BRAILLE_SPINNER_FRAMES, renderGraph, renderRoots, statusMarker, statusLabel, statusColor } from "../../src/presentation/render"
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

test.each([40, 80])("root message and branch counts align numerically at width %i", (width) => {
  const messageCounts = [0, 1, 123, 12]
  const roots = [1, 2, 12, 100].map((count, index) => ({
    history: { _tag: "Ready" as const },
    activation: "open" as const,
    sessionId: `root-${count}`,
    title: "A long conversation title",
    memberSessionIds: Array.from({ length: count }, (_, index) => `session-${count}-${index}`),
    messageCount: messageCounts[index]!,
    lastModified: 0,
    selected: count === 1,
    status: "idle" as const,
  }))
  const rendered = renderRoots(roots, "root-1", roots.length, width)
  const rows = rendered.text.split("\n")
  const branchColumns = new Set<number>()
  const messageColumns = new Set<number>()
  for (const [index, count] of [1, 2, 12, 100].entries()) {
    const row = rows[index]!
    expect(row.trimEnd()).toEndWith(`${count} ${count === 1 ? "branch" : "branches"}`)
    branchColumns.add(row.lastIndexOf(`${count} `) + String(count).length)
    const messageCount = messageCounts[index]!
    expect(row).toContain(`${messageCount} ${messageCount === 1 ? "message " : "messages"}`)
    messageColumns.add(row.indexOf(String(messageCount)) + String(messageCount).length)
    expect(displayWidth(row)).toBeLessThanOrEqual(width)
  }
  expect(branchColumns.size).toBe(1)
  expect(messageColumns.size).toBe(1)
  const scrolled = renderRoots(roots, "root-100", 1, width)
  expect(scrolled.text).toBe(rows[3]!)
})

test.each([16, 40, 80])("loading braille advances without reformatting cached root titles at width %i", (width) => {
  let titleReads = 0
  const root: RootViewModel = {
    sessionId: "loading", get title() { titleReads++; return "Loading 界 conversation" },
    history: { _tag: "Loading" }, activation: "loading", memberSessionIds: ["loading"],
    messageCount: 0, lastModified: 0, status: "blocked",
  }
  for (const [index, marker] of BRAILLE_SPINNER_FRAMES.entries()) {
    const rendered = renderRoots([root], index % 2 ? null : root.sessionId, 1, width, 0, index)
    expect(rendered.text).toContain(`${marker} Loading`)
    expect(rendered.text).not.toContain("Loading history")
    expect(rendered.text).toContain(statusMarker("blocked", index))
    expect(rendered.content.chunks.map((chunk) => chunk.text).join("").trimEnd()).toBe(rendered.text)
    expect(displayWidth(rendered.text)).toBeLessThanOrEqual(width)
  }
  expect(titleReads).toBe(1)
})

test.each([60, 80, 120])("history gaps precede aligned root counts at width %i", (width) => {
  const roots: RootViewModel[] = ["Ready", "Limited"].map((status, index) => ({
    sessionId: `root-${index}`, title: `Session ${index}`, lastModified: 0, status: "idle",
    activation: "open",
    memberSessionIds: [`root-${index}`], messageCount: 12,
    history: status === "Ready" ? { _tag: "Ready" } : { _tag: "Limited", contextMessageCount: 99 },
  }))
  const [normal, limited] = renderRoots(roots, roots[0]!.sessionId, 2, width).text.split("\n")
  expect(limited).toContain("History gap  12 messages")
  expect(limited!.indexOf("12 messages")).toBe(normal!.indexOf("12 messages"))
  expect(limited!.indexOf("1 branch")).toBe(normal!.indexOf("1 branch"))
  expect(limited).not.toContain("99")
  expect(limited).not.toContain("Open available")
})

test("highlighted status colors have readable contrast but root markers stay unhighlighted", () => {
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
    const rendered = renderRoots([{ activation: "open", history: { _tag: "Ready" }, sessionId: "root", title: "Root", memberSessionIds: ["root"], messageCount: 0, lastModified: 0, status }], "root", 1, 40)
    const marker = rendered.content.chunks.find((chunk) => chunk.text.includes(statusMarker(status, 0)))
    expect(marker?.fg?.equals(statusColor(status, false))).toBeTrue()
    expect(marker?.bg?.equals(theme.background)).toBeTrue()
    const title = rendered.content.chunks.find((chunk) => chunk.text.includes("Root"))
    expect(title?.bg?.equals(theme.selected)).toBeTrue()
  }
})
