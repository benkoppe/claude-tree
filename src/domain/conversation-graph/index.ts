import type { AgentMessage, AgentSession, MessageRef } from "../model"
import type { BranchRelation, ConversationRemoval } from "../persistence"

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
  transcript: readonly AgentMessage[]
  rawLogicalNodeIds: Array<string | undefined>
  nodeIdByMessageId: Map<string, string>
  knownMessageIds: Set<string>
}

type RetainedMessage = AgentMessage | null

const sessionContextByGraph = new WeakMap<
  ConversationGraph,
  Map<string, SessionGraphContext>
>()

export function buildConversationForest(
  sessions: readonly AgentSession[],
  transcripts: ReadonlyMap<string, readonly AgentMessage[]>,
  relations: readonly BranchRelation[],
  removals: readonly ConversationRemoval[] = [],
): ConversationForest {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]))
  const relationsByParent = groupRelationsByParent(relations)
  const retainedMessagesBySession = collectRetainedMessages(transcripts, relations)
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

  const buildRoot = (rootSession: AgentSession): void => {
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

    interface RelationFrame {
      parentSessionId: string
      relations: readonly BranchRelation[]
      nextIndex: number
    }
    const traversal: RelationFrame[] = [{
      parentSessionId: rootSession.id,
      relations: relationsByParent.get(rootSession.id) ?? [],
      nextIndex: 0,
    }]
    while (traversal.length > 0) {
      const frame = traversal[traversal.length - 1]!
      const relation = frame.relations[frame.nextIndex]
      if (!relation) {
        traversal.pop()
        continue
      }
      frame.nextIndex += 1

      const parentContext = contexts.get(frame.parentSessionId)
      const child = sessionsById.get(relation.childSessionId)
      if (!parentContext || !child || processedSessions.has(child.id)) continue

      const error = attachChildSession(
        graph,
        child,
        relation,
        parentContext,
        transcripts,
        retainedMessagesBySession,
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
      if (!childContext) continue
      contexts.set(child.id, childContext)
      traversal.push({
        parentSessionId: child.id,
        relations: relationsByParent.get(child.id) ?? [],
        nextIndex: 0,
      })
    }
    graphs.push(graph)
  }

  for (const root of roots) buildRoot(root)
  for (const session of [...sessions].sort(compareSessions)) buildRoot(session)

  repairForkTargets(graphs, transcripts)
  return applyConversationRemovals(graphs, graphBySessionId, removals)
}

function repairForkTargets(
  graphs: readonly ConversationGraph[],
  transcripts: ReadonlyMap<string, readonly AgentMessage[]>,
): void {
  const currentMessageIds = new Map(
    [...transcripts].map(([sessionId, transcript]) => [
      sessionId,
      new Set(transcript.map((message) => message.id)),
    ]),
  )
  for (const graph of graphs) {
    for (const node of graph.nodes.values()) {
      if (node.kind !== "message") continue
      if (
        node.forkTarget &&
        currentMessageIds.get(node.forkTarget.sessionId)?.has(node.forkTarget.messageId)
      ) {
        continue
      }
      const target = [...node.aliases].reverse().find((alias) =>
        currentMessageIds.get(alias.sessionId)?.has(alias.messageId)
      )
      if (target) node.forkTarget = target
      else delete node.forkTarget
    }
  }
}

interface IndexedMessageNode {
  graph: ConversationGraph
  nodeId: string
}

