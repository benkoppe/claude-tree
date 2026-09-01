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

import {
  BranchCreatedError,
  type AgentMessage,
  type AgentProvider,
  type AgentSession,
  type PreparedBranch,
  type TerminalLaunch,
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
  topVisibleGraphNodeId,
  type ConversationGraphLayout,
  type GraphDirection,
  type GraphNavigationIntent,
  visibleGraphNodeId,
} from "./graph-layout"
import {
  buildConversationForest,
  reachableSessionEndpoints,
  resolveForkTarget,
  visibleConversationForest,
  type ConversationForest,
  type ConversationGraph,
  type MessageGraphNodeOrEndpoint,
  type ReachableSessionEndpoint,
  type SessionEndpointNode,
} from "./message-graph"
import {
  isEnterKey,
  isShiftedKey,
  isUnmodifiedKey,
  listNavigationDelta,
} from "./list-navigation"
import {
  BranchMetadataStore,
  type BranchRelation,
  type ConversationRemoval,
  type ConversationRemovalTarget,
  type NewConversationRemoval,
} from "./metadata"
import { OpenLeafPicker } from "./open-leaf-picker"
import { PROCESS_TITLE_PREFIX, PROGRAM_NAME, PROGRAM_VERSION } from "./program"
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
const COMPLETION_REFRESH_RETRY_DELAYS_MS = [75, 150, 300, 600, 1_200, 2_400, 4_800] as const
const REFRESH_SPINNER_FRAMES = ["|", "/", "-", "\\"] as const

type FooterAction =
  | "enter-root"
  | "new"
  | "refresh"
  | "quit"
  | "open"
  | "fork"
  | "kill"
  | "remove"
  | "roots"
  | "about"

interface KillConfirmation {
  kind: "kill"
  sessionId: string
  sessionKind: "draft" | "working"
  choice: "confirm" | "cancel"
}

interface RemovalConfirmation {
  kind: "removal"
  scope: "tree" | "subtree"
  input: NewConversationRemoval
  sessionIdsToStop: string[]
  rootSessionId: string
  rootIndex: number
  parentNodeId?: string
  choice: "confirm" | "cancel"
}

type Confirmation = KillConfirmation | RemovalConfirmation

interface PreferredOpenSession {
  nodeId: string
  sessionId: string
}

type InfoModal = { kind: "about" } | { kind: "error"; message: string }

interface ActiveRefresh {
  generation: number
  controller: AbortController
  focusSessionId?: string
  transcriptSessionIds?: Set<string>
}

type NavigatorView = "roots" | "graph"
type ActiveSurface = "navigator" | "terminal"

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
  { key: "d", description: "delete", action: "remove" },
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
  { key: "d", description: "delete", action: "remove" },
  { key: "x", description: "kill", action: "kill" },
  { key: "q", description: "quit", action: "roots" },
  { key: "?", description: "about", action: "about" },
  { key: "r", description: "refresh", action: "refresh" },
]

export class AgentTreeApp {
  private readonly navigator: BoxRenderable
  private readonly header: TextRenderable
  private readonly headerSeparator: TextRenderable
  private readonly content: TextRenderable
  private readonly footerSeparator: TextRenderable
  private readonly footer: TextRenderable
  private readonly confirmationOverlay: BoxRenderable
  private readonly confirmationDialog: BoxRenderable
  private readonly confirmationTitle: TextRenderable
  private readonly confirmationMessage: TextRenderable
  private readonly confirmationCancelButton: BoxRenderable
  private readonly confirmationCancelLabel: TextRenderable
  private readonly confirmationConfirmButton: BoxRenderable
  private readonly confirmationConfirmLabel: TextRenderable
  private readonly infoOverlay: BoxRenderable
  private readonly infoDialog: BoxRenderable
  private readonly infoTitle: TextRenderable
  private readonly infoTab: TextRenderable
  private readonly infoTabSeparator: TextRenderable
  private readonly infoBody: TextRenderable
  private readonly terminalManager: TerminalManager
  private readonly openLeafPicker: OpenLeafPicker
  private readonly temporarySessions = new Map<string, AgentSession>()
  private readonly visibleEmptySessionIds = new Set<string>()
  private readonly unavailableTranscriptSessionIds = new Set<string>()
  private readonly consumedKeyReleases = new Set<string>()
  private readonly stopped: Promise<void>
  private resolveStopped!: () => void
  private stopPromise: Promise<void> | undefined
  private currentProcessTitle: string | undefined
  private currentTerminalTitle: string | undefined
  private rendererStarted = false

  private relations: BranchRelation[]
  private removals: ConversationRemoval[]
  private sessions: AgentSession[] = []
  private transcripts = new Map<string, AgentMessage[]>()
  private forest: ConversationForest = {
    graphs: [],
    graphBySessionId: new Map(),
    graphByRootSessionId: new Map(),
    warnings: [],
  }
  private navigatorView: NavigatorView = "roots"
  private activeSurface: ActiveSurface = "navigator"
  private selectedRootIndex = 0
  private currentRootSessionId: string | null = null
  private selectedGraphNodeId: string | null = null
  private rootViewportStart = 0
  private graphLayout: ConversationGraphLayout | null = null
  private graphViewportOffset: ViewportOffset | null = null
  private graphNavigationIntent: GraphNavigationIntent | null = null
  private footerHitRegions: FooterHitRegion[] = []
  private pendingMouseAction: PendingMouseAction | null = null
  private confirmation: Confirmation | null = null
  private activeConfirmedAction: Confirmation | null = null
  private infoModal: InfoModal | null = null
  private preferredOpenSession: PreferredOpenSession | null = null
  private busy = false
  private stopping = false
  private initialLoadPending = true
  private refreshGeneration = 0
  private activeRefresh: ActiveRefresh | null = null
  private spinnerFrame = 0
  private spinnerTimer: ReturnType<typeof setInterval> | undefined
  private completionRefreshTimer: ReturnType<typeof setTimeout> | undefined
  private completionRefreshTimerDueAt: number | undefined
  private completionRefreshRunning = false
  private completionRefreshVersion = 0
  private readonly pendingCompletionRefreshes = new Map<string, number>()
  private readonly completionRefreshAttempts = new Map<string, number>()
  private readonly completionRefreshDueAt = new Map<string, number>()
  private constructor(
    private readonly renderer: CliRenderer,
    private readonly metadata: BranchMetadataStore,
    private readonly provider: AgentProvider,
    relations: BranchRelation[],
    removals: ConversationRemoval[],
    private readonly setProcessTitle: (title: string) => void,
  ) {
    this.relations = relations
    this.removals = removals
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

    this.confirmationOverlay = new BoxRenderable(renderer, {
      id: "confirmation-overlay",
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
        this.completeConfirmation("cancel")
      },
    })
    this.confirmationDialog = new BoxRenderable(renderer, {
      id: "confirmation-dialog",
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
    const confirmationContent = new BoxRenderable(renderer, {
      id: "confirmation-content",
      paddingLeft: 2,
      paddingRight: 2,
      rowGap: 1,
      backgroundColor: theme.element,
    })
    const confirmationHeader = new BoxRenderable(renderer, {
      id: "confirmation-header",
      flexDirection: "row",
      justifyContent: "space-between",
      backgroundColor: theme.element,
    })
    this.confirmationTitle = new TextRenderable(renderer, {
      id: "confirmation-title",
      fg: theme.text,
      attributes: TextAttributes.BOLD,
      selectable: false,
      content: "",
    })
    const confirmationEscape = new TextRenderable(renderer, {
      id: "confirmation-escape",
      fg: theme.textMuted,
      selectable: false,
      content: "esc",
      onMouseUp: (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.completeConfirmation("cancel")
      },
    })
    confirmationHeader.add(this.confirmationTitle)
    confirmationHeader.add(confirmationEscape)

    this.confirmationMessage = new TextRenderable(renderer, {
      id: "confirmation-message",
      fg: theme.textMuted,
      marginBottom: 1,
      selectable: false,
      wrapMode: "word",
      content: "",
    })
    const confirmationActions = new BoxRenderable(renderer, {
      id: "confirmation-actions",
      flexDirection: "row",
      justifyContent: "flex-end",
      paddingBottom: 1,
      backgroundColor: theme.element,
    })
    this.confirmationCancelButton = new BoxRenderable(renderer, {
      id: "confirmation-cancel",
      paddingLeft: 1,
      paddingRight: 1,
      onMouseUp: (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.completeConfirmation("cancel")
      },
    })
    this.confirmationCancelLabel = new TextRenderable(renderer, {
      id: "confirmation-cancel-label",
      selectable: false,
      content: "Cancel",
    })
    this.confirmationCancelButton.add(this.confirmationCancelLabel)
    this.confirmationConfirmButton = new BoxRenderable(renderer, {
      id: "confirmation-confirm",
      paddingLeft: 1,
      paddingRight: 1,
      onMouseUp: (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.completeConfirmation("confirm")
      },
    })
    this.confirmationConfirmLabel = new TextRenderable(renderer, {
      id: "confirmation-confirm-label",
      selectable: false,
      content: "Kill",
    })
    this.confirmationConfirmButton.add(this.confirmationConfirmLabel)
    confirmationActions.add(this.confirmationCancelButton)
    confirmationActions.add(this.confirmationConfirmButton)
    confirmationContent.add(confirmationHeader)
    confirmationContent.add(this.confirmationMessage)
    confirmationContent.add(confirmationActions)
    this.confirmationDialog.add(confirmationContent)
    this.confirmationOverlay.add(this.confirmationDialog)
    renderer.root.add(this.confirmationOverlay)
    this.openLeafPicker = new OpenLeafPicker(renderer)

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
    setProcessTitle: (title: string) => void = () => undefined,
  ): Promise<AgentTreeApp> {
    const metadata = await BranchMetadataStore.openForProvider(projectDirectory, provider.id, stateHome)
    const [relations, removals] = await Promise.all([
      metadata.loadRelations(),
      metadata.loadRemovals(),
    ])
    return new AgentTreeApp(renderer, metadata, provider, relations, removals, setProcessTitle)
  }

  async run(): Promise<void> {
    this.renderer.keyInput.on("keypress", this.onKeyPress)
    this.renderer.keyInput.on("keyrelease", this.onKeyRelease)
    this.renderer.on(CliRenderEvents.RESIZE, this.onResize)
    await Promise.race([this.refreshData(), this.stopped])
    if (this.stopping) return
    this.renderer.start()
    this.rendererStarted = true
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
      this.completionRefreshTimerDueAt = undefined
      this.pendingCompletionRefreshes.clear()
      this.completionRefreshAttempts.clear()
      this.completionRefreshDueAt.clear()

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
    this.openLeafPicker.updateDimensions()
    this.render()
  }

  private onTerminalExited(event: TerminalExitEvent): void {
    if (this.stopping) return
    if (this.confirmation?.kind === "kill" && this.confirmation.sessionId === event.sessionId) {
      this.confirmation = null
    }
    this.pendingCompletionRefreshes.delete(event.sessionId)
    this.completionRefreshAttempts.delete(event.sessionId)
    this.completionRefreshDueAt.delete(event.sessionId)
    if (event.wasActive) {
      this.focusCachedGraph(event.sessionId)
      this.activeSurface = "navigator"
      this.navigator.visible = true
    }
    const exitError =
      event.exitCode === 0
        ? undefined
        : `${this.provider.displayName} session exited with code ${event.exitCode}`
    void this.refreshData(
      event.wasActive ? event.sessionId : undefined,
      true,
      new Set([event.sessionId]),
    )
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
      this.completionRefreshAttempts.delete(event.sessionId)
      this.completionRefreshDueAt.delete(event.sessionId)
      if (this.activeSurface === "navigator") this.render()
      return
    }
    this.pendingCompletionRefreshes.set(event.sessionId, ++this.completionRefreshVersion)
    this.completionRefreshAttempts.set(event.sessionId, 0)
    this.completionRefreshDueAt.set(event.sessionId, Date.now() + COMPLETION_REFRESH_DELAY_MS)
    this.scheduleCompletionRefresh()
    if (this.activeSurface === "navigator") this.render()
  }

