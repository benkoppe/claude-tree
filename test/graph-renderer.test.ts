import { describe, expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

import { displayWidth, truncateToWidth } from "../src/display-text"
import { directionalMove, layoutConversationGraph } from "../src/graph-layout"
import { renderConversationGraph, renderRootPicker } from "../src/graph-renderer"
import { buildConversationForest } from "../src/message-graph"
import type { BranchRelation } from "../src/metadata"
import type { ConversationMessage, SessionSummary } from "../src/sessions"
import { theme } from "../src/theme"

const ROOT = "11111111-1111-4111-8111-111111111111"
const CHILD = "22222222-2222-4222-8222-222222222222"

describe("renderConversationGraph", () => {
  test("draws branches, endpoints, and selection status", () => {
    const graph = branchGraph()
    const selected = graph.endpointBySessionId.get(CHILD)!
    const rendered = renderConversationGraph(
      graph,
      selected,
      100,
      30,
      new Set([CHILD]),
      new Map([[CHILD, { text: "fix the tests", exact: true }]]),
    )

    expect(rendered.text).toContain("󰭹 User")
    expect(rendered.text).toContain("root question")
    expect(rendered.text).toContain("󰚩 Assistant")
    expect(rendered.text).toContain("main answer")
    expect(rendered.text).toContain("fork answer")
    expect(rendered.text).toContain("󰆍 Claude session")
    expect(rendered.text).toContain("● Live")
    expect(rendered.text).toContain("Draft: fix the tests")
    expect(rendered.text).not.toContain("Fork")
    expect(rendered.text).not.toContain(">")
    expect(rendered.text).not.toContain("+")
    expect(rendered.text).not.toContain("|")
    expect(rendered.text).toContain("┌")
    expect(rendered.text).toContain("┴")
    expect(rendered.text).toContain("┐")
    expect(rendered.text).toContain("│")
    const selectedHeader = rendered.content.chunks.find(
      (chunk) => chunk.text.includes("Claude session") && chunk.bg?.equals(theme.selected),
    )
    expect(selectedHeader?.fg?.equals(theme.selectedText)).toBeTrue()
    const unselectedPreview = rendered.content.chunks.find((chunk) =>
      chunk.text.includes("main answer"),
    )
    expect(unselectedPreview?.bg?.equals(theme.element)).toBeTrue()
    expect(rendered.worldWidth).toBeGreaterThan(32)
  })

  test("preserves card backgrounds through OpenTUI rendering", async () => {
    const graph = branchGraph()
    const selected = graph.endpointBySessionId.get(CHILD)!
    const rendered = renderConversationGraph(graph, selected, 100, 30, new Set([CHILD]))
    const setup = await createTestRenderer({ width: 100, height: 30 })

    try {
      setup.renderer.root.add(
        new TextRenderable(setup.renderer, {
          id: "styled-graph",
          width: 100,
          height: 30,
          wrapMode: "none",
          content: rendered.content,
        }),
      )
      await setup.renderOnce()
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
      expect(
        spans.some(
          (span) => span.text.includes("Claude session") && span.bg.equals(theme.selected),
        ),
      ).toBeTrue()
      expect(
        spans.some((span) => span.text.includes("main answer") && span.bg.equals(theme.element)),
      ).toBeTrue()
    } finally {
      setup.renderer.destroy()
    }
  })

  test("centers a selected node inside a clipped viewport", () => {
    const graph = branchGraph()
    const selected = graph.endpointBySessionId.get(CHILD)!
    const rendered = renderConversationGraph(graph, selected, 40, 6, new Set())

    expect(rendered.offsetX).toBeGreaterThan(0)
    expect(rendered.offsetY).toBeGreaterThan(0)
    expect(rendered.text).toContain("󰆍 Claude session")
    expect(rendered.text).toContain("○ Saved")
    expect(rendered.text).toContain("No live draft")
    expect(rendered.text.split("\n")).toHaveLength(6)
  })

  test("marks screen-derived drafts as approximate", () => {
    const graph = branchGraph()
    const selected = graph.endpointBySessionId.get(CHILD)!
    const rendered = renderConversationGraph(
      graph,
      selected,
      100,
      30,
      new Set([CHILD]),
      new Map([[CHILD, { text: "line one\nline two", exact: false }]]),
    )

    expect(rendered.text).toContain("Observed draft: line one li…")
    const warningDraft = rendered.content.chunks.find((chunk) =>
      chunk.text.includes("Observed draft"),
    )
    expect(warningDraft?.bg?.equals(theme.selected)).toBeTrue()
    expect(warningDraft?.fg?.equals(theme.selectedText)).toBeTrue()
  })
})

describe("renderRootPicker", () => {
  test("summarizes logical messages, leaves, and live families", () => {
    const graph = branchGraph()
    const rendered = renderRootPicker([graph], 0, 5, 80, new Set([CHILD]))

    expect(rendered.text.split("\n")[0]).toBe(
      " ● Live  Root                                             3 messages · 2 leaves",
    )
    expect(rendered.text).not.toContain(">")
    const selectedTitle = rendered.content.chunks.find((chunk) => chunk.text === "Root")
    expect(selectedTitle?.bg?.equals(theme.selected)).toBeTrue()
    expect(selectedTitle?.fg?.equals(theme.selectedText)).toBeTrue()
    expect(renderRootPicker([], 0, 5, 80, new Set()).text).toContain("press n")
  })
})

describe("display text", () => {
  test("truncates Unicode by terminal cells without splitting graphemes", () => {
    expect(truncateToWidth("你好世界", 5)).toBe("你好…")
    expect(displayWidth(truncateToWidth("󰭹 conversation", 8))).toBeLessThanOrEqual(8)
    expect(truncateToWidth("a👩‍💻b", 3)).toBe("a…")
  })
})

describe("spatial graph navigation", () => {
  test("moves in all four directions across different parent chains", () => {
    const graph = branchGraph()
    const layout = layoutConversationGraph(graph, 100)
    const rootId = graph.rootNodeId
    const mainId = [...graph.nodes.values()].find(
      (node) => node.kind === "message" && node.preview === "main answer",
    )!.id
    const branchId = [...graph.nodes.values()].find(
      (node) => node.kind === "message" && node.preview === "fork answer",
    )!.id
    const mainEndpointId = graph.endpointBySessionId.get(ROOT)!
    const branchEndpointId = graph.endpointBySessionId.get(CHILD)!

    expect(directionalMove(layout, mainId, "right")?.nodeId).toBe(branchId)
    expect(directionalMove(layout, branchId, "left")?.nodeId).toBe(mainId)
    expect(directionalMove(layout, branchId, "up")?.nodeId).toBe(rootId)
    expect(directionalMove(layout, branchId, "down")?.nodeId).toBe(branchEndpointId)
    expect(directionalMove(layout, branchEndpointId, "left")?.nodeId).toBe(mainEndpointId)
    expect(directionalMove(layout, rootId, "down")?.nodeId).toBe(mainId)
    expect(directionalMove(layout, rootId, "up")).toBeUndefined()
  })

  test("moves naturally between roots and falls back across disconnected chains", () => {
    const graph = rootReplayGraph()
    const childEndpointId = graph.endpointBySessionId.get(CHILD)!
    const rendered = renderConversationGraph(graph, childEndpointId, 40, 8, new Set())

    expect(rendered.layout.nodes.has(graph.originNodeId)).toBeFalse()
    expect(rendered.layout.nodes.get(graph.rootNodeId)?.y).toBe(0)
    expect(rendered.layout.nodes.get(childEndpointId)?.y).toBe(0)
    expect(directionalMove(rendered.layout, graph.rootNodeId, "right")?.nodeId).toBe(childEndpointId)
    expect(directionalMove(rendered.layout, childEndpointId, "left")?.nodeId).toBe(graph.rootNodeId)
    expect(directionalMove(rendered.layout, childEndpointId, "down")).toBeUndefined()
    expect(rendered.offsetX).toBeGreaterThan(0)
  })

  test("does not move down from a short branch into a taller neighboring branch", () => {
    const graph = unevenBranchGraph()
    const layout = layoutConversationGraph(graph, 100)
    const shortEndpointId = graph.endpointBySessionId.get(CHILD)!
    const tallAtSameDepthId = nodeIdByPreview(graph, "tall two")

    expect(directionalMove(layout, shortEndpointId, "down")).toBeUndefined()
    expect(directionalMove(layout, shortEndpointId, "left")?.nodeId).toBe(tallAtSameDepthId)
  })

  test("returns to the exact child after moving up to an ambiguous parent", () => {
    const graph = unevenBranchGraph()
    const layout = layoutConversationGraph(graph, 100)
    const shortChildId = nodeIdByPreview(graph, "short")
    const up = directionalMove(layout, shortChildId, "up")!
    const down = directionalMove(layout, up.nodeId, "down", up.intent)

    expect(up.nodeId).toBe(graph.rootNodeId)
    expect(down?.nodeId).toBe(shortChildId)
  })

  test("preserves depth when crossing a shorter branch and ignores blocked moves", () => {
    const graph = unevenBranchGraph()
    const layout = layoutConversationGraph(graph, 100)
    const tallDeepId = nodeIdByPreview(graph, "tall three")
    const shortEndpointId = graph.endpointBySessionId.get(CHILD)!
    const across = directionalMove(layout, tallDeepId, "right")!

    expect(across.nodeId).toBe(shortEndpointId)
    expect(directionalMove(layout, shortEndpointId, "down", across.intent)).toBeUndefined()
    expect(directionalMove(layout, shortEndpointId, "left", across.intent)?.nodeId).toBe(
      tallDeepId,
    )
  })
})

function branchGraph() {
  const parentMessages = [
    message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "root question", 0),
    message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "assistant", "main answer", 1),
  ]
  const childMessages = [
    message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "user", "root question", 0),
    message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", "assistant", "fork answer", 1),
  ]
  const relation: BranchRelation = {
    schemaVersion: 1,
    childSessionId: CHILD,
    parentSessionId: ROOT,
    sourceMessageId: parentMessages[0]!.id,
    copiedPrefixLength: 1,
    childPrefixEndMessageId: childMessages[0]!.id,
    createdAt: "2026-08-30T12:00:00.000Z",
  }
  return buildConversationForest(
    [session(ROOT, "Root", 20), session(CHILD, "Fork", 10)],
    new Map([
      [ROOT, parentMessages],
      [CHILD, childMessages],
    ]),
    [relation],
  ).graphs[0]!
}