function applyConversationRemovals(
  rawGraphs: readonly ConversationGraph[],
  rawGraphBySessionId: ReadonlyMap<string, ConversationGraph>,
  removals: readonly ConversationRemoval[],
): ConversationForest {
  const messageNodesBySessionId = new Map<
    string,
    Map<string, IndexedMessageNode[]>
  >()
  const forkEndpointsBySourceNodeId = new Map<string, IndexedMessageNode[]>()
  for (const graph of rawGraphs) {
    for (const node of graph.nodes.values()) {
      if (node.kind === "message") {
        for (const alias of node.aliases) {
          const nodesByMessageId = messageNodesBySessionId.get(alias.sessionId) ?? new Map()
          const matches = nodesByMessageId.get(alias.messageId) ?? []
          matches.push({ graph, nodeId: node.id })
          nodesByMessageId.set(alias.messageId, matches)
          messageNodesBySessionId.set(alias.sessionId, nodesByMessageId)
        }
      } else if (
        node.kind === "endpoint" &&
        node.fork &&
        !isAncestorNode(graph, node.fork.sourceNodeId, node.id)
      ) {
        const matches = forkEndpointsBySourceNodeId.get(node.fork.sourceNodeId) ?? []
        matches.push({ graph, nodeId: node.id })
        forkEndpointsBySourceNodeId.set(node.fork.sourceNodeId, matches)
      }
    }
  }

  const removedGraphs = new Set<ConversationGraph>()
  const targetNodeIdsByGraph = new Map<ConversationGraph, Set<string>>()
  const addTarget = (graph: ConversationGraph, nodeId: string): void => {
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
        const sourceNodeId = messageNodeId(alias.sessionId, alias.messageId)
        for (const match of forkEndpointsBySourceNodeId.get(sourceNodeId) ?? []) {
          addTarget(match.graph, detachedPathRootNodeId(match.graph, match.nodeId))
        }
      }
      continue
    }

    const target = removal.target
    const graph = rawGraphBySessionId.get(target.sessionId)
    const endpointId = graph?.endpointBySessionId.get(target.sessionId)
    if (!graph || !endpointId) continue

    const context = sessionContextByGraph.get(graph)?.get(target.sessionId)
    const anchorIndex = target.afterMessageId === null
      ? -1
      : (context?.transcript.findIndex((message) => message.id === target.afterMessageId) ?? -1)
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

function detachedPathRootNodeId(graph: ConversationGraph, endpointId: string): string {
  let nodeId = endpointId
  let node = graph.nodes.get(nodeId)
  while (node?.parentId && node.parentId !== graph.originNodeId) {
    nodeId = node.parentId
    node = graph.nodes.get(nodeId)
  }
  return nodeId
}

