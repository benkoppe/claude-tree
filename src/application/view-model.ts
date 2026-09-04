import type {
  ConversationGraph,
  MessageGraphNode,
  SessionEndpointNode,
} from "../domain/conversation-graph"
import { reachableSessionEndpoints } from "../domain/conversation-graph"
import {
  initialVisibleGraphNodeId,
  layoutConversationGraph,
  visibleGraphNodeId,
} from "../domain/graph-layout"
import type { AgentMessage, AgentSession, MessageRef, NavigationTarget } from "../domain/model"
import {
  selectAggregateStatus,
  selectConversationForest,
  selectProjectedData,
  selectSessionStatus,
  selectVisibleConversationForest,
  selectVisibleEndpointSessionIds,
  type SessionStatus,
} from "./selectors"
import type { ApplicationModal, ApplicationState } from "./state"

export interface RootViewModel {
  readonly sessionId: string
  readonly title: string
  readonly lastModified: number
  readonly memberSessionIds: readonly string[]
  readonly status: SessionStatus
  readonly selected: boolean
}

interface PositionedNodeViewModel {
  readonly id: string
  readonly parentIds: readonly string[]
  readonly childIds: readonly string[]
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly target: NavigationTarget
  readonly selected: boolean
  readonly reachableEndpoints: readonly ReachableEndpointViewModel[]
}

export interface EndpointForkViewModel {
  readonly sourceNodeId: string
  readonly createdAt: string
  readonly empty: boolean
  readonly number?: number
}

export interface ReachableEndpointViewModel {
  readonly session: AgentSession
  readonly status: SessionStatus
  readonly draft: import("../domain/model").DraftPreview | undefined
  readonly fork: EndpointForkViewModel | undefined
  readonly distance: number
  readonly visibleNodeId: string | null
}

export interface MessageNodeViewModel extends PositionedNodeViewModel {
  readonly _tag: "Message"
  readonly role: AgentMessage["role"]
  readonly preview: string
  readonly aliases: readonly MessageRef[]
}

export interface EndpointNodeViewModel extends PositionedNodeViewModel {
  readonly _tag: "Endpoint"
  readonly session: AgentSession
  readonly status: SessionStatus
  readonly draft: import("../domain/model").DraftPreview | undefined
  readonly fork: EndpointForkViewModel | undefined
}

export type GraphNodeViewModel = MessageNodeViewModel | EndpointNodeViewModel

export type SurfaceViewModel =
  | { readonly _tag: "Roots"; readonly roots: readonly RootViewModel[] }
  | {
      readonly _tag: "Graph"
      readonly familySessionId: string
      readonly title: string
      readonly nodes: readonly GraphNodeViewModel[]
      readonly selectedNodeId: string | null
      readonly status: SessionStatus
      readonly warnings: readonly string[]
      readonly worldWidth: number
      readonly worldHeight: number
    }
  | {
      readonly _tag: "Terminal"
      readonly sessionId: string
      readonly title: string
      readonly status: SessionStatus
      readonly draft: import("../domain/model").DraftPreview | undefined
    }

export interface ApplicationViewModel {
  readonly surface: SurfaceViewModel
  readonly modal: ApplicationModal | null
  readonly refreshing: boolean
  readonly initialLoadPending: boolean
  readonly shuttingDown: boolean
  readonly liveSessionIds: ReadonlySet<string>
}

export function projectApplicationViewModel(state: ApplicationState): ApplicationViewModel {
  return {
    surface: projectSurface(state),
    modal: state.modal,
    refreshing: state.refresh.active.size > 0,
    initialLoadPending: state.refresh.initialPending,
    shuttingDown: state.shutdown !== "running",
    liveSessionIds: new Set(state.terminals.keys()),
  }
}

export function projectRootsViewModel(state: ApplicationState): readonly RootViewModel[] {
  const data = selectProjectedData(state)
  const forest = selectVisibleConversationForest(state)
  return forest.graphs.map((graph) => {
    const memberSessionIds = [...graph.sessionIds].filter((sessionId) => data.sessions.has(sessionId))
    return {
      sessionId: graph.rootSessionId,
      title: graph.rootSession.title,
      lastModified: Math.max(
        graph.rootSession.lastModified,
        ...memberSessionIds.map((sessionId) => data.sessions.get(sessionId)?.lastModified ?? 0),
      ),
      memberSessionIds,
      status: selectAggregateStatus(state, memberSessionIds),
      selected:
        state.surface._tag === "Roots" &&
        state.surface.selectedSessionId !== null &&
        graph.sessionIds.has(state.surface.selectedSessionId),
    }
  }).sort(
    (left, right) => right.lastModified - left.lastModified || left.sessionId.localeCompare(right.sessionId),
  )
}

