import { randomUUID } from "node:crypto"

import {
  BoxRenderable,
  CliRenderEvents,
  StyledText,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type RGBA,
  type TextChunk,
} from "@opentui/core"

import { truncateToWidth } from "./display-text"
import { renderConversationGraph, renderRootPicker } from "./graph-renderer"
import {
  directionalMove,
  type ConversationGraphLayout,
  type GraphDirection,
  type GraphNavigationIntent,
} from "./graph-layout"
import {
  buildConversationForest,
  resolveForkPlan,
  type ConversationForest,
  type ConversationGraph,
  type ForkTarget,
  type MessageGraphNodeOrEndpoint,
  type SessionEndpointNode,
} from "./message-graph"
import { BranchMetadataStore, type BranchRelation } from "./metadata"
import {
  SessionService,
  type ConversationMessage,
  type SessionSummary,
} from "./sessions"
import {
  TerminalManager,
  type TerminalExitEvent,
  type TerminalLaunch,
} from "./terminal-manager"
import { theme } from "./theme"

const MINIMUM_WIDTH = 50
const MINIMUM_HEIGHT = 12

export class ClaudeTreeApp {
  private readonly navigator: BoxRenderable
  private readonly header: TextRenderable
  private readonly content: TextRenderable
  private readonly footer: TextRenderable
  private readonly terminalManager: TerminalManager
  private readonly sessionService: SessionService
  private readonly temporarySessions = new Map<string, SessionSummary>()
  private readonly stopped: Promise<void>
  private resolveStopped!: () => void

  private relations: BranchRelation[]
  private sessions: SessionSummary[] = []
  private transcripts = new Map<string, ConversationMessage[]>()
  private forest: ConversationForest = { graphs: [], graphBySessionId: new Map(), warnings: [] }
  private view: "roots" | "graph" | "terminal" = "roots"
  private selectedRootIndex = 0
  private currentRootSessionId: string | null = null
  private selectedGraphNodeId: string | null = null
  private graphLayout: ConversationGraphLayout | null = null
  private graphNavigationIntent: GraphNavigationIntent | null = null
  private status: string
  private busy = false
  private stopping = false
  private refreshGeneration = 0
  private readonly compatibilityWarning: string | undefined

  private constructor(
    private readonly renderer: CliRenderer,
    private readonly metadata: BranchMetadataStore,
    relations: BranchRelation[],
    claudeExecutable: string,
    compatibilityWarning?: string,
  ) {
    this.relations = relations
    this.compatibilityWarning = compatibilityWarning
    this.status = "Ready"
    this.sessionService = new SessionService(metadata.projectPath)
    this.terminalManager = new TerminalManager(
      renderer,
      metadata.projectPath,
      claudeExecutable,
      (event) => this.onTerminalExited(event),
    )
    this.stopped = new Promise((resolve) => {
      this.resolveStopped = resolve
    })

    this.navigator = new BoxRenderable(renderer, {
      id: "navigator",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
      backgroundColor: theme.background,
      zIndex: 1,
    })
    this.header = new TextRenderable(renderer, {
      id: "header",
      height: 2,
      fg: theme.text,
      bg: theme.background,
      selectable: false,
      wrapMode: "none",
      content: "",
    })
    this.content = new TextRenderable(renderer, {
      id: "graph-content",
      flexGrow: 1,
      fg: theme.text,
      bg: theme.background,
      selectable: false,
      wrapMode: "none",
      content: "",
    })
    this.footer = new TextRenderable(renderer, {
      id: "footer",
      height: 4,
      fg: theme.textMuted,
      bg: theme.background,
      selectable: false,
      wrapMode: "none",
      content: "",
    })
    this.navigator.add(this.header)
    this.navigator.add(this.content)
    this.navigator.add(this.footer)
    renderer.root.add(this.navigator)
  }