  private readonly onKeyRelease = (key: KeyEvent) => {
    const identity = keyIdentity(key)
    if (!this.consumedKeyReleases.delete(identity)) return
    key.stopPropagation()
  }

  private readonly onKeyPress = (key: KeyEvent) => {
    if (this.terminalManager.ownsInput()) {
      if (!isHostEscape(key)) return
      key.stopPropagation()
      this.rememberConsumedKeyRelease(key)
      if (!key.repeated) void this.returnToGraph()
      return
    }
    if (this.activeSurface === "terminal") return
    if (this.infoModal) {
      this.handleInfoModalKey(key)
      return
    }
    if (this.confirmation) {
      this.handleConfirmationKey(key)
      return
    }
    if (isQuestionMarkKey(key) && !key.repeated) {
      key.stopPropagation()
      this.showAbout()
      return
    }

    if (this.openLeafPicker.isOpen) {
      key.stopPropagation()
      this.rememberConsumedKeyRelease(key)
      if (isExitKey(key)) {
        void this.stop()
      } else {
        this.openLeafPicker.handleKeyPress(key)
      }
      return
    }

    if (this.navigatorView === "roots") {
      this.handleRootKey(key)
    } else {
      this.handleGraphKey(key)
    }
    if (key.propagationStopped) this.rememberConsumedKeyRelease(key)
  }

  private rememberConsumedKeyRelease(key: KeyEvent): void {
    if (key.source === "kitty") this.consumedKeyReleases.add(keyIdentity(key))
  }

  private readonly onContentMouseDown = (event: MouseEvent) => {
    this.pendingMouseAction = null
    if (
      event.button !== 0 ||
      this.interactionBlocked() ||
      this.hasModal() ||
      this.activeSurface === "terminal"
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
      this.activeSurface === "terminal" ||
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
    if (this.navigatorView === "roots") {
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
    if (this.interactionBlocked() || this.hasModal() || this.navigatorView !== "roots") return
    const direction = event.scroll?.direction
    if (direction !== "up" && direction !== "down") return
    event.preventDefault()
    event.stopPropagation()
    const distance = Math.max(1, Math.round(event.scroll?.delta ?? 1))
    this.moveRoot(direction === "up" ? -distance : distance)
  }

  private readonly onFooterMouseDown = (event: MouseEvent) => {
    this.pendingMouseAction = null
    if (event.button !== 0 || this.hasModal() || this.activeSurface === "terminal") return
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
      this.activeSurface === "terminal" ||
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
    } else if (action === "remove") {
      this.showRemovalConfirmation()
    } else if (action === "roots") {
      this.showRoots()
    } else if (action === "about") {
      this.showAbout()
    }
  }

  private handleRootKey(key: KeyEvent): void {
    const quit = isUnmodifiedKey(key, "q") || isExitKey(key)
    const movement = listNavigationDelta(key)
    const recognized =
      quit ||
      movement !== undefined ||
      isEnterKey(key) ||
      isUnmodifiedKey(key, "d") ||
      isUnmodifiedKey(key, "n") ||
      isUnmodifiedKey(key, "r")
    if (!recognized) return
    key.stopPropagation()

    if (quit) {
      void this.stop()
    } else if (key.name === "r" && !key.repeated && !this.busy) {
      void this.requestRefresh()
    } else if (this.interactionBlocked()) {
      return
    } else if (movement !== undefined) {
      this.moveRoot(movement)
    } else if (isEnterKey(key) && !key.repeated) {
      this.enterSelectedRoot()
    } else if (isUnmodifiedKey(key, "d") && !key.repeated) {
      this.showRemovalConfirmation()
    } else if (isUnmodifiedKey(key, "n") && !key.repeated) {
      void this.runAction(() => this.newSession())
    }
  }

  private handleGraphKey(key: KeyEvent): void {
    const exit = isExitKey(key)
    const back = isUnmodifiedKey(key, "q") || isUnmodifiedKey(key, "escape")
    const jumpToTop = isUnmodifiedKey(key, "g")
    const jumpToBottom = isShiftedKey(key, "g")
    const recognized =
      exit ||
      back ||
      jumpToTop ||
      jumpToBottom ||
      ["up", "down", "left", "right", "k", "j", "h", "l"].some((name) =>
        isUnmodifiedKey(key, name),
      ) ||
      isEnterKey(key) ||
      isUnmodifiedKey(key, "f") ||
      isUnmodifiedKey(key, "d") ||
      isUnmodifiedKey(key, "x") ||
      isUnmodifiedKey(key, "n") ||
      isUnmodifiedKey(key, "r")
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
    } else if (jumpToTop && !key.repeated) {
      this.jumpSelectionToTop()
    } else if (jumpToBottom && !key.repeated) {
      this.jumpSelectionToBottom()
    } else if (isUnmodifiedKey(key, "up") || isUnmodifiedKey(key, "k")) {
      this.moveSelection("up")
    } else if (isUnmodifiedKey(key, "down") || isUnmodifiedKey(key, "j")) {
      this.moveSelection("down")
    } else if (isUnmodifiedKey(key, "left") || isUnmodifiedKey(key, "h")) {
      this.moveSelection("left")
    } else if (isUnmodifiedKey(key, "right") || isUnmodifiedKey(key, "l")) {
      this.moveSelection("right")
    } else if (isEnterKey(key) && !key.repeated) {
      void this.runAction(() => this.openSelectedLeaf())
    } else if (isUnmodifiedKey(key, "f") && !key.repeated) {
      void this.runAction(() => this.forkSelectedNode())
    } else if (isUnmodifiedKey(key, "d") && !key.repeated) {
      this.showRemovalConfirmation()
    } else if (isUnmodifiedKey(key, "x") && !key.repeated) {
      this.showKillConfirmation()
    } else if (isUnmodifiedKey(key, "n") && !key.repeated) {
      void this.runAction(() => this.newSession())
    }
  }

