import type { AgentMessage, AgentSession, MessageRef } from "./agent-provider"
import type { BranchRelation, ConversationRemoval } from "./metadata"

export type ForkTarget = MessageRef

interface GraphNodeBase {
  id: string
  parentId: string | null
  childIds: string[]
}

export interface FamilyOriginNode extends GraphNodeBase {
  kind: "origin"
  parentId: null
}

export interface MessageGraphNode extends GraphNodeBase {
  kind: "message"
  role: AgentMessage["role"]
  preview: string
  internal: boolean
  aliases: ForkTarget[]
  forkTarget?: ForkTarget
}

export interface SessionEndpointNode extends GraphNodeBase {
  kind: "endpoint"
  session: AgentSession
  forkTarget?: ForkTarget
  fork?: {
    sourceNodeId: string
    createdAt: string
    empty: boolean
    number?: number
  }
}

export type MessageGraphNodeOrEndpoint = MessageGraphNode | SessionEndpointNode
export type ConversationGraphNode = FamilyOriginNode | MessageGraphNodeOrEndpoint

export interface ConversationGraph {
  rootSessionId: string
  rootSession: AgentSession
  originNodeId: string
  rootNodeId: string
  nodes: Map<string, ConversationGraphNode>
  endpointBySessionId: Map<string, string>
  sessionIds: Set<string>
  warnings: string[]
}

export interface ConversationForest {
  graphs: ConversationGraph[]
  graphBySessionId: Map<string, ConversationGraph>
  graphByRootSessionId: Map<string, ConversationGraph>
  warnings: string[]
}

export interface ReachableSessionEndpoint {
  endpoint: SessionEndpointNode
  distance: number
}

interface SessionGraphContext {
  transcript: AgentMessage[]
  rawLogicalNodeIds: Array<string | undefined>
  nodeIdByMessageId: Map<string, string>
}

export function buildConversationForest(
  sessions: AgentSession[],
  transcripts: Map<string, AgentMessage[]>,
  relations: BranchRelation[],
  removals: ConversationRemoval[] = [],
): ConversationForest {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]))
  const relationsByParent = groupRelationsByParent(relations)
  const exactBranchPointIdsBySession = collectExactBranchPointIds(relations)
  const displayGroupEndIdsBySession = collectDisplayGroupEndIds(relations, removals)
  const recordedChildren = new Set(relations.map((relation) => relation.childSessionId))
  const processedSessions = new Set<string>()
  const graphBySessionId = new Map<string, ConversationGraph>()
  const graphs: ConversationGraph[] = []
  const warnings: string[] = []

  const roots = sessions
    .filter((session) => !recordedChildren.has(session.id))
    .sort(compareSessions)

  const buildRoot = (rootSession: AgentSession) => {
    if (processedSessions.has(rootSession.id)) return

    const originNodeId = `origin:${encodeURIComponent(rootSession.id)}`
    const graph: ConversationGraph = {
      rootSessionId: rootSession.id,
      rootSession,
      originNodeId,
      rootNodeId: "",
      nodes: new Map(),
      endpointBySessionId: new Map(),
      sessionIds: new Set(),
      warnings: [],
    }
    graph.nodes.set(originNodeId, {
      id: originNodeId,
      kind: "origin",
      parentId: null,
      childIds: [],
    })
    const contexts = new Map<string, SessionGraphContext>()

    const processRelations = (parentSessionId: string) => {
      const parentContext = contexts.get(parentSessionId)
      if (!parentContext) return
      for (const relation of relationsByParent.get(parentSessionId) ?? []) {
        const child = sessionsById.get(relation.childSessionId)
        if (!child || processedSessions.has(child.id)) continue
        const error = attachChildSession(
          graph,
          child,
          relation,
          parentContext,
          transcripts,
          exactBranchPointIdsBySession,
          displayGroupEndIdsBySession,
        )
        if (error) {
          graph.warnings.push(error)
          warnings.push(error)
          continue
        }

        processedSessions.add(child.id)
        graph.sessionIds.add(child.id)
        graphBySessionId.set(child.id, graph)
        const childContext = sessionContextByGraph.get(graph)?.get(child.id)
        if (childContext) contexts.set(child.id, childContext)
        processRelations(child.id)
      }
    }

    const rootContext = appendRootSession(
      graph,
      rootSession,
      transcripts.get(rootSession.id) ?? [],
      exactBranchPointIdsBySession,
      displayGroupEndIdsBySession,
    )
    contexts.set(rootSession.id, rootContext)
    processedSessions.add(rootSession.id)
    graph.sessionIds.add(rootSession.id)
    graphBySessionId.set(rootSession.id, graph)
    processRelations(rootSession.id)
    graphs.push(graph)
  }

  for (const root of roots) buildRoot(root)
  for (const session of [...sessions].sort(compareSessions)) buildRoot(session)

  return applyConversationRemovals(graphs, graphBySessionId, removals)
}

