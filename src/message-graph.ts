import type { BranchRelation } from "./metadata"
import type { ConversationMessage, SessionSummary } from "./sessions"

export interface ForkTarget {
  sessionId: string
  messageId: string
}

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
  role: ConversationMessage["role"]
  preview: string
  internal: boolean
  aliases: ForkTarget[]
  prefillText?: string
}

export interface SessionEndpointNode extends GraphNodeBase {
  kind: "endpoint"
  session: SessionSummary
  forkTarget?: ForkTarget
}

export type MessageGraphNodeOrEndpoint = MessageGraphNode | SessionEndpointNode
export type ConversationGraphNode = FamilyOriginNode | MessageGraphNodeOrEndpoint

export type ForkPlan =
  | { kind: "historical"; target: ForkTarget }
  | { kind: "prefilled"; prefillText?: string; target: ForkTarget }
  | { kind: "root-replay"; prefillText?: string; source: ForkTarget }

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
  transcript: ConversationMessage[]
  rawLogicalNodeIds: Array<string | undefined>
  nodeIdByMessageId: Map<string, string>
}

export function buildConversationForest(
  sessions: SessionSummary[],
  transcripts: Map<string, ConversationMessage[]>,
  relations: BranchRelation[],
): ConversationForest {
  const sessionsById = new Map(sessions.map((session) => [session.sessionId, session]))
  const relationsByParent = groupRelationsByParent(relations)
  const recordedChildren = new Set(relations.map((relation) => relation.childSessionId))
  const processedSessions = new Set<string>()
  const graphBySessionId = new Map<string, ConversationGraph>()
  const graphs: ConversationGraph[] = []
  const warnings: string[] = []

  const roots = sessions
    .filter((session) => !recordedChildren.has(session.sessionId))
    .sort(compareSessions)

  const buildRoot = (rootSession: SessionSummary) => {
    if (processedSessions.has(rootSession.sessionId)) return

    const originNodeId = `origin:${rootSession.sessionId}`
    const graph: ConversationGraph = {
      rootSessionId: rootSession.sessionId,
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
        if (!child || processedSessions.has(child.sessionId)) continue
        const error = attachChildSession(graph, child, relation, parentContext, transcripts, relationsByParent)
        if (error) {
          graph.warnings.push(error)
          warnings.push(error)
          continue
        }

        processedSessions.add(child.sessionId)
        graph.sessionIds.add(child.sessionId)
        graphBySessionId.set(child.sessionId, graph)
        const childContext = sessionContextByGraph.get(graph)?.get(child.sessionId)
        if (childContext) contexts.set(child.sessionId, childContext)
        processRelations(child.sessionId)
      }
    }

    const rootContext = appendRootSession(
      graph,
      rootSession,
      transcripts.get(rootSession.sessionId) ?? [],
      relationsByParent,
    )
    contexts.set(rootSession.sessionId, rootContext)
    processedSessions.add(rootSession.sessionId)
    graph.sessionIds.add(rootSession.sessionId)
    graphBySessionId.set(rootSession.sessionId, graph)
    processRelations(rootSession.sessionId)
    graphs.push(graph)
  }

  for (const root of roots) buildRoot(root)
  for (const session of [...sessions].sort(compareSessions)) buildRoot(session)

  return { graphs, graphBySessionId, warnings }
}

const sessionContextByGraph = new WeakMap<ConversationGraph, Map<string, SessionGraphContext>>()

function appendRootSession(
  graph: ConversationGraph,
  session: SessionSummary,
  transcript: ConversationMessage[],
  relationsByParent: Map<string, BranchRelation[]>,
): SessionGraphContext {
  const context = createContext(transcript)
  appendSessionMessages(
    graph,
    session.sessionId,
    transcript,
    0,
    graph.originNodeId,
    sourceMessageIds(relationsByParent.get(session.sessionId)),
    context,
  )
  const finalMessageNodeId = lastDefined(context.rawLogicalNodeIds)
  const endpointId = appendEndpoint(
    graph,
    session,
    finalMessageNodeId ?? graph.originNodeId,
    forkTargetForLastMessage(session.sessionId, transcript),
  )
  graph.rootNodeId = firstDefined(context.rawLogicalNodeIds) ?? endpointId
  contextFor(graph).set(session.sessionId, context)
  return context
}

