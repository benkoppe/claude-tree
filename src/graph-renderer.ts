import {
  StyledText,
  TextAttributes,
  type RGBA,
  type TextChunk,
} from "@opentui/core"

import type { DraftPreview } from "./agent-provider"
import { displayWidth, graphemes, truncateToWidth } from "./display-text"
import type { ConversationGraph } from "./message-graph"
import {
  GRAPH_NODE_HEIGHT,
  type ConversationGraphLayout,
  type PositionedGraphNode,
  layoutConversationGraph,
} from "./graph-layout"
import { theme } from "./theme"

export interface RenderedText {
  content: StyledText
  text: string
}

export interface RenderedGraph extends RenderedText {
  worldWidth: number
  worldHeight: number
  offsetX: number
  offsetY: number
  layout: ConversationGraphLayout
}

export interface RenderedRootPicker extends RenderedText {
  startIndex: number
  endIndex: number
}

export interface ViewportOffset {
  x: number
  y: number
}

interface CellStyle {
  fg: RGBA
  bg: RGBA
  attributes: number
}

interface CanvasCell {
  text: string
  width: number
  continuation: boolean
  style: CellStyle
}

const DEFAULT_STYLE: CellStyle = {
  fg: theme.text,
  bg: theme.background,
  attributes: TextAttributes.NONE,
}

const CONNECTOR_STYLE: CellStyle = {
  fg: theme.connector,
  bg: theme.background,
  attributes: TextAttributes.NONE,
}

const NORTH = 1
const EAST = 2
const SOUTH = 4
const WEST = 8

export const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

const ICONS = {
  user: "󰭹",
  agent: "󰚩",
  branch: "󰘬",
  system: "󰒓",
  session: "󰆍",
} as const