interface IndexedMessageNode {
  graph: ConversationGraph
  nodeId: string
}

function applyConversationRemovals(
  rawGraphs: ConversationGraph[],
  rawGraphBySessionId: Map<string, ConversationGraph>,
  removals: ConversationRemoval[],
): ConversationForest {
  const messageNodesBySessionId = new Map<
    string,
    Map<string, IndexedMessageNode[]>
  >()
  for (const graph of rawGraphs) {
    for (const node of graph.nodes.values()) {
      if (node.kind !== "message") continue
      for (const alias of node.aliases) {
        const nodesByMessageId = messageNodesBySessionId.get(alias.sessionId) ?? new Map()
        const matches = nodesByMessageId.get(alias.messageId) ?? []
        matches.push({ graph, nodeId: node.id })
        nodesByMessageId.set(alias.messageId, matches)
        messageNodesBySessionId.set(alias.sessionId, nodesByMessageId)
      }
    }
  }

  const removedGraphs = new Set<ConversationGraph>()
  const targetNodeIdsByGraph = new Map<ConversationGraph, Set<string>>()
  const addTarget = (graph: ConversationGraph, nodeId: string) => {
    const nodeIds = targetNodeIdsByGraph.get(graph) ?? new Set()
    nodeIds.add(nodeId)
    targetNodeIdsByGraph.set(graph, nodeIds)
  }

  for (const removal of removals) {
    if (removal.kind === "tree") {
      const memberSessionIds = new Set(removal.memberSessionIds)
      for (const graph of rawGraphs) {
        if (
          graph.rootSessionId === removal.rootSessionId ||
          intersects(graph.sessionIds, memberSessionIds)
        ) {
          removedGraphs.add(graph)
        }
      }
      continue
    }

    if (removal.target.kind === "message") {
      for (const alias of removal.target.aliases) {
        const matches = messageNodesBySessionId.get(alias.sessionId)?.get(alias.messageId) ?? []
        for (const match of matches) addTarget(match.graph, match.nodeId)
      }
      continue
    }

    const target = removal.target
    const graph = rawGraphBySessionId.get(target.sessionId)
    const endpointId = graph?.endpointBySessionId.get(target.sessionId)
    if (!graph || !endpointId) continue

    const context = sessionContextByGraph.get(graph)?.get(target.sessionId)
    const anchorIndex =
      target.afterMessageId === null
        ? -1
        : (context?.transcript.findIndex(
            (message) => message.id === target.afterMessageId,
          ) ?? -1)
    if (context && (target.afterMessageId === null || anchorIndex >= 0)) {
      const appendedNodeId = firstDefined(context.rawLogicalNodeIds.slice(anchorIndex + 1))
      if (appendedNodeId) addTarget(graph, appendedNodeId)
    }
    addTarget(graph, endpointId)
  }

  const graphs: ConversationGraph[] = []
  for (const graph of rawGraphs) {
    if (removedGraphs.has(graph)) continue

    const removedNodeIds = new Set<string>()
    for (const targetNodeId of targetNodeIdsByGraph.get(graph) ?? []) {
      collectDescendantNodeIds(graph, targetNodeId, removedNodeIds)
    }
    for (const nodeId of removedNodeIds) graph.nodes.delete(nodeId)
    for (const node of graph.nodes.values()) {
      node.childIds = node.childIds.filter((childId) => graph.nodes.has(childId))
    }
    for (const [sessionId, endpointId] of graph.endpointBySessionId) {
      if (!graph.nodes.has(endpointId)) graph.endpointBySessionId.delete(sessionId)
    }
    graph.sessionIds = new Set(graph.endpointBySessionId.keys())

    const origin = graph.nodes.get(graph.originNodeId)
    graph.rootNodeId = origin?.kind === "origin" ? (origin.childIds[0] ?? "") : ""
    if (graph.nodes.size > 1) {
      numberEmptyForkEndpoints(graph)
      graphs.push(graph)
    }
  }

  const graphBySessionId = new Map<string, ConversationGraph>()
  const graphByRootSessionId = new Map<string, ConversationGraph>()
  for (const graph of graphs) {
    graphByRootSessionId.set(graph.rootSessionId, graph)
    for (const sessionId of graph.sessionIds) graphBySessionId.set(sessionId, graph)
  }

  return {
    graphs,
    graphBySessionId,
    graphByRootSessionId,
    warnings: graphs.flatMap((graph) => graph.warnings),
  }
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true
  }
  return false
}