function attachChildSession(
  graph: ConversationGraph,
  child: SessionSummary,
  relation: BranchRelation,
  parentContext: SessionGraphContext,
  transcripts: Map<string, ConversationMessage[]>,
  relationsByParent: Map<string, BranchRelation[]>,
): string | null {
  const sourceIndex = parentContext.transcript.findIndex(
    (message) => message.id === relation.sourceMessageId,
  )
  const sourceNodeId = parentContext.nodeIdByMessageId.get(relation.sourceMessageId)
  if (sourceIndex < 0 || !sourceNodeId) {
    return `Cannot attach ${child.sessionId}: source message ${relation.sourceMessageId} is unavailable`
  }

  const copiedPrefixLength = relation.copiedPrefixLength ?? sourceIndex + 1
  const transcript = transcripts.get(child.sessionId) ?? []
  if (copiedPrefixLength === 0) {
    const context = createContext(transcript)
    appendSessionMessages(
      graph,
      child.sessionId,
      transcript,
      0,
      graph.originNodeId,
      sourceMessageIds(relationsByParent.get(child.sessionId)),
      context,
    )
    const finalMessageNodeId = lastDefined(context.rawLogicalNodeIds)
    appendEndpoint(
      graph,
      child,
      finalMessageNodeId ?? graph.originNodeId,
      forkTargetForLastMessage(child.sessionId, transcript),
    )
    contextFor(graph).set(child.sessionId, context)
    return null
  }
  if (copiedPrefixLength !== sourceIndex + 1) {
    return `Cannot attach ${child.sessionId}: copied prefix does not end at its recorded source message`
  }

  if (transcript.length < copiedPrefixLength) {
    return `Cannot attach ${child.sessionId}: copied prefix is no longer available`
  }
  if (
    relation.childPrefixEndMessageId &&
    transcript[copiedPrefixLength - 1]?.id !== relation.childPrefixEndMessageId
  ) {
    return `Cannot attach ${child.sessionId}: copied prefix boundary does not match its transcript`
  }

  const context = createContext(transcript)
  for (let index = 0; index < copiedPrefixLength; index += 1) {
    const logicalNodeId = parentContext.rawLogicalNodeIds[index]
    const childMessage = transcript[index]
    if (!logicalNodeId || !childMessage) continue
    context.rawLogicalNodeIds[index] = logicalNodeId
    context.nodeIdByMessageId.set(childMessage.id, logicalNodeId)
    const logicalNode = graph.nodes.get(logicalNodeId)
    if (logicalNode?.kind === "message") {
      addAlias(logicalNode, { sessionId: child.sessionId, messageId: childMessage.id })
    }
  }

  appendSessionMessages(
    graph,
    child.sessionId,
    transcript,
    copiedPrefixLength,
    sourceNodeId,
    sourceMessageIds(relationsByParent.get(child.sessionId)),
    context,
  )
  const finalMessageNodeId = lastDefined(context.rawLogicalNodeIds, copiedPrefixLength) ?? sourceNodeId
  appendEndpoint(
    graph,
    child,
    finalMessageNodeId,
    forkTargetForLastMessage(child.sessionId, transcript),
  )
  contextFor(graph).set(child.sessionId, context)
  return null
}

function appendSessionMessages(
  graph: ConversationGraph,
  sessionId: string,
  transcript: ConversationMessage[],
  startIndex: number,
  initialParentId: string | null,
  exactBranchPoints: Set<string>,
  context: SessionGraphContext,
): void {
  let parentId = initialParentId
  for (let index = startIndex; index < transcript.length; index += 1) {
    const message = transcript[index]
    if (!message || (!message.visible && !exactBranchPoints.has(message.id))) continue

    const nodeId = `message:${sessionId}:${message.id}`
    const node: MessageGraphNode = {
      id: nodeId,
      kind: "message",
      parentId,
      childIds: [],
      role: message.role,
      preview: message.visible ? message.preview : "[internal branch point]",
      internal: !message.visible,
      aliases: [{ sessionId, messageId: message.id }],
      ...(message.prefillText === undefined ? {} : { prefillText: message.prefillText }),
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
  session: SessionSummary,
  parentId: string | null,
  forkTarget?: ForkTarget,
): string {
  const endpointId = `endpoint:${session.sessionId}`
  graph.nodes.set(endpointId, {
    id: endpointId,
    kind: "endpoint",
    parentId,
    childIds: [],
    session,
    ...(forkTarget === undefined ? {} : { forkTarget }),
  })
  if (parentId) graph.nodes.get(parentId)?.childIds.push(endpointId)
  graph.endpointBySessionId.set(session.sessionId, endpointId)
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

export function resolveForkPlan(
  graph: ConversationGraph,
  nodeId: string,
): ForkPlan | undefined {
  const node = graph.nodes.get(nodeId)
  if (!node) return undefined
  if (node.kind === "origin") return undefined
  if (node.kind === "endpoint" || node.role !== "user") {
    const target = resolveForkTarget(graph, nodeId)
    return target ? { kind: "historical", target } : undefined
  }

  const selectedAlias = node.aliases[0]
  if (!selectedAlias) return undefined
  let ancestor = node.parentId ? graph.nodes.get(node.parentId) : undefined
  while (ancestor) {
    if (ancestor.kind === "message" && ancestor.role === "assistant") {
      const target =
        ancestor.aliases.find((alias) => alias.sessionId === selectedAlias?.sessionId) ??
        ancestor.aliases[0]
      if (!target) return undefined
      return {
        kind: "prefilled",
        ...(node.prefillText === undefined ? {} : { prefillText: node.prefillText }),
        target,
      }
    }
    ancestor = ancestor.parentId ? graph.nodes.get(ancestor.parentId) : undefined
  }

  return {
    kind: "root-replay",
    ...(node.prefillText === undefined ? {} : { prefillText: node.prefillText }),
    source: selectedAlias,
  }
}

function createContext(transcript: ConversationMessage[]): SessionGraphContext {
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
  transcript: ConversationMessage[],
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

function compareSessions(left: SessionSummary, right: SessionSummary): number {
  return right.lastModified - left.lastModified || left.sessionId.localeCompare(right.sessionId)
}