export function renderConversationGraph(
  graph: ConversationGraph,
  selectedNodeId: string,
  viewportWidth: number,
  viewportHeight: number,
  runningSessionIds: Set<string>,
  draftPreviews: Map<string, DraftPreview> = new Map(),
  workingSessionIds: Set<string> = new Set(),
  spinnerFrame = 0,
  viewportOffset?: ViewportOffset,
): RenderedGraph {
  const safeWidth = Math.max(1, viewportWidth)
  const safeHeight = Math.max(1, viewportHeight)
  const layout = layoutConversationGraph(graph, safeWidth, runningSessionIds)
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
      draftPreviews,
      workingSessionIds,
      spinnerFrame,
    )
  }

  const worldWidth = Math.max(layout.worldWidth, canvas.width)
  const worldHeight = Math.max(layout.worldHeight, canvas.height)
  const selected = positioned.get(selectedNodeId) ?? positioned.values().next().value
  const selectedCenterX = (selected?.x ?? 0) + Math.floor((selected?.width ?? nodeWidth) / 2)
  const selectedCenterY = (selected?.y ?? 0) + Math.floor((selected?.height ?? GRAPH_NODE_HEIGHT) / 2)
  const centeredOffsetX =
    worldWidth === 0 ? 0 : -Math.floor(Math.max(0, safeWidth - worldWidth) / 2)
  const centeredOffsetY =
    worldHeight === 0 ? 0 : -Math.floor(Math.max(0, safeHeight - worldHeight) / 2)
  const offsetX = clamp(
    viewportOffset?.x ?? selectedCenterX - Math.floor(safeWidth / 2),
    centeredOffsetX,
    worldWidth <= safeWidth ? centeredOffsetX : worldWidth - safeWidth,
  )
  const offsetY = clamp(
    viewportOffset?.y ?? selectedCenterY - Math.floor(safeHeight / 2),
    centeredOffsetY,
    worldHeight <= safeHeight ? centeredOffsetY : worldHeight - safeHeight,
  )
  const viewport = canvas.viewport(offsetX, offsetY, safeWidth, safeHeight)

  return {
    ...viewport,
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
  viewportStart = 0,
): RenderedRootPicker {
  const safeWidth = Math.max(1, width)
  if (graphs.length === 0) {
    const canvas = new SparseCanvas()
    canvas.write(0, 0, truncateToWidth("No conversations · press n to start one", safeWidth), {
      ...DEFAULT_STYLE,
      fg: theme.textMuted,
    })
    return {
      ...canvas.viewport(0, 0, safeWidth, Math.max(1, height)),
      startIndex: 0,
      endIndex: 0,
    }
  }

  const canvas = new SparseCanvas()
  const { start, end } = visibleWindow(graphs.length, selectedIndex, height, viewportStart)
  for (let index = start; index < end; index += 1) {
    const graph = graphs[index]!
    const row = index - start
    const selected = index === selectedIndex
    const background = selected ? theme.selected : theme.background
    const foreground = selected ? theme.selectedText : theme.text
    const rootEndpointId = graph.endpointBySessionId.get(graph.rootSessionId)
    const rootEndpoint = rootEndpointId ? graph.nodes.get(rootEndpointId) : undefined
    const title = rootEndpoint?.kind === "endpoint" ? rootEndpoint.session.title : "Conversation"
    const live = [...graph.sessionIds].some((sessionId) => runningSessionIds.has(sessionId))
    const messageCount = [...graph.nodes.values()].filter((node) => node.kind === "message").length
    const sessionCount = graph.endpointBySessionId.size
    const status = live ? "● Live" : "○ Saved"
    const metadata = `${messageCount} messages · ${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}`
    const rowStyle = { fg: foreground, bg: background, attributes: TextAttributes.NONE }
    const statusStyle = {
      ...rowStyle,
      fg: selected ? theme.selectedText : live ? theme.success : theme.textMuted,
      attributes: TextAttributes.BOLD,
    }

    canvas.paint(0, row, safeWidth, 1, rowStyle)
    canvas.write(1, row, status, statusStyle)
    const titleX = 1 + displayWidth(status) + 2
    const metadataWidth = displayWidth(metadata)
    const metadataX = Math.max(titleX, safeWidth - metadataWidth - 1)
    const titleWidth = Math.max(0, metadataX - titleX - 2)
    canvas.write(titleX, row, truncateToWidth(title, titleWidth), {
      ...rowStyle,
      attributes: selected ? TextAttributes.BOLD : TextAttributes.NONE,
    })
    if (metadataX > titleX) {
      canvas.write(metadataX, row, truncateToWidth(metadata, safeWidth - metadataX - 1), {
        ...rowStyle,
        fg: selected ? theme.selectedText : theme.textMuted,
      })
    }
  }
  return {
    ...canvas.viewport(0, 0, safeWidth, Math.max(1, height)),
    startIndex: start,
    endIndex: end,
  }
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
  const minimumX = Math.min(parentCenter, ...childCenters)
  const maximumX = Math.max(parentCenter, ...childCenters)

  canvas.connectHorizontal(minimumX, maximumX, branchY)
  canvas.connect(parentCenter, branchY, NORTH)
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!
    const center = childCenters[index]!
    canvas.connect(center, branchY, SOUTH)
    canvas.connectVertical(center, branchY + 1, child.y - 1)
  }
}