function collectDescendantNodeIds(
  graph: ConversationGraph,
  nodeId: string,
  removedNodeIds: Set<string>,
): void {
  const pending = [nodeId]
  while (pending.length > 0) {
    const currentNodeId = pending.pop()!
    if (currentNodeId === graph.originNodeId || removedNodeIds.has(currentNodeId)) continue
    const node = graph.nodes.get(currentNodeId)
    if (!node) continue

    removedNodeIds.add(currentNodeId)
    pending.push(...node.childIds)
  }
}

export function visibleConversationForest(
  forest: ConversationForest,
  runningSessionIds: ReadonlySet<string>,
): ConversationForest {
  const graphs = forest.graphs.filter(
    (graph) =>
      [...graph.nodes.values()].some((node) => node.kind === "message" && !node.internal) ||
      [...graph.sessionIds].some((sessionId) => runningSessionIds.has(sessionId)),
  )
  const visibleGraphs = new Set(graphs)
  return {
    graphs,
    graphBySessionId: new Map(
      [...forest.graphBySessionId].filter(([, graph]) => visibleGraphs.has(graph)),
    ),
    graphByRootSessionId: new Map(
      [...forest.graphByRootSessionId].filter(([, graph]) => visibleGraphs.has(graph)),
    ),
    warnings: graphs.flatMap((graph) => graph.warnings),
  }
}

export function reachableSessionEndpoints(
  graph: ConversationGraph,
  nodeId: string,
): ReachableSessionEndpoint[] {
  const selected = graph.nodes.get(nodeId)
  if (!selected || selected.kind === "origin") return []

  const endpoints: ReachableSessionEndpoint[] = []
  const queue = [{ nodeId, distance: 0 }]
  const visited = new Set<string>()
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!
    if (visited.has(current.nodeId)) continue
    visited.add(current.nodeId)

    const node = graph.nodes.get(current.nodeId)
    if (!node || node.kind === "origin") continue
    if (node.kind === "endpoint") {
      endpoints.push({ endpoint: node, distance: current.distance })
      continue
    }
    for (const childId of node.childIds) {
      queue.push({ nodeId: childId, distance: current.distance + 1 })
    }
  }

  return endpoints.sort(
    (left, right) =>
      left.distance - right.distance ||
      right.endpoint.session.lastModified - left.endpoint.session.lastModified ||
      left.endpoint.session.id.localeCompare(right.endpoint.session.id),
  )
}

const sessionContextByGraph = new WeakMap<ConversationGraph, Map<string, SessionGraphContext>>()