  private handleInfoModalKey(key: KeyEvent): void {
    key.stopPropagation()
    if (isExitKey(key)) {
      void this.stop()
      return
    }
    if (
      isUnmodifiedKey(key, "escape") ||
      isUnmodifiedKey(key, "q") ||
      isEnterKey(key) ||
      (isQuestionMarkKey(key) && !key.repeated)
    ) {
      this.closeInfoModal()
    }
  }

  private handleConfirmationKey(key: KeyEvent): void {
    const confirmation = this.confirmation
    if (!confirmation) return
    key.stopPropagation()
    if (isExitKey(key)) {
      void this.stop()
      return
    }
    if (isUnmodifiedKey(key, "q") || isUnmodifiedKey(key, "escape")) {
      this.completeConfirmation("cancel")
      return
    }
    if (["tab", "left", "right", "up", "down", "h", "j", "k", "l"].some((name) =>
      isUnmodifiedKey(key, name),
    )) {
      confirmation.choice = confirmation.choice === "confirm" ? "cancel" : "confirm"
      this.render()
      return
    }
    if (!isEnterKey(key) || key.repeated) return

    this.completeConfirmation(confirmation.choice)
  }

  private completeConfirmation(choice: "confirm" | "cancel"): void {
    const confirmation = this.confirmation
    if (!confirmation) return
    this.confirmation = null
    if (choice === "confirm") {
      void this.runAction(async () => {
        this.activeConfirmedAction = confirmation
        try {
          if (confirmation.kind === "kill") {
            await this.killLiveSession(confirmation)
          } else {
            await this.removeConversation(confirmation)
          }
        } finally {
          if (this.activeConfirmedAction === confirmation) this.activeConfirmedAction = null
        }
      })
      return
    }
    this.render()
  }

  private showKillConfirmation(): void {
    if (this.interactionBlocked() || this.navigatorView !== "graph") return
    const selected = this.selectedGraphNode()
    if (
      selected?.kind !== "endpoint" ||
      !this.terminalManager.runningSessionIds().has(selected.session.id)
    ) {
      this.showError("Select a live Draft or Agent to kill")
      return
    }

    const sessionId = selected.session.id
    this.confirmation = {
      kind: "kill",
      sessionId,
      sessionKind: this.displayedWorkingSessionIds().has(sessionId) ? "working" : "draft",
      choice: "confirm",
    }
    this.pendingMouseAction = null
    this.render()
  }