function drawNode(
  canvas: SparseCanvas,
  positioned: PositionedGraphNode,
  width: number,
  selected: boolean,
  draftPreviews: Map<string, DraftPreview>,
  workingSessionIds: Set<string>,
  spinnerFrame: number,
): void {
  const { node, x, y } = positioned
  const background = selected
    ? theme.selected
    : node.kind === "endpoint"
      ? theme.sessionElement
      : node.internal
        ? theme.branchElement
        : theme.element
  const foreground = selected ? theme.selectedText : theme.text
  const baseStyle = { fg: foreground, bg: background, attributes: TextAttributes.NONE }
  const headerStyle = { ...baseStyle, attributes: TextAttributes.BOLD }
  const contentWidth = Math.max(0, width - 4)

  canvas.paint(x, y, width, GRAPH_NODE_HEIGHT, baseStyle)

  if (node.kind === "message") {
    const kind = node.internal
      ? { icon: ICONS.branch, label: "Branch point", accent: theme.accent }
      : node.role === "agent"
        ? { icon: ICONS.agent, label: "Agent", accent: theme.primary }
        : node.role === "user"
          ? { icon: ICONS.user, label: "User", accent: theme.secondary }
          : { icon: ICONS.system, label: "System", accent: theme.warning }
    drawHeading(canvas, x + 2, y, kind.icon, kind.label, contentWidth, {
      ...headerStyle,
      fg: selected ? theme.selectedText : kind.accent,
    }, headerStyle)
    canvas.write(x + 2, y + 1, truncateToWidth(node.preview, contentWidth), baseStyle)
    return
  }

  const sessionId = node.session.id
  if (workingSessionIds.has(sessionId)) {
    drawHeading(canvas, x + 2, y, ICONS.agent, "Agent", contentWidth, {
      ...headerStyle,
      fg: selected ? theme.selectedText : theme.primary,
    }, headerStyle)
    const frame = BRAILLE_SPINNER_FRAMES[spinnerFrame % BRAILLE_SPINNER_FRAMES.length]!
    canvas.write(x + 2, y + 1, frame, {
      ...baseStyle,
      fg: selected ? theme.selectedText : theme.primary,
    })
    return
  }

  drawHeading(canvas, x + 2, y, ICONS.session, "Draft", contentWidth, {
    ...headerStyle,
    fg: selected ? theme.selectedText : theme.info,
  }, headerStyle)
  const draft = draftPreviews.get(node.session.id)
  const description = draft ? normalizePreview(draft.text) : ""
  canvas.write(x + 2, y + 1, truncateToWidth(description, contentWidth), {
    ...baseStyle,
    fg: selected ? theme.selectedText : theme.text,
  })
}

function drawHeading(
  canvas: SparseCanvas,
  x: number,
  y: number,
  icon: string,
  label: string,
  width: number,
  iconStyle: CellStyle,
  labelStyle: CellStyle,
): void {
  if (width <= 0) return
  const iconText = truncateToWidth(icon, width)
  canvas.write(x, y, iconText, iconStyle)
  const labelX = x + displayWidth(iconText) + 1
  const remaining = width - displayWidth(iconText) - 1
  if (remaining > 0) canvas.write(labelX, y, truncateToWidth(label, remaining), labelStyle)
}

class SparseCanvas {
  private readonly cells = new Map<string, CanvasCell>()
  private readonly connections = new Map<string, number>()
  width = 0
  height = 0

  paint(x: number, y: number, width: number, height: number, style: CellStyle): void {
    for (let row = y; row < y + height; row += 1) {
      for (let column = x; column < x + width; column += 1) {
        this.set(column, row, { text: " ", width: 1, continuation: false, style })
      }
    }
  }

  write(x: number, y: number, value: string, style: CellStyle): void {
    let column = x
    for (const grapheme of graphemes(value)) {
      const width = displayWidth(grapheme)
      if (width <= 0) continue
      this.set(column, y, { text: grapheme, width, continuation: false, style })
      for (let offset = 1; offset < width; offset += 1) {
        this.set(column + offset, y, { text: "", width: 0, continuation: true, style })
      }
      column += width
    }
  }

  connect(x: number, y: number, directions: number): void {
    if (x < 0 || y < 0) return
    const key = cellKey(x, y)
    this.connections.set(key, (this.connections.get(key) ?? 0) | directions)
    this.width = Math.max(this.width, x + 1)
    this.height = Math.max(this.height, y + 1)
  }