function appendRootSession(
  graph: ConversationGraph,
  session: AgentSession,
  transcript: AgentMessage[],
  exactBranchPointIdsBySession: Map<string, Set<string>>,
  displayGroupEndIdsBySession: Map<string, Set<string>>,
): SessionGraphContext {
  const context = createContext(transcript)
  appendSessionMessages(
    graph,
    session.id,
    transcript,
    0,
    graph.originNodeId,
    exactBranchPointIdsBySession.get(session.id) ?? new Set(),
    displayGroupEndIdsBySession.get(session.id) ?? new Set(),
    context,
  )
  const finalMessageNodeId = lastDefined(context.rawLogicalNodeIds)
  const endpointId = appendEndpoint(
    graph,
    session,
    finalMessageNodeId ?? graph.originNodeId,
    forkTargetForLastMessage(session.id, transcript),
  )
  graph.rootNodeId = firstDefined(context.rawLogicalNodeIds) ?? endpointId
  contextFor(graph).set(session.id, context)
  return context
}

function attachChildSession(
  graph: ConversationGraph,
  child: AgentSession,
  relation: BranchRelation,
  parentContext: SessionGraphContext,
  transcripts: Map<string, AgentMessage[]>,
  exactBranchPointIdsBySession: Map<string, Set<string>>,
  displayGroupEndIdsBySession: Map<string, Set<string>>,
): string | null {
  const sourceIndex = parentContext.transcript.findIndex(
    (message) => message.id === relation.sourceMessageId,
  )
  const sourceNodeId = parentContext.nodeIdByMessageId.get(relation.sourceMessageId)
  if (sourceIndex < 0 || !sourceNodeId) {
    return `Cannot attach ${child.id}: source message ${relation.sourceMessageId} is unavailable`
  }

  const sharedPrefixLength = relation.sharedMessages.length
  const transcript = transcripts.get(child.id) ?? []
  if (sharedPrefixLength === 0) {
    const context = createContext(transcript)
    appendSessionMessages(
      graph,
      child.id,
      transcript,
      0,
      graph.originNodeId,
      exactBranchPointIdsBySession.get(child.id) ?? new Set(),
      displayGroupEndIdsBySession.get(child.id) ?? new Set(),
      context,
    )
    const finalMessageNodeId = lastDefined(context.rawLogicalNodeIds)
    appendEndpoint(
      graph,
      child,
      finalMessageNodeId ?? graph.originNodeId,
      forkTargetForLastMessage(child.id, transcript),
      { sourceNodeId, createdAt: relation.createdAt, empty: finalMessageNodeId === undefined },
    )
    contextFor(graph).set(child.id, context)
    return null
  }
  if (sharedPrefixLength !== sourceIndex + 1) {
    return `Cannot attach ${child.id}: shared history does not end at its recorded source message`
  }

  if (transcript.length < sharedPrefixLength) {
    return `Cannot attach ${child.id}: shared history is no longer available`
  }
  for (let index = 0; index < sharedPrefixLength; index += 1) {
    const pair = relation.sharedMessages[index]
    if (
      !pair ||
      parentContext.transcript[index]?.id !== pair.parentMessageId ||
      transcript[index]?.id !== pair.childMessageId
    ) {
      return `Cannot attach ${child.id}: shared history does not match its transcripts`
    }
  }

  const context = createContext(transcript)
  for (let index = 0; index < sharedPrefixLength; index += 1) {
    const logicalNodeId = parentContext.rawLogicalNodeIds[index]
    const childMessage = transcript[index]
    if (!logicalNodeId || !childMessage) continue
    context.rawLogicalNodeIds[index] = logicalNodeId
    context.nodeIdByMessageId.set(childMessage.id, logicalNodeId)
    const logicalNode = graph.nodes.get(logicalNodeId)
    if (logicalNode?.kind === "message") {
      addAlias(logicalNode, { sessionId: child.id, messageId: childMessage.id })
    }
  }

  appendSessionMessages(
    graph,
    child.id,
    transcript,
    sharedPrefixLength,
    sourceNodeId,
    exactBranchPointIdsBySession.get(child.id) ?? new Set(),
    displayGroupEndIdsBySession.get(child.id) ?? new Set(),
    context,
  )
  const appendedMessageNodeId = lastDefined(context.rawLogicalNodeIds, sharedPrefixLength)
  const finalMessageNodeId = appendedMessageNodeId ?? sourceNodeId
  appendEndpoint(
    graph,
    child,
    finalMessageNodeId,
    forkTargetForLastMessage(child.id, transcript),
    { sourceNodeId, createdAt: relation.createdAt, empty: appendedMessageNodeId === undefined },
  )
  contextFor(graph).set(child.id, context)
  return null
}