  static async create(
    renderer: CliRenderer,
    projectDirectory: string,
    claudeExecutable: string,
    compatibilityWarning?: string,
    stateHome?: string,
  ): Promise<ClaudeTreeApp> {
    const metadata = await BranchMetadataStore.open(projectDirectory, stateHome)
    const relations = await metadata.loadRelations()
    return new ClaudeTreeApp(
      renderer,
      metadata,
      relations,
      claudeExecutable,
      compatibilityWarning,
    )
  }

  async run(): Promise<void> {
    this.renderer.keyInput.on("keypress", this.onKeyPress)
    this.renderer.keyInput.on("keyrelease", this.onKeyRelease)
    this.renderer.on(CliRenderEvents.RESIZE, this.onResize)
    await this.refreshData()
    this.renderer.start()
    this.render()
    await this.stopped
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopped
    this.stopping = true
    this.renderer.keyInput.off("keypress", this.onKeyPress)
    this.renderer.keyInput.off("keyrelease", this.onKeyRelease)
    this.renderer.off(CliRenderEvents.RESIZE, this.onResize)
    await this.terminalManager.shutdown()
    this.renderer.destroy()
    this.resolveStopped()
  }

  private readonly onResize = () => {
    this.graphNavigationIntent = null
    this.render()
  }

  private onTerminalExited(event: TerminalExitEvent): void {
    if (this.stopping) return
    const exitStatus =
      event.exitCode === 0
        ? "Claude session exited"
        : `Claude session exited with code ${event.exitCode}`
    if (event.wasActive) {
      this.view = "roots"
      this.navigator.visible = true
    }
    void this.refreshData(event.wasActive ? event.sessionId : undefined)
      .then(() => {
        this.status = exitStatus
        this.render()
      })
      .catch((error) => {
        this.status = `${exitStatus}; refresh failed: ${error instanceof Error ? error.message : String(error)}`
        this.render()
      })
  }

  private readonly onKeyRelease = (key: KeyEvent) => {
    if (isHostEscape(key)) key.stopPropagation()
  }

  private readonly onKeyPress = (key: KeyEvent) => {
    if (isHostEscape(key)) {
      key.stopPropagation()
      if (this.view === "terminal" && !key.repeated) void this.returnToGraph()
      return
    }
    if (this.view === "terminal") return

    if (this.view === "roots") {
      this.handleRootKey(key)
    } else {
      this.handleGraphKey(key)
    }
  }

  private handleRootKey(key: KeyEvent): void {
    const quit = key.name === "q" || (key.name === "c" && key.ctrl)
    const recognized =
      quit || ["up", "down", "k", "j", "return", "n", "r"].includes(key.name)
    if (!recognized) return
    key.stopPropagation()
    if (this.busy) return

    if (quit) {
      void this.stop()
    } else if (key.name === "up" || key.name === "k") {
      this.moveRoot(-1)
    } else if (key.name === "down" || key.name === "j") {
      this.moveRoot(1)
    } else if (key.name === "return" && !key.repeated) {
      this.enterSelectedRoot()
    } else if (key.name === "n" && !key.repeated) {
      void this.runAction(() => this.newSession())
    } else if (key.name === "r" && !key.repeated) {
      void this.runAction(() => this.refreshData())
    }
  }