function isAncestorNode(graph: ConversationGraph, ancestorNodeId: string, nodeId: string): boolean {
  const visited = new Set<string>()
  let currentNodeId: string | null = nodeId
  while (currentNodeId && !visited.has(currentNodeId)) {
    if (currentNodeId === ancestorNodeId) return true
    visited.add(currentNodeId)
    currentNodeId = graph.nodes.get(currentNodeId)?.parentId ?? null
  }
  return false
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
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

function appendRootSession(
  graph: ConversationGraph,
  session: AgentSession,
  transcript: readonly AgentMessage[],
  exactBranchPointIdsBySession: ReadonlyMap<string, ReadonlySet<string>>,
  displayGroupEndIdsBySession: ReadonlyMap<string, ReadonlySet<string>>,
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
  transcripts: ReadonlyMap<string, readonly AgentMessage[]>,
  retainedMessagesBySession: ReadonlyMap<string, ReadonlyMap<string, RetainedMessage>>,
  exactBranchPointIdsBySession: ReadonlyMap<string, ReadonlySet<string>>,
  displayGroupEndIdsBySession: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  const sourceIndex = parentContext.transcript.findIndex(
    (message) => message.id === relation.sourceMessageId,
  )
  const sharedPrefixLength = relation.sharedMessages.length
  const transcript = transcripts.get(child.id) ?? []
  if (sharedPrefixLength === 0) {
    const sourceNodeId = parentContext.nodeIdByMessageId.get(relation.sourceMessageId)
    if (sourceIndex < 0 || !sourceNodeId) {
      return `Cannot attach ${child.id}: source message ${relation.sourceMessageId} is unavailable`
    }
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

  if (relation.sharedMessages.at(-1)?.parentMessageId !== relation.sourceMessageId) {
    return `Cannot attach ${child.id}: shared history does not end at its recorded source message`
  }
  const retainedChildMessages = retainedMessagesBySession.get(child.id) ?? new Map()
  const retainedParentMessages = retainedMessagesBySession.get(relation.parentSessionId) ?? new Map()
  const sharedHistoryCompletelyUnavailable = relation.sharedMessages.every(
    (pair) =>
      !retainedChildMessages.has(pair.childMessageId) &&
      !retainedParentMessages.has(pair.parentMessageId),
  )
  if (sharedHistoryCompletelyUnavailable) {
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
      {
        sourceNodeId: messageNodeId(relation.parentSessionId, relation.sourceMessageId),
        createdAt: relation.createdAt,
        empty: finalMessageNodeId === undefined,
      },
    )
    contextFor(graph).set(child.id, context)
    return null
  }

  const sharedChildMessages: AgentMessage[] = []
  const childIdByParentId = new Map(
    relation.sharedMessages.map((pair) => [pair.parentMessageId, pair.childMessageId]),
  )
  const sharedParentIds = new Set(relation.sharedMessages.map((pair) => pair.parentMessageId))
  const sharedChildIds = new Set(relation.sharedMessages.map((pair) => pair.childMessageId))
  const sharedChildIndexById = new Map(
    relation.sharedMessages.map((pair, index) => [pair.childMessageId, index]),
  )
  const preferParentMessages =
    parentContext.transcript.filter((message) => sharedParentIds.has(message.id)).length >=
    transcript.filter((message) => sharedChildIds.has(message.id)).length
  for (let index = 0; index < relation.sharedMessages.length; index += 1) {
    const pair = relation.sharedMessages[index]!
    const retainedChildMessage = retainedChildMessages.get(pair.childMessageId)
    const retainedParentMessage = retainedParentMessages.get(pair.parentMessageId)
    if (retainedChildMessage === null || retainedParentMessage === null) {
      return `Cannot attach ${child.id}: retained shared history is contradictory`
    }
    if (
      retainedChildMessage !== undefined &&
      retainedParentMessage !== undefined &&
      !sameCopiedMessage(retainedChildMessage, retainedParentMessage)
    ) {
      return `Cannot attach ${child.id}: retained shared history is contradictory`
    }
    const copiedParentMessage = retainedParentMessage === undefined
      ? undefined
      : copyRetainedMessage(retainedParentMessage, pair.childMessageId, childIdByParentId)
    const retainedMessage = selectRetainedMessage(
      copiedParentMessage,
      retainedChildMessage,
      index,
      sharedChildIndexById,
      preferParentMessages,
    )
    if (retainedMessage === undefined) {
      return transcript[index] === undefined
        ? `Cannot attach ${child.id}: shared history is no longer available`
        : `Cannot attach ${child.id}: shared history does not match its transcripts`
    }
    sharedChildMessages.push(retainedMessage)
  }

  const sharedIndexByParentMessageId = new Map(
    relation.sharedMessages.map((pair, index) => [pair.parentMessageId, index]),
  )
  let previousParentSharedIndex = -1
  let parentDiverged = false
  for (const message of parentContext.transcript) {
    const sharedIndex = sharedIndexByParentMessageId.get(message.id)
    if (sharedIndex === undefined) {
      parentDiverged = true
      continue
    }
    if (parentDiverged || sharedIndex <= previousParentSharedIndex) {
      return `Cannot attach ${child.id}: shared history does not match its transcripts`
    }
    previousParentSharedIndex = sharedIndex
  }

  const sharedIndexByChildMessageId = new Map(
    relation.sharedMessages.map((pair, index) => [pair.childMessageId, index]),
  )
  const currentSharedIndexesByTranscriptIndex = new Map<number, number>()
  let childSpecificStartIndex = transcript.length
  let previousSharedIndex = -1
  for (let transcriptIndex = 0; transcriptIndex < transcript.length; transcriptIndex += 1) {
    const message = transcript[transcriptIndex]!
    const sharedIndex = sharedIndexByChildMessageId.get(message.id)
    if (sharedIndex === undefined) {
      childSpecificStartIndex = Math.min(childSpecificStartIndex, transcriptIndex)
      continue
    }
    if (childSpecificStartIndex < transcript.length || sharedIndex <= previousSharedIndex) {
      return `Cannot attach ${child.id}: shared history does not match its recorded order`
    }
    currentSharedIndexesByTranscriptIndex.set(transcriptIndex, sharedIndex)
    previousSharedIndex = sharedIndex
  }

  const reconciledGraph = cloneGraphForReconciliation(graph)
  const reconciledParentContext: SessionGraphContext = {
    ...parentContext,
    nodeIdByMessageId: new Map(parentContext.nodeIdByMessageId),
    knownMessageIds: new Set(parentContext.knownMessageIds),
  }
  const reconciliationError = reconcileSharedPath(
    reconciledGraph,
    relation,
    child.id,
    sharedChildMessages,
    reconciledParentContext,
    retainedMessagesBySession,
    exactBranchPointIdsBySession.get(child.id) ?? new Set(),
    displayGroupEndIdsBySession.get(child.id) ?? new Set(),
  )
  if (reconciliationError) return `Cannot attach ${child.id}: ${reconciliationError}`
  graph.nodes = reconciledGraph.nodes
  graph.rootNodeId = reconciledGraph.rootNodeId
  parentContext.nodeIdByMessageId = reconciledParentContext.nodeIdByMessageId
  parentContext.knownMessageIds = reconciledParentContext.knownMessageIds

  const sourceNodeId = parentContext.nodeIdByMessageId.get(relation.sourceMessageId)
  if (!sourceNodeId) {
    return `Cannot attach ${child.id}: source message ${relation.sourceMessageId} is unavailable`
  }

  const context = createContext(transcript)
  for (const pair of relation.sharedMessages) {
    const logicalNodeId = parentContext.nodeIdByMessageId.get(pair.parentMessageId)
    if (!logicalNodeId) continue
    context.knownMessageIds.add(pair.childMessageId)
    context.nodeIdByMessageId.set(pair.childMessageId, logicalNodeId)
  }
  for (const [transcriptIndex, sharedIndex] of currentSharedIndexesByTranscriptIndex) {
    const pair = relation.sharedMessages[sharedIndex]!
    const logicalNodeId = parentContext.nodeIdByMessageId.get(pair.parentMessageId)
    const childMessage = transcript[transcriptIndex]
    if (!logicalNodeId || !childMessage) continue
    context.rawLogicalNodeIds[transcriptIndex] = logicalNodeId
    context.nodeIdByMessageId.set(childMessage.id, logicalNodeId)
  }
  const continuationParentId = childSpecificStartIndex < transcript.length
    ? lastDefined(context.rawLogicalNodeIds) ?? graph.originNodeId
    : sourceNodeId
  appendSessionMessages(
    graph,
    child.id,
    transcript,
    childSpecificStartIndex,
    continuationParentId,
    exactBranchPointIdsBySession.get(child.id) ?? new Set(),
    displayGroupEndIdsBySession.get(child.id) ?? new Set(),
    context,
  )
  const finalMessageNodeId = childSpecificStartIndex < transcript.length
    ? lastDefined(context.rawLogicalNodeIds) ?? sourceNodeId
    : sourceNodeId
  appendEndpoint(
    graph,
    child,
    finalMessageNodeId,
    forkTargetForLastMessage(child.id, transcript),
    { sourceNodeId, createdAt: relation.createdAt, empty: finalMessageNodeId === sourceNodeId },
  )
  contextFor(graph).set(child.id, context)
  return null
}

interface ProjectedSharedGroup {
  indexes: number[]
  role: AgentMessage["role"]
  preview: string
  internal: boolean
  existingNodeId?: string
  splitFromNodeId?: string
}

function cloneGraphForReconciliation(graph: ConversationGraph): ConversationGraph {
  return {
    ...graph,
    nodes: new Map([...graph.nodes].map(([nodeId, node]) => [
      nodeId,
      node.kind === "message"
        ? { ...node, childIds: [...node.childIds], aliases: [...node.aliases] }
        : { ...node, childIds: [...node.childIds] },
    ])),
  }
}

function reconcileSharedPath(
  graph: ConversationGraph,
  relation: BranchRelation,
  childSessionId: string,
  sharedMessages: readonly AgentMessage[],
  parentContext: SessionGraphContext,
  retainedMessagesBySession: ReadonlyMap<string, ReadonlyMap<string, RetainedMessage>>,
  exactBranchPoints: ReadonlySet<string>,
  displayGroupEndPoints: ReadonlySet<string>,
): string | null {
  const groups = projectSharedPath(sharedMessages, exactBranchPoints, displayGroupEndPoints)
  const claimedExistingNodeIds = new Set<string>()
  for (const group of groups) {
    const existingNodeIds = new Set(
      group.indexes.flatMap((index) => {
        const pair = relation.sharedMessages[index]
        if (!pair) return []
        const nodeId = parentContext.nodeIdByMessageId.get(pair.parentMessageId)
        return nodeId === undefined ? [] : [nodeId]
      }),
    )
    if (existingNodeIds.size > 1) return "shared history has contradictory ancestry"
    const existingNodeId = existingNodeIds.values().next().value
    if (existingNodeId !== undefined) {
      if (claimedExistingNodeIds.has(existingNodeId)) group.splitFromNodeId = existingNodeId
      else {
        group.existingNodeId = existingNodeId
        claimedExistingNodeIds.add(existingNodeId)
      }
    }
  }

  let previousExistingIndex = -1
  let previousExistingNodeId = graph.originNodeId
  for (let index = 0; index < groups.length; index += 1) {
    const nodeId = groups[index]!.existingNodeId
    if (!nodeId) continue
    const node = graph.nodes.get(nodeId)
    if (node?.kind !== "message" || node.role !== groups[index]!.role) {
      return "shared history has contradictory ancestry"
    }
    if (index > previousExistingIndex + 1) {
      if (
        node.parentId !== previousExistingNodeId ||
        !graph.nodes.get(previousExistingNodeId)?.childIds.includes(nodeId)
      ) {
        return "shared history has contradictory ancestry"
      }
    } else if (
      previousExistingIndex >= 0 &&
      !isLogicalAncestor(graph, previousExistingNodeId, nodeId)
    ) {
      return "shared history has contradictory ancestry"
    }
    previousExistingIndex = index
    previousExistingNodeId = nodeId
  }

  for (const group of groups) {
    if (group.existingNodeId) continue
    const lastIndex = group.indexes.at(-1)!
    const pair = relation.sharedMessages[lastIndex]!
    const nodeId = messageNodeId(childSessionId, pair.childMessageId)
    if (graph.nodes.has(nodeId)) return "shared history has contradictory ancestry"
  }

  let validationIndex = 0
  while (validationIndex < groups.length) {
    if (groups[validationIndex]!.existingNodeId) {
      validationIndex += 1
      continue
    }
    const runStart = validationIndex
    while (validationIndex < groups.length && !groups[validationIndex]!.existingNodeId) {
      validationIndex += 1
    }
    const leftNodeId = runStart === 0
      ? graph.originNodeId
      : groups[runStart - 1]!.existingNodeId!
    const splitFromNodeIds = new Set(
      groups
        .slice(runStart, validationIndex)
        .flatMap((group) => group.splitFromNodeId === undefined ? [] : [group.splitFromNodeId]),
    )
    if (
      !graph.nodes.has(leftNodeId) ||
      splitFromNodeIds.size > 1 ||
      (splitFromNodeIds.size === 1 && !splitFromNodeIds.has(leftNodeId))
    ) {
      return "shared history has contradictory ancestry"
    }
  }

  let index = 0
  while (index < groups.length) {
    if (groups[index]!.existingNodeId) {
      index += 1
      continue
    }
    const runStart = index
    while (index < groups.length && !groups[index]!.existingNodeId) index += 1
    const runEnd = index
    const leftNodeId = runStart === 0
      ? graph.originNodeId
      : groups[runStart - 1]!.existingNodeId!
    const rightNodeId = runEnd < groups.length ? groups[runEnd]!.existingNodeId : undefined
    const insertedNodeIds: string[] = []
    let parentId = leftNodeId
    for (let groupIndex = runStart; groupIndex < runEnd; groupIndex += 1) {
      const group = groups[groupIndex]!
      const lastIndex = group.indexes.at(-1)!
      const lastPair = relation.sharedMessages[lastIndex]!
      const nodeId = messageNodeId(childSessionId, lastPair.childMessageId)
      const aliases = group.indexes.flatMap((messageIndex) => {
        const pair = relation.sharedMessages[messageIndex]!
        return [
          { sessionId: childSessionId, messageId: pair.childMessageId },
          { sessionId: relation.parentSessionId, messageId: pair.parentMessageId },
        ]
      })
      graph.nodes.set(nodeId, {
        id: nodeId,
        kind: "message",
        parentId,
        childIds: [],
        role: group.role,
        preview: group.preview,
        internal: group.internal,
        aliases,
        forkTarget: { sessionId: childSessionId, messageId: lastPair.childMessageId },
      })
      if (group.splitFromNodeId) {
        const splitFromNode = graph.nodes.get(group.splitFromNodeId)
        if (splitFromNode?.kind !== "message") return "shared history has contradictory ancestry"
        const splitMessages = group.indexes.map((messageIndex) => sharedMessages[messageIndex]!)
        const movedAliases = splitFromNode.aliases.filter((alias) => {
          const retainedMessage = retainedMessagesBySession
            .get(alias.sessionId)
            ?.get(alias.messageId)
          return retainedMessage != null && splitMessages.some(
            (splitMessage) => sameCopiedMessage(retainedMessage, splitMessage),
          )
        })
        const movedAliasKeys = new Set([
          ...aliases.map(aliasKey),
          ...movedAliases.map(aliasKey),
        ])
        splitFromNode.aliases = splitFromNode.aliases.filter(
          (alias) => !movedAliasKeys.has(aliasKey(alias)),
        )
        const splitNode = graph.nodes.get(nodeId)
        if (splitNode?.kind !== "message") return "shared history has contradictory ancestry"
        for (const alias of movedAliases) addAlias(splitNode, alias)
        if (splitFromNode.forkTarget && movedAliasKeys.has(aliasKey(splitFromNode.forkTarget))) {
          const fallbackTarget = splitFromNode.aliases.at(-1)
          if (fallbackTarget) splitFromNode.forkTarget = fallbackTarget
          else delete splitFromNode.forkTarget
        }
      }
      if (insertedNodeIds.length > 0) graph.nodes.get(parentId)?.childIds.push(nodeId)
      insertedNodeIds.push(nodeId)
      group.existingNodeId = nodeId
      parentId = nodeId
    }

    const leftNode = graph.nodes.get(leftNodeId)!
    const firstInsertedNodeId = insertedNodeIds[0]!
    const splitFromNodeId = groups
      .slice(runStart, runEnd)
      .find((group) => group.splitFromNodeId)?.splitFromNodeId
    if (splitFromNodeId) {
      const movedChildren = [...leftNode.childIds]
      leftNode.childIds = [firstInsertedNodeId]
      const lastInsertedNode = graph.nodes.get(insertedNodeIds.at(-1)!)
      for (const movedChildId of movedChildren) {
        const movedChild = graph.nodes.get(movedChildId)
        if (movedChild) movedChild.parentId = lastInsertedNode!.id
        lastInsertedNode?.childIds.push(movedChildId)
      }
    } else if (rightNodeId) {
      const rightIndex = leftNode.childIds.indexOf(rightNodeId)
      if (rightIndex < 0) throw new Error("Validated shared path edge is unavailable")
      leftNode.childIds[rightIndex] = firstInsertedNodeId
      const rightNode = graph.nodes.get(rightNodeId)
      if (!rightNode) throw new Error("Validated shared path node is unavailable")
      rightNode.parentId = insertedNodeIds.at(-1)!
      graph.nodes.get(insertedNodeIds.at(-1)!)?.childIds.push(rightNodeId)
      if (graph.rootNodeId === rightNodeId) graph.rootNodeId = firstInsertedNodeId
    } else {
      leftNode.childIds.push(firstInsertedNodeId)
    }
  }

  for (const group of groups) {
    const nodeId = group.existingNodeId
    const node = nodeId === undefined ? undefined : graph.nodes.get(nodeId)
    if (node?.kind !== "message") return "shared history has contradictory ancestry"
    node.preview = group.preview
    node.internal = group.internal
    for (const messageIndex of group.indexes) {
      const pair = relation.sharedMessages[messageIndex]!
      parentContext.nodeIdByMessageId.set(pair.parentMessageId, nodeId!)
      addAlias(node, { sessionId: childSessionId, messageId: pair.childMessageId })
      addAlias(node, { sessionId: relation.parentSessionId, messageId: pair.parentMessageId })
    }
  }
  for (const pair of relation.sharedMessages) {
    parentContext.knownMessageIds.add(pair.parentMessageId)
  }
  return null
}

function isLogicalAncestor(
  graph: ConversationGraph,
  ancestorNodeId: string,
  descendantNodeId: string,
): boolean {
  let currentNodeId: string | null = descendantNodeId
  const visited = new Set<string>()
  while (currentNodeId !== null && !visited.has(currentNodeId)) {
    if (currentNodeId === ancestorNodeId) return true
    visited.add(currentNodeId)
    currentNodeId = graph.nodes.get(currentNodeId)?.parentId ?? null
  }
  return false
}

function projectSharedPath(
  messages: readonly AgentMessage[],
  exactBranchPoints: ReadonlySet<string>,
  displayGroupEndPoints: ReadonlySet<string>,
): ProjectedSharedGroup[] {
  const groups: ProjectedSharedGroup[] = []
  let openDisplayGroup: { id: string; group: ProjectedSharedGroup } | undefined
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (!message.visible && !exactBranchPoints.has(message.id)) {
      if (displayGroupEndPoints.has(message.id)) openDisplayGroup = undefined
      continue
    }
    const preview = message.visible ? message.preview : "[internal branch point]"
    if (message.displayGroupId !== undefined && openDisplayGroup?.id === message.displayGroupId) {
      openDisplayGroup.group.indexes.push(index)
      openDisplayGroup.group.preview = `${openDisplayGroup.group.preview} ${preview}`
      openDisplayGroup.group.internal = openDisplayGroup.group.internal && !message.visible
      if (displayGroupEndPoints.has(message.id)) openDisplayGroup = undefined
      continue
    }
    const group: ProjectedSharedGroup = {
      indexes: [index],
      role: message.role,
      preview,
      internal: !message.visible,
    }
    groups.push(group)
    openDisplayGroup = message.displayGroupId === undefined
      ? undefined
      : { id: message.displayGroupId, group }
    if (displayGroupEndPoints.has(message.id)) openDisplayGroup = undefined
  }
  return groups
}