  private showRemovalConfirmation(): void {
    if (this.interactionBlocked()) return
    const ownedSessionIds = this.terminalManager.ownedSessionIds()
    if (this.navigatorView === "roots") {
      const graph = this.forest.graphs[this.selectedRootIndex]
      if (!graph) return
      const memberSessionIds = representedSessionIds(graph)
      this.confirmation = {
        kind: "removal",
        scope: "tree",
        input: {
          kind: "tree",
          rootSessionId: graph.rootSessionId,
          memberSessionIds,
        },
        sessionIdsToStop: [...graph.endpointBySessionId.keys()].filter((sessionId) =>
          ownedSessionIds.has(sessionId),
        ),
        rootSessionId: graph.rootSessionId,
        rootIndex: this.selectedRootIndex,
        choice: "cancel",
      }
    } else if (this.navigatorView === "graph") {
      const graph = this.currentGraph()
      const selected = this.selectedGraphNode()
      if (!graph || !selected) return
      const target: ConversationRemovalTarget =
        selected.kind === "message"
          ? { kind: "message", aliases: selected.aliases.map((alias) => ({ ...alias })) }
          : {
              kind: "endpoint",
              sessionId: selected.session.id,
              afterMessageId: selected.forkTarget?.messageId ?? null,
            }
      const fallbackNodeId = selected.kind === "endpoint" && selected.fork?.empty
        ? selected.fork.sourceNodeId
        : selected.parentId
      this.confirmation = {
        kind: "removal",
        scope: "subtree",
        input: { kind: "subtree", target },
        sessionIdsToStop: reachableSessionEndpoints(graph, selected.id)
          .map(({ endpoint }) => endpoint.session.id)
          .filter((sessionId) => ownedSessionIds.has(sessionId)),
        rootSessionId: graph.rootSessionId,
        rootIndex: this.selectedRootIndex,
        ...(fallbackNodeId === null ? {} : { parentNodeId: fallbackNodeId }),
        choice: "cancel",
      }
    } else {
      return
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
    this.confirmation = null
    this.pendingMouseAction = null
    this.render()
  }

  private closeInfoModal(): void {
    if (!this.infoModal) return
    this.infoModal = null
    this.render()
  }

  private hasModal(): boolean {
    return this.confirmation !== null || this.infoModal !== null
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
    const selectedNodeId = initialVisibleGraphNodeId(graph, this.visibleEndpointSessionIds())
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
    this.navigatorView = "graph"
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

  private jumpSelectionToTop(): void {
    if (!this.graphLayout || !this.selectedGraphNodeId) return
    const nodeId = topVisibleGraphNodeId(this.graphLayout, this.selectedGraphNodeId)
    if (!nodeId || nodeId === this.selectedGraphNodeId) return
    this.selectGraphNode(nodeId)
  }

  private jumpSelectionToBottom(): void {
    const graph = this.currentGraph()
    if (!graph || !this.graphLayout || !this.selectedGraphNodeId) return

    const visibleEndpointSessionIds = this.visibleEndpointSessionIds()
    const destinations = new Map<
      string,
      { option: ReachableSessionEndpoint; nodeId: string }
    >()
    for (const reachable of reachableSessionEndpoints(graph, this.selectedGraphNodeId)) {
      const nodeId = visibleGraphNodeId(graph, reachable.endpoint.id, visibleEndpointSessionIds)
      if (!nodeId || destinations.has(nodeId)) continue
      destinations.set(nodeId, {
        option: {
          ...reachable,
          distance: Math.max(
            0,
            reachable.distance - (nodeId === reachable.endpoint.id ? 0 : 1),
          ),
        },
        nodeId,
      })
    }

    const choices = [...destinations.values()]
    if (choices.length === 0) return
    if (choices.length === 1) {
      const nodeId = choices[0]!.nodeId
      if (nodeId !== this.selectedGraphNodeId) this.selectGraphNode(nodeId)
      return
    }

    const nodeIdBySessionId = new Map(
      choices.map(({ option, nodeId }) => [option.endpoint.session.id, nodeId]),
    )
    this.openLeafPicker.open({
      title: "Jump to Leaf",
      options: choices.map(({ option }) => option),
      activeSessionIds: this.terminalManager.runningSessionIds(),
      onSelect: ({ endpoint }) => {
        const nodeId = nodeIdBySessionId.get(endpoint.session.id)
        if (nodeId) this.selectGraphNode(nodeId)
      },
    })
  }

  private selectGraphNode(nodeId: string): void {
    if (!this.graphLayout?.nodes.has(nodeId)) return
    if (nodeId !== this.selectedGraphNodeId) {
      this.selectedGraphNodeId = nodeId
      this.preferredOpenSession = null
      this.graphViewportOffset = null
      this.graphNavigationIntent = null
    }
    this.render()
  }

  private showRoots(): void {
    this.openLeafPicker.close()
    this.navigatorView = "roots"
    this.preferredOpenSession = null
    this.graphViewportOffset = null
    this.graphNavigationIntent = null
    this.render()
  }

  private async requestRefresh(
    focusSessionId?: string,
    showWarnings = true,
    transcriptSessionIds?: ReadonlySet<string>,
  ): Promise<boolean> {
    try {
      return await this.refreshData(focusSessionId, showWarnings, transcriptSessionIds)
    } catch (error) {
      this.showError(error)
      return false
    }
  }

  private async refreshData(
    focusSessionId?: string,
    showWarnings = true,
    transcriptSessionIds?: ReadonlySet<string>,
  ): Promise<boolean> {
    this.openLeafPicker.close()
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
      ...(transcriptSessionIds === undefined
        ? {}
        : { transcriptSessionIds: new Set(transcriptSessionIds) }),
    }
    this.activeRefresh = refresh
    const pendingCompletions = new Map(this.pendingCompletionRefreshes)
    this.render()

    try {
      const incremental = refresh.transcriptSessionIds !== undefined && !this.initialLoadPending
      const snapshot = !incremental && this.provider.loadSessionSnapshot
        ? await abortable(this.provider.loadSessionSnapshot(), controller.signal)
        : undefined
      const discovered = snapshot?.sessions ?? await abortable(
        this.provider.listSessions(),
        controller.signal,
      )
      if (!this.refreshCurrent(refresh)) return false

      const discoveredIds = new Set(discovered.map((session) => session.id))
      const runningIds = this.terminalManager.runningSessionIds()
      const retainedTemporarySessions = [...this.temporarySessions.values()].filter(
        (session) =>
          !discoveredIds.has(session.id) && (!session.transient || runningIds.has(session.id)),
      )
      const sessions = [...discovered, ...retainedTemporarySessions]

      const persistedSessionIds = sessions
        .filter((session) => !session.transient)
        .map((session) => session.id)
      const persistedTranscripts = incremental
        ? new Map<string, AgentMessage[] | null>(this.transcripts)
        : new Map(snapshot?.transcripts)
      const previousSessionIds = new Set(this.sessions.map((session) => session.id))
      const missingTranscriptIds = persistedSessionIds.filter((sessionId) =>
        incremental
          ? refresh.transcriptSessionIds!.has(sessionId) || !previousSessionIds.has(sessionId)
          : !persistedTranscripts.has(sessionId),
      )
      if (missingTranscriptIds.length > 0) {
        const missingTranscripts = await abortable(
          this.provider.readTranscripts(missingTranscriptIds),
          controller.signal,
        )
        for (const [sessionId, transcript] of missingTranscripts) {
          persistedTranscripts.set(sessionId, transcript)
        }
      }
      const retainedTemporarySessionIds = new Set(
        retainedTemporarySessions.map((session) => session.id),
      )
      const workingSessionIds = this.terminalManager.workingSessionIds()
      const refreshedTranscriptIds = new Set(incremental ? missingTranscriptIds : persistedSessionIds)
      const availableSessions: AgentSession[] = []
      const transcriptEntries: Array<readonly [string, AgentMessage[]]> = []
      for (const session of sessions) {
        if (session.transient) {
          availableSessions.push(session)
          transcriptEntries.push([session.id, []])
          continue
        }
        const transcript = persistedTranscripts.get(session.id)
        if (transcript === undefined) {
          throw new Error(`${this.provider.displayName} did not return transcript ${session.id}`)
        }
        if (transcript === null) {
          const retainedTranscript = this.temporarySessions.has(session.id)
            ? this.transcripts.get(session.id)
            : undefined
          if (retainedTranscript === undefined) continue
          availableSessions.push(session)
          transcriptEntries.push([session.id, retainedTranscript])
          continue
        }
        if (refreshedTranscriptIds.has(session.id)) {
          this.unavailableTranscriptSessionIds.delete(session.id)
        }
        availableSessions.push(session)
        const previousTranscript = this.transcripts.get(session.id) ?? []
        let acceptedTranscript =
          workingSessionIds.has(session.id) && refreshedTranscriptIds.has(session.id)
            ? stableTranscriptWhileWorking(previousTranscript, transcript)
            : transcript
        const pendingVersion = this.pendingCompletionRefreshes.get(session.id)
        if (
          pendingVersion !== undefined &&
          refreshedTranscriptIds.has(session.id) &&
          (
            pendingCompletions.get(session.id) !== pendingVersion ||
            !completionTranscriptReady(previousTranscript, acceptedTranscript)
          )
        ) {
          acceptedTranscript = previousTranscript
        }
        transcriptEntries.push([session.id, acceptedTranscript])
      }
      if (!this.refreshCurrent(refresh)) return false
      const previousRootSessionId = this.currentRootSessionId
      const previousNodeId = this.selectedGraphNodeId
      const previousSelectedRoot = this.forest.graphs[this.selectedRootIndex]?.rootSessionId
      const nextTranscripts = new Map(transcriptEntries)
      const advancedCompletions = new Map<string, number>()
      for (const [sessionId, version] of pendingCompletions) {
        if (
          this.pendingCompletionRefreshes.get(sessionId) === version &&
          refreshedTranscriptIds.has(sessionId) &&
          transcriptAdvanced(this.transcripts.get(sessionId) ?? [], nextTranscripts.get(sessionId))
        ) {
          advancedCompletions.set(sessionId, version)
        }
      }
      this.sessions = availableSessions
      this.transcripts = nextTranscripts
      for (const sessionId of this.visibleEmptySessionIds) {
        if (this.transcripts.get(sessionId)?.some((message) => message.visible)) {
          this.visibleEmptySessionIds.delete(sessionId)
          this.unavailableTranscriptSessionIds.delete(sessionId)
        }
      }
      for (const sessionId of this.temporarySessions.keys()) {
        if (
          !retainedTemporarySessionIds.has(sessionId) &&
          persistedTranscripts.get(sessionId) !== null &&
          !this.visibleEmptySessionIds.has(sessionId)
        ) {
          this.temporarySessions.delete(sessionId)
        }
      }
      this.rebuildForest(runningIds)
      this.initialLoadPending = false
      this.graphViewportOffset = null
      this.graphNavigationIntent = null

      const refreshedFocusSessionId = refresh.focusSessionId
      const focusedGraph = refreshedFocusSessionId
        ? this.forest.graphBySessionId.get(refreshedFocusSessionId)
        : undefined
      const preservedGraph = previousRootSessionId
        ? this.forest.graphByRootSessionId.get(previousRootSessionId)
        : undefined
      const graph = focusedGraph ?? preservedGraph
      if (graph) {
        this.selectedRootIndex = this.forest.graphs.indexOf(graph)
        const requestedNodeId =
          (refreshedFocusSessionId
            ? graph.endpointBySessionId.get(refreshedFocusSessionId)
            : undefined) ??
          (previousNodeId && graph.nodes.has(previousNodeId) ? previousNodeId : graph.rootNodeId)
        const selectedNodeId =
          visibleGraphNodeId(graph, requestedNodeId, this.visibleEndpointSessionIds(runningIds)) ??
          initialVisibleGraphNodeId(graph, this.visibleEndpointSessionIds(runningIds))
        if (selectedNodeId) {
          this.currentRootSessionId = graph.rootSessionId
          this.selectedGraphNodeId = selectedNodeId
          if (refreshedFocusSessionId) this.navigatorView = "graph"
        } else {
          this.currentRootSessionId = null
          this.selectedGraphNodeId = null
          this.navigatorView = "roots"
        }
      } else {
        this.currentRootSessionId = null
        this.selectedGraphNodeId = null
        this.navigatorView = "roots"
        const preservedRootIndex = previousSelectedRoot
          ? this.forest.graphs.findIndex(
              (candidate) => candidate.rootSessionId === previousSelectedRoot,
            )
          : -1
        this.selectedRootIndex = preservedRootIndex >= 0 ? preservedRootIndex : 0
      }

      this.clearPendingCompletions(advancedCompletions)
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
    void prepared.startedSession?.catch(() => undefined)
    const previousNavigatorView = this.navigatorView
    const previousRootSessionId = this.currentRootSessionId
    const previousSelectedRootIndex = this.selectedRootIndex
    const previousNodeId = this.selectedGraphNodeId
    const previousViewportOffset = this.graphViewportOffset
    const previousNavigationIntent = this.graphNavigationIntent
    this.registerTemporarySession(prepared.session)
    try {
      await this.openTerminal(prepared.launch)
    } catch (error) {
      if (!this.terminalManager.ownedSessionIds().has(prepared.session.id)) {
        this.removeTemporarySession(prepared.session.id)
        this.navigatorView = previousNavigatorView
        this.currentRootSessionId = previousRootSessionId
        this.selectedRootIndex = previousSelectedRootIndex
        this.selectedGraphNodeId = previousNodeId
        this.graphViewportOffset = previousViewportOffset
        this.graphNavigationIntent = previousNavigationIntent
      }
      throw error
    }
    if (prepared.startedSession) {
      void this.adoptStartedSession(prepared.session, prepared.startedSession).catch((error) => {
        this.showError(error)
      })
    }
  }

  private async adoptStartedSession(
    temporarySession: AgentSession,
    startedSessionPromise: Promise<AgentSession>,
  ): Promise<void> {
    const startedSession = await startedSessionPromise
    if (!this.terminalManager.replaceSessionId(temporarySession.id, startedSession.id)) return
    if (this.activeRefresh?.focusSessionId === temporarySession.id) {
      this.activeRefresh.focusSessionId = startedSession.id
    }
    if (this.activeRefresh?.transcriptSessionIds?.delete(temporarySession.id)) {
      this.activeRefresh.transcriptSessionIds.add(startedSession.id)
    }
    const completionVersion = this.pendingCompletionRefreshes.get(temporarySession.id)
    const completionAttempt = this.completionRefreshAttempts.get(temporarySession.id)
    const completionDueAt = this.completionRefreshDueAt.get(temporarySession.id)
    this.pendingCompletionRefreshes.delete(temporarySession.id)
    this.completionRefreshAttempts.delete(temporarySession.id)
    this.completionRefreshDueAt.delete(temporarySession.id)
    if (completionVersion !== undefined) {
      this.pendingCompletionRefreshes.set(startedSession.id, completionVersion)
      this.completionRefreshAttempts.set(startedSession.id, completionAttempt ?? 0)
      this.completionRefreshDueAt.set(startedSession.id, completionDueAt ?? Date.now())
    }
    if (this.visibleEmptySessionIds.delete(temporarySession.id)) {
      this.visibleEmptySessionIds.add(startedSession.id)
    }
    if (this.unavailableTranscriptSessionIds.delete(temporarySession.id)) {
      this.unavailableTranscriptSessionIds.add(startedSession.id)
    }
    this.replaceConfirmationSessionId(temporarySession.id, startedSession.id)
    const temporaryGraph = this.forest.graphBySessionId.get(temporarySession.id)
    const focusedTemporaryGraph = temporaryGraph?.rootSessionId === this.currentRootSessionId
    const selectedRootSessionId = this.forest.graphs[this.selectedRootIndex]?.rootSessionId
    const temporaryTranscript = this.transcripts.get(temporarySession.id)
    const discoveredSession = this.sessions.find((session) => session.id === startedSession.id)
    this.sessions = this.sessions.flatMap((session) =>
      session.id === temporarySession.id
        ? (discoveredSession ? [] : [startedSession])
        : [session],
    )
    this.transcripts.delete(temporarySession.id)
    if (temporaryTranscript && !this.transcripts.has(startedSession.id)) {
      this.transcripts.set(startedSession.id, temporaryTranscript)
    }
    this.temporarySessions.delete(temporarySession.id)
    this.temporarySessions.set(startedSession.id, discoveredSession ?? startedSession)
    this.rebuildForest()
    if (focusedTemporaryGraph && this.navigatorView === "graph") {
      this.focusCachedGraph(startedSession.id)
    } else if (this.navigatorView === "roots") {
      const selectedGraph = selectedRootSessionId === temporaryGraph?.rootSessionId
        ? this.forest.graphBySessionId.get(startedSession.id)
        : this.forest.graphByRootSessionId.get(selectedRootSessionId ?? "")
      if (selectedGraph) this.selectedRootIndex = this.forest.graphs.indexOf(selectedGraph)
    }
    if (this.activeSurface === "navigator") {
      this.render()
    } else {
      this.updateProcessTitle()
    }
    this.scheduleCompletionRefresh()
  }

  private replaceConfirmationSessionId(previousSessionId: string, sessionId: string): void {
    if (this.confirmation) {
      replaceConfirmationSessionId(this.confirmation, previousSessionId, sessionId)
    }
    if (this.activeConfirmedAction) {
      replaceConfirmationSessionId(this.activeConfirmedAction, previousSessionId, sessionId)
    }
  }

  private async openSelectedLeaf(): Promise<void> {
    const graph = this.currentGraph()
    const selected = this.selectedGraphNode()
    if (!graph || !selected) return

    const endpoints = reachableSessionEndpoints(graph, selected.id)
    if (endpoints.length === 0) {
      this.showError(`No ${this.provider.displayName} session is reachable from this node`)
      return
    }
    const preferred = this.preferredOpenSession
    const preferredSessionId =
      preferred?.nodeId === selected.id ? preferred.sessionId : undefined
    if (endpoints.length > 1) {
      this.openLeafPicker.open({
        title: "Open leaf",
        options: endpoints,
        ...(preferredSessionId === undefined ? {} : { selectedSessionId: preferredSessionId }),
        activeSessionIds: this.terminalManager.runningSessionIds(),
        onSelect: ({ endpoint }) => {
          void this.runAction(() => this.openEndpoint(endpoint))
        },
      })
      return
    }

    await this.openEndpoint(endpoints[0]!.endpoint)
  }

  private async openEndpoint(endpoint: SessionEndpointNode): Promise<void> {
    await this.openTerminal(await this.provider.prepareResume(endpoint.session))
    this.preferredOpenSession = null
  }

  private async killLiveSession(confirmation: KillConfirmation): Promise<void> {
    const sessionId = confirmation.sessionId
    const graph = this.currentGraph()
    const endpointId = graph?.endpointBySessionId.get(sessionId)
    const request = this.terminalManager.stopSession(sessionId)
    if (!request) {
      throw new Error(`The selected ${this.provider.displayName} session is no longer running`)
    }

    this.cancelActiveRefresh()
    this.pendingCompletionRefreshes.delete(sessionId)
    this.completionRefreshAttempts.delete(sessionId)
    this.completionRefreshDueAt.delete(sessionId)
    if (this.pendingCompletionRefreshes.size === 0 && this.completionRefreshTimer) {
      clearTimeout(this.completionRefreshTimer)
      this.completionRefreshTimer = undefined
      this.completionRefreshTimerDueAt = undefined
    }
    if (graph && endpointId && this.selectedGraphNodeId === endpointId) {
      const fallbackNodeId = visibleGraphNodeId(
        graph,
        endpointId,
        this.visibleEndpointSessionIds(),
      )
      if (fallbackNodeId) {
        this.selectedGraphNodeId = fallbackNodeId
        this.graphViewportOffset = null
        this.graphNavigationIntent = null
      } else {
        this.currentRootSessionId = null
        this.selectedGraphNodeId = null
        this.navigatorView = "roots"
      }
    }
    this.render()

    await request.completion
    if (this.stopping) return
    const refreshedSessionId = confirmation.sessionId
    const refreshed = await this.refreshData(refreshedSessionId, false)
    if (!refreshed) return
    this.preferredOpenSession = this.selectedGraphNodeId
      ? { nodeId: this.selectedGraphNodeId, sessionId: refreshedSessionId }
      : null
  }

  private async removeConversation(confirmation: RemovalConfirmation): Promise<void> {
    this.cancelActiveRefresh()
    this.clearCompletionRefreshes(confirmation.sessionIdsToStop)

    const stopRequests = confirmation.sessionIdsToStop.flatMap((sessionId) => {
      const request = this.terminalManager.stopSession(sessionId)
      return request ? [request] : []
    })
    this.render()

    const stopResults = await Promise.allSettled(stopRequests.map((request) => request.completion))
    const stopErrors = stopResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    )
    if (stopErrors.length > 0) {
      try {
        await this.refreshData(undefined, false)
      } catch (refreshError) {
        throw new AggregateError(
          [...stopErrors, refreshError],
          "Unable to stop every live session; deletion was not saved and refresh failed",
        )
      }
      throw new AggregateError(
        stopErrors,
        "Unable to stop every live session; deletion was not saved",
      )
    }
    if (this.stopping) return

    let removal: ConversationRemoval
    try {
      removal = await this.metadata.saveRemoval(confirmation.input)
    } catch (error) {
      if (confirmation.sessionIdsToStop.length > 0) {
        try {
          await this.refreshData(undefined, false)
        } catch (refreshError) {
          throw new AggregateError(
            [error, refreshError],
            "Deletion was not saved and the stopped sessions could not be refreshed",
          )
        }
      }
      throw error
    }

    this.removals.push(removal)
    if (confirmation.sessionIdsToStop.length > 0) {
      try {
        const refreshed = await this.refreshData(undefined, false)
        if (!refreshed && !this.stopping) {
          throw new Error("the stopped sessions could not be refreshed")
        }
      } catch (error) {
        this.rebuildForest()
        this.repairSelectionAfterRemoval(confirmation)
        throw new Error(
          `Conversation was deleted, but refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (this.stopping) return
    } else {
      this.rebuildForest()
    }
    this.repairSelectionAfterRemoval(confirmation)
  }

  private rebuildForest(
    runningSessionIds = this.terminalManager.runningSessionIds(),
  ): void {
    const projectedSessions = new Map(
      [...this.temporarySessions.values()].map((session) => [session.id, session]),
    )
    for (const session of this.sessions) projectedSessions.set(session.id, session)
    this.forest = visibleConversationForest(
      buildConversationForest(
        [...projectedSessions.values()],
        this.transcripts,
        this.relations,
        this.removals,
      ),
      this.visibleEndpointSessionIds(runningSessionIds),
    )
  }

  private visibleEndpointSessionIds(
    runningSessionIds = this.terminalManager.runningSessionIds(),
  ): Set<string> {
    return new Set([
      ...runningSessionIds,
      ...this.temporarySessions.keys(),
      ...this.visibleEmptySessionIds,
    ])
  }

  private registerTemporarySession(session: AgentSession): void {
    this.temporarySessions.set(session.id, session)
    if (!this.transcripts.has(session.id)) this.transcripts.set(session.id, [])
    this.rebuildForest()
  }

  private removeTemporarySession(sessionId: string): void {
    this.temporarySessions.delete(sessionId)
    this.visibleEmptySessionIds.delete(sessionId)
    this.unavailableTranscriptSessionIds.delete(sessionId)
    if (!this.sessions.some((session) => session.id === sessionId)) this.transcripts.delete(sessionId)
    this.rebuildForest()
  }

  private clearCompletionRefreshes(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.pendingCompletionRefreshes.delete(sessionId)
      this.completionRefreshAttempts.delete(sessionId)
      this.completionRefreshDueAt.delete(sessionId)
    }
    if (this.completionRefreshTimer) clearTimeout(this.completionRefreshTimer)
    this.completionRefreshTimer = undefined
    this.completionRefreshTimerDueAt = undefined
  }

  private repairSelectionAfterRemoval(confirmation: RemovalConfirmation): void {
    this.openLeafPicker.close()
    this.preferredOpenSession = null
    this.rootViewportStart = 0
    this.graphViewportOffset = null
    this.graphNavigationIntent = null

    if (confirmation.scope === "tree") {
      this.currentRootSessionId = null
      this.selectedGraphNodeId = null
      this.navigatorView = "roots"
      this.selectedRootIndex = clampRootIndex(confirmation.rootIndex, this.forest.graphs.length)
      return
    }

    const graph = this.forest.graphByRootSessionId.get(confirmation.rootSessionId)
    const visibleEndpointSessionIds = this.visibleEndpointSessionIds()
    const selectedNodeId = graph
      ? (visibleGraphNodeId(graph, confirmation.parentNodeId, visibleEndpointSessionIds) ??
        initialVisibleGraphNodeId(graph, visibleEndpointSessionIds))
      : undefined
    if (graph && selectedNodeId) {
      this.currentRootSessionId = graph.rootSessionId
      this.selectedGraphNodeId = selectedNodeId
      this.selectedRootIndex = this.forest.graphs.indexOf(graph)
      this.navigatorView = "graph"
      return
    }

    this.currentRootSessionId = null
    this.selectedGraphNodeId = null
    this.navigatorView = "roots"
    this.selectedRootIndex = clampRootIndex(confirmation.rootIndex, this.forest.graphs.length)
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

    let prepared: PreparedBranch
    try {
      prepared = await this.provider.branchFrom(target)
    } catch (error) {
      if (!(error instanceof BranchCreatedError)) throw error
      this.registerTemporarySession(error.session)
      this.transcripts.set(error.session.id, error.transcript)
      if (!error.transcript.some((message) => message.visible)) {
        this.visibleEmptySessionIds.add(error.session.id)
      }
      if (!error.transcriptAvailable) {
        this.unavailableTranscriptSessionIds.add(error.session.id)
      }
      this.rebuildForest()
      let refreshed = false
      try {
        refreshed = await this.refreshData(error.session.id, false)
      } catch {}
      if (!refreshed || !this.forest.graphBySessionId.has(error.session.id)) {
        this.showIndependentCreatedBranch(error)
      }
      throw error
    }

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
    this.registerTemporarySession(prepared.session)
    if (!prepared.session.transient) await this.refreshData(prepared.session.id)
    const previousNodeId = this.selectedGraphNodeId
    const previousViewportOffset = this.graphViewportOffset
    const previousNavigationIntent = this.graphNavigationIntent
    try {
      await this.openTerminal(prepared.launch)
    } catch (error) {
      if (!prepared.providerSessionCreated && !this.terminalManager.ownedSessionIds().has(prepared.session.id)) {
        try {
          await this.metadata.removeRelation(relation)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Fork ${prepared.session.id} could not start and its ancestry could not be rolled back`,
          )
        }
        this.relations = this.relations.filter((candidate) => candidate !== relation)
        this.removeTemporarySession(prepared.session.id)
        this.selectedGraphNodeId = previousNodeId
        this.graphViewportOffset = previousViewportOffset
        this.graphNavigationIntent = previousNavigationIntent
      }
      throw error
    }
  }

