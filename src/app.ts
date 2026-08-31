import {
  BoxRenderable,
  CliRenderEvents,
  RGBA,
  StyledText,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type TextChunk,
} from "@opentui/core"

import type {
  AgentMessage,
  AgentProvider,
  AgentSession,
  TerminalLaunch,
} from "./agent-provider"
import { displayWidth, truncateToWidth } from "./display-text"
import {
  BRAILLE_SPINNER_FRAMES,
  renderConversationGraph,
  renderRootPicker,
  type ViewportOffset,
} from "./graph-renderer"
import {
  directionalMove,
  graphNodeAt,
  initialVisibleGraphNodeId,
  type ConversationGraphLayout,
  type GraphDirection,
  type GraphNavigationIntent,
  visibleGraphNodeId,
} from "./graph-layout"
import {
  buildConversationForest,
  resolveForkTarget,
  type ConversationForest,
  type ConversationGraph,
  type MessageGraphNodeOrEndpoint,
  type SessionEndpointNode,
} from "./message-graph"
import { BranchMetadataStore, type BranchRelation } from "./metadata"
import { PROGRAM_NAME, PROGRAM_VERSION } from "./program"
import {
  TerminalManager,
  type TerminalActivityEvent,
  type TerminalExitEvent,
} from "./terminal-manager"
import { theme } from "./theme"

const MINIMUM_WIDTH = 50
const MINIMUM_HEIGHT = 12
const NAVIGATOR_HORIZONTAL_MARGIN = 1
const HEADER_HEIGHT = 2
const FOOTER_HEIGHT = 2
const SEPARATOR_HEIGHT = 1
const NAVIGATOR_CHROME_HEIGHT = HEADER_HEIGHT + FOOTER_HEIGHT + SEPARATOR_HEIGHT * 2
const SPINNER_INTERVAL_MS = 80
const COMPLETION_REFRESH_DELAY_MS = 75
const REFRESH_SPINNER_FRAMES = ["|", "/", "-", "\\"] as const

type FooterAction =
  | "enter-root"
  | "new"
  | "refresh"
  | "quit"
  | "open"
  | "fork"
  | "kill"
  | "roots"
  | "about"

interface KillConfirmation {
  sessionId: string
  kind: "draft" | "working"
  choice: "kill" | "cancel"
}

interface PreferredOpenSession {
  nodeId: string
  sessionId: string
}

type InfoModal = { kind: "about" } | { kind: "error"; message: string }

interface ActiveRefresh {
  generation: number
  controller: AbortController
  focusSessionId?: string
}

interface FooterControl {
  key: string
  description: string
  action?: FooterAction
}

interface FooterHitRegion {
  startX: number
  endX: number
  action: FooterAction
}

interface RenderedFooter {
  content: StyledText
  hitRegions: FooterHitRegion[]
}

type ContentMouseAction =
  | { kind: "root"; rootIndex: number }
  | { kind: "graph"; nodeId: string }
type FooterMouseAction = { kind: "footer"; action: FooterAction }
type PendingMouseAction = ContentMouseAction | FooterMouseAction

const ROOT_FOOTER_CONTROLS: FooterControl[] = [
  { key: "↑↓/jk", description: "select" },
  { key: "Enter", description: "graph", action: "enter-root" },
  { key: "n", description: "new", action: "new" },
  { key: "r", description: "refresh", action: "refresh" },
  { key: "q", description: "quit", action: "quit" },
  { key: "?", description: "about", action: "about" },
]

const GRAPH_FOOTER_CONTROLS: FooterControl[] = [
  { key: "↑↓/kj", description: "edges" },
  { key: "←→/hl", description: "branches" },
  { key: "Enter", description: "open", action: "open" },
  { key: "f", description: "fork", action: "fork" },
  { key: "x", description: "kill", action: "kill" },
  { key: "r", description: "refresh", action: "refresh" },
  { key: "q", description: "quit", action: "roots" },
  { key: "?", description: "about", action: "about" },
]

export class AgentTreeApp {
  private readonly navigator: BoxRenderable
  private readonly header: TextRenderable
  private readonly headerSeparator: TextRenderable
  private readonly content: TextRenderable
  private readonly footerSeparator: TextRenderable
  private readonly footer: TextRenderable
  private readonly killOverlay: BoxRenderable
  private readonly killDialog: BoxRenderable
  private readonly killMessage: TextRenderable
  private readonly killCancelButton: BoxRenderable
  private readonly killCancelLabel: TextRenderable
  private readonly killConfirmButton: BoxRenderable
  private readonly killConfirmLabel: TextRenderable
  private readonly infoOverlay: BoxRenderable
  private readonly infoDialog: BoxRenderable
  private readonly infoTitle: TextRenderable
  private readonly infoTab: TextRenderable
  private readonly infoTabSeparator: TextRenderable
  private readonly infoBody: TextRenderable
  private readonly terminalManager: TerminalManager
  private readonly temporarySessions = new Map<string, AgentSession>()
  private readonly stopped: Promise<void>
  private resolveStopped!: () => void
  private stopPromise: Promise<void> | undefined