function rootReplayGraph() {
  const rootMessage = message(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    "user",
    "root question",
    0,
  )
  const relation: BranchRelation = {
    schemaVersion: 1,
    childSessionId: CHILD,
    parentSessionId: ROOT,
    sourceMessageId: rootMessage.id,
    copiedPrefixLength: 0,
    createdAt: "2026-08-30T12:00:00.000Z",
  }
  return buildConversationForest(
    [session(ROOT, "Root", 20), session(CHILD, "Replay", 10)],
    new Map([
      [ROOT, [rootMessage]],
      [CHILD, []],
    ]),
    [relation],
  ).graphs[0]!
}

function unevenBranchGraph() {
  const parentMessages = [
    message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "root", 0),
    message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "assistant", "tall one", 1),
    message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "assistant", "tall two", 2),
    message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", "assistant", "tall three", 3),
  ]
  const childMessages = [
    message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "user", "root", 0),
    message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", "assistant", "short", 1),
  ]
  const relation: BranchRelation = {
    schemaVersion: 1,
    childSessionId: CHILD,
    parentSessionId: ROOT,
    sourceMessageId: parentMessages[0]!.id,
    copiedPrefixLength: 1,
    childPrefixEndMessageId: childMessages[0]!.id,
    createdAt: "2026-08-30T12:00:00.000Z",
  }
  return buildConversationForest(
    [session(ROOT, "Root", 20), session(CHILD, "Short", 10)],
    new Map([
      [ROOT, parentMessages],
      [CHILD, childMessages],
    ]),
    [relation],
  ).graphs[0]!
}

function nodeIdByPreview(graph: ReturnType<typeof branchGraph>, preview: string): string {
  const node = [...graph.nodes.values()].find(
    (candidate) => candidate.kind === "message" && candidate.preview === preview,
  )
  if (!node) throw new Error(`Missing graph node: ${preview}`)
  return node.id
}

function session(sessionId: string, title: string, lastModified: number): SessionSummary {
  return { sessionId, title, lastModified }
}

function message(
  id: string,
  role: ConversationMessage["role"],
  preview: string,
  rawIndex: number,
): ConversationMessage {
  return { id, role, preview, rawIndex, visible: true }
}