function appendSessionMessages(
  graph: ConversationGraph,
  sessionId: string,
  transcript: AgentMessage[],
  startIndex: number,
  initialParentId: string | null,
  exactBranchPoints: Set<string>,
  displayGroupEndPoints: Set<string>,
  context: SessionGraphContext,
): void {
  let parentId = initialParentId
  let openDisplayGroup: { id: string; nodeId: string } | undefined
  for (let index = startIndex; index < transcript.length; index += 1) {
    const message = transcript[index]
    if (!message) continue
    if (!message.visible && !exactBranchPoints.has(message.id)) {
      if (displayGroupEndPoints.has(message.id)) openDisplayGroup = undefined
      continue
    }

    const alias = { sessionId, messageId: message.id }
    const preview = message.visible ? message.preview : "[internal branch point]"
    const groupedNode =
      message.displayGroupId !== undefined && openDisplayGroup?.id === message.displayGroupId
        ? graph.nodes.get(openDisplayGroup.nodeId)
        : undefined
    if (groupedNode?.kind === "message") {
      groupedNode.preview = `${groupedNode.preview} ${preview}`
      groupedNode.internal = groupedNode.internal && !message.visible
      addAlias(groupedNode, alias)
      groupedNode.forkTarget = alias
      context.rawLogicalNodeIds[index] = groupedNode.id
      context.nodeIdByMessageId.set(message.id, groupedNode.id)
      if (displayGroupEndPoints.has(message.id)) openDisplayGroup = undefined
      continue
    }

    const nodeId = `message:${encodeURIComponent(sessionId)}:${encodeURIComponent(message.id)}`
    const node: MessageGraphNode = {
      id: nodeId,
      kind: "message",
      parentId,
      childIds: [],
      role: message.role,
      preview,
      internal: !message.visible,
      aliases: [alias],
      forkTarget: alias,
    }
    graph.nodes.set(nodeId, node)
    if (parentId) graph.nodes.get(parentId)?.childIds.push(nodeId)
    context.rawLogicalNodeIds[index] = nodeId
    context.nodeIdByMessageId.set(message.id, nodeId)
    parentId = nodeId
    openDisplayGroup = message.displayGroupId === undefined
      ? undefined
      : { id: message.displayGroupId, nodeId }
    if (displayGroupEndPoints.has(message.id)) openDisplayGroup = undefined
  }
}

function appendEndpoint(
  graph: ConversationGraph,
  session: AgentSession,
  parentId: string | null,
  forkTarget?: ForkTarget,
  fork?: SessionEndpointNode["fork"],
): string {
  const endpointId = `endpoint:${encodeURIComponent(session.id)}`
  graph.nodes.set(endpointId, {
    id: endpointId,
    kind: "endpoint",
    parentId,
    childIds: [],
    session,
    ...(forkTarget === undefined ? {} : { forkTarget }),
    ...(fork === undefined ? {} : { fork }),
  })
  if (parentId) graph.nodes.get(parentId)?.childIds.push(endpointId)
  graph.endpointBySessionId.set(session.id, endpointId)
  return endpointId
}

function numberEmptyForkEndpoints(graph: ConversationGraph): void {
  const endpointsBySource = new Map<string, SessionEndpointNode[]>()
  for (const node of graph.nodes.values()) {
    if (
      node.kind !== "endpoint" ||
      !node.fork?.empty
    ) {
      continue
    }

    const endpoints = endpointsBySource.get(node.fork.sourceNodeId) ?? []
    endpoints.push(node)
    endpointsBySource.set(node.fork.sourceNodeId, endpoints)
  }

  for (const endpoints of endpointsBySource.values()) {
    endpoints.sort(
      (left, right) =>
        left.fork!.createdAt.localeCompare(right.fork!.createdAt) ||
        left.session.id.localeCompare(right.session.id),
    )
    if (endpoints.length === 1) continue
    for (let index = 0; index < endpoints.length; index += 1) {
      endpoints[index]!.fork!.number = index + 1
    }
  }
}

