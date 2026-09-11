import {
  StyledText,
  TextAttributes,
  type RGBA,
  type TextChunk,
} from "@opentui/core"

import type {
  GraphNodeViewModel,
  RootViewModel,
  SurfaceViewModel,
} from "../application/view-model"
import type { SessionStatus } from "../application/selectors"
import { displayWidth, graphemes, truncateToWidth } from "./text"
import { presentationTheme as theme } from "./theme"

export const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export interface ViewportOffset {
  readonly x: number
  readonly y: number
}

export interface RenderedGraph {
  readonly content: StyledText
  readonly text: string
  readonly offsetX: number
  readonly offsetY: number
  readonly worldWidth: number
  readonly worldHeight: number
}

export interface RenderedRoots {
  readonly content: StyledText
  readonly text: string
  readonly startIndex: number
  readonly endIndex: number
}

interface VerticalEntry {
  readonly node: GraphNodeViewModel
  readonly start: number
  readonly end: number
  maximumEnd: number
}
const renderIndexes = new WeakMap<readonly GraphNodeViewModel[], {
  readonly byId: ReadonlyMap<string, GraphNodeViewModel>
  readonly nodes: readonly VerticalEntry[]
  readonly connections: readonly VerticalEntry[]
}>()

function verticalIndex(entries: VerticalEntry[]): readonly VerticalEntry[] {
  entries.sort((a, b) => a.start - b.start)
  let maximumEnd = -Infinity
  for (const entry of entries) entry.maximumEnd = maximumEnd = Math.max(maximumEnd, entry.end)
  return entries
}

function intersecting(entries: readonly VerticalEntry[], start: number, end: number): GraphNodeViewModel[] {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (entries[middle]!.start < end) low = middle + 1
    else high = middle
  }
  const found: GraphNodeViewModel[] = []
  for (let i = low - 1; i >= 0 && entries[i]!.maximumEnd > start; i--) {
    if (entries[i]!.end > start) found.push(entries[i]!.node)
  }
  return found
}

function renderIndex(nodes: readonly GraphNodeViewModel[]) {
  const cached = renderIndexes.get(nodes)
  if (cached) return cached
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const connections: VerticalEntry[] = []
  for (const node of nodes) {
    let end = node.y + node.height
    for (const id of node.childIds) end = Math.max(end, byId.get(id)?.y ?? end)
    if (node.childIds.length) connections.push({ node, start: node.y + node.height, end: end + 1, maximumEnd: 0 })
  }
  const index = { byId, connections: verticalIndex(connections), nodes: verticalIndex(nodes.map((node) => ({
    node, start: node.y, end: node.y + node.height, maximumEnd: 0,
  }))) }
  renderIndexes.set(nodes, index)
  return index
}

interface CellStyle {
  readonly fg: RGBA
  readonly bg: RGBA
  readonly attributes: number
}

