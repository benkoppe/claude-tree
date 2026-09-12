import type {
  ConversationGraph,
  MessageGraphNode,
  ReachableSessionEndpoint,
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
import { selectCatalogueFamilies, selectFamilyHistoryStatus, type FamilyHistoryStatus } from "./catalogue"

export interface RootViewModel {
  readonly history: FamilyHistoryStatus
  readonly sessionId: string
  readonly title: string
  readonly lastModified: number
  readonly memberSessionIds: readonly string[]
  readonly messageCount: number
  readonly status: SessionStatus
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
  readonly text?: string
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
  | { readonly _tag: "Roots"; readonly roots: readonly RootViewModel[]; readonly selectedSessionId: string | null }
  | {
      readonly _tag: "Graph"
      readonly familySessionId: string
      readonly title: string
      readonly nodes: readonly GraphNodeViewModel[]
      /** Selection-independent nodes; geometry and rendering indexes survive cursor movement. */
      readonly unselectedNodes?: readonly GraphNodeViewModel[]
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
  readonly selectionId: string | null
  readonly surface: SurfaceViewModel
  readonly modal: ApplicationModal | null
  readonly refreshing: boolean
  readonly initialLoadPending: boolean
  readonly shuttingDown: boolean
  readonly liveSessionIds: ReadonlySet<string>
}

type GraphView = Extract<SurfaceViewModel, { readonly _tag: "Graph" }>
const layoutCache = new WeakMap<ConversationGraph, {
  width: number
  visible: ReadonlySet<string>
  layout: ReturnType<typeof layoutConversationGraph>
  aliases: ReadonlyMap<string, ReadonlyMap<string, string>>
}>()
const graphViewCache = new WeakMap<ConversationGraph, {
  layout: ReturnType<typeof layoutConversationGraph>
  terminals: ApplicationState["terminals"]
  drafts: ApplicationState["drafts"]
  completions: ApplicationState["pendingCompletions"]
  unviewed: ApplicationState["unviewedSessionIds"]
  view: GraphView
}>()
const rootSummaryCache = new WeakMap<ConversationGraph, Omit<RootViewModel, "status" | "history">>()
const rootViewCache = new WeakMap<ReturnType<typeof selectVisibleConversationForest>, {
  provider: ApplicationState["provider"]
  terminals: ApplicationState["terminals"]
  historyStatus: ApplicationState["historyStatus"]
  completions: ApplicationState["pendingCompletions"]
  unviewed: ApplicationState["unviewedSessionIds"]
  roots: readonly RootViewModel[]
}>()

export interface RootViewIndex {
  readonly bySessionId: ReadonlyMap<string, RootViewModel>
  readonly positions: ReadonlyMap<string, number>
  readonly working: boolean
  readonly messageCountWidth: number
  readonly branchCountWidth: number
}
const rootIndexes = new WeakMap<readonly RootViewModel[], RootViewIndex>()

export function indexRootViews(roots: readonly RootViewModel[]): RootViewIndex {
  const cached = rootIndexes.get(roots)
  if (cached) return cached
  const bySessionId = new Map<string, RootViewModel>()
  const positions = new Map<string, number>()
  let working = false, messageCountWidth = 1, branchCountWidth = 1
  roots.forEach((root, index) => {
    for (const id of [root.sessionId, ...root.memberSessionIds]) {
      bySessionId.set(id, root)
      positions.set(id, index)
    }
    working ||= root.status === "working"
    messageCountWidth = Math.max(messageCountWidth, String(root.messageCount).length)
    branchCountWidth = Math.max(branchCountWidth, String(root.memberSessionIds.length).length)
  })
  const indexed = { bySessionId, positions, working, messageCountWidth, branchCountWidth }
  rootIndexes.set(roots, indexed)
  return indexed
}

export function projectApplicationViewModel(state: ApplicationState): ApplicationViewModel {
  return {
    selectionId: state.selectionId,
    surface: projectSurface(state),
    modal: state.modal,
    refreshing: state.refresh.active.size > 0,
    initialLoadPending: state.refresh.initialPending && state.provider.sessions.size === 0,
    shuttingDown: state.shutdown !== "running",
    liveSessionIds: new Set(state.terminals.keys()),
  }
}

export function projectRootsViewModel(state: ApplicationState): readonly RootViewModel[] {
  const data = selectProjectedData(state)
  const forest = selectVisibleConversationForest(state)
  const cached = rootViewCache.get(forest)
  if (cached && cached.provider === state.provider && cached.terminals === state.terminals && cached.historyStatus === state.historyStatus &&
    cached.completions === state.pendingCompletions && cached.unviewed === state.unviewedSessionIds) return cached.roots
  const roots = forest.graphs.map((graph): RootViewModel => {
    let summary = rootSummaryCache.get(graph)
    if (!summary) {
      const memberSessionIds = [...graph.sessionIds].filter((sessionId) => data.sessions.has(sessionId))
      summary = {
        sessionId: graph.rootSessionId,
        title: graph.rootSession.title,
        lastModified: memberSessionIds.reduce((latest, id) => Math.max(latest, data.sessions.get(id)?.lastModified ?? 0), graph.rootSession.lastModified),
        memberSessionIds,
        messageCount: [...graph.nodes.values()].filter((node) => node.kind === "message").length,
      }
      rootSummaryCache.set(graph, summary)
    }
    return {
      ...summary,
      history: selectFamilyHistoryStatus(state, summary.memberSessionIds),
      status: selectAggregateStatus(state, summary.memberSessionIds),
    }
  })
  const pendingIds = new Set<string>()
  const pendingRoots: RootViewModel[] = []
  for (const family of selectCatalogueFamilies(state)) {
      const history = selectFamilyHistoryStatus(state, family.sessionIds)
      if (history._tag === "Ready") continue
      const memberSessionIds = [...family.sessionIds]
      const root = family.root
      if (state.removals.some((removal) => removal.kind === "tree" &&
        (family.sessionIds.has(removal.rootSessionId) || removal.memberSessionIds.some((id) => family.sessionIds.has(id))))) continue
      // Keep validated removals effective even when a later read fails.
      const accepted = memberSessionIds.every((id) =>
        (state.local.transcripts.get(id) ?? state.provider.transcripts.get(id))?._tag === "Available")
      if (accepted) continue
      for (const id of memberSessionIds) pendingIds.add(id)
      pendingRoots.push({ sessionId: root.id, title: root.title,
        lastModified: memberSessionIds.reduce((latest, id) => Math.max(latest, state.provider.sessions.get(id)?.lastModified ?? 0), root.lastModified),
        memberSessionIds, messageCount: 0, history, status: selectAggregateStatus(state, memberSessionIds),
      })
  }
  const rows = [...roots.filter((root) => !pendingIds.has(root.sessionId)), ...pendingRoots].sort(
    (left, right) => right.lastModified - left.lastModified || left.sessionId.localeCompare(right.sessionId),
  )
  rootViewCache.set(forest, { provider: state.provider, terminals: state.terminals, historyStatus: state.historyStatus,
    completions: state.pendingCompletions, unviewed: state.unviewedSessionIds, roots: rows })
  return rows
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
  let geometry = layoutCache.get(graph)
  if (!geometry || geometry.width !== viewportWidth || geometry.visible.size !== visibleEndpointSessionIds.size ||
    [...visibleEndpointSessionIds].some((id) => !geometry!.visible.has(id))) {
    const aliases = new Map<string, Map<string, string>>()
    for (const node of graph.nodes.values()) {
      if (node.kind !== "message") continue
      for (const alias of node.aliases) {
        let messages = aliases.get(alias.sessionId)
        if (!messages) aliases.set(alias.sessionId, messages = new Map())
        messages.set(alias.messageId, node.id)
      }
    }
    geometry = { width: viewportWidth, visible: visibleEndpointSessionIds,
      layout: layoutConversationGraph(graph, viewportWidth, visibleEndpointSessionIds), aliases }
    layoutCache.set(graph, geometry)
  }
  const layout = geometry.layout
  const requestedTarget = selection ?? (state.surface._tag === "Graph" ? state.surface.target : undefined)
  const requestedNodeId = requestedTarget?.kind === "endpoint"
    ? graph.endpointBySessionId.get(requestedTarget.sessionId)
    : requestedTarget ? [requestedTarget.preferred, ...requestedTarget.aliases]
      .map((ref) => geometry.aliases.get(ref.sessionId)?.get(ref.messageId)).find((id) => id !== undefined) : undefined
  const selectedNodeId = visibleGraphNodeId(graph, requestedNodeId, visibleEndpointSessionIds) ??
    initialVisibleGraphNodeId(graph, visibleEndpointSessionIds) ??
    null
  const cached = graphViewCache.get(graph)
  if (cached && cached.layout === layout && cached.terminals === state.terminals && cached.drafts === state.drafts &&
    cached.completions === state.pendingCompletions && cached.unviewed === state.unviewedSessionIds) {
    return withGraphSelection(cached.view, selectedNodeId)
  }
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
        selected: false,
      }
      let endpoints: readonly ReachableEndpointViewModel[] | undefined
      const projected = node.kind === "message"
        ? messageViewModel(node, { ...position, reachableEndpoints: [] })
        : endpointViewModel(state, node, { ...position, reachableEndpoints: [] })
      Object.defineProperty(projected, "reachableEndpoints", { enumerable: true, get: () =>
        endpoints ??= projectReachableEndpoints(state, graph, reachableSessionEndpoints(graph, node.id), visibleEndpointSessionIds) })
      return projected
    })
  const view: GraphView = {
    _tag: "Graph",
    familySessionId: graph.rootSessionId,
    title: graph.rootSession.title,
    nodes,
    unselectedNodes: nodes,
    selectedNodeId: null,
    status: selectAggregateStatus(state, graph.sessionIds),
    warnings: [...graph.warnings],
    worldWidth: layout.worldWidth,
    worldHeight: layout.worldHeight,
  }
  graphViewCache.set(graph, { layout, terminals: state.terminals, drafts: state.drafts,
    completions: state.pendingCompletions, unviewed: state.unviewedSessionIds, view })
  return withGraphSelection(view, selectedNodeId)
}

