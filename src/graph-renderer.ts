import type {
  ConversationGraph,
} from "./message-graph"
import {
  GRAPH_NODE_HEIGHT,
  type ConversationGraphLayout,
  type PositionedGraphNode,
  layoutConversationGraph,
} from "./graph-layout"
import type { DraftPreview } from "./terminal-manager"

export interface RenderedGraph {
  text: string
  worldWidth: number
  worldHeight: number
  offsetX: number
  offsetY: number
  layout: ConversationGraphLayout
}

export function renderConversationGraph(
  graph: ConversationGraph,
  selectedNodeId: string,
  viewportWidth: number,
  viewportHeight: number,
  runningSessionIds: Set<string>,
  draftPreviews: Map<string, DraftPreview> = new Map(),
): RenderedGraph {
  const safeWidth = Math.max(1, viewportWidth)
  const safeHeight = Math.max(1, viewportHeight)
  const layout = layoutConversationGraph(graph, safeWidth)
  const { nodes: positioned, nodeWidth } = layout
  const canvas = new SparseCanvas()

  for (const positionedNode of positioned.values()) {
    drawConnections(canvas, positionedNode, positioned, nodeWidth)
  }
  for (const positionedNode of positioned.values()) {
    drawNode(
      canvas,
      positionedNode,
      nodeWidth,
      positionedNode.node.id === selectedNodeId,
      runningSessionIds,
      draftPreviews,
    )
  }

  const worldWidth = Math.max(layout.worldWidth, canvas.width)
  const worldHeight = Math.max(layout.worldHeight, canvas.height)
  const selected = positioned.get(selectedNodeId) ?? positioned.get(graph.rootNodeId)
  const selectedCenterX = (selected?.x ?? 0) + Math.floor(nodeWidth / 2)
  const selectedCenterY = (selected?.y ?? 0) + 1
  const offsetX = clamp(
    selectedCenterX - Math.floor(safeWidth / 2),
    0,
    Math.max(0, worldWidth - safeWidth),
  )
  const offsetY = clamp(
    selectedCenterY - Math.floor(safeHeight / 2),
    0,
    Math.max(0, worldHeight - safeHeight),
  )

  return {
    text: canvas.viewport(offsetX, offsetY, safeWidth, safeHeight),
    worldWidth,
    worldHeight,
    offsetX,
    offsetY,
    layout,
  }
}

export function renderRootPicker(
  graphs: ConversationGraph[],
  selectedIndex: number,
  height: number,
  width: number,
  runningSessionIds: Set<string>,
): string {
  if (graphs.length === 0) return "No conversations. Press n to start one."
  const { start, end } = windowAround(graphs.length, selectedIndex, height)
  return graphs
    .slice(start, end)
    .map((graph, offset) => {
      const index = start + offset
      const rootEndpointId = graph.endpointBySessionId.get(graph.rootSessionId)
      const rootEndpoint = rootEndpointId ? graph.nodes.get(rootEndpointId) : undefined
      const title = rootEndpoint?.kind === "endpoint" ? rootEndpoint.session.title : "Conversation"
      const live = [...graph.sessionIds].some((sessionId) => runningSessionIds.has(sessionId))
      const messageCount = [...graph.nodes.values()].filter((node) => node.kind === "message").length
      const branchCount = graph.endpointBySessionId.size
      return truncate(
        `${index === selectedIndex ? ">" : " "} ${live ? "*" : "o"} ${title}  (${messageCount} messages, ${branchCount} ${branchCount === 1 ? "leaf" : "leaves"})`,
        width,
      )
    })
    .join("\n")
}

function drawConnections(
  canvas: SparseCanvas,
  parent: PositionedGraphNode,
  positioned: Map<string, PositionedGraphNode>,
  nodeWidth: number,
): void {
  const children = parent.node.childIds
    .map((childId) => positioned.get(childId))
    .filter((child): child is PositionedGraphNode => child !== undefined)
  if (children.length === 0) return

  const parentCenter = parent.x + Math.floor(nodeWidth / 2)
  const branchY = parent.y + GRAPH_NODE_HEIGHT
  const childCenters = children.map((child) => child.x + Math.floor(nodeWidth / 2))
  if (children.length > 1) {
    canvas.horizontal(Math.min(...childCenters, parentCenter), Math.max(...childCenters, parentCenter), branchY)
  }
  canvas.set(parentCenter, branchY, "+")

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!
    const center = childCenters[index]!
    canvas.set(center, branchY, "+")
    canvas.vertical(center, branchY + 1, child.y - 1)
  }
}

function drawNode(
  canvas: SparseCanvas,
  positioned: PositionedGraphNode,
  width: number,
  selected: boolean,
  runningSessionIds: Set<string>,
  draftPreviews: Map<string, DraftPreview>,
): void {
  const { node, x, y } = positioned
  const top = `+${"-".repeat(width - 2)}+`
  let label: string
  if (node.kind === "message") {
    const role = node.internal
      ? "I"
      : node.role === "assistant"
        ? "A"
        : node.role === "user"
          ? "U"
          : "S"
    label = `${selected ? ">" : " "} ${role} ${node.preview}`
  } else {
    const running = runningSessionIds.has(node.session.sessionId)
    const status = running ? "* live" : "o saved"
    const draft = draftPreviews.get(node.session.sessionId)
    const description = draft
      ? `${draft.exact ? "draft" : "~ draft"}: ${normalizePreview(draft.text)}`
      : running
        ? "[no draft observed]"
        : "[no live draft]"
    label = `${selected ? ">" : " "} @ ${status} ${description}`
  }
  const middle = `|${padOrTruncate(label, width - 2)}|`
  canvas.text(x, y, top)
  canvas.text(x, y + 1, middle)
  canvas.text(x, y + 2, top)
}

class SparseCanvas {
  private readonly cells = new Map<string, string>()
  width = 0
  height = 0

  set(x: number, y: number, value: string): void {
    if (x < 0 || y < 0) return
    const key = `${x}:${y}`
    const existing = this.cells.get(key)
    const next =
      existing &&
      ((existing === "-" && value === "|") ||
        (existing === "|" && value === "-") ||
        existing === "+" ||
        value === "+")
        ? "+"
        : value
    this.cells.set(key, next)
    this.width = Math.max(this.width, x + 1)
    this.height = Math.max(this.height, y + 1)
  }

  text(x: number, y: number, value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      this.set(x + index, y, value[index]!)
    }
  }

  horizontal(startX: number, endX: number, y: number): void {
    for (let x = startX; x <= endX; x += 1) this.set(x, y, "-")
  }

  vertical(x: number, startY: number, endY: number): void {
    for (let y = startY; y <= endY; y += 1) this.set(x, y, "|")
  }

  viewport(offsetX: number, offsetY: number, width: number, height: number): string {
    const lines: string[] = []
    for (let y = offsetY; y < offsetY + height; y += 1) {
      let line = ""
      for (let x = offsetX; x < offsetX + width; x += 1) {
        line += this.cells.get(`${x}:${y}`) ?? " "
      }
      lines.push(line.trimEnd())
    }
    return lines.join("\n")
  }
}

function windowAround(total: number, selected: number, height: number): { start: number; end: number } {
  const safeHeight = Math.max(1, height)
  const start = clamp(selected - Math.floor(safeHeight / 2), 0, Math.max(0, total - safeHeight))
  return { start, end: Math.min(total, start + safeHeight) }
}

function padOrTruncate(value: string, width: number): string {
  const truncated = truncate(value, width)
  return truncated.padEnd(width)
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value
  return width <= 3 ? value.slice(0, width) : `${value.slice(0, width - 3)}...`
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