interface CanvasCell {
  readonly text: string
  readonly width: number
  readonly continuation: boolean
  readonly style: CellStyle
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

const ICONS = {
  user: "󰭹",
  agent: "󰚩",
  branch: "󰘬",
  system: "󰒓",
  session: "󰆍",
} as const

export function renderRoots(
  roots: readonly RootViewModel[],
  selectedSessionId: string | null,
  height: number,
  width: number,
  viewportStart = 0,
  spinnerFrame = 0,
): RenderedRoots {
  const safeWidth = Math.max(1, width)
  const safeHeight = Math.max(1, height)
  if (roots.length === 0) {
    const canvas = new SparseCanvas()
    canvas.write(0, 0, truncateToWidth("No conversations · press n to start one", safeWidth), {
      ...DEFAULT_STYLE,
      fg: theme.textMuted,
    })
    return { ...canvas.viewport(0, 0, safeWidth, safeHeight), startIndex: 0, endIndex: 0 }
  }

  const selectedIndex = Math.max(0, roots.findIndex((root) => root.sessionId === selectedSessionId))
  const maximumStart = Math.max(0, roots.length - safeHeight)
  let start = clamp(viewportStart, 0, maximumStart)
  if (selectedIndex < start) start = selectedIndex
  if (selectedIndex >= start + safeHeight) start = selectedIndex - safeHeight + 1
  start = clamp(start, 0, maximumStart)
  const end = Math.min(roots.length, start + safeHeight)
  const canvas = new SparseCanvas()

  const messageCountWidth = roots.reduce((width, root) => Math.max(width, String(root.messageCount).length), 1)
  const branchCountWidth = roots.reduce((width, root) => Math.max(width, String(root.memberSessionIds.length).length), 1)
  for (let index = start; index < end; index += 1) {
    const root = roots[index]!
    const row = index - start
    const selected = root.sessionId === selectedSessionId
    const background = selected ? theme.selected : theme.background
    const foreground = selected ? theme.selectedText : theme.text
    const status = statusMarker(root.status, spinnerFrame)
    const branchLabel = root.memberSessionIds.length === 1 ? "branch" : "branches"
    const messageLabel = root.messageCount === 1 ? "message" : "messages"
    const counts = root.history._tag === "Loading" ? "Loading history…"
      : root.history._tag === "Unavailable" ? "History unavailable · Enter to retry"
      : `${String(root.messageCount).padStart(messageCountWidth)} ${messageLabel.padEnd("messages".length)}  ${String(root.memberSessionIds.length).padStart(branchCountWidth)} ${branchLabel.padEnd("branches".length)}`
    const style = { fg: foreground, bg: background, attributes: TextAttributes.NONE }
    canvas.paint(3, row, Math.max(0, safeWidth - 3), 1, style)
    canvas.write(1, row, status, {
      ...DEFAULT_STYLE,
      fg: statusColor(root.status, false),
      attributes: TextAttributes.BOLD,
    })
    const titleX = 4
    const metadataX = Math.max(titleX, safeWidth - displayWidth(counts) - 1)
    canvas.write(titleX, row, truncateToWidth(root.title, Math.max(0, metadataX - titleX - 2)), {
      ...style,
      attributes: selected ? TextAttributes.BOLD : TextAttributes.NONE,
    })
    if (metadataX > titleX) {
      canvas.write(metadataX, row, truncateToWidth(counts, safeWidth - metadataX - 1), {
        ...style,
        fg: root.history._tag === "Unavailable" ? theme.danger : selected ? theme.selectedText : theme.textMuted,
      })
    }
  }
  return { ...canvas.viewport(0, 0, safeWidth, safeHeight), startIndex: start, endIndex: end }
}

export function renderGraph(
  graph: Extract<SurfaceViewModel, { readonly _tag: "Graph" }>,
  viewportWidth: number,
  viewportHeight: number,
  spinnerFrame: number,
  viewportOffset?: ViewportOffset,
  liveSessionIds: ReadonlySet<string> = new Set(),
): RenderedGraph {
  const width = Math.max(1, viewportWidth)
  const height = Math.max(1, viewportHeight)
  const worldWidth = graph.worldWidth
  const worldHeight = graph.worldHeight
  const index = renderIndex(graph.unselectedNodes ?? graph.nodes)
  const selected = (graph.selectedNodeId ? index.byId.get(graph.selectedNodeId) : undefined) ?? graph.nodes.find((node) => node.selected) ?? graph.nodes[0]
  const centerX = (selected?.x ?? 0) + Math.floor((selected?.width ?? 1) / 2)
  const centerY = (selected?.y ?? 0) + Math.floor((selected?.height ?? 1) / 2)
  const centeredX = worldWidth === 0 ? 0 : -Math.floor(Math.max(0, width - worldWidth) / 2)
  const centeredY = worldHeight === 0 ? 0 : -Math.floor(Math.max(0, height - worldHeight) / 2)
  const offsetX = clamp(
    viewportOffset?.x ?? centerX - Math.floor(width / 2),
    centeredX,
    worldWidth <= width ? centeredX : worldWidth - width,
  )
  const offsetY = clamp(
    viewportOffset?.y ?? centerY - Math.floor(height / 2),
    centeredY,
    worldHeight <= height ? centeredY : worldHeight - height,
  )
  const canvas = new SparseCanvas({ x: offsetX, y: offsetY, width, height })
  for (const node of intersecting(index.connections, offsetY, offsetY + height)) {
    drawConnections(canvas, node, index.byId)
  }
  for (const node of intersecting(index.nodes, offsetY, offsetY + height)) {
    if (node.x < offsetX + width && node.x + node.width > offsetX) {
      drawNode(canvas, node, spinnerFrame, liveSessionIds, node.id === selected?.id)
    }
  }
  return {
    ...canvas.viewport(offsetX, offsetY, width, height),
    offsetX,
    offsetY,
    worldWidth,
    worldHeight,
  }
}

function drawConnections(
  canvas: SparseCanvas,
  parent: GraphNodeViewModel,
  nodes: ReadonlyMap<string, GraphNodeViewModel>,
): void {
  const children = parent.childIds
    .map((id) => nodes.get(id))
    .filter((node): node is GraphNodeViewModel => node !== undefined)
  if (children.length === 0) return
  const parentCenter = parent.x + Math.floor(parent.width / 2)
  const branchY = parent.y + parent.height
  const childCenters = children.map((child) => child.x + Math.floor(child.width / 2))
  canvas.connectHorizontal(Math.min(parentCenter, ...childCenters), Math.max(parentCenter, ...childCenters), branchY)
  canvas.connect(parentCenter, branchY, NORTH)
  for (const [index, child] of children.entries()) {
    const center = childCenters[index]!
    canvas.connect(center, branchY, SOUTH)
    canvas.connectVertical(center, branchY + 1, child.y - 1)
  }
}

function drawNode(
  canvas: SparseCanvas,
  node: GraphNodeViewModel,
  spinnerFrame: number,
  liveSessionIds: ReadonlySet<string>,
  selected: boolean,
): void {
  const background = selected
    ? theme.selected
    : node._tag === "Endpoint"
      ? theme.sessionElement
      : theme.element
  const foreground = selected ? theme.selectedText : theme.text
  const style = { fg: foreground, bg: background, attributes: TextAttributes.NONE }
  const heading = { ...style, attributes: TextAttributes.BOLD }
  const contentWidth = Math.max(0, node.width - 4)
  canvas.paint(node.x, node.y, node.width, node.height, style)

  if (node._tag === "Message") {
    const kind = node.role === "agent"
        ? { icon: ICONS.agent, label: "Agent", color: theme.primary }
        : node.role === "user"
          ? { icon: ICONS.user, label: "User", color: theme.secondary }
          : { icon: ICONS.system, label: "System", color: theme.warning }
    drawHeading(canvas, node.x + 2, node.y, kind.icon, kind.label, contentWidth, {
      ...heading,
      fg: selected ? theme.selectedText : kind.color,
    }, heading)
    canvas.write(node.x + 2, node.y + 1, truncateToWidth(node.preview, contentWidth), style)
    return
  }

  const badge = truncateToWidth(`${statusMarker(node.status, spinnerFrame)} ${statusLabel(node.status)}`, contentWidth)
  const badgeWidth = displayWidth(badge)
  const titleWidth = Math.max(0, contentWidth - badgeWidth - 1)
  const agent = node.status === "working" || node.status === "blocked"
  const live = liveSessionIds.has(node.session.id)
  const stoppedFork = !live && node.fork?.empty
  const label = agent ? "Agent" : stoppedFork
    ? node.fork?.number === undefined ? "Fork" : `Fork ${node.fork.number}`
    : live ? "Draft" : "Session"
  drawHeading(canvas, node.x + 2, node.y, agent ? ICONS.agent : stoppedFork ? ICONS.branch : ICONS.session, label, titleWidth, {
    ...heading,
    fg: selected ? theme.selectedText : agent ? theme.primary : stoppedFork ? theme.accent : live ? theme.info : theme.textMuted,
  }, heading)
  canvas.write(node.x + 2 + contentWidth - badgeWidth, node.y, badge, {
    ...heading, fg: statusColor(node.status, selected),
  })
  if (agent) return
  const description = node.draft?.text.replace(/\s+/g, " ").trim() ?? ""
  canvas.write(node.x + 2, node.y + 1, truncateToWidth(description, contentWidth), style)
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
  const remaining = width - displayWidth(iconText) - 1
  if (remaining > 0) {
    canvas.write(x + displayWidth(iconText) + 1, y, truncateToWidth(label, remaining), labelStyle)
  }
}

export function statusColor(status: RootViewModel["status"], selected = false): RGBA {
  if (selected) {
    if (status === "blocked") return theme.selectedDanger
    if (status === "unviewed") return theme.selectedWarning
    if (status === "live") return theme.selectedSuccess
    return status === "working" ? theme.selectedText : theme.selectedMuted
  }
  if (status === "blocked") return theme.danger
  if (status === "unviewed") return theme.warning
  if (status === "working") return theme.primary
  if (status === "live") return theme.success
  return theme.textMuted
}

export function statusMarker(status: SessionStatus, frame: number): string {
  return status === "working" ? BRAILLE_SPINNER_FRAMES[frame % BRAILLE_SPINNER_FRAMES.length]!
    : status === "idle" ? "○" : "●"
}

export function statusLabel(status: SessionStatus): string {
  return { idle: "Stopped", live: "Live", unviewed: "New updates", working: "Working", blocked: "Needs user" }[status]
}

export function chunk(
  text: string,
  fg: RGBA,
  attributes: number = TextAttributes.NONE,
  bg: RGBA = theme.background,
): TextChunk {
  return { __isChunk: true, text, fg, bg, attributes }
}

export function styledText(chunks: TextChunk[]): StyledText {
  return new StyledText(chunks)
}

class SparseCanvas {
  constructor(private readonly bounds?: { x: number; y: number; width: number; height: number }) {}
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
    if (!this.contains(x, y)) return
    const key = `${x}:${y}`
    this.connections.set(key, (this.connections.get(key) ?? 0) | directions)
    this.width = Math.max(this.width, x + 1)
    this.height = Math.max(this.height, y + 1)
  }