function withGraphSelection(view: GraphView, selectedNodeId: string | null): GraphView {
  return { ...view, selectedNodeId, nodes: view.nodes.map((node) => node.id === selectedNodeId
    ? Object.defineProperties(Object.create(Object.getPrototypeOf(node)), {
      ...Object.getOwnPropertyDescriptors(node), selected: { value: true, enumerable: true },
    }) as GraphNodeViewModel : node) }
}

function projectSurface(state: ApplicationState): SurfaceViewModel {
  if (state.surface._tag === "Roots") {
    const roots = projectRootsViewModel(state)
    return { _tag: "Roots", roots, selectedSessionId: state.surface.selectedSessionId === null ? null
      : indexRootViews(roots).bySessionId.get(state.surface.selectedSessionId)?.sessionId ?? null }
  }
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
    text: node.text ?? "",
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
  endpoints: readonly ReachableSessionEndpoint[],
  visibleEndpointSessionIds: ReadonlySet<string>,
): readonly ReachableEndpointViewModel[] {
  return endpoints.map(({ endpoint, distance }) => ({
    session: endpoint.session,
    status: selectSessionStatus(state, endpoint.session.id),
    draft: state.drafts.get(endpoint.session.id),
    fork: endpoint.fork ? { ...endpoint.fork } : undefined,
    distance,
    visibleNodeId: visibleGraphNodeId(graph, endpoint.id, visibleEndpointSessionIds) ?? null,
  }))
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
