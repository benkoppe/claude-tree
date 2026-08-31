import { describe, expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

import type { AgentMessage, AgentSession } from "../src/agent-provider"
import { displayWidth, truncateToWidth } from "../src/display-text"
import {
  directionalMove,
  graphNodeAt,
  initialVisibleGraphNodeId,
  layoutConversationGraph,
  visibleGraphNodeId,
} from "../src/graph-layout"
import {
  BRAILLE_SPINNER_FRAMES,
  renderConversationGraph,
  renderRootPicker,
} from "../src/graph-renderer"
import { buildConversationForest } from "../src/message-graph"
import type { BranchRelation } from "../src/metadata"
import { theme } from "../src/theme"

const ROOT = "11111111-1111-4111-8111-111111111111"
const CHILD = "22222222-2222-4222-8222-222222222222"

describe("renderConversationGraph", () => {
  test("draws branches and only the live session endpoint", () => {
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
    expect(rendered.text).toContain("󰚩 Agent")
    expect(rendered.text).toContain("main answer")
    expect(rendered.text).toContain("fork answer")
    expect(rendered.text).toContain("󰆍 Draft")
    expect(rendered.text.match(/󰆍 Draft/g)).toHaveLength(1)
    expect(rendered.text).not.toContain("Claude session")
    expect(rendered.text).not.toContain("● Live")
    expect(rendered.text).not.toContain("○ Saved")
    expect(rendered.text).toContain("fix the tests")
    expect(rendered.text).not.toContain("Fork")
    expect(rendered.text).not.toContain(">")
    expect(rendered.text).not.toContain("+")
    expect(rendered.text).not.toContain("|")
    expect(rendered.text).toContain("┌")
    expect(rendered.text).toContain("┴")
    expect(rendered.text).toContain("┐")
    expect(rendered.text).toContain("│")
    const selectedHeader = rendered.content.chunks.find(
      (chunk) => chunk.text.includes("Draft") && chunk.bg?.equals(theme.selected),
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
          (span) => span.text.includes("Draft") && span.bg.equals(theme.selected),
        ),
      ).toBeTrue()
      expect(
        spans.some((span) => span.text.includes("main answer") && span.bg.equals(theme.element)),
      ).toBeTrue()
    } finally {
      setup.renderer.destroy()
    }
  })

  test("uses saved sessions' final messages as selected leaves", () => {
    const graph = branchGraph()
    const selected = nodeIdByPreview(graph, "fork answer")
    const rendered = renderConversationGraph(graph, selected, 40, 4, new Set())

    expect(rendered.offsetX).toBeGreaterThan(0)
    expect(rendered.offsetY).toBe(2)
    expect(rendered.text).toContain("fork answer")
    expect(rendered.text).not.toContain("Draft")
    expect(rendered.layout.nodes.has(graph.endpointBySessionId.get(ROOT)!)).toBeFalse()
    expect(rendered.layout.nodes.has(graph.endpointBySessionId.get(CHILD)!)).toBeFalse()
    expect(visibleGraphNodeId(graph, graph.endpointBySessionId.get(CHILD), new Set())).toBe(
      selected,
    )
    expect(initialVisibleGraphNodeId(graph, new Set())).toBe(graph.rootNodeId)
    const selectedPreview = rendered.content.chunks.find(
      (chunk) => chunk.text.includes("fork answer") && chunk.bg?.equals(theme.selected),
    )
    expect(selectedPreview).toBeDefined()
    expect(rendered.text.split("\n")).toHaveLength(4)
  })

  test("preserves an explicit viewport offset when mouse selection changes", () => {
    const graph = branchGraph()
    const branchId = nodeIdByPreview(graph, "fork answer")
    const initial = renderConversationGraph(graph, branchId, 40, 4, new Set())
    const selectedRoot = renderConversationGraph(
      graph,
      graph.rootNodeId,
      40,
      4,
      new Set(),
      new Map(),
      new Set(),
      0,
      { x: initial.offsetX, y: initial.offsetY },
    )

    expect(initial.offsetX).toBeGreaterThan(0)
    expect(initial.offsetY).toBeGreaterThan(0)
    expect(selectedRoot.offsetX).toBe(initial.offsetX)
    expect(selectedRoot.offsetY).toBe(initial.offsetY)
  })

  test("centers a narrow graph even when given a previous horizontal offset", () => {
    const graph = branchGraph()
    const viewportWidth = 101
    const rendered = renderConversationGraph(
      graph,
      graph.rootNodeId,
      viewportWidth,
      30,
      new Set(),
      new Map(),
      new Set(),
      0,
      { x: 0, y: 0 },
    )
    const leftGutter = -rendered.offsetX
    const rightGutter = viewportWidth - rendered.worldWidth - leftGutter

    expect(rendered.worldWidth).toBeLessThan(viewportWidth)
    expect(rendered.offsetX).toBe(-Math.floor((viewportWidth - rendered.worldWidth) / 2))
    expect(leftGutter).toBe(16)
    expect(rightGutter).toBe(17)
  })

  test("centers a short graph even when given a previous vertical offset", () => {
    const graph = branchGraph()
    const viewportHeight = 31
    const rendered = renderConversationGraph(
      graph,
      graph.rootNodeId,
      40,
      viewportHeight,
      new Set(),
      new Map(),
      new Set(),
      0,
      { x: 0, y: 0 },
    )
    const topGutter = -rendered.offsetY
    const bottomGutter = viewportHeight - rendered.worldHeight - topGutter

    expect(rendered.worldHeight).toBeLessThan(viewportHeight)
    expect(rendered.offsetY).toBe(-Math.floor((viewportHeight - rendered.worldHeight) / 2))
    expect(topGutter).toBe(12)
    expect(bottomGutter).toBe(13)
  })

  test("hit-tests only graph card rectangles", () => {
    const graph = branchGraph()
    const rendered = renderConversationGraph(graph, graph.rootNodeId, 100, 30, new Set())
    const root = rendered.layout.nodes.get(graph.rootNodeId)!

    expect(graphNodeAt(rendered.layout, root.x, root.y)?.node.id).toBe(root.node.id)
    expect(
      graphNodeAt(
        rendered.layout,
        root.x + root.width - 1,
        root.y + root.height - 1,
      )?.node.id,
    ).toBe(root.node.id)
    expect(graphNodeAt(rendered.layout, root.x + root.width, root.y)).toBeUndefined()
    expect(graphNodeAt(rendered.layout, root.x, root.y + root.height)).toBeUndefined()
  })

  test("shows screen-derived draft text without an observation prefix", () => {
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

    expect(rendered.text).toContain("line one line two")
    expect(rendered.text).not.toContain("Observed draft")
  })

  test("replaces a live draft with an animated agent card while generating", () => {
    const graph = branchGraph()
    const selected = graph.endpointBySessionId.get(CHILD)!
    const first = renderConversationGraph(
      graph,
      selected,
      100,
      30,
      new Set([CHILD]),
      new Map([[CHILD, { text: "queued text", exact: true }]]),
      new Set([CHILD]),
      0,
    )
    const second = renderConversationGraph(
      graph,
      selected,
      100,
      30,
      new Set([CHILD]),
      new Map(),
      new Set([CHILD]),
      1,
    )

    expect(first.text).toContain("󰚩 Agent")
    expect(first.text).toContain(BRAILLE_SPINNER_FRAMES[0])
    expect(first.text).not.toContain("Draft")
    expect(first.text).not.toContain("queued text")
    expect(second.text).toContain(BRAILLE_SPINNER_FRAMES[1])
    expect(second.text).not.toContain(BRAILLE_SPINNER_FRAMES[0])
  })

  test("keeps the special live-card background in both activity states", () => {
    const graph = branchGraph()
    const selected = graph.endpointBySessionId.get(CHILD)!
    const rendered = renderConversationGraph(
      graph,
      selected,
      100,
      30,
      new Set([ROOT, CHILD]),
      new Map(),
      new Set([ROOT]),
    )

    const agent = rendered.content.chunks.find(
      (chunk) => chunk.text.includes("Agent") && chunk.bg?.equals(theme.sessionElement),
    )
    const draft = rendered.content.chunks.find(
      (chunk) => chunk.text.includes("Draft") && chunk.bg?.equals(theme.selected),
    )
    expect(agent).toBeDefined()
    expect(draft).toBeDefined()
  })
})