export function projectGraphViewModel(
  state: ApplicationState,
  familySessionId: string,
  selection?: NavigationTarget,
  viewportWidth = 80,
): Extract<SurfaceViewModel, { readonly _tag: "Graph" }> {
  const forest = selectConversationForest(state)
  const graph = forest.graphBySessionId.get(familySessionId) ??
    forest.graphByRootSessionId.get(familySessionId)
  if (!graph) return unavailableGraph(familySessionId)

  const visibleEndpointSessionIds = selectVisibleEndpointSessionIds(state)
  const layout = layoutConversationGraph(graph, viewportWidth, visibleEndpointSessionIds)
  const requestedTarget = selection ?? (state.surface._tag === "Graph" ? state.surface.target : undefined)
  const requestedNodeId = requestedTarget ? resolveSelection(graph, requestedTarget) : undefined
  const selectedNodeId = visibleGraphNodeId(graph, requestedNodeId, visibleEndpointSessionIds) ??
    initialVisibleGraphNodeId(graph, visibleEndpointSessionIds) ??
    null
  const nodes = [...layout.nodes.values()]
    .sort((left, right) => left.y - right.y || left.x - right.x || left.node.id.localeCompare(right.node.id))
    .map((positioned): GraphNodeViewModel => {
      const node = positioned.node
      const parentIds = node.parentId && layout.nodes.has(node.parentId) ? [node.parentId] : []
      const childIds = node.childIds.filter((childId) => layout.nodes.has(childId))
      const position = {
        id: node.id,
        parentIds,
        childIds,
        x: positioned.x,
        y: positioned.y,
        width: positioned.width,
        height: positioned.height,
        selected: node.id === selectedNodeId,
        reachableEndpoints: projectReachableEndpoints(
          state,
          graph,
          node.id,
          visibleEndpointSessionIds,
        ),
      }
      return node.kind === "message"
        ? messageViewModel(node, position)
        : endpointViewModel(state, node, position)
    })
  return {
    _tag: "Graph",
    familySessionId: graph.rootSessionId,
    title: graph.rootSession.title,
    nodes,
    selectedNodeId,
    status: selectAggregateStatus(state, graph.sessionIds),
    warnings: [...graph.warnings],
    worldWidth: layout.worldWidth,
    worldHeight: layout.worldHeight,
  }
}

function projectSurface(state: ApplicationState): SurfaceViewModel {
  if (state.surface._tag === "Roots") return { _tag: "Roots", roots: projectRootsViewModel(state) }
  if (state.surface._tag === "Graph") {
    return projectGraphViewModel(state, state.surface.familySessionId, state.surface.target)
  }
  const data = selectProjectedData(state)
  return {
    _tag: "Terminal",
    sessionId: state.surface.sessionId,
    title: data.sessions.get(state.surface.sessionId)?.title ?? state.surface.sessionId,
    status: selectSessionStatus(state, state.surface.sessionId),
    draft: state.drafts.get(state.surface.sessionId),
  }
}

function messageViewModel(
  node: MessageGraphNode,
  position: Omit<MessageNodeViewModel, "_tag" | "role" | "preview" | "aliases" | "target">,
): MessageNodeViewModel {
  const preferred = node.forkTarget ?? node.aliases.at(-1)!
  return {
    _tag: "Message",
    ...position,
    role: node.role,
    preview: node.preview,
    aliases: node.aliases,
    target: { kind: "message", preferred, aliases: node.aliases },
  }
}

function endpointViewModel(
  state: ApplicationState,
  node: SessionEndpointNode,
  position: Omit<EndpointNodeViewModel, "_tag" | "session" | "status" | "draft" | "fork" | "target">,
): EndpointNodeViewModel {
  return {
    _tag: "Endpoint",
    ...position,
    session: node.session,
    target: { kind: "endpoint", sessionId: node.session.id },
    status: selectSessionStatus(state, node.session.id),
    draft: state.drafts.get(node.session.id),
    fork: node.fork ? { ...node.fork } : undefined,
  }
}

function projectReachableEndpoints(
  state: ApplicationState,
  graph: ConversationGraph,
  nodeId: string,
  visibleEndpointSessionIds: ReadonlySet<string>,
): readonly ReachableEndpointViewModel[] {
  return reachableSessionEndpoints(graph, nodeId).map(({ endpoint, distance }) => ({
    session: endpoint.session,
    status: selectSessionStatus(state, endpoint.session.id),
    draft: state.drafts.get(endpoint.session.id),
    fork: endpoint.fork ? { ...endpoint.fork } : undefined,
    distance,
    visibleNodeId: visibleGraphNodeId(graph, endpoint.id, visibleEndpointSessionIds) ?? null,
  }))
}

function resolveSelection(graph: ConversationGraph, selection: NavigationTarget): string | undefined {
  if (selection.kind === "endpoint") return graph.endpointBySessionId.get(selection.sessionId)
  for (const ref of [selection.preferred, ...selection.aliases]) {
    for (const node of graph.nodes.values()) {
      if (
        node.kind === "message" &&
        node.aliases.some((alias) => alias.sessionId === ref.sessionId && alias.messageId === ref.messageId)
      ) return node.id
    }
  }
  return undefined
}

function unavailableGraph(
  familySessionId: string,
): Extract<SurfaceViewModel, { readonly _tag: "Graph" }> {
  return {
    _tag: "Graph",
    familySessionId,
    title: "Conversation unavailable",
    nodes: [],
    selectedNodeId: null,
    status: "idle",
    warnings: [],
    worldWidth: 0,
    worldHeight: 0,
  }
}