  connectHorizontal(startX: number, endX: number, y: number): void {
    for (let x = startX; x <= endX; x += 1) {
      this.connect(x, y, (x > startX ? WEST : 0) | (x < endX ? EAST : 0))
    }
  }

  connectVertical(x: number, startY: number, endY: number): void {
    for (let y = startY; y <= endY; y += 1) this.connect(x, y, NORTH | SOUTH)
  }

  viewport(offsetX: number, offsetY: number, width: number, height: number): RenderedText {
    const chunks: TextChunk[] = []
    const plainLines: string[] = []
    for (let y = offsetY; y < offsetY + height; y += 1) {
      let plainLine = ""
      let x = offsetX
      while (x < offsetX + width) {
        const cell = this.cell(x, y)
        if (cell.continuation || cell.width > offsetX + width - x) {
          appendChunk(chunks, " ", cell.style)
          plainLine += " "
          x += 1
          continue
        }
        appendChunk(chunks, cell.text, cell.style)
        plainLine += cell.text
        x += cell.width
      }
      plainLines.push(plainLine.trimEnd())
      if (y < offsetY + height - 1) appendChunk(chunks, "\n", DEFAULT_STYLE)
    }
    return { content: new StyledText(chunks), text: plainLines.join("\n") }
  }

  private set(x: number, y: number, cell: CanvasCell): void {
    if (x < 0 || y < 0) return
    this.cells.set(cellKey(x, y), cell)
    this.width = Math.max(this.width, x + Math.max(1, cell.width))
    this.height = Math.max(this.height, y + 1)
  }

  private cell(x: number, y: number): CanvasCell {
    const key = cellKey(x, y)
    const cell = this.cells.get(key)
    if (cell) return cell
    const connection = this.connections.get(key)
    if (connection) {
      return {
        text: connectorGlyph(connection),
        width: 1,
        continuation: false,
        style: CONNECTOR_STYLE,
      }
    }
    return { text: " ", width: 1, continuation: false, style: DEFAULT_STYLE }
  }
}

function appendChunk(chunks: TextChunk[], text: string, style: CellStyle): void {
  const previous = chunks[chunks.length - 1]
  if (
    previous &&
    previous.fg === style.fg &&
    previous.bg === style.bg &&
    previous.attributes === style.attributes
  ) {
    previous.text += text
    return
  }
  chunks.push({
    __isChunk: true,
    text,
    fg: style.fg,
    bg: style.bg,
    attributes: style.attributes,
  })
}

function connectorGlyph(directions: number): string {
  const glyphs: Record<number, string> = {
    [NORTH]: "╵",
    [EAST]: "╶",
    [SOUTH]: "╷",
    [WEST]: "╴",
    [NORTH | SOUTH]: "│",
    [EAST | WEST]: "─",
    [EAST | SOUTH]: "┌",
    [SOUTH | WEST]: "┐",
    [NORTH | EAST]: "└",
    [NORTH | WEST]: "┘",
    [EAST | SOUTH | WEST]: "┬",
    [NORTH | SOUTH | WEST]: "┤",
    [NORTH | EAST | WEST]: "┴",
    [NORTH | EAST | SOUTH]: "├",
    [NORTH | EAST | SOUTH | WEST]: "┼",
  }
  const glyph = glyphs[directions]
  if (!glyph) throw new Error(`Unsupported connector topology: ${directions}`)
  return glyph
}

function cellKey(x: number, y: number): string {
  return `${x}:${y}`
}

function visibleWindow(
  total: number,
  selected: number,
  height: number,
  viewportStart: number,
): { start: number; end: number } {
  const safeHeight = Math.max(1, height)
  const maximumStart = Math.max(0, total - safeHeight)
  let start = clamp(viewportStart, 0, maximumStart)
  if (selected < start) start = selected
  if (selected >= start + safeHeight) start = selected - safeHeight + 1
  start = clamp(start, 0, maximumStart)
  return { start, end: Math.min(total, start + safeHeight) }
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