  private showIndependentCreatedBranch(error: BranchCreatedError): void {
    this.sessions = [error.session, ...this.sessions.filter((session) => session.id !== error.session.id)]
    this.transcripts.set(error.session.id, error.transcript)
    this.rebuildForest()

    const graph = this.forest.graphBySessionId.get(error.session.id)
    if (!graph) return
    const requestedNodeId = graph.endpointBySessionId.get(error.session.id) ?? graph.rootNodeId
    const selectedNodeId = visibleGraphNodeId(
      graph,
      requestedNodeId,
      this.visibleEndpointSessionIds(),
    )
    if (!selectedNodeId) return
    this.selectedRootIndex = this.forest.graphs.indexOf(graph)
    this.currentRootSessionId = graph.rootSessionId
    this.selectedGraphNodeId = selectedNodeId
    this.navigatorView = "graph"
  }

  private async openTerminal(launch: TerminalLaunch): Promise<void> {
    if (this.stopping) {
      await launch.cleanup?.()
      throw new Error("claude-tree is shutting down")
    }
    this.openLeafPicker.close()
    if (!this.focusCachedGraph(launch.sessionId)) {
      await launch.cleanup?.()
      throw new Error(`Conversation graph for ${launch.sessionId} is unavailable`)
    }
    await this.terminalManager.show(launch)
    this.activeSurface = "terminal"
    this.navigator.visible = false
    this.stopSpinnerAnimation()
    this.updateProcessTitle()
  }