function appendSessionMessages(
  graph: ConversationGraph,
  sessionId: string,
  transcript: readonly AgentMessage[],
  startIndex: number,
  initialParentId: string | null,
  exactBranchPoints: ReadonlySet<string>,
  displayGroupEndPoints: ReadonlySet<string>,
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

    const nodeId = messageNodeId(sessionId, message.id)
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
    if (node.kind !== "endpoint" || !node.fork?.empty) continue
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
  return !node || node.kind === "origin" ? undefined : node.forkTarget
}

function createContext(transcript: readonly AgentMessage[]): SessionGraphContext {
  return {
    transcript,
    rawLogicalNodeIds: new Array<string | undefined>(transcript.length),
    nodeIdByMessageId: new Map(),
    knownMessageIds: new Set(transcript.map((message) => message.id)),
  }
}

function collectRetainedMessages(
  transcripts: ReadonlyMap<string, readonly AgentMessage[]>,
  relations: readonly BranchRelation[],
): Map<string, Map<string, RetainedMessage>> {
  const retained = new Map<string, Map<string, RetainedMessage>>()
  for (const [sessionId, transcript] of transcripts) {
    retained.set(sessionId, new Map(transcript.map((message) => [message.id, message])))
  }

  const sortedRelations = [...relations].sort(compareRelations)
  let changed = true
  while (changed) {
    changed = false
    for (const relation of sortedRelations) {
      const childMessages = retained.get(relation.childSessionId) ?? new Map()
      const parentMessages = retained.get(relation.parentSessionId) ?? new Map()
      retained.set(relation.childSessionId, childMessages)
      retained.set(relation.parentSessionId, parentMessages)
      const childIdByParentId = new Map(
        relation.sharedMessages.map((pair) => [pair.parentMessageId, pair.childMessageId]),
      )
      const parentIdByChildId = new Map(
        relation.sharedMessages.map((pair) => [pair.childMessageId, pair.parentMessageId]),
      )
      for (const pair of relation.sharedMessages) {
        const childMessage = childMessages.get(pair.childMessageId)
        if (childMessage !== undefined || childMessages.has(pair.childMessageId)) {
          const candidate = childMessage == null
            ? null
            : copyRetainedMessage(childMessage, pair.parentMessageId, parentIdByChildId)
          if (mergeRetainedMessage(parentMessages, pair.parentMessageId, candidate)) changed = true
        }

        const parentMessage = parentMessages.get(pair.parentMessageId)
        if (parentMessage !== undefined || parentMessages.has(pair.parentMessageId)) {
          const candidate = parentMessage == null
            ? null
            : copyRetainedMessage(parentMessage, pair.childMessageId, childIdByParentId)
          if (mergeRetainedMessage(childMessages, pair.childMessageId, candidate)) changed = true
        }
      }
    }
  }
  return retained
}