describe("renderRootPicker", () => {
  test("summarizes logical messages, sessions, and live families", () => {
    const graph = branchGraph()
    const rendered = renderRootPicker([graph], 0, 5, 80, new Set([CHILD]))

    expect(rendered.text.split("\n")[0]).toBe(
      " ● Live  Root                                           3 messages · 2 sessions",
    )
    expect(rendered.text).not.toContain(">")
    const selectedTitle = rendered.content.chunks.find((chunk) => chunk.text === "Root")
    expect(selectedTitle?.bg?.equals(theme.selected)).toBeTrue()
    expect(selectedTitle?.fg?.equals(theme.selectedText)).toBeTrue()
    expect(renderRootPicker([], 0, 5, 80, new Set()).text).toContain("press n")
  })

  test("keeps a stable viewport and scrolls only to reveal the selection", () => {
    const graphs = Array.from({ length: 10 }, () => branchGraph())

    expect(renderRootPicker(graphs, 2, 3, 80, new Set(), 0).startIndex).toBe(0)
    expect(renderRootPicker(graphs, 3, 3, 80, new Set(), 0).startIndex).toBe(1)
    expect(renderRootPicker(graphs, 2, 3, 80, new Set(), 1).startIndex).toBe(1)
    expect(renderRootPicker(graphs, 0, 3, 80, new Set(), 1).startIndex).toBe(0)
    const finalWindow = renderRootPicker(graphs, 9, 3, 80, new Set(), 1)
    expect(finalWindow.startIndex).toBe(7)
    expect(finalWindow.endIndex).toBe(10)
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
    const layout = layoutConversationGraph(graph, 100, new Set([ROOT, CHILD]))
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
    const rendered = renderConversationGraph(graph, childEndpointId, 40, 8, new Set([CHILD]))

    expect(rendered.layout.nodes.has(graph.originNodeId)).toBeFalse()
    expect(rendered.layout.nodes.get(graph.rootNodeId)?.y).toBe(0)
    expect(rendered.layout.nodes.get(childEndpointId)?.y).toBe(0)
    expect(directionalMove(rendered.layout, graph.rootNodeId, "right")?.nodeId).toBe(childEndpointId)
    expect(directionalMove(rendered.layout, childEndpointId, "left")?.nodeId).toBe(graph.rootNodeId)
    expect(directionalMove(rendered.layout, childEndpointId, "down")).toBeUndefined()
    expect(rendered.offsetX).toBeGreaterThan(0)
  })

  test("shows an empty session endpoint only while its process is live", () => {
    const graph = buildConversationForest(
      [session(ROOT, "Empty", 20)],
      new Map([[ROOT, []]]),
      [],
    ).graphs[0]!
    const endpointId = graph.endpointBySessionId.get(ROOT)!
    const saved = renderConversationGraph(graph, endpointId, 40, 8, new Set())
    const live = renderConversationGraph(graph, endpointId, 40, 8, new Set([ROOT]))

    expect(saved.layout.nodes.size).toBe(0)
    expect(saved.offsetX).toBe(0)
    expect(saved.offsetY).toBe(0)
    expect(saved.text).not.toContain("Draft")
    expect(initialVisibleGraphNodeId(graph, new Set())).toBeUndefined()
    expect(live.layout.nodes.has(endpointId)).toBeTrue()
    expect(live.offsetY).toBe(-3)
    expect(live.text).toContain("Draft")
    expect(initialVisibleGraphNodeId(graph, new Set([ROOT]))).toBe(endpointId)
  })

  test("does not move down from a short branch into a taller neighboring branch", () => {
    const graph = unevenBranchGraph()
    const layout = layoutConversationGraph(graph, 100, new Set([ROOT, CHILD]))
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
    const layout = layoutConversationGraph(graph, 100, new Set([ROOT, CHILD]))
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
    message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "agent", "main answer", 1),
  ]
  const childMessages = [
    message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "user", "root question", 0),
    message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", "agent", "fork answer", 1),
  ]
  const relation: BranchRelation = {
    schemaVersion: 1,
    childSessionId: CHILD,
    parentSessionId: ROOT,
    sourceMessageId: parentMessages[0]!.id,
    sharedMessages: [{
      parentMessageId: parentMessages[0]!.id,
      childMessageId: childMessages[0]!.id,
    }],
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
    sharedMessages: [],
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
    message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "agent", "tall one", 1),
    message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "agent", "tall two", 2),
    message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", "agent", "tall three", 3),
  ]
  const childMessages = [
    message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "user", "root", 0),
    message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", "agent", "short", 1),
  ]
  const relation: BranchRelation = {
    schemaVersion: 1,
    childSessionId: CHILD,
    parentSessionId: ROOT,
    sourceMessageId: parentMessages[0]!.id,
    sharedMessages: [{
      parentMessageId: parentMessages[0]!.id,
      childMessageId: childMessages[0]!.id,
    }],
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

function session(id: string, title: string, lastModified: number): AgentSession {
  return { id, title, lastModified }
}

function message(
  id: string,
  role: AgentMessage["role"],
  preview: string,
  ordinal: number,
): AgentMessage {
  return { id, role, preview, ordinal, visible: true }
}