export function resolveForkTarget(
  graph: ConversationGraph,
  nodeId: string,
): ForkTarget | undefined {
  const node = graph.nodes.get(nodeId)
  if (!node) return undefined
  if (node.kind === "origin") return undefined
  if (node.kind === "message") return node.forkTarget
  return node.forkTarget
}

function createContext(transcript: AgentMessage[]): SessionGraphContext {
  return {
    transcript,
    rawLogicalNodeIds: new Array<string | undefined>(transcript.length),
    nodeIdByMessageId: new Map(),
  }
}

function contextFor(graph: ConversationGraph): Map<string, SessionGraphContext> {
  let contexts = sessionContextByGraph.get(graph)
  if (!contexts) {
    contexts = new Map()
    sessionContextByGraph.set(graph, contexts)
  }
  return contexts
}

function groupRelationsByParent(relations: BranchRelation[]): Map<string, BranchRelation[]> {
  const grouped = new Map<string, BranchRelation[]>()
  for (const relation of [...relations].sort(compareRelations)) {
    const children = grouped.get(relation.parentSessionId) ?? []
    children.push(relation)
    grouped.set(relation.parentSessionId, children)
  }
  return grouped
}

function compareRelations(left: BranchRelation, right: BranchRelation): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.childSessionId.localeCompare(right.childSessionId)
  )
}

function collectExactBranchPointIds(relations: BranchRelation[]): Map<string, Set<string>> {
  const idsBySession = new Map<string, Set<string>>()
  for (const relation of relations) {
    const ids = idsBySession.get(relation.parentSessionId) ?? new Set()
    ids.add(relation.sourceMessageId)
    idsBySession.set(relation.parentSessionId, ids)
  }

  propagateSharedMessageIds(idsBySession, relations)
  return idsBySession
}

function collectDisplayGroupEndIds(
  relations: BranchRelation[],
  removals: ConversationRemoval[],
): Map<string, Set<string>> {
  const idsBySession = collectExactBranchPointIds(relations)
  for (const removal of removals) {
    if (removal.kind !== "subtree" || removal.target.kind !== "endpoint") continue
    if (removal.target.afterMessageId === null) continue
    const ids = idsBySession.get(removal.target.sessionId) ?? new Set()
    ids.add(removal.target.afterMessageId)
    idsBySession.set(removal.target.sessionId, ids)
  }
  propagateSharedMessageIds(idsBySession, relations)
  return idsBySession
}

function propagateSharedMessageIds(
  idsBySession: Map<string, Set<string>>,
  relations: BranchRelation[],
): void {
  let changed = true
  while (changed) {
    changed = false
    for (const relation of relations) {
      const childIds = idsBySession.get(relation.childSessionId)
      if (!childIds) continue
      const parentIds = idsBySession.get(relation.parentSessionId) ?? new Set()
      for (const sharedMessage of relation.sharedMessages) {
        if (!childIds.has(sharedMessage.childMessageId) || parentIds.has(sharedMessage.parentMessageId)) {
          continue
        }
        parentIds.add(sharedMessage.parentMessageId)
        changed = true
      }
      if (parentIds.size > 0) idsBySession.set(relation.parentSessionId, parentIds)
    }
  }
}

function addAlias(node: MessageGraphNode, alias: ForkTarget): void {
  if (
    node.aliases.some(
      (existing) =>
        existing.sessionId === alias.sessionId && existing.messageId === alias.messageId,
    )
  ) {
    return
  }
  node.aliases.push(alias)
}

function forkTargetForLastMessage(
  sessionId: string,
  transcript: AgentMessage[],
): ForkTarget | undefined {
  const message = transcript[transcript.length - 1]
  return message ? { sessionId, messageId: message.id } : undefined
}

function firstDefined(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined)
}

function lastDefined(
  values: Array<string | undefined>,
  startIndex = 0,
): string | undefined {
  for (let index = values.length - 1; index >= startIndex; index -= 1) {
    if (values[index]) return values[index]
  }
  return undefined
}

function compareSessions(left: AgentSession, right: AgentSession): number {
  return right.lastModified - left.lastModified || left.id.localeCompare(right.id)
}