function copyRetainedMessage(
  message: AgentMessage,
  id: string,
  translatedIds: ReadonlyMap<string, string>,
): AgentMessage {
  const { displayGroupId: _displayGroupId, ...copy } = message
  const displayGroupId = message.displayGroupId === undefined
    ? undefined
    : translatedIds.get(message.displayGroupId) ?? message.displayGroupId
  return {
    ...copy,
    id,
    ...(displayGroupId === undefined ? {} : { displayGroupId }),
  }
}

function selectRetainedMessage(
  parentMessage: AgentMessage | undefined,
  childMessage: AgentMessage | undefined,
  messageIndex: number,
  childIndexById: ReadonlyMap<string, number>,
  preferParent: boolean,
): AgentMessage | undefined {
  if (!parentMessage) return childMessage
  if (!childMessage) return parentMessage
  const parentGroupIndex = parentMessage.displayGroupId === undefined
    ? -1
    : childIndexById.get(parentMessage.displayGroupId) ?? -1
  const childGroupIndex = childMessage.displayGroupId === undefined
    ? -1
    : childIndexById.get(childMessage.displayGroupId) ?? -1
  const validParentGroupIndex = parentGroupIndex < messageIndex ? parentGroupIndex : -1
  const validChildGroupIndex = childGroupIndex < messageIndex ? childGroupIndex : -1
  if (validParentGroupIndex !== validChildGroupIndex) {
    return validParentGroupIndex > validChildGroupIndex ? parentMessage : childMessage
  }
  return preferParent ? parentMessage : childMessage
}