  connectHorizontal(startX: number, endX: number, y: number): void {
    if (this.bounds && (y < this.bounds.y || y >= this.bounds.y + this.bounds.height)) return
    const first = Math.max(startX, this.bounds?.x ?? startX)
    const last = Math.min(endX, this.bounds ? this.bounds.x + this.bounds.width - 1 : endX)
    for (let x = first; x <= last; x += 1) {
      this.connect(x, y, (x > startX ? WEST : 0) | (x < endX ? EAST : 0))
    }
  }

  connectVertical(x: number, startY: number, endY: number): void {
    if (this.bounds && (x < this.bounds.x || x >= this.bounds.x + this.bounds.width)) return
    const first = Math.max(startY, this.bounds?.y ?? startY)
    const last = Math.min(endY, this.bounds ? this.bounds.y + this.bounds.height - 1 : endY)
    for (let y = first; y <= last; y += 1) this.connect(x, y, NORTH | SOUTH)
  }

  viewport(offsetX: number, offsetY: number, width: number, height: number): {
    content: StyledText
    text: string
  } {
    const chunks: TextChunk[] = []
    const lines: string[] = []
    for (let y = offsetY; y < offsetY + height; y += 1) {
      let line = ""
      let x = offsetX
      while (x < offsetX + width) {
        const cell = this.cell(x, y)
        if (cell.continuation || cell.width > offsetX + width - x) {
          appendChunk(chunks, " ", cell.style)
          line += " "
          x += 1
          continue
        }
        appendChunk(chunks, cell.text, cell.style)
        line += cell.text
        x += cell.width
      }
      lines.push(line.trimEnd())
      if (y < offsetY + height - 1) appendChunk(chunks, "\n", DEFAULT_STYLE)
    }
    return { content: styledText(chunks), text: lines.join("\n") }
  }

  private set(x: number, y: number, cell: CanvasCell): void {
    if (!this.contains(x, y)) return
    this.cells.set(`${x}:${y}`, cell)
    this.width = Math.max(this.width, x + Math.max(1, cell.width))
    this.height = Math.max(this.height, y + 1)
  }

  private contains(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && (!this.bounds || (x >= this.bounds.x && y >= this.bounds.y &&
      x < this.bounds.x + this.bounds.width && y < this.bounds.y + this.bounds.height))
  }

  private cell(x: number, y: number): CanvasCell {
    const key = `${x}:${y}`
    const cell = this.cells.get(key)
    if (cell) return cell
    const connection = this.connections.get(key)
    return connection
      ? {
          text: connectorGlyph(connection),
          width: 1,
          continuation: false,
          style: CONNECTOR_STYLE,
        }
      : { text: " ", width: 1, continuation: false, style: DEFAULT_STYLE }
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
  } else {
    chunks.push({ __isChunk: true, text, ...style })
  }
}

function connectorGlyph(directions: number): string {
  const glyphs: Readonly<Record<number, string>> = {
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
  return glyphs[directions] ?? "·"
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
