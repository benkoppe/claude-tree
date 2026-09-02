import type {
  ConversationGraph,
  ConversationGraphNode,
  MessageGraphNodeOrEndpoint,
} from "./conversation-graph"

export const GRAPH_NODE_HEIGHT = 2
export const GRAPH_HORIZONTAL_GAP = 4
export const GRAPH_VERTICAL_GAP = 2

export type GraphDirection = "up" | "down" | "left" | "right"
export type GraphNavigationAxis = "vertical" | "horizontal"

export interface GraphNavigationIntent {
  axis: GraphNavigationAxis
  preferredCoordinate: number
  atNodeId: string
  returnNodeId: string
  lastDirection: GraphDirection
}

export interface GraphNavigationMove {
  nodeId: string
  intent: GraphNavigationIntent
}

export interface PositionedGraphNode {
  node: MessageGraphNodeOrEndpoint
  x: number
  y: number
  width: number
  height: number
}

export interface ConversationGraphLayout {
  nodes: Map<string, PositionedGraphNode>
  nodeWidth: number
  worldWidth: number
  worldHeight: number
}

interface LayoutTraversalFrame {
  node: MessageGraphNodeOrEndpoint
  depth: number
  visibleChildren: MessageGraphNodeOrEndpoint[]
  nextChildIndex: number
  firstChildCenter: number | undefined
  lastChildCenter: number | undefined
}

export function graphNodeAt(
  layout: ConversationGraphLayout,
  worldX: number,
  worldY: number,
): PositionedGraphNode | undefined {
  for (const positioned of layout.nodes.values()) {
    if (
      worldX >= positioned.x &&
      worldX < positioned.x + positioned.width &&
      worldY >= positioned.y &&
      worldY < positioned.y + positioned.height
    ) {
      return positioned
    }
  }
  return undefined
}

export function visibleGraphNodeId(
  graph: ConversationGraph,
  nodeId: string | undefined,
  visibleEndpointSessionIds: ReadonlySet<string>,
): string | undefined {
  let currentNodeId = nodeId
  const visited = new Set<string>()
  while (currentNodeId !== undefined && !visited.has(currentNodeId)) {
    visited.add(currentNodeId)
    const node = graph.nodes.get(currentNodeId)
    if (!node || node.kind === "origin") return undefined
    if (isPositionedNode(graph, node, visibleEndpointSessionIds)) return node.id
    currentNodeId = node.kind === "endpoint" && node.fork?.empty
      ? node.fork.sourceNodeId
      : node.parentId ?? undefined
  }
  return undefined
}

export function initialVisibleGraphNodeId(
  graph: ConversationGraph,
  visibleEndpointSessionIds: ReadonlySet<string>,
): string | undefined {
  const origin = graph.nodes.get(graph.originNodeId)
  for (const childId of origin?.childIds ?? []) {
    const visibleNodeId = visibleGraphNodeId(graph, childId, visibleEndpointSessionIds)
    if (visibleNodeId) return visibleNodeId
  }
  return undefined
}

export function topVisibleGraphNodeId(
  layout: ConversationGraphLayout,
  nodeId: string,
): string | undefined {
  let current = layout.nodes.get(nodeId)
  if (!current) return undefined
  const visited = new Set<string>()
  while (current.node.parentId && !visited.has(current.node.id)) {
    visited.add(current.node.id)
    const parent = layout.nodes.get(current.node.parentId)
    if (!parent) break
    current = parent
  }
  return current.node.id
}