  private relations: BranchRelation[]
  private sessions: AgentSession[] = []
  private transcripts = new Map<string, AgentMessage[]>()
  private forest: ConversationForest = { graphs: [], graphBySessionId: new Map(), warnings: [] }
  private view: "roots" | "graph" | "terminal" = "roots"
  private selectedRootIndex = 0
  private currentRootSessionId: string | null = null
  private selectedGraphNodeId: string | null = null
  private rootViewportStart = 0
  private graphLayout: ConversationGraphLayout | null = null
  private graphViewportOffset: ViewportOffset | null = null
  private graphNavigationIntent: GraphNavigationIntent | null = null
  private footerHitRegions: FooterHitRegion[] = []
  private pendingMouseAction: PendingMouseAction | null = null
  private killConfirmation: KillConfirmation | null = null
  private infoModal: InfoModal | null = null
  private preferredOpenSession: PreferredOpenSession | null = null
  private busy = false
  private stopping = false
  private refreshGeneration = 0
  private activeRefresh: ActiveRefresh | null = null
  private spinnerFrame = 0
  private spinnerTimer: ReturnType<typeof setInterval> | undefined
  private completionRefreshTimer: ReturnType<typeof setTimeout> | undefined
  private completionRefreshRunning = false
  private completionRefreshVersion = 0
  private readonly pendingCompletionRefreshes = new Map<string, number>()
  private constructor(
    private readonly renderer: CliRenderer,
    private readonly metadata: BranchMetadataStore,
    private readonly provider: AgentProvider,
    relations: BranchRelation[],
  ) {
    this.relations = relations
    this.terminalManager = new TerminalManager(
      renderer,
      (event) => this.onTerminalExited(event),
      (event) => this.onTerminalActivityChanged(event),
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
      backgroundColor: theme.background,
      zIndex: 1,
    })
    this.header = new TextRenderable(renderer, {
      id: "header",
      height: HEADER_HEIGHT,
      marginX: NAVIGATOR_HORIZONTAL_MARGIN,
      fg: theme.text,
      bg: theme.background,
      selectable: false,
      wrapMode: "none",
      content: "",
    })
    this.headerSeparator = new TextRenderable(renderer, {
      id: "header-separator",
      width: "100%",
      height: SEPARATOR_HEIGHT,
      fg: theme.separator,
      bg: theme.background,
      selectable: false,
      wrapMode: "none",
      content: "",
    })
    this.content = new TextRenderable(renderer, {
      id: "graph-content",
      flexGrow: 1,
      marginX: NAVIGATOR_HORIZONTAL_MARGIN,
      fg: theme.text,
      bg: theme.background,
      selectable: false,
      wrapMode: "none",
      content: "",
      onMouseDown: this.onContentMouseDown,
      onMouseUp: this.onContentMouseUp,
      onMouseScroll: this.onContentMouseScroll,
    })
    this.footerSeparator = new TextRenderable(renderer, {
      id: "footer-separator",
      width: "100%",
      height: SEPARATOR_HEIGHT,
      fg: theme.separator,
      bg: theme.background,
      selectable: false,
      wrapMode: "none",
      content: "",
    })
    this.footer = new TextRenderable(renderer, {
      id: "footer",
      height: FOOTER_HEIGHT,
      marginX: NAVIGATOR_HORIZONTAL_MARGIN,
      fg: theme.textMuted,
      bg: theme.background,
      selectable: false,
      wrapMode: "none",
      content: "",
      onMouseDown: this.onFooterMouseDown,
      onMouseUp: this.onFooterMouseUp,
    })
    this.navigator.add(this.header)
    this.navigator.add(this.headerSeparator)
    this.navigator.add(this.content)
    this.navigator.add(this.footerSeparator)
    this.navigator.add(this.footer)
    renderer.root.add(this.navigator)

    this.killOverlay = new BoxRenderable(renderer, {
      id: "kill-overlay",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      alignItems: "center",
      paddingTop: Math.floor(renderer.terminalHeight / 4),
      backgroundColor: RGBA.fromInts(0, 0, 0, 150),
      visible: false,
      zIndex: 3000,
      onMouseDown: (event) => {
        event.preventDefault()
        event.stopPropagation()
      },
      onMouseUp: (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.completeKillConfirmation("cancel")
      },
    })
    this.killDialog = new BoxRenderable(renderer, {
      id: "kill-dialog",
      width: 60,
      maxWidth: Math.max(1, renderer.terminalWidth - 2),
      paddingTop: 1,
      backgroundColor: theme.element,
      onMouseDown: (event) => {
        event.stopPropagation()
      },
      onMouseUp: (event) => {
        event.stopPropagation()
      },
    })
    const killContent = new BoxRenderable(renderer, {
      id: "kill-content",
      paddingLeft: 2,
      paddingRight: 2,
      rowGap: 1,
      backgroundColor: theme.element,
    })
    const killHeader = new BoxRenderable(renderer, {
      id: "kill-header",
      flexDirection: "row",
      justifyContent: "space-between",
      backgroundColor: theme.element,
    })
    const killTitle = new TextRenderable(renderer, {
      id: "kill-title",
      fg: theme.text,
      attributes: TextAttributes.BOLD,
      selectable: false,
      content: "Kill live session",
    })
    const killEscape = new TextRenderable(renderer, {
      id: "kill-escape",
      fg: theme.textMuted,
      selectable: false,
      content: "esc",
      onMouseUp: (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.completeKillConfirmation("cancel")
      },
    })
    killHeader.add(killTitle)
    killHeader.add(killEscape)

    this.killMessage = new TextRenderable(renderer, {
      id: "kill-message",
      fg: theme.textMuted,
      marginBottom: 1,
      selectable: false,
      wrapMode: "word",
      content: "",
    })
    const killActions = new BoxRenderable(renderer, {
      id: "kill-actions",
      flexDirection: "row",
      justifyContent: "flex-end",
      paddingBottom: 1,
      backgroundColor: theme.element,
    })
    this.killCancelButton = new BoxRenderable(renderer, {
      id: "kill-cancel",
      paddingLeft: 1,
      paddingRight: 1,
      onMouseUp: (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.completeKillConfirmation("cancel")
      },
    })
    this.killCancelLabel = new TextRenderable(renderer, {
      id: "kill-cancel-label",
      selectable: false,
      content: "Cancel",
    })
    this.killCancelButton.add(this.killCancelLabel)
    this.killConfirmButton = new BoxRenderable(renderer, {
      id: "kill-confirm",
      paddingLeft: 1,
      paddingRight: 1,
      onMouseUp: (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.completeKillConfirmation("kill")
      },
    })
    this.killConfirmLabel = new TextRenderable(renderer, {
      id: "kill-confirm-label",
      selectable: false,
      content: "Kill",
    })
    this.killConfirmButton.add(this.killConfirmLabel)
    killActions.add(this.killCancelButton)
    killActions.add(this.killConfirmButton)
    killContent.add(killHeader)
    killContent.add(this.killMessage)
    killContent.add(killActions)
    this.killDialog.add(killContent)
    this.killOverlay.add(this.killDialog)
    renderer.root.add(this.killOverlay)