  private handleGraphKey(key: KeyEvent): void {
    const exit = key.name === "c" && key.ctrl
    const back = key.name === "q" || key.name === "escape"
    const recognized =
      exit ||
      back ||
      ["up", "down", "left", "right", "k", "j", "h", "l", "return", "f", "n", "r"].includes(
        key.name,
      )
    if (!recognized) return
    key.stopPropagation()
    if (this.busy) return

    if (exit) {
      void this.stop()
    } else if (back) {
      this.view = "roots"
      this.graphNavigationIntent = null
      this.render()
    } else if (key.name === "up" || key.name === "k") {
      this.moveSelection("up")
    } else if (key.name === "down" || key.name === "j") {
      this.moveSelection("down")
    } else if (key.name === "left" || key.name === "h") {
      this.moveSelection("left")
    } else if (key.name === "right" || key.name === "l") {
      this.moveSelection("right")
    } else if (key.name === "return" && !key.repeated) {
      void this.runAction(() => this.openSelectedLeaf())
    } else if (key.name === "f" && !key.repeated) {
      void this.runAction(() => this.forkSelectedNode())
    } else if (key.name === "n" && !key.repeated) {
      void this.runAction(() => this.newSession())
    } else if (key.name === "r" && !key.repeated) {
      void this.runAction(() => this.refreshData())
    }
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    this.busy = true
    this.render()
    try {
      await action()
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error)
    } finally {
      this.busy = false
      this.render()
    }
  }

  private moveRoot(delta: number): void {
    if (this.forest.graphs.length === 0) return
    this.selectedRootIndex = clamp(
      this.selectedRootIndex + delta,
      0,
      this.forest.graphs.length - 1,
    )
    this.render()
  }

  private enterSelectedRoot(): void {
    const graph = this.forest.graphs[this.selectedRootIndex]
    if (!graph) return
    this.currentRootSessionId = graph.rootSessionId
    this.selectedGraphNodeId = graph.rootNodeId
    this.graphNavigationIntent = null
    this.view = "graph"
    this.status = graph.warnings[0] ?? "Graph ready"
    this.render()
  }

  private moveSelection(direction: GraphDirection): void {
    if (!this.graphLayout || !this.selectedGraphNodeId) return
    const move = directionalMove(
      this.graphLayout,
      this.selectedGraphNodeId,
      direction,
      this.graphNavigationIntent ?? undefined,
    )
    if (!move) return
    this.selectedGraphNodeId = move.nodeId
    this.graphNavigationIntent = move.intent
    this.render()
  }

  private async refreshData(focusSessionId?: string): Promise<void> {
    const generation = ++this.refreshGeneration
    const previousRootSessionId = this.currentRootSessionId
    const previousNodeId = this.selectedGraphNodeId
    const previousSelectedRoot = this.forest.graphs[this.selectedRootIndex]?.rootSessionId
    const discovered = await this.sessionService.list()
    if (generation !== this.refreshGeneration || this.stopping) return

    const discoveredIds = new Set(discovered.map((session) => session.sessionId))
    for (const sessionId of discoveredIds) this.temporarySessions.delete(sessionId)
    const runningIds = this.terminalManager.runningSessionIds()
    for (const [sessionId, session] of this.temporarySessions) {
      if (session.transient && !runningIds.has(sessionId)) this.temporarySessions.delete(sessionId)
    }
    this.sessions = [...discovered, ...this.temporarySessions.values()]

    const transcriptEntries = await Promise.all(
      this.sessions.map(async (session) => {
        if (session.transient) return [session.sessionId, [] as ConversationMessage[]] as const
        return [session.sessionId, await this.sessionService.messages(session.sessionId)] as const
      }),
    )
    if (generation !== this.refreshGeneration || this.stopping) return
    this.transcripts = new Map(transcriptEntries)
    this.forest = buildConversationForest(this.sessions, this.transcripts, this.relations)
    this.graphNavigationIntent = null

    const focusedGraph = focusSessionId ? this.forest.graphBySessionId.get(focusSessionId) : undefined
    const preservedGraph = previousRootSessionId
      ? this.forest.graphBySessionId.get(previousRootSessionId)
      : undefined
    const graph = focusedGraph ?? preservedGraph
    if (graph) {
      this.currentRootSessionId = graph.rootSessionId
      this.selectedRootIndex = this.forest.graphs.indexOf(graph)
      this.selectedGraphNodeId =
        (focusSessionId ? graph.endpointBySessionId.get(focusSessionId) : undefined) ??
        (previousNodeId && graph.nodes.has(previousNodeId) ? previousNodeId : graph.rootNodeId)
      if (focusSessionId) this.view = "graph"
    } else {
      this.currentRootSessionId = null
      this.selectedGraphNodeId = null
      this.view = "roots"
      const preservedRootIndex = previousSelectedRoot
        ? this.forest.graphs.findIndex((candidate) => candidate.rootSessionId === previousSelectedRoot)
        : -1
      this.selectedRootIndex = preservedRootIndex >= 0 ? preservedRootIndex : 0
    }

    this.status =
      this.forest.warnings[0] ??
      (this.forest.graphs.length === 0
        ? "No Claude conversations found. Press n to start one."
        : "Refreshed")
  }

  private async newSession(
    prefillText?: string,
    replaySource?: ForkTarget,
  ): Promise<void> {
    const sessionId = randomUUID()
    if (replaySource) {
      const relation = await this.metadata.saveRelation({
        childSessionId: sessionId,
        parentSessionId: replaySource.sessionId,
        sourceMessageId: replaySource.messageId,
        copiedPrefixLength: 0,
      })
      this.relations.push(relation)
    }
    this.temporarySessions.set(sessionId, {
      sessionId,
      title: "New conversation",
      lastModified: Date.now(),
      transient: true,
    })
    await this.openTerminal({
      kind: "new",
      sessionId,
      ...(prefillText === undefined ? {} : { prefillText }),
    })
  }

  private async openSelectedLeaf(): Promise<void> {
    const graph = this.currentGraph()
    const selected = this.selectedGraphNode()
    if (!graph || !selected) return

    let endpoint = selected.kind === "endpoint" ? selected : undefined
    if (!endpoint) {
      const endpointChildren = selected.childIds
        .map((childId) => graph.nodes.get(childId))
        .filter((node): node is SessionEndpointNode => node?.kind === "endpoint")
      const messageChildren = selected.childIds.filter(
        (childId) => graph.nodes.get(childId)?.kind === "message",
      )
      if (endpointChildren.length === 1 && messageChildren.length === 0) {
        endpoint = endpointChildren[0]
      }
    }
    if (endpoint?.kind !== "endpoint") {
      this.status = "Select a Claude session leaf to enter Claude"
      return
    }

    await this.openTerminal({
      kind: endpoint.session.transient ? "new" : "resume",
      sessionId: endpoint.session.sessionId,
    })
  }

  private async forkSelectedNode(): Promise<void> {
    const graph = this.currentGraph()
    if (!graph || !this.selectedGraphNodeId) return
    const plan = resolveForkPlan(graph, this.selectedGraphNodeId)
    if (!plan) {
      this.status = "This node has no historical message to fork"
      return
    }
    if (plan.kind !== "historical" && plan.prefillText === undefined) {
      this.status = "This user message contains content that Claude cannot prefill"
      return
    }
    if (plan.kind === "root-replay") {
      await this.newSession(plan.prefillText, plan.source)
      return
    }

    const target = plan.target

    const parentTranscript = this.transcripts.get(target.sessionId) ?? []
    const sourceIndex = parentTranscript.findIndex((message) => message.id === target.messageId)
    if (sourceIndex < 0) throw new Error("The selected historical message is no longer available")

    this.status = "Forking conversation..."
    this.render()
    const childSessionId = await this.sessionService.fork(target.sessionId, target.messageId)
    const childTranscript = await this.sessionService.messages(childSessionId)
    const copiedPrefixLength = sourceIndex + 1
    const childPrefixEndMessageId = childTranscript[copiedPrefixLength - 1]?.id
    if (!childPrefixEndMessageId) {
      throw new Error(
        `Fork ${childSessionId} was created, but its copied prefix could not be validated`,
      )
    }

    let relation: BranchRelation
    try {
      relation = await this.metadata.saveRelation({
        childSessionId,
        parentSessionId: target.sessionId,
        sourceMessageId: target.messageId,
        copiedPrefixLength,
        childPrefixEndMessageId,
      })
    } catch (error) {
      throw new Error(
        `Fork ${childSessionId} was created, but ancestry could not be saved: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    this.relations.push(relation)
    const parentSession = this.sessions.find((session) => session.sessionId === target.sessionId)
    this.temporarySessions.set(childSessionId, {
      sessionId: childSessionId,
      title: `${parentSession?.title ?? "Conversation"} (fork)`,
      lastModified: Date.now(),
    })
    await this.refreshData(childSessionId)
    await this.openTerminal({
      kind: "resume",
      sessionId: childSessionId,
      ...(plan.kind === "prefilled" ? { prefillText: plan.prefillText } : {}),
    })
  }

  private async openTerminal(launch: TerminalLaunch): Promise<void> {
    if (this.stopping) throw new Error("claude-tree is shutting down")
    await this.terminalManager.show(launch)
    this.view = "terminal"
    this.navigator.visible = false
  }

  private async returnToGraph(): Promise<void> {
    const sessionId = this.terminalManager.hideActive()
    this.view = "roots"
    this.navigator.visible = true
    await this.runAction(() => this.refreshData(sessionId ?? undefined))
  }

  private currentGraph(): ConversationGraph | undefined {
    return this.currentRootSessionId
      ? this.forest.graphBySessionId.get(this.currentRootSessionId)
      : undefined
  }

  private selectedGraphNode(): MessageGraphNodeOrEndpoint | undefined {
    const graph = this.currentGraph()
    const node =
      graph && this.selectedGraphNodeId ? graph.nodes.get(this.selectedGraphNodeId) : undefined
    return node?.kind === "origin" ? undefined : node
  }

  private render(): void {
    if (this.renderer.isDestroyed || this.view === "terminal") return
    const tooSmall =
      this.renderer.terminalWidth < MINIMUM_WIDTH || this.renderer.terminalHeight < MINIMUM_HEIGHT
    this.header.content = tooSmall
      ? styledText([
          chunk("󰙅 claude-tree", theme.primary, TextAttributes.BOLD),
          chunk("\nResize to at least ", theme.textMuted),
          chunk(`${MINIMUM_WIDTH}×${MINIMUM_HEIGHT}`, theme.warning),
          chunk(` · current ${this.renderer.terminalWidth}×${this.renderer.terminalHeight}`, theme.textMuted),
        ])
      : this.renderHeader()
    this.content.visible = !tooSmall
    this.footer.visible = !tooSmall
    if (tooSmall) {
      this.graphLayout = null
      this.graphNavigationIntent = null
      return
    }

    const contentHeight = Math.max(1, this.renderer.terminalHeight - 8)
    if (this.view === "roots") {
      this.graphLayout = null
      this.graphNavigationIntent = null
      const rendered = renderRootPicker(
        this.forest.graphs,
        this.selectedRootIndex,
        contentHeight,
        this.renderer.terminalWidth - 2,
        this.terminalManager.runningSessionIds(),
      )
      this.content.content = rendered.content
      this.footer.content = this.renderRootFooter()
    } else {
      const graph = this.currentGraph()
      if (!graph || !this.selectedGraphNodeId) {
        this.graphLayout = null
        return
      }
      const rendered = renderConversationGraph(
        graph,
        this.selectedGraphNodeId,
        this.renderer.terminalWidth - 2,
        contentHeight,
        this.terminalManager.runningSessionIds(),
        this.terminalManager.draftPreviews(),
      )
      this.graphLayout = rendered.layout
      this.content.content = rendered.content
      this.footer.content = this.renderGraphFooter()
    }
  }

  private renderHeader(): StyledText {
    const identity = [
      chunk("󰙅 claude-tree", theme.primary, TextAttributes.BOLD),
      chunk("  ", theme.textMuted),
      chunk(this.metadata.projectPath, theme.textMuted),
      chunk("\n", theme.text),
    ]
    if (this.view === "roots") {
      return styledText([...identity, chunk("Conversation roots", theme.text, TextAttributes.BOLD)])
    }
    const graph = this.currentGraph()
    const rootEndpointId = graph?.endpointBySessionId.get(graph.rootSessionId)
    const rootEndpoint = rootEndpointId ? graph?.nodes.get(rootEndpointId) : undefined
    const title = rootEndpoint?.kind === "endpoint" ? rootEndpoint.session.title : "Conversation"
    return styledText([
      ...identity,
      chunk(truncateToWidth(title, Math.max(1, this.renderer.terminalWidth - 18)), theme.text, TextAttributes.BOLD),
      chunk("  Message graph", theme.textMuted),
    ])
  }

  private renderRootFooter(): StyledText {
    return styledText([
      ...controlChunks([
        ["↑↓ / jk", "select"],
        ["Enter", "graph"],
        ["n", "new"],
        ["r", "refresh"],
        ["q", "quit"],
      ]),
      chunk("\nAll branches share this working tree.", theme.warning),
      chunk("\n", theme.text),
      ...this.statusChunks(),
    ])
  }

  private renderGraphFooter(): StyledText {
    return styledText([
      ...controlChunks([
        ["↑↓ / kj", "edges"],
        ["←→ / hl", "branches"],
        ["Enter", "open"],
        ["f", "fork"],
        ["r", "refresh"],
        ["q", "roots"],
      ]),
      chunk("\n", theme.text),
      chunk(this.selectedDescription(), theme.textMuted),
      chunk("\n", theme.text),
      ...this.statusChunks(),
    ])
  }

  private statusChunks(): TextChunk[] {
    const status = this.busy ? "Working…" : this.status
    const result = [
      chunk(status, this.busy ? theme.primary : theme.text, this.busy ? TextAttributes.BOLD : TextAttributes.NONE),
    ]
    if (this.compatibilityWarning) {
      result.push(chunk("  ·  ", theme.textMuted), chunk(this.compatibilityWarning, theme.warning))
    }
    return result
  }

  private selectedDescription(): string {
    const selected = this.selectedGraphNode()
    if (!selected) return "No node selected"
    if (selected.kind === "endpoint") {
      const draft = this.terminalManager.draftPreviews().get(selected.session.sessionId)
      const draftDescription = draft
        ? `${draft.exact ? "Draft" : "Observed draft"}: ${draft.text.replace(/\s+/g, " ").trim()}`
        : this.terminalManager.isRunning(selected.session.sessionId)
          ? "No draft observed"
          : "No live draft"
      const description = truncateToWidth(
        draftDescription,
        Math.max(20, this.renderer.terminalWidth - 32),
      )
      return `Selected session · ${description} · ${selected.session.sessionId.slice(0, 8)}`
    }
    const role = selected.internal
      ? "internal"
      : selected.role === "assistant"
        ? "assistant"
        : selected.role === "user"
          ? "user"
          : "system"
    return `Selected ${role} · ${truncateToWidth(selected.preview, Math.max(20, this.renderer.terminalWidth - 24))}`
  }
}

function chunk(
  text: string,
  fg: RGBA,
  attributes: number = TextAttributes.NONE,
  bg: RGBA = theme.background,
): TextChunk {
  return { __isChunk: true, text, fg, bg, attributes }
}

function styledText(chunks: TextChunk[]): StyledText {
  return new StyledText(chunks)
}

function controlChunks(controls: Array<readonly [key: string, description: string]>): TextChunk[] {
  return controls.flatMap(([key, description], index) => [
    ...(index === 0 ? [] : [chunk("  ", theme.textMuted)]),
    chunk(key, theme.text, TextAttributes.BOLD),
    chunk(` ${description}`, theme.textMuted),
  ])
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function isHostEscape(key: KeyEvent): boolean {
  return (
    key.name === "space" &&
    key.ctrl &&
    !key.shift &&
    !key.meta &&
    !key.option &&
    !key.super &&
    !key.hyper
  )
}