function mergeRetainedMessage(
  messages: Map<string, RetainedMessage>,
  messageId: string,
  candidate: RetainedMessage,
): boolean {
  if (!messages.has(messageId)) {
    messages.set(messageId, candidate)
    return true
  }
  const existing = messages.get(messageId) ?? null
  if (existing === null || (candidate !== null && sameCopiedMessage(existing, candidate))) {
    return false
  }
  messages.set(messageId, null)
  return true
}

function sameCopiedMessage(left: AgentMessage, right: AgentMessage): boolean {
  if (left.copyIdentity !== undefined && right.copyIdentity !== undefined) {
    return left.copyIdentity === right.copyIdentity
  }
  return (
    left.role === right.role &&
    left.preview === right.preview &&
    left.visible === right.visible
  )
}

function contextFor(graph: ConversationGraph): Map<string, SessionGraphContext> {
  let contexts = sessionContextByGraph.get(graph)
  if (!contexts) {
    contexts = new Map()
    sessionContextByGraph.set(graph, contexts)
  }
  return contexts
}

function groupRelationsByParent(
  relations: readonly BranchRelation[],
): Map<string, BranchRelation[]> {
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

function collectExactBranchPointIds(
  relations: readonly BranchRelation[],
): Map<string, Set<string>> {
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
  relations: readonly BranchRelation[],
  removals: readonly ConversationRemoval[],
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
  relations: readonly BranchRelation[],
): void {
  let changed = true
  while (changed) {
    changed = false
    for (const relation of relations) {
      const parentIds = idsBySession.get(relation.parentSessionId) ?? new Set()
      const childIds = idsBySession.get(relation.childSessionId) ?? new Set()
      for (const sharedMessage of relation.sharedMessages) {
        if (childIds.has(sharedMessage.childMessageId) && !parentIds.has(sharedMessage.parentMessageId)) {
          parentIds.add(sharedMessage.parentMessageId)
          changed = true
        }
        if (parentIds.has(sharedMessage.parentMessageId) && !childIds.has(sharedMessage.childMessageId)) {
          childIds.add(sharedMessage.childMessageId)
          changed = true
        }
      }
      if (parentIds.size > 0) idsBySession.set(relation.parentSessionId, parentIds)
      if (childIds.size > 0) idsBySession.set(relation.childSessionId, childIds)
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

function aliasKey(alias: ForkTarget): string {
  return JSON.stringify([alias.sessionId, alias.messageId])
}

function messageNodeId(sessionId: string, messageId: string): string {
  return `message:${encodeURIComponent(sessionId)}:${encodeURIComponent(messageId)}`
}

function forkTargetForLastMessage(
  sessionId: string,
  transcript: readonly AgentMessage[],
): ForkTarget | undefined {
  const message = transcript[transcript.length - 1]
  return message ? { sessionId, messageId: message.id } : undefined
}

function firstDefined(values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined)
}

function lastDefined(
  values: readonly (string | undefined)[],
  startIndex = 0,
  endIndex = values.length,
): string | undefined {
  for (let index = endIndex - 1; index >= startIndex; index -= 1) {
    if (values[index]) return values[index]
  }
  return undefined
}

function compareSessions(left: AgentSession, right: AgentSession): number {
  return right.lastModified - left.lastModified || left.id.localeCompare(right.id)
}
