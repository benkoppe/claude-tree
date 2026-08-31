import type { AgentMessage, AgentSession, MessageRef } from "./agent-provider"
import type { BranchRelation } from "./metadata"

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
}

export interface SessionEndpointNode extends GraphNodeBase {
  kind: "endpoint"
  session: AgentSession
  forkTarget?: ForkTarget
}

export type MessageGraphNodeOrEndpoint = MessageGraphNode | SessionEndpointNode
export type ConversationGraphNode = FamilyOriginNode | MessageGraphNodeOrEndpoint

export interface ConversationGraph {
  rootSessionId: string
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
  warnings: string[]
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
): ConversationForest {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]))
  const relationsByParent = groupRelationsByParent(relations)
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
        const error = attachChildSession(graph, child, relation, parentContext, transcripts, relationsByParent)
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
      relationsByParent,
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

  return { graphs, graphBySessionId, warnings }
}

const sessionContextByGraph = new WeakMap<ConversationGraph, Map<string, SessionGraphContext>>()

function appendRootSession(
  graph: ConversationGraph,
  session: AgentSession,
  transcript: AgentMessage[],
  relationsByParent: Map<string, BranchRelation[]>,
): SessionGraphContext {
  const context = createContext(transcript)
  appendSessionMessages(
    graph,
    session.id,
    transcript,
    0,
    graph.originNodeId,
    sourceMessageIds(relationsByParent.get(session.id)),
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
  relationsByParent: Map<string, BranchRelation[]>,
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
      sourceMessageIds(relationsByParent.get(child.id)),
      context,
    )
    const finalMessageNodeId = lastDefined(context.rawLogicalNodeIds)
    appendEndpoint(
      graph,
      child,
      finalMessageNodeId ?? graph.originNodeId,
      forkTargetForLastMessage(child.id, transcript),
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
    sourceMessageIds(relationsByParent.get(child.id)),
    context,
  )
  const finalMessageNodeId = lastDefined(context.rawLogicalNodeIds, sharedPrefixLength) ?? sourceNodeId
  appendEndpoint(
    graph,
    child,
    finalMessageNodeId,
    forkTargetForLastMessage(child.id, transcript),
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
  context: SessionGraphContext,
): void {
  let parentId = initialParentId
  for (let index = startIndex; index < transcript.length; index += 1) {
    const message = transcript[index]
    if (!message || (!message.visible && !exactBranchPoints.has(message.id))) continue

    const nodeId = `message:${encodeURIComponent(sessionId)}:${encodeURIComponent(message.id)}`
    const node: MessageGraphNode = {
      id: nodeId,
      kind: "message",
      parentId,
      childIds: [],
      role: message.role,
      preview: message.visible ? message.preview : "[internal branch point]",
      internal: !message.visible,
      aliases: [{ sessionId, messageId: message.id }],
    }
    graph.nodes.set(nodeId, node)
    if (parentId) graph.nodes.get(parentId)?.childIds.push(nodeId)
    context.rawLogicalNodeIds[index] = nodeId
    context.nodeIdByMessageId.set(message.id, nodeId)
    parentId = nodeId
  }
}

function appendEndpoint(
  graph: ConversationGraph,
  session: AgentSession,
  parentId: string | null,
  forkTarget?: ForkTarget,
): string {
  const endpointId = `endpoint:${encodeURIComponent(session.id)}`
  graph.nodes.set(endpointId, {
    id: endpointId,
    kind: "endpoint",
    parentId,
    childIds: [],
    session,
    ...(forkTarget === undefined ? {} : { forkTarget }),
  })
  if (parentId) graph.nodes.get(parentId)?.childIds.push(endpointId)
  graph.endpointBySessionId.set(session.id, endpointId)
  return endpointId
}

export function resolveForkTarget(
  graph: ConversationGraph,
  nodeId: string,
): ForkTarget | undefined {
  const node = graph.nodes.get(nodeId)
  if (!node) return undefined
  if (node.kind === "origin") return undefined
  if (node.kind === "message") return node.aliases[0]
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

function sourceMessageIds(relations: BranchRelation[] | undefined): Set<string> {
  return new Set((relations ?? []).map((relation) => relation.sourceMessageId))
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