export function layoutConversationGraph(
  graph: ConversationGraph,
  viewportWidth: number,
  visibleEndpointSessionIds: ReadonlySet<string> = new Set(),
): ConversationGraphLayout {
  const safeWidth = Math.max(1, viewportWidth)
  const nodeWidth = Math.max(22, Math.min(32, safeWidth - 2))
  const positioned = new Map<string, PositionedGraphNode>()
  const stride = nodeWidth + GRAPH_HORIZONTAL_GAP
  let nextLeaf = 0

  const origin = graph.nodes.get(graph.originNodeId)
  for (const rootId of origin?.childIds ?? []) {
    const root = graph.nodes.get(rootId)
    if (!root || root.kind === "origin" || !isPositionedNode(graph, root, visibleEndpointSessionIds)) {
      continue
    }

    const traversal: LayoutTraversalFrame[] = [{
      node: root,
      depth: 0,
      visibleChildren: visibleChildren(graph, root, visibleEndpointSessionIds),
      nextChildIndex: 0,
      firstChildCenter: undefined,
      lastChildCenter: undefined,
    }]
    while (traversal.length > 0) {
      const frame = traversal[traversal.length - 1]!
      const child = frame.visibleChildren[frame.nextChildIndex]
      if (child) {
        frame.nextChildIndex += 1
        traversal.push({
          node: child,
          depth: frame.depth + 1,
          visibleChildren: visibleChildren(graph, child, visibleEndpointSessionIds),
          nextChildIndex: 0,
          firstChildCenter: undefined,
          lastChildCenter: undefined,
        })
        continue
      }

      const center = frame.visibleChildren.length === 0
        ? nextLeaf++ * stride + Math.floor(nodeWidth / 2)
        : Math.round((frame.firstChildCenter! + frame.lastChildCenter!) / 2)
      positioned.set(frame.node.id, {
        node: frame.node,
        x: Math.max(0, center - Math.floor(nodeWidth / 2)),
        y: frame.depth * (GRAPH_NODE_HEIGHT + GRAPH_VERTICAL_GAP),
        width: nodeWidth,
        height: GRAPH_NODE_HEIGHT,
      })
      traversal.pop()

      const parent = traversal[traversal.length - 1]
      if (parent) {
        parent.firstChildCenter ??= center
        parent.lastChildCenter = center
      }
    }
  }

  let worldWidth = positioned.size > 0 ? nodeWidth : 0
  let worldHeight = positioned.size > 0 ? GRAPH_NODE_HEIGHT : 0
  for (const node of positioned.values()) {
    worldWidth = Math.max(worldWidth, node.x + node.width)
    worldHeight = Math.max(worldHeight, node.y + node.height)
  }
  return { nodes: positioned, nodeWidth, worldWidth, worldHeight }
}

function visibleChildren(
  graph: ConversationGraph,
  node: MessageGraphNodeOrEndpoint,
  visibleEndpointSessionIds: ReadonlySet<string>,
): MessageGraphNodeOrEndpoint[] {
  return node.childIds
    .map((childId) => graph.nodes.get(childId))
    .filter((child): child is MessageGraphNodeOrEndpoint =>
      child !== undefined &&
      child.kind !== "origin" &&
      isPositionedNode(graph, child, visibleEndpointSessionIds)
    )
}

function isPositionedNode(
  graph: ConversationGraph,
  node: ConversationGraphNode,
  visibleEndpointSessionIds: ReadonlySet<string>,
): boolean {
  if (node.kind === "message") return true
  if (node.kind === "origin") return false
  if (visibleEndpointSessionIds.has(node.session.id)) return true
  if (!node.fork?.empty) return false

  const source = graph.nodes.get(node.fork.sourceNodeId)
  return (source?.childIds ?? []).some((childId) => {
    if (childId === node.id) return false
    const child = graph.nodes.get(childId)
    return child?.kind === "message" ||
      (child?.kind === "endpoint" && visibleEndpointSessionIds.has(child.session.id))
  })
}

export function directionalMove(
  layout: ConversationGraphLayout,
  selectedNodeId: string,
  direction: GraphDirection,
  intent?: GraphNavigationIntent,
): GraphNavigationMove | undefined {
  const selected = layout.nodes.get(selectedNodeId)
  if (!selected) return undefined

  const axis = navigationAxis(direction)
  const continuingIntent = intent?.axis === axis && intent.atNodeId === selectedNodeId
  const preferredCoordinate = continuingIntent
    ? intent.preferredCoordinate
    : perpendicularCenter(selected, axis)
  const eligibleNodes = axis === "vertical"
    ? verticalCandidates(layout, selected, direction)
    : [...layout.nodes.values()].filter((candidate) => candidate.node.id !== selectedNodeId)
  const exactReturnNodeId =
    continuingIntent && oppositeDirection(intent.lastDirection) === direction
      ? intent.returnNodeId
      : undefined
  const candidates = eligibleNodes
    .map((candidate) =>
      directionalCandidate(
        selected,
        candidate,
        direction,
        preferredCoordinate,
        candidate.node.id === exactReturnNodeId,
      )
    )
    .filter((candidate): candidate is DirectionalCandidate => candidate !== undefined)
    .sort(compareDirectionalCandidates)
  const next = candidates[0]
  if (!next) return undefined
  return {
    nodeId: next.nodeId,
    intent: {
      axis,
      preferredCoordinate,
      atNodeId: next.nodeId,
      returnNodeId: selectedNodeId,
      lastDirection: direction,
    },
  }
}