    this.infoOverlay = new BoxRenderable(renderer, {
      id: "info-overlay",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: RGBA.fromInts(0, 0, 0, 150),
      visible: false,
      zIndex: 3000,
      onMouseDown: (event) => {
        event.preventDefault()
        event.stopPropagation()
      },
      onMouseUp: (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.closeInfoModal()
      },
    })
    this.infoDialog = new BoxRenderable(renderer, {
      id: "info-dialog",
      width: 76,
      height: 22,
      backgroundColor: theme.element,
      onMouseDown: (event) => {
        event.stopPropagation()
      },
      onMouseUp: (event) => {
        event.stopPropagation()
      },
    })
    const infoContent = new BoxRenderable(renderer, {
      id: "info-content",
      width: "100%",
      height: "100%",
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      backgroundColor: theme.element,
    })
    const infoHeader = new BoxRenderable(renderer, {
      id: "info-header",
      flexDirection: "row",
      justifyContent: "space-between",
      backgroundColor: theme.element,
    })
    this.infoTitle = new TextRenderable(renderer, {
      id: "info-title",
      fg: theme.text,
      attributes: TextAttributes.BOLD,
      selectable: false,
      content: "",
    })
    const infoEscape = new TextRenderable(renderer, {
      id: "info-escape",
      fg: theme.textMuted,
      selectable: false,
      content: "esc",
      onMouseUp: (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.closeInfoModal()
      },
    })
    infoHeader.add(this.infoTitle)
    infoHeader.add(infoEscape)
    this.infoTab = new TextRenderable(renderer, {
      id: "info-tab",
      marginTop: 1,
      bg: theme.element,
      selectable: false,
      content: styledText([
        chunk(" About ", theme.selectedText, TextAttributes.BOLD, theme.primary),
      ]),
    })
    this.infoTabSeparator = new TextRenderable(renderer, {
      id: "info-tab-separator",
      fg: theme.separator,
      bg: theme.element,
      selectable: false,
      wrapMode: "none",
      content: "",
    })
    this.infoBody = new TextRenderable(renderer, {
      id: "info-body",
      flexGrow: 1,
      marginTop: 1,
      fg: theme.textMuted,
      bg: theme.element,
      selectable: false,
      wrapMode: "word",
      content: "",
    })
    const infoActions = new BoxRenderable(renderer, {
      id: "info-actions",
      flexDirection: "row",
      justifyContent: "center",
      backgroundColor: theme.element,
    })
    const infoCloseButton = new BoxRenderable(renderer, {
      id: "info-close",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: theme.primary,
      onMouseUp: (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.closeInfoModal()
      },
    })
    infoCloseButton.add(
      new TextRenderable(renderer, {
        id: "info-close-label",
        fg: theme.selectedText,
        attributes: TextAttributes.BOLD,
        selectable: false,
        content: "esc close",
      }),
    )
    infoActions.add(infoCloseButton)
    infoContent.add(infoHeader)
    infoContent.add(this.infoTab)
    infoContent.add(this.infoTabSeparator)
    infoContent.add(this.infoBody)
    infoContent.add(infoActions)
    this.infoDialog.add(infoContent)
    this.infoOverlay.add(this.infoDialog)
    renderer.root.add(this.infoOverlay)
  }

  static async create(
    renderer: CliRenderer,
    projectDirectory: string,
    provider: AgentProvider,
    stateHome?: string,
  ): Promise<AgentTreeApp> {
    const metadata = await BranchMetadataStore.openForProvider(projectDirectory, provider.id, stateHome)
    const relations = await metadata.loadRelations()
    return new AgentTreeApp(renderer, metadata, provider, relations)
  }

  async run(): Promise<void> {
    this.renderer.keyInput.on("keypress", this.onKeyPress)
    this.renderer.keyInput.on("keyrelease", this.onKeyRelease)
    this.renderer.on(CliRenderEvents.RESIZE, this.onResize)
    await Promise.race([this.refreshData(), this.stopped])
    if (this.stopping) return
    this.renderer.start()
    this.render()
    await this.stopped
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.performStop()
    void this.stopPromise.catch(() => undefined)
    return this.stopPromise
  }

  private async performStop(): Promise<void> {
    this.stopping = true
    this.cancelActiveRefresh()
    try {
      this.renderer.keyInput.off("keypress", this.onKeyPress)
      this.renderer.keyInput.off("keyrelease", this.onKeyRelease)
      this.renderer.off(CliRenderEvents.RESIZE, this.onResize)
      this.stopSpinnerAnimation()
      if (this.completionRefreshTimer) clearTimeout(this.completionRefreshTimer)
      this.completionRefreshTimer = undefined
      this.pendingCompletionRefreshes.clear()

      const terminalShutdown = this.terminalManager.shutdown()
      this.renderer.destroy()
      await terminalShutdown
    } finally {
      if (!this.renderer.isDestroyed) this.renderer.destroy()
      this.resolveStopped()
    }
  }

  private readonly onResize = () => {
    this.graphViewportOffset = null
    this.graphNavigationIntent = null
    this.render()
  }

  private onTerminalExited(event: TerminalExitEvent): void {
    if (this.stopping) return
    if (this.killConfirmation?.sessionId === event.sessionId) {
      this.killConfirmation = null
    }
    this.pendingCompletionRefreshes.delete(event.sessionId)
    if (event.wasActive) {
      this.view = "roots"
      this.navigator.visible = true
    }
    const exitError =
      event.exitCode === 0
        ? undefined
        : `${this.provider.displayName} session exited with code ${event.exitCode}`
    void this.refreshData(event.wasActive ? event.sessionId : undefined)
      .then(() => {
        if (exitError) this.showError(exitError)
      })
      .catch((error) => {
        const refreshError = error instanceof Error ? error.message : String(error)
        this.showError(exitError ? `${exitError}; refresh failed: ${refreshError}` : refreshError)
      })
  }

  private onTerminalActivityChanged(event: TerminalActivityEvent): void {
    if (this.stopping) return
    if (event.activity === "working") {
      this.pendingCompletionRefreshes.delete(event.sessionId)
      if (this.view !== "terminal") this.render()
      return
    }
    this.pendingCompletionRefreshes.set(event.sessionId, ++this.completionRefreshVersion)
    this.scheduleCompletionRefresh()
    if (this.view !== "terminal") this.render()
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
    if (this.infoModal) {
      this.handleInfoModalKey(key)
      return
    }
    if (this.killConfirmation) {
      this.handleKillConfirmationKey(key)
      return
    }
    if (key.name === "?" && !key.repeated) {
      key.stopPropagation()
      this.showAbout()
      return
    }

    if (this.view === "roots") {
      this.handleRootKey(key)
    } else {
      this.handleGraphKey(key)
    }
  }

  private readonly onContentMouseDown = (event: MouseEvent) => {
    this.pendingMouseAction = null
    if (
      event.button !== 0 ||
      this.interactionBlocked() ||
      this.hasModal() ||
      this.view === "terminal"
    ) {
      return
    }
    const action = this.contentMouseActionAt(event)
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    this.pendingMouseAction = action
  }

  private readonly onContentMouseUp = (event: MouseEvent) => {
    const pending = this.pendingMouseAction
    this.pendingMouseAction = null
    if (
      event.button !== 0 ||
      this.interactionBlocked() ||
      this.hasModal() ||
      this.view === "terminal" ||
      !pending
    ) {
      return
    }
    const action = this.contentMouseActionAt(event)
    if (!action || !sameMouseAction(pending, action)) return
    event.preventDefault()
    event.stopPropagation()

    if (action.kind === "root") {
      if (action.rootIndex === this.selectedRootIndex) {
        this.enterSelectedRoot()
      } else {
        this.selectedRootIndex = action.rootIndex
        this.render()
      }
    } else if (action.nodeId === this.selectedGraphNodeId) {
      void this.runAction(() => this.openSelectedLeaf())
    } else {
      this.selectedGraphNodeId = action.nodeId
      this.preferredOpenSession = null
      this.graphNavigationIntent = null
      this.render()
    }
  }

  private contentMouseActionAt(event: MouseEvent): ContentMouseAction | undefined {
    const localX = event.x - this.content.screenX
    const localY = event.y - this.content.screenY
    if (localX < 0 || localY < 0) return undefined
    if (this.view === "roots") {
      const rootIndex = this.rootViewportStart + localY
      return rootIndex >= this.rootViewportStart && rootIndex < this.forest.graphs.length
        ? { kind: "root", rootIndex }
        : undefined
    }
    if (!this.graphLayout || !this.graphViewportOffset) return undefined
    const positioned = graphNodeAt(
      this.graphLayout,
      this.graphViewportOffset.x + localX,
      this.graphViewportOffset.y + localY,
    )
    return positioned ? { kind: "graph", nodeId: positioned.node.id } : undefined
  }

  private readonly onContentMouseScroll = (event: MouseEvent) => {
    if (this.interactionBlocked() || this.hasModal() || this.view !== "roots") return
    const direction = event.scroll?.direction
    if (direction !== "up" && direction !== "down") return
    event.preventDefault()
    event.stopPropagation()
    const distance = Math.max(1, Math.round(event.scroll?.delta ?? 1))
    this.moveRoot(direction === "up" ? -distance : distance)
  }

  private readonly onFooterMouseDown = (event: MouseEvent) => {
    this.pendingMouseAction = null
    if (event.button !== 0 || this.hasModal() || this.view === "terminal") return
    const action = this.footerMouseActionAt(event)
    if (!action || !this.footerActionAvailable(action.action)) return
    event.preventDefault()
    event.stopPropagation()
    this.pendingMouseAction = action
  }

  private readonly onFooterMouseUp = (event: MouseEvent) => {
    const pending = this.pendingMouseAction
    this.pendingMouseAction = null
    if (
      event.button !== 0 ||
      this.hasModal() ||
      this.view === "terminal" ||
      pending?.kind !== "footer"
    ) {
      return
    }
    const action = this.footerMouseActionAt(event)
    if (!action || action.action !== pending.action || !this.footerActionAvailable(action.action)) return
    event.preventDefault()
    event.stopPropagation()
    this.runFooterAction(action.action)
  }

  private footerMouseActionAt(event: MouseEvent): FooterMouseAction | undefined {
    const localX = event.x - this.footer.screenX
    const localY = event.y - this.footer.screenY
    if (localY !== 0) return undefined
    const hit = this.footerHitRegions.find(
      (region) => localX >= region.startX && localX < region.endX,
    )
    return hit ? { kind: "footer", action: hit.action } : undefined
  }

  private runFooterAction(action: FooterAction): void {
    if (action === "enter-root") {
      this.enterSelectedRoot()
    } else if (action === "new") {
      void this.runAction(() => this.newSession())
    } else if (action === "refresh") {
      void this.requestRefresh()
    } else if (action === "quit") {
      void this.stop()
    } else if (action === "open") {
      void this.runAction(() => this.openSelectedLeaf())
    } else if (action === "fork") {
      void this.runAction(() => this.forkSelectedNode())
    } else if (action === "kill") {
      this.showKillConfirmation()
    } else if (action === "roots") {
      this.showRoots()
    } else if (action === "about") {
      this.showAbout()
    }
  }

  private handleRootKey(key: KeyEvent): void {
    const quit = key.name === "q" || (key.name === "c" && key.ctrl)
    const recognized =
      quit || ["up", "down", "k", "j", "return", "n", "r"].includes(key.name)
    if (!recognized) return
    key.stopPropagation()

    if (quit) {
      void this.stop()
    } else if (key.name === "r" && !key.repeated && !this.busy) {
      void this.requestRefresh()
    } else if (this.interactionBlocked()) {
      return
    } else if (key.name === "up" || key.name === "k") {
      this.moveRoot(-1)
    } else if (key.name === "down" || key.name === "j") {
      this.moveRoot(1)
    } else if (key.name === "return" && !key.repeated) {
      this.enterSelectedRoot()
    } else if (key.name === "n" && !key.repeated) {
      void this.runAction(() => this.newSession())
    }
  }

  private handleGraphKey(key: KeyEvent): void {
    const exit = key.name === "c" && key.ctrl
    const back = key.name === "q" || key.name === "escape"
    const recognized =
      exit ||
      back ||
      ["up", "down", "left", "right", "k", "j", "h", "l", "return", "f", "x", "n", "r"].includes(
        key.name,
      )
    if (!recognized) return
    key.stopPropagation()

    if (exit) {
      void this.stop()
    } else if (key.name === "r" && !key.repeated && !this.busy) {
      void this.requestRefresh()
    } else if (this.interactionBlocked()) {
      return
    } else if (back) {
      this.showRoots()
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
    } else if (key.name === "x" && !key.repeated) {
      this.showKillConfirmation()
    } else if (key.name === "n" && !key.repeated) {
      void this.runAction(() => this.newSession())
    }
  }

  private handleInfoModalKey(key: KeyEvent): void {
    key.stopPropagation()
    if (key.name === "c" && key.ctrl) {
      void this.stop()
      return
    }
    if (
      key.name === "escape" ||
      key.name === "q" ||
      key.name === "return" ||
      (key.name === "?" && !key.repeated)
    ) {
      this.closeInfoModal()
    }
  }

  private handleKillConfirmationKey(key: KeyEvent): void {
    const confirmation = this.killConfirmation
    if (!confirmation) return
    key.stopPropagation()
    if (key.name === "c" && key.ctrl) {
      void this.stop()
      return
    }
    if (key.name === "q" || key.name === "escape") {
      this.completeKillConfirmation("cancel")
      return
    }
    if (
      key.name === "tab" ||
      key.name === "left" ||
      key.name === "right" ||
      key.name === "up" ||
      key.name === "down" ||
      key.name === "h" ||
      key.name === "j" ||
      key.name === "k" ||
      key.name === "l"
    ) {
      confirmation.choice = confirmation.choice === "kill" ? "cancel" : "kill"
      this.render()
      return
    }
    if (key.name !== "return" || key.repeated) return

    this.completeKillConfirmation(confirmation.choice)
  }

  private completeKillConfirmation(choice: "kill" | "cancel"): void {
    const confirmation = this.killConfirmation
    if (!confirmation) return
    this.killConfirmation = null
    if (choice === "kill") {
      void this.runAction(() => this.killLiveSession(confirmation.sessionId))
      return
    }
    this.render()
  }

  private showKillConfirmation(): void {
    if (this.interactionBlocked() || this.view !== "graph") return
    const selected = this.selectedGraphNode()
    if (
      selected?.kind !== "endpoint" ||
      !this.terminalManager.runningSessionIds().has(selected.session.id)
    ) {
      this.showError("Select a live Draft or Agent to kill")
      return
    }

    const sessionId = selected.session.id
    this.killConfirmation = {
      sessionId,
      kind: this.displayedWorkingSessionIds().has(sessionId) ? "working" : "draft",
      choice: "kill",
    }
    this.pendingMouseAction = null
    this.render()
  }

  private async runAction(action: () => Promise<unknown>): Promise<void> {
    this.busy = true
    this.render()
    try {
      await action()
    } catch (error) {
      this.showError(error)
    } finally {
      this.busy = false
      this.scheduleCompletionRefresh()
      this.render()
    }
  }

  private showAbout(): void {
    this.infoModal = { kind: "about" }
    this.pendingMouseAction = null
    this.render()
  }

  private showError(error: unknown): void {
    if (isAbortError(error) || this.stopping) return
    this.infoModal = {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    }
    this.killConfirmation = null
    this.pendingMouseAction = null
    this.render()
  }

  private closeInfoModal(): void {
    if (!this.infoModal) return
    this.infoModal = null
    this.render()
  }

  private hasModal(): boolean {
    return this.killConfirmation !== null || this.infoModal !== null
  }

  private interactionBlocked(): boolean {
    return this.busy || this.activeRefresh !== null
  }

  private footerActionAvailable(action: FooterAction): boolean {
    if (action === "quit" || action === "about") return true
    if (action === "refresh") return !this.busy
    return !this.interactionBlocked()
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
    const runningSessionIds = this.terminalManager.runningSessionIds()
    const selectedNodeId = initialVisibleGraphNodeId(graph, runningSessionIds)
    if (!selectedNodeId) {
      const endpointId = graph.endpointBySessionId.get(graph.rootSessionId)
      const endpoint = endpointId ? graph.nodes.get(endpointId) : undefined
      if (endpoint?.kind === "endpoint") {
        void this.runAction(() => this.openEndpoint(endpoint))
      }
      return
    }
    this.currentRootSessionId = graph.rootSessionId
    this.selectedGraphNodeId = selectedNodeId
    this.preferredOpenSession = null
    this.graphViewportOffset = null
    this.graphNavigationIntent = null
    this.view = "graph"
    this.render()
    if (graph.warnings[0]) this.showError(graph.warnings[0])
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
    this.preferredOpenSession = null
    this.graphViewportOffset = null
    this.graphNavigationIntent = move.intent
    this.render()
  }

  private showRoots(): void {
    this.view = "roots"
    this.preferredOpenSession = null
    this.graphViewportOffset = null
    this.graphNavigationIntent = null
    this.render()
  }

  private async requestRefresh(focusSessionId?: string, showWarnings = true): Promise<boolean> {
    try {
      return await this.refreshData(focusSessionId, showWarnings)
    } catch (error) {
      this.showError(error)
      return false
    }
  }

  private async refreshData(focusSessionId?: string, showWarnings = true): Promise<boolean> {
    const effectiveFocusSessionId = focusSessionId ?? this.activeRefresh?.focusSessionId
    this.cancelActiveRefresh()
    const generation = ++this.refreshGeneration
    const controller = new AbortController()
    const refresh: ActiveRefresh = {
      generation,
      controller,
      ...(effectiveFocusSessionId === undefined
        ? {}
        : { focusSessionId: effectiveFocusSessionId }),
    }
    this.activeRefresh = refresh
    const pendingCompletions = new Map(this.pendingCompletionRefreshes)
    this.render()

    try {
      const discovered = await abortable(this.provider.listSessions(), controller.signal)
      if (!this.refreshCurrent(refresh)) return false

      const discoveredIds = new Set(discovered.map((session) => session.id))
      const runningIds = this.terminalManager.runningSessionIds()
      const retainedTemporarySessions = [...this.temporarySessions.values()].filter(
        (session) =>
          !discoveredIds.has(session.id) && (!session.transient || runningIds.has(session.id)),
      )
      const sessions = [...discovered, ...retainedTemporarySessions]

      const transcriptEntries = await Promise.all(
        sessions.map(async (session) => {
          if (session.transient) return [session.id, [] as AgentMessage[]] as const
          const transcript = await abortable(
            this.provider.readTranscript(session.id),
            controller.signal,
          )
          return [session.id, transcript] as const
        }),
      )
      if (!this.refreshCurrent(refresh)) return false
      const previousRootSessionId = this.currentRootSessionId
      const previousNodeId = this.selectedGraphNodeId
      const previousSelectedRoot = this.forest.graphs[this.selectedRootIndex]?.rootSessionId
      const retainedTemporarySessionIds = new Set(
        retainedTemporarySessions.map((session) => session.id),
      )
      for (const sessionId of this.temporarySessions.keys()) {
        if (!retainedTemporarySessionIds.has(sessionId)) {
          this.temporarySessions.delete(sessionId)
        }
      }
      this.sessions = sessions
      this.transcripts = new Map(transcriptEntries)
      this.forest = buildConversationForest(this.sessions, this.transcripts, this.relations)
      this.graphViewportOffset = null
      this.graphNavigationIntent = null

      const focusedGraph = effectiveFocusSessionId
        ? this.forest.graphBySessionId.get(effectiveFocusSessionId)
        : undefined
      const preservedGraph = previousRootSessionId
        ? this.forest.graphBySessionId.get(previousRootSessionId)
        : undefined
      const graph = focusedGraph ?? preservedGraph
      if (graph) {
        this.selectedRootIndex = this.forest.graphs.indexOf(graph)
        const requestedNodeId =
          (effectiveFocusSessionId
            ? graph.endpointBySessionId.get(effectiveFocusSessionId)
            : undefined) ??
          (previousNodeId && graph.nodes.has(previousNodeId) ? previousNodeId : graph.rootNodeId)
        const selectedNodeId =
          visibleGraphNodeId(graph, requestedNodeId, runningIds) ??
          initialVisibleGraphNodeId(graph, runningIds)
        if (selectedNodeId) {
          this.currentRootSessionId = graph.rootSessionId
          this.selectedGraphNodeId = selectedNodeId
          if (effectiveFocusSessionId) this.view = "graph"
        } else {
          this.currentRootSessionId = null
          this.selectedGraphNodeId = null
          this.view = "roots"
        }
      } else {
        this.currentRootSessionId = null
        this.selectedGraphNodeId = null
        this.view = "roots"
        const preservedRootIndex = previousSelectedRoot
          ? this.forest.graphs.findIndex(
              (candidate) => candidate.rootSessionId === previousSelectedRoot,
            )
          : -1
        this.selectedRootIndex = preservedRootIndex >= 0 ? preservedRootIndex : 0
      }

      this.clearPendingCompletions(pendingCompletions)
      if (showWarnings && this.forest.warnings[0]) this.showError(this.forest.warnings[0])
      return true
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return false
      throw error
    } finally {
      if (this.activeRefresh === refresh) {
        this.activeRefresh = null
        this.render()
        this.scheduleCompletionRefresh()
      }
    }
  }

  private refreshCurrent(refresh: ActiveRefresh): boolean {
    return (
      this.activeRefresh === refresh &&
      refresh.generation === this.refreshGeneration &&
      !refresh.controller.signal.aborted &&
      !this.stopping
    )
  }

  private cancelActiveRefresh(): void {
    this.activeRefresh?.controller.abort()
    this.activeRefresh = null
    this.refreshGeneration += 1
  }

  private async newSession(): Promise<void> {
    const prepared = await this.provider.prepareNewSession()
    this.temporarySessions.set(prepared.session.id, prepared.session)
    await this.openTerminal(prepared.launch)
  }

  private async openSelectedLeaf(): Promise<void> {
    const graph = this.currentGraph()
    const selected = this.selectedGraphNode()
    if (!graph || !selected) return

    let endpoint = selected.kind === "endpoint" ? selected : undefined
    if (!endpoint) {
      const endpoints = selected.childIds
        .map((childId) => graph.nodes.get(childId))
        .filter((node): node is SessionEndpointNode => node?.kind === "endpoint")
        .sort(compareSessionEndpoints)
      const preferred = this.preferredOpenSession
      endpoint =
        preferred?.nodeId === selected.id
          ? endpoints.find(
              (candidate) => candidate.session.id === preferred.sessionId,
            ) ?? endpoints[0]
          : endpoints[0]
    }
    if (endpoint?.kind !== "endpoint") {
      this.showError(`This message is not the end of a ${this.provider.displayName} session`)
      return
    }

    await this.openEndpoint(endpoint)
  }

  private async openEndpoint(endpoint: SessionEndpointNode): Promise<void> {
    await this.openTerminal(await this.provider.prepareResume(endpoint.session))
    this.preferredOpenSession = null
  }

  private async killLiveSession(sessionId: string): Promise<void> {
    const graph = this.currentGraph()
    const endpointId = graph?.endpointBySessionId.get(sessionId)
    const request = this.terminalManager.stopSession(sessionId)
    if (!request) {
      throw new Error(`The selected ${this.provider.displayName} session is no longer running`)
    }

    this.cancelActiveRefresh()
    this.pendingCompletionRefreshes.delete(sessionId)
    if (this.pendingCompletionRefreshes.size === 0 && this.completionRefreshTimer) {
      clearTimeout(this.completionRefreshTimer)
      this.completionRefreshTimer = undefined
    }
    if (graph && endpointId && this.selectedGraphNodeId === endpointId) {
      const fallbackNodeId = visibleGraphNodeId(
        graph,
        endpointId,
        this.terminalManager.runningSessionIds(),
      )
      if (fallbackNodeId) {
        this.selectedGraphNodeId = fallbackNodeId
        this.graphViewportOffset = null
        this.graphNavigationIntent = null
      } else {
        this.currentRootSessionId = null
        this.selectedGraphNodeId = null
        this.view = "roots"
      }
    }
    this.render()

    await request.completion
    if (this.stopping) return
    const refreshed = await this.refreshData(sessionId, false)
    if (!refreshed) return
    this.preferredOpenSession = this.selectedGraphNodeId
      ? { nodeId: this.selectedGraphNodeId, sessionId }
      : null
  }

  private async forkSelectedNode(): Promise<void> {
    const graph = this.currentGraph()
    if (!graph || !this.selectedGraphNodeId) return
    const target = resolveForkTarget(graph, this.selectedGraphNodeId)
    if (!target) {
      this.showError("This node has no historical message to fork")
      return
    }
    if (!this.provider.branchFrom) {
      this.showError(`${this.provider.displayName} does not support historical branching`)
      return
    }

    const prepared = await this.provider.branchFrom(target)

    let relation: BranchRelation
    try {
      relation = await this.metadata.saveRelation(prepared.derivation)
    } catch (error) {
      if (!prepared.providerSessionCreated) throw error
      throw new Error(
        `Fork ${prepared.session.id} was created, but ancestry could not be saved: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    this.relations.push(relation)
    this.temporarySessions.set(prepared.session.id, prepared.session)
    if (!prepared.session.transient) await this.refreshData(prepared.session.id)
    await this.openTerminal(prepared.launch)
  }

  private async openTerminal(launch: TerminalLaunch): Promise<void> {
    if (this.stopping) throw new Error("claude-tree is shutting down")
    await this.terminalManager.show(launch)
    this.view = "terminal"
    this.navigator.visible = false
    this.stopSpinnerAnimation()
  }

  private async returnToGraph(): Promise<void> {
    const sessionId = this.terminalManager.hideActive()
    this.view = "roots"
    this.navigator.visible = true
    await this.requestRefresh(sessionId ?? undefined)
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
    if (this.renderer.isDestroyed) return
    this.updateSpinnerAnimation()
    if (this.view === "terminal") {
      this.killOverlay.visible = false
      this.infoOverlay.visible = false
      return
    }
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
    this.headerSeparator.visible = !tooSmall
    this.footerSeparator.visible = !tooSmall
    this.footer.visible = !tooSmall
    this.killOverlay.visible = false
    this.infoOverlay.visible = false
    if (tooSmall) {
      this.killConfirmation = null
      this.infoModal = null
      this.graphLayout = null
      this.graphViewportOffset = null
      this.graphNavigationIntent = null
      this.footerHitRegions = []
      return
    }

    const separator = styledText([
      chunk("─".repeat(this.renderer.terminalWidth), theme.separator),
    ])
    this.headerSeparator.content = separator
    this.footerSeparator.content = separator
    const contentHeight = Math.max(
      1,
      this.renderer.terminalHeight - NAVIGATOR_CHROME_HEIGHT,
    )
    const contentWidth =
      this.renderer.terminalWidth - NAVIGATOR_HORIZONTAL_MARGIN * 2
    if (this.view === "roots") {
      this.graphLayout = null
      this.graphViewportOffset = null
      this.graphNavigationIntent = null
      const rendered = renderRootPicker(
        this.forest.graphs,
        this.selectedRootIndex,
        contentHeight,
        contentWidth,
        this.terminalManager.runningSessionIds(),
        this.rootViewportStart,
      )
      this.rootViewportStart = rendered.startIndex
      this.content.content = rendered.content
      const footer = this.renderRootFooter()
      this.footer.content = footer.content
      this.footerHitRegions = footer.hitRegions
    } else {
      const graph = this.currentGraph()
      if (!graph || !this.selectedGraphNodeId) {
        this.graphLayout = null
        this.graphViewportOffset = null
        this.footerHitRegions = []
        return
      }
      const rendered = renderConversationGraph(
        graph,
        this.selectedGraphNodeId,
        contentWidth,
        contentHeight,
        this.terminalManager.runningSessionIds(),
        this.terminalManager.draftPreviews(),
        this.displayedWorkingSessionIds(),
        this.spinnerFrame,
        this.graphViewportOffset ?? undefined,
      )
      this.graphLayout = rendered.layout
      this.graphViewportOffset = { x: rendered.offsetX, y: rendered.offsetY }
      this.content.content = rendered.content
      const footer = this.renderGraphFooter()
      this.footer.content = footer.content
      this.footerHitRegions = footer.hitRegions
    }
    this.renderKillOverlay()
    this.renderInfoOverlay()
  }

  private renderKillOverlay(): void {
    const confirmation = this.killConfirmation
    if (!confirmation || this.view !== "graph") {
      if (this.view !== "graph") this.killConfirmation = null
      this.killOverlay.visible = false
      return
    }

    const message =
      confirmation.kind === "working"
        ? "Interrupt this working Agent?\nPersisted response text remains resumable."
        : "Kill this Draft?\nIts unsent text will be discarded."
    const killSelected = confirmation.choice === "kill"
    this.killOverlay.paddingTop = Math.floor(this.renderer.terminalHeight / 4)
    this.killDialog.maxWidth = Math.max(1, this.renderer.terminalWidth - 2)
    this.killMessage.content = message
    this.killCancelButton.backgroundColor = killSelected ? undefined : theme.primary
    this.killCancelLabel.fg = killSelected ? theme.textMuted : theme.selectedText
    this.killConfirmButton.backgroundColor = killSelected ? theme.primary : undefined
    this.killConfirmLabel.fg = killSelected ? theme.selectedText : theme.textMuted
    this.killOverlay.visible = true
  }

  private renderInfoOverlay(): void {
    const modal = this.infoModal
    if (!modal) {
      this.infoOverlay.visible = false
      return
    }

    const horizontalMargin = 4
    const verticalMargin = 2
    const about = modal.kind === "about"
    const width = Math.max(
      1,
      Math.min(about ? 76 : 60, this.renderer.terminalWidth - horizontalMargin),
    )
    const height = Math.max(
      1,
      Math.min(about ? 22 : 9, this.renderer.terminalHeight - verticalMargin),
    )
    this.infoDialog.width = width
    this.infoDialog.height = height
    this.infoTitle.content = about ? "Settings" : "Error"
    this.infoTab.visible = about
    this.infoTabSeparator.visible = about
    this.infoTabSeparator.content = "─".repeat(Math.max(1, width - 4))
    this.infoBody.content = about ? this.aboutContent() : modal.message
    this.infoOverlay.visible = true
  }

  private aboutContent(): StyledText {
    const background = theme.element
    const chunks = [
      chunk(PROGRAM_NAME, theme.text, TextAttributes.BOLD, background),
      chunk(`\nVersion ${PROGRAM_VERSION}`, theme.textMuted, TextAttributes.NONE, background),
      chunk(
        "\n\nNote: Branches are not isolated. All conversations share this working directory and can modify the same files.",
        theme.warning,
        TextAttributes.NONE,
        background,
      ),
    ]
    return styledText(chunks)
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
    const title = graph ? graphTitle(graph) : "Conversation"
    return styledText([
      ...identity,
      chunk(truncateToWidth(title, Math.max(1, this.renderer.terminalWidth - 18)), theme.text, TextAttributes.BOLD),
      chunk("  Message graph", theme.textMuted),
    ])
  }

  private renderRootFooter(): RenderedFooter {
    const controls = renderControls(ROOT_FOOTER_CONTROLS, this.refreshSpinnerFrame())
    const selected = this.forest.graphs[this.selectedRootIndex]
    const runningSessionIds = this.terminalManager.runningSessionIds()
    const live = selected
      ? [...selected.sessionIds].some((sessionId) => runningSessionIds.has(sessionId))
      : false
    const prefixWidth = live ? displayWidth("● Live · ") : 0
    const title = truncateToWidth(
      selected ? graphTitle(selected) : "",
      Math.max(1, this.renderer.terminalWidth - NAVIGATOR_HORIZONTAL_MARGIN * 2 - prefixWidth),
    )
    return {
      content: styledText([
        ...controls.chunks,
        chunk("\n", theme.text),
        ...(live
          ? [
              chunk("● Live", theme.success, TextAttributes.BOLD),
              chunk(" · ", theme.textMuted),
            ]
          : []),
        chunk(title, theme.textMuted),
      ]),
      hitRegions: controls.hitRegions,
    }
  }

  private renderGraphFooter(): RenderedFooter {
    const controls = renderControls(GRAPH_FOOTER_CONTROLS, this.refreshSpinnerFrame())
    return {
      content: styledText([
        ...controls.chunks,
        chunk("\n", theme.text),
        chunk(this.selectedDescription(), theme.textMuted),
      ]),
      hitRegions: controls.hitRegions,
    }
  }

  private refreshSpinnerFrame(): string | undefined {
    return this.activeRefresh
      ? REFRESH_SPINNER_FRAMES[this.spinnerFrame % REFRESH_SPINNER_FRAMES.length]
      : undefined
  }

  private selectedDescription(): string {
    const selected = this.selectedGraphNode()
    if (!selected) return "No node selected"
    if (selected.kind === "endpoint") {
      if (this.displayedWorkingSessionIds().has(selected.session.id)) {
        return `Selected agent · generating · ${selected.session.id.slice(0, 8)}`
      }
      const draft = this.terminalManager.draftPreviews().get(selected.session.id)
      const draftDescription = draft ? draft.text.replace(/\s+/g, " ").trim() : "blank"
      const description = truncateToWidth(
        draftDescription,
        Math.max(20, this.renderer.terminalWidth - 32),
      )
      return `Selected draft · ${description} · ${selected.session.id.slice(0, 8)}`
    }
    const role = selected.internal
      ? "internal"
      : selected.role === "agent"
        ? "agent"
        : selected.role === "user"
          ? "user"
          : "system"
    return `Selected ${role} · ${truncateToWidth(selected.preview, Math.max(20, this.renderer.terminalWidth - 24))}`
  }

  private updateSpinnerAnimation(): void {
    const graph = this.currentGraph()
    const workingSessionIds = this.displayedWorkingSessionIds()
    const graphShouldAnimate =
      this.view === "graph" &&
      graph !== undefined &&
      [...graph.sessionIds].some((sessionId) => workingSessionIds.has(sessionId))
    const shouldAnimate =
      this.view !== "terminal" &&
      this.renderer.terminalWidth >= MINIMUM_WIDTH &&
      this.renderer.terminalHeight >= MINIMUM_HEIGHT &&
      (this.activeRefresh !== null || graphShouldAnimate)
    if (!shouldAnimate) {
      this.stopSpinnerAnimation()
      return
    }
    if (this.spinnerTimer) return
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame += 1
      this.render()
    }, SPINNER_INTERVAL_MS)
  }

  private stopSpinnerAnimation(): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer)
    this.spinnerTimer = undefined
    this.spinnerFrame = 0
  }

  private displayedWorkingSessionIds(): Set<string> {
    const runningSessionIds = this.terminalManager.runningSessionIds()
    const workingSessionIds = this.terminalManager.workingSessionIds()
    for (const sessionId of this.pendingCompletionRefreshes.keys()) {
      if (runningSessionIds.has(sessionId)) workingSessionIds.add(sessionId)
    }
    return workingSessionIds
  }

  private scheduleCompletionRefresh(): void {
    if (
      this.stopping ||
      this.busy ||
      this.activeRefresh !== null ||
      this.completionRefreshRunning ||
      this.completionRefreshTimer ||
      this.pendingCompletionRefreshes.size === 0
    ) {
      return
    }
    this.completionRefreshTimer = setTimeout(() => {
      this.completionRefreshTimer = undefined
      if (this.busy || this.activeRefresh) {
        this.scheduleCompletionRefresh()
        return
      }
      void this.refreshCompletedSessions()
    }, COMPLETION_REFRESH_DELAY_MS)
  }

  private async refreshCompletedSessions(): Promise<void> {
    if (this.stopping || this.completionRefreshRunning) return
    const refreshes = new Map(this.pendingCompletionRefreshes)
    if (refreshes.size === 0) return
    this.completionRefreshRunning = true
    let failed = false
    try {
      await this.refreshData(undefined, false)
    } catch (error) {
      failed = true
      this.showError(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (failed) this.clearPendingCompletions(refreshes)
      this.completionRefreshRunning = false
      this.render()
      this.scheduleCompletionRefresh()
    }
  }

  private clearPendingCompletions(completions: Map<string, number>): void {
    for (const [sessionId, version] of completions) {
      if (this.pendingCompletionRefreshes.get(sessionId) === version) {
        this.pendingCompletionRefreshes.delete(sessionId)
      }
    }
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

function renderControls(controls: FooterControl[], refreshKey?: string): {
  chunks: TextChunk[]
  hitRegions: FooterHitRegion[]
} {
  const chunks: TextChunk[] = []
  const hitRegions: FooterHitRegion[] = []
  let x = 0
  for (const [index, control] of controls.entries()) {
    if (index > 0) {
      chunks.push(chunk(" ", theme.textMuted))
      x += 1
    }
    const key = control.action === "refresh" && refreshKey ? refreshKey : control.key
    const text = `${key} ${control.description}`
    const endX = x + displayWidth(text)
    chunks.push(
      chunk(key, theme.text, TextAttributes.BOLD),
      chunk(` ${control.description}`, theme.textMuted),
    )
    if (control.action) hitRegions.push({ startX: x, endX, action: control.action })
    x = endX
  }
  return { chunks, hitRegions }
}

function graphTitle(graph: ConversationGraph): string {
  const rootEndpointId = graph.endpointBySessionId.get(graph.rootSessionId)
  const rootEndpoint = rootEndpointId ? graph.nodes.get(rootEndpointId) : undefined
  return rootEndpoint?.kind === "endpoint" ? rootEndpoint.session.title : "Conversation"
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

function abortError(): Error {
  const error = new Error("Refresh aborted")
  error.name = "AbortError"
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function sameMouseAction(left: PendingMouseAction, right: PendingMouseAction): boolean {
  if (left.kind === "root" && right.kind === "root") return left.rootIndex === right.rootIndex
  if (left.kind === "graph" && right.kind === "graph") return left.nodeId === right.nodeId
  if (left.kind === "footer" && right.kind === "footer") return left.action === right.action
  return false
}

function compareSessionEndpoints(left: SessionEndpointNode, right: SessionEndpointNode): number {
  return (
    right.session.lastModified - left.session.lastModified ||
    left.session.id.localeCompare(right.session.id)
  )
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