  private async returnToGraph(): Promise<void> {
    const sessionId = this.terminalManager.hideActive()
    if (sessionId) this.focusCachedGraph(sessionId)
    this.activeSurface = "navigator"
    this.navigator.visible = true
    await this.requestRefresh(
      sessionId ?? undefined,
      true,
      sessionId ? new Set([sessionId]) : undefined,
    )
  }

  private focusCachedGraph(sessionId: string): boolean {
    const graph = this.forest.graphBySessionId.get(sessionId)
    const endpointId = graph?.endpointBySessionId.get(sessionId)
    if (!graph || !endpointId) return false
    const selectedNodeId = visibleGraphNodeId(
      graph,
      endpointId,
      this.visibleEndpointSessionIds(),
    )
    if (!selectedNodeId) return false

    this.currentRootSessionId = graph.rootSessionId
    this.selectedRootIndex = this.forest.graphs.indexOf(graph)
    this.selectedGraphNodeId = selectedNodeId
    this.preferredOpenSession = null
    this.graphViewportOffset = null
    this.graphNavigationIntent = null
    this.navigatorView = "graph"
    return true
  }

  private currentGraph(): ConversationGraph | undefined {
    return this.currentRootSessionId
      ? this.forest.graphByRootSessionId.get(this.currentRootSessionId)
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
    this.updateProcessTitle()
    this.updateSpinnerAnimation()
    if (this.activeSurface === "terminal") {
      this.confirmationOverlay.visible = false
      this.infoOverlay.visible = false
      return
    }
    const tooSmall =
      this.renderer.terminalWidth < MINIMUM_WIDTH || this.renderer.terminalHeight < MINIMUM_HEIGHT
    this.header.content = tooSmall
      ? styledText([
          ...this.renderAppIdentity(),
          chunk("\nResize to at least ", theme.textMuted),
          chunk(`${MINIMUM_WIDTH}×${MINIMUM_HEIGHT}`, theme.warning),
          chunk(` · current ${this.renderer.terminalWidth}×${this.renderer.terminalHeight}`, theme.textMuted),
        ])
      : this.renderHeader()
    this.content.visible = !tooSmall
    this.headerSeparator.visible = !tooSmall
    this.footerSeparator.visible = !tooSmall
    this.footer.visible = !tooSmall
    this.confirmationOverlay.visible = false
    this.infoOverlay.visible = false
    if (tooSmall) {
      this.confirmation = null
      this.openLeafPicker.close()
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
    if (this.navigatorView === "roots") {
      this.graphLayout = null
      this.graphViewportOffset = null
      this.graphNavigationIntent = null
      if (this.initialLoadPending) {
        this.rootViewportStart = 0
        this.content.content = styledText([
          chunk(
            `${BRAILLE_SPINNER_FRAMES[this.spinnerFrame % BRAILLE_SPINNER_FRAMES.length]} Loading conversations`,
            theme.textMuted,
          ),
        ])
      } else {
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
      }
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
        this.visibleEndpointSessionIds(),
        this.unavailableTranscriptSessionIds,
      )
      this.graphLayout = rendered.layout
      this.graphViewportOffset = { x: rendered.offsetX, y: rendered.offsetY }
      this.content.content = rendered.content
      const footer = this.renderGraphFooter()
      this.footer.content = footer.content
      this.footerHitRegions = footer.hitRegions
    }
    this.renderConfirmationOverlay()
    this.renderInfoOverlay()
  }