interface DirectionalCandidate {
  nodeId: string
  x: number
  y: number
  primary: number
  secondaryGap: number
  secondaryCenterDistance: number
  beam: boolean
  distanceSquared: number
  exactReturn: boolean
}

function directionalCandidate(
  selected: PositionedGraphNode,
  candidate: PositionedGraphNode,
  direction: GraphDirection,
  preferredCoordinate: number,
  exactReturn: boolean,
): DirectionalCandidate | undefined {
  const selectedCenterX = selected.x * 2 + selected.width
  const selectedCenterY = selected.y * 2 + selected.height
  const candidateCenterX = candidate.x * 2 + candidate.width
  const candidateCenterY = candidate.y * 2 + candidate.height
  const deltaX = candidateCenterX - selectedCenterX
  const deltaY = candidateCenterY - selectedCenterY
  const horizontal = direction === "left" || direction === "right"
  const primary = horizontal
    ? direction === "left"
      ? -deltaX
      : deltaX
    : direction === "up"
      ? -deltaY
      : deltaY
  if (primary <= 0) return undefined

  const candidatePerpendicularStart = (horizontal ? candidate.y : candidate.x) * 2
  const candidatePerpendicularEnd =
    candidatePerpendicularStart + (horizontal ? candidate.height : candidate.width) * 2
  const candidatePerpendicularCenter = horizontal ? candidateCenterY : candidateCenterX
  const secondaryGap = distanceToRange(
    preferredCoordinate,
    candidatePerpendicularStart,
    candidatePerpendicularEnd,
  )
  const secondaryCenterDistance = Math.abs(candidatePerpendicularCenter - preferredCoordinate)
  return {
    nodeId: candidate.node.id,
    x: candidate.x,
    y: candidate.y,
    primary,
    secondaryGap,
    secondaryCenterDistance,
    beam: secondaryGap === 0,
    distanceSquared: primary * primary + secondaryGap * secondaryGap,
    exactReturn,
  }
}

function compareDirectionalCandidates(
  left: DirectionalCandidate,
  right: DirectionalCandidate,
): number {
  if (left.exactReturn !== right.exactReturn) return left.exactReturn ? -1 : 1
  if (left.beam !== right.beam) return left.beam ? -1 : 1
  if (left.beam) {
    return (
      left.primary - right.primary ||
      left.secondaryCenterDistance - right.secondaryCenterDistance ||
      left.distanceSquared - right.distanceSquared ||
      compareVisualOrder(left, right)
    )
  }
  const angleOrder = left.secondaryGap * right.primary - right.secondaryGap * left.primary
  return (
    angleOrder ||
    left.distanceSquared - right.distanceSquared ||
    left.primary - right.primary ||
    compareVisualOrder(left, right)
  )
}

function verticalCandidates(
  layout: ConversationGraphLayout,
  selected: PositionedGraphNode,
  direction: GraphDirection,
): PositionedGraphNode[] {
  if (direction === "up") {
    const parentId = selected.node.parentId
    const parent = parentId ? layout.nodes.get(parentId) : undefined
    return parent ? [parent] : []
  }
  if (direction !== "down") return []
  return selected.node.childIds
    .map((childId) => layout.nodes.get(childId))
    .filter((child): child is PositionedGraphNode => child !== undefined)
}

function navigationAxis(direction: GraphDirection): GraphNavigationAxis {
  return direction === "up" || direction === "down" ? "vertical" : "horizontal"
}

function perpendicularCenter(
  node: PositionedGraphNode,
  axis: GraphNavigationAxis,
): number {
  return axis === "vertical"
    ? node.x * 2 + node.width
    : node.y * 2 + node.height
}

function oppositeDirection(direction: GraphDirection): GraphDirection {
  if (direction === "up") return "down"
  if (direction === "down") return "up"
  if (direction === "left") return "right"
  return "left"
}

function compareVisualOrder(left: DirectionalCandidate, right: DirectionalCandidate): number {
  return left.y - right.y || left.x - right.x || left.nodeId.localeCompare(right.nodeId)
}

function distanceToRange(value: number, start: number, end: number): number {
  if (value < start) return start - value
  if (value > end) return value - end
  return 0
}