  private renderConfirmationOverlay(): void {
    const confirmation = this.confirmation
    if (!confirmation) {
      this.confirmationOverlay.visible = false
      return
    }

    const confirmSelected = confirmation.choice === "confirm"
    const content = confirmationContent(confirmation)
    this.confirmationOverlay.paddingTop = Math.floor(this.renderer.terminalHeight / 4)
    this.confirmationDialog.maxWidth = Math.max(1, this.renderer.terminalWidth - 2)
    this.confirmationTitle.content = content.title
    this.confirmationMessage.content = content.message
    this.confirmationConfirmLabel.content = content.confirmLabel
    this.confirmationCancelButton.backgroundColor = confirmSelected ? undefined : theme.primary
    this.confirmationCancelLabel.fg = confirmSelected ? theme.textMuted : theme.selectedText
    this.confirmationConfirmButton.backgroundColor = confirmSelected ? theme.primary : undefined
    this.confirmationConfirmLabel.fg = confirmSelected ? theme.selectedText : theme.textMuted
    this.confirmationOverlay.visible = true
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
      ...(this.provider.compatibilityWarning
        ? [
            chunk(
              `\n\n${this.provider.compatibilityWarning}`,
              theme.warning,
              TextAttributes.NONE,
              background,
            ),
          ]
        : []),
    ]
    return styledText(chunks)
  }

  private renderHeader(): StyledText {
    const identity = [
      ...this.renderAppIdentity(),
      chunk("  ", theme.textMuted),
      chunk(this.metadata.projectPath, theme.textMuted),
      chunk("\n", theme.text),
    ]
    if (this.navigatorView === "roots") {
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

  private renderAppIdentity(): TextChunk[] {
    return [
      chunk("󰙅 claude-tree", theme.primary, TextAttributes.BOLD),
      chunk("  ", theme.textMuted),
      chunk(
        this.provider.navigatorIdentity.label,
        this.provider.navigatorIdentity.color,
        TextAttributes.BOLD,
      ),
    ]
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
      if (
        !this.terminalManager.runningSessionIds().has(selected.session.id) &&
        this.visibleEmptySessionIds.has(selected.session.id)
      ) {
        const state = this.unavailableTranscriptSessionIds.has(selected.session.id)
          ? "transcript unavailable"
          : "no visible messages"
        return `Selected session · ${state} · ${selected.session.id.slice(0, 8)}`
      }
      if (
        !this.terminalManager.runningSessionIds().has(selected.session.id) &&
        selected.fork?.empty
      ) {
        const label = selected.fork.number === undefined ? "fork" : `fork ${selected.fork.number}`
        return `Selected ${label} · ${selected.session.id.slice(0, 8)}`
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
      this.navigatorView === "graph" &&
      graph !== undefined &&
      [...graph.sessionIds].some((sessionId) => workingSessionIds.has(sessionId))
    const shouldAnimate =
      this.activeSurface === "navigator" &&
      this.renderer.terminalWidth >= MINIMUM_WIDTH &&
      this.renderer.terminalHeight >= MINIMUM_HEIGHT &&
      (this.activeRefresh !== null || graphShouldAnimate)
    if (!shouldAnimate) {
      this.stopSpinnerAnimation()
      return
    }
    if (this.spinnerTimer) return
    const scheduleFrame = () => {
      const timer = setTimeout(() => {
        if (this.spinnerTimer !== timer) return
        this.spinnerFrame += 1
        this.render()
        if (this.spinnerTimer === timer) scheduleFrame()
      }, SPINNER_INTERVAL_MS)
      this.spinnerTimer = timer
    }
    scheduleFrame()
  }

  private stopSpinnerAnimation(): void {
    if (this.spinnerTimer) clearTimeout(this.spinnerTimer)
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

  private updateProcessTitle(): void {
    const activeSessionId = this.terminalManager.activeTerminalSessionId()
    let context: string | undefined
    if (activeSessionId) {
      context =
        this.sessions.find((session) => session.id === activeSessionId)?.title ??
        this.temporarySessions.get(activeSessionId)?.title
    } else if (this.navigatorView === "graph") {
      context = this.currentGraph()?.rootSession.title
    }
    const title = context === undefined
      ? PROCESS_TITLE_PREFIX
      : `${PROCESS_TITLE_PREFIX}: ${context}`
    if (this.rendererStarted && title !== this.currentTerminalTitle) {
      this.currentTerminalTitle = title
      this.renderer.setTerminalTitle(title)
    }
    if (title === this.currentProcessTitle) return
    this.currentProcessTitle = title
    this.setProcessTitle(title)
  }

  private scheduleCompletionRefresh(): void {
    if (
      this.stopping ||
      this.busy ||
      this.activeRefresh !== null ||
      this.completionRefreshRunning ||
      this.pendingCompletionRefreshes.size === 0
    ) {
      return
    }
    const now = Date.now()
    const dueAt = Math.min(...[...this.pendingCompletionRefreshes.keys()].map((sessionId) => {
      const sessionDueAt = this.completionRefreshDueAt.get(sessionId) ?? now
      this.completionRefreshDueAt.set(sessionId, sessionDueAt)
      return sessionDueAt
    }))
    if (
      this.completionRefreshTimer !== undefined &&
      this.completionRefreshTimerDueAt !== undefined &&
      this.completionRefreshTimerDueAt <= dueAt
    ) {
      return
    }
    if (this.completionRefreshTimer) clearTimeout(this.completionRefreshTimer)
    this.completionRefreshTimerDueAt = dueAt
    this.completionRefreshTimer = setTimeout(() => {
      this.completionRefreshTimer = undefined
      this.completionRefreshTimerDueAt = undefined
      if (this.busy || this.activeRefresh) {
        this.scheduleCompletionRefresh()
        return
      }
      void this.refreshCompletedSessions()
    }, Math.max(0, dueAt - now))
  }

  private async refreshCompletedSessions(): Promise<void> {
    if (this.stopping || this.completionRefreshRunning) return
    const now = Date.now()
    const refreshes = new Map(
      [...this.pendingCompletionRefreshes].filter(
        ([sessionId]) => (this.completionRefreshDueAt.get(sessionId) ?? now) <= now,
      ),
    )
    if (refreshes.size === 0) {
      this.scheduleCompletionRefresh()
      return
    }
    this.completionRefreshRunning = true
    let refreshError: unknown
    let refreshed = false
    try {
      refreshed = await this.refreshData(undefined, false, new Set(refreshes.keys()))
    } catch (error) {
      refreshError = error
    } finally {
      const exhausted: string[] = []
      if (refreshed || refreshError !== undefined) {
        for (const [sessionId, version] of refreshes) {
          if (this.pendingCompletionRefreshes.get(sessionId) !== version) continue
          const attempt = (this.completionRefreshAttempts.get(sessionId) ?? 0) + 1
          if (attempt >= COMPLETION_REFRESH_RETRY_DELAYS_MS.length) {
            this.pendingCompletionRefreshes.delete(sessionId)
            this.completionRefreshAttempts.delete(sessionId)
            this.completionRefreshDueAt.delete(sessionId)
            exhausted.push(sessionId)
          } else {
            this.completionRefreshAttempts.set(sessionId, attempt)
            const delay = COMPLETION_REFRESH_RETRY_DELAYS_MS[attempt] ?? COMPLETION_REFRESH_DELAY_MS
            this.completionRefreshDueAt.set(sessionId, Date.now() + delay)
          }
        }
      }
      this.completionRefreshRunning = false
      this.render()
      this.scheduleCompletionRefresh()
      if (exhausted.length > 0) {
        const detail = refreshError instanceof Error ? `: ${refreshError.message}` : ""
        this.showError(`Completed response did not become available${detail}`)
      }
    }
  }

  private clearPendingCompletions(completions: Map<string, number>): void {
    for (const [sessionId, version] of completions) {
      if (this.pendingCompletionRefreshes.get(sessionId) === version) {
        this.pendingCompletionRefreshes.delete(sessionId)
        this.completionRefreshAttempts.delete(sessionId)
        this.completionRefreshDueAt.delete(sessionId)
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
  return graph.rootSession.title
}

function representedSessionIds(graph: ConversationGraph): string[] {
  const sessionIds = new Set(graph.endpointBySessionId.keys())
  sessionIds.add(graph.rootSessionId)
  for (const node of graph.nodes.values()) {
    if (node.kind !== "message") continue
    for (const alias of node.aliases) sessionIds.add(alias.sessionId)
  }
  return [...sessionIds]
}

function replaceConfirmationSessionId(
  confirmation: Confirmation,
  previousSessionId: string,
  sessionId: string,
): void {
  if (confirmation.kind === "kill") {
    if (confirmation.sessionId === previousSessionId) confirmation.sessionId = sessionId
    return
  }

  confirmation.sessionIdsToStop = confirmation.sessionIdsToStop.map((candidate) =>
    candidate === previousSessionId ? sessionId : candidate,
  )
  if (confirmation.rootSessionId === previousSessionId) confirmation.rootSessionId = sessionId
  if (confirmation.input.kind === "tree") {
    if (confirmation.input.rootSessionId === previousSessionId) {
      confirmation.input.rootSessionId = sessionId
    }
    confirmation.input.memberSessionIds = confirmation.input.memberSessionIds.map((candidate) =>
      candidate === previousSessionId ? sessionId : candidate,
    )
  } else if (confirmation.input.target.kind === "endpoint") {
    if (confirmation.input.target.sessionId === previousSessionId) {
      confirmation.input.target.sessionId = sessionId
    }
  } else {
    confirmation.input.target.aliases = confirmation.input.target.aliases.map((alias) =>
      alias.sessionId === previousSessionId ? { ...alias, sessionId } : alias,
    )
  }
}

function confirmationContent(confirmation: Confirmation): {
  title: string
  message: string | StyledText
  confirmLabel: string
} {
  if (confirmation.kind === "kill") {
    return {
      title: "Kill live session",
      message:
        confirmation.sessionKind === "working"
          ? "Interrupt this working Agent?\nPersisted response text remains resumable."
          : "Kill this Draft?\nIts unsent text will be discarded.",
      confirmLabel: "Kill",
    }
  }

  const liveCount = confirmation.sessionIdsToStop.length
  const background = theme.element
  const question =
    confirmation.scope === "tree"
      ? "Delete this conversation tree?"
      : "Delete this node and all descendents?"
  const messageChunks = [
    chunk(question, theme.text, TextAttributes.NONE, background),
    chunk("\n\n• Deletion cannot be undone.", theme.danger, TextAttributes.NONE, background),
    chunk(
      "\n• Transcripts and project files are not deleted.",
      theme.textMuted,
      TextAttributes.NONE,
      background,
    ),
  ]
  if (liveCount > 0) {
    messageChunks.push(
      chunk(
        `\n• ${liveCount} live ${liveCount === 1 ? "session" : "sessions"} will be stopped first.`,
        theme.textMuted,
        TextAttributes.NONE,
        background,
      ),
    )
  }
  return {
    title:
      confirmation.scope === "tree" ? "Delete conversation tree" : "Delete conversation path",
    message: styledText(messageChunks),
    confirmLabel: "Delete",
  }
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

function stableTranscriptWhileWorking(
  previous: AgentMessage[],
  refreshed: AgentMessage[],
): AgentMessage[] {
  if (!isTranscriptPrefix(previous, refreshed)) return previous

  let lastNewVisibleUserIndex = -1
  for (let index = previous.length; index < refreshed.length; index += 1) {
    const message = refreshed[index]
    if (message?.role === "user" && message.visible) lastNewVisibleUserIndex = index
  }
  return lastNewVisibleUserIndex < 0
    ? previous
    : refreshed.slice(0, lastNewVisibleUserIndex + 1)
}

function transcriptAdvanced(
  previous: AgentMessage[],
  refreshed: AgentMessage[] | undefined,
): boolean {
  return refreshed !== undefined && !sameTranscript(previous, refreshed)
}

function isTranscriptPrefix(prefix: AgentMessage[], transcript: AgentMessage[]): boolean {
  return (
    prefix.length <= transcript.length &&
    prefix.every((message, index) => sameAgentMessage(message, transcript[index]))
  )
}

function sameTranscript(left: AgentMessage[], right: AgentMessage[]): boolean {
  return (
    left.length === right.length &&
    left.every((message, index) => sameAgentMessage(message, right[index]))
  )
}

function sameAgentMessage(
  left: AgentMessage,
  right: AgentMessage | undefined,
): boolean {
  return (
    right !== undefined &&
    left.id === right.id &&
    left.role === right.role &&
    left.preview === right.preview &&
    left.ordinal === right.ordinal &&
    left.visible === right.visible &&
    left.displayGroupId === right.displayGroupId &&
    left.turnComplete === right.turnComplete
  )
}

function completionTranscriptReady(
  previous: AgentMessage[],
  refreshed: AgentMessage[],
): boolean {
  if (!transcriptAdvanced(previous, refreshed)) return false

  const lastVisibleUserIndex = refreshed.findLastIndex(
    (message) => message.role === "user" && message.visible,
  )
  const messagesAfterUser = refreshed.slice(lastVisibleUserIndex + 1)
  const completionSignals = refreshed
    .slice(Math.max(0, lastVisibleUserIndex))
    .filter(
      (message): message is AgentMessage & { turnComplete: boolean } =>
        message.turnComplete !== undefined,
    )
  return completionSignals.at(-1)?.turnComplete ?? messagesAfterUser.some(
    (message) => message.role === "agent",
  )
}

function sameMouseAction(left: PendingMouseAction, right: PendingMouseAction): boolean {
  if (left.kind === "root" && right.kind === "root") return left.rootIndex === right.rootIndex
  if (left.kind === "graph" && right.kind === "graph") return left.nodeId === right.nodeId
  if (left.kind === "footer" && right.kind === "footer") return left.action === right.action
  return false
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function clampRootIndex(index: number, graphCount: number): number {
  return graphCount === 0 ? 0 : clamp(index, 0, graphCount - 1)
}

function isExitKey(key: KeyEvent): boolean {
  return (
    key.name === "c" &&
    key.ctrl &&
    !key.shift &&
    !key.meta &&
    !key.option &&
    !key.super &&
    !key.hyper
  )
}

function isQuestionMarkKey(key: KeyEvent): boolean {
  return (
    key.name === "?" &&
    !key.ctrl &&
    !key.meta &&
    !key.option &&
    !key.super &&
    !key.hyper
  )
}

function keyIdentity(key: KeyEvent): string {
  return [
    key.name,
    key.ctrl,
    key.shift,
    key.meta,
    key.option,
    key.super,
    key.hyper,
  ].join(":")
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
