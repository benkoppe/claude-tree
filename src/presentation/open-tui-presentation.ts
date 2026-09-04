import {
  BoxRenderable,
  CliRenderEvents,
  RGBA,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type RGBA as Color,
  type TextChunk,
} from "@opentui/core"
import { Cause, Deferred, Effect, Queue, Scope, Stream } from "effect"

import type {
  AppRuntime,
  ApplicationShutdownError,
  ApplicationModal,
  ApplicationViewModel,
  EndpointNodeViewModel,
  GraphNodeViewModel,
  ReachableEndpointViewModel,
  RootViewModel,
} from "../application"
import {
  directionalMove,
  topVisibleGraphNodeId,
  type ConversationGraphLayout,
  type GraphDirection,
  type GraphNavigationIntent,
} from "../domain/graph-layout"
import type { MessageGraphNodeOrEndpoint } from "../domain/conversation-graph"
import type { ConversationRemoval } from "../domain/persistence"
import { PROCESS_TITLE_PREFIX, PROGRAM_NAME, PROGRAM_VERSION } from "../program"
import {
  BRAILLE_SPINNER_FRAMES,
  chunk,
  renderGraph,
  renderRoots,
  statusColor,
  styledText,
  type ViewportOffset,
} from "./render"
import { displayWidth, truncateToWidth } from "./text"
import { presentationTheme as theme } from "./theme"

export const MINIMUM_PRESENTATION_WIDTH = 50
export const MINIMUM_PRESENTATION_HEIGHT = 12

const HORIZONTAL_MARGIN = 1
const HEADER_HEIGHT = 2
const FOOTER_HEIGHT = 2
const SEPARATOR_HEIGHT = 1
const CHROME_HEIGHT = HEADER_HEIGHT + FOOTER_HEIGHT + SEPARATOR_HEIGHT * 2
const SPINNER_INTERVAL_MS = 80
const REFRESH_SPINNER_FRAMES = ["|", "/", "-", "\\"] as const

export interface OpenTuiProviderIdentity {
  readonly id: string
  readonly displayName: string
  readonly label?: string
  readonly color?: Color
  readonly historicalBranching?: boolean
  readonly capabilities?: {
    readonly historicalBranching: boolean
  }
}

export interface OpenTuiPresentationOptions {
  readonly setProcessTitle?: (title: string) => void
  readonly setTerminalTitle?: (title: string) => void
}

export interface OpenTuiPresentation {
  readonly run: Effect.Effect<void>
  readonly wait: Effect.Effect<void, ApplicationShutdownError>
  readonly stop: Effect.Effect<void, ApplicationShutdownError>
}

interface QueuedAction {
  readonly effect: Effect.Effect<unknown, unknown, never>
  readonly reportFailure: boolean
}

type FooterAction =
  | "enter-root"
  | "new"
  | "refresh"
  | "quit"
  | "open"
  | "fork"
  | "stop"
  | "remove"
  | "roots"
  | "about"

interface FooterControl {
  readonly key: string
  readonly description: string
  readonly action?: FooterAction
}

interface FooterHitRegion {
  readonly startX: number
  readonly endX: number
  readonly action: FooterAction
}

type PickerOption = ReachableEndpointViewModel

interface LeafPickerState {
  readonly title: string
  readonly options: readonly PickerOption[]
  selectedIndex: number
  viewportStart: number
  readonly action: "open" | "jump"
}

type ContentMouseAction =
  | { readonly kind: "root"; readonly sessionId: string }
  | { readonly kind: "graph"; readonly nodeId: string }
type PendingMouseAction =
  | ContentMouseAction
  | { readonly kind: "footer"; readonly action: FooterAction }
  | { readonly kind: "picker"; readonly index: number }
  | { readonly kind: "dialog-action"; readonly choice: "confirm" | "cancel" | "close" }

const ROOT_CONTROLS: readonly FooterControl[] = [
  { key: "↑↓/jk", description: "select" },
  { key: "Enter", description: "graph", action: "enter-root" },
  { key: "d", description: "delete", action: "remove" },
  { key: "n", description: "new", action: "new" },
  { key: "r", description: "refresh", action: "refresh" },
  { key: "q", description: "quit", action: "quit" },
  { key: "?", description: "about", action: "about" },
]

const GRAPH_CONTROLS: readonly FooterControl[] = [
  { key: "↑↓/kj", description: "edges" },
  { key: "←→/hl", description: "branches" },
  { key: "g/G", description: "top/leaf" },
  { key: "Enter", description: "open", action: "open" },
  { key: "f", description: "fork", action: "fork" },
  { key: "d", description: "delete", action: "remove" },
  { key: "x", description: "stop", action: "stop" },
  { key: "q", description: "roots", action: "roots" },
  { key: "?", description: "about", action: "about" },
  { key: "r", description: "refresh", action: "refresh" },
]

export function makeOpenTuiPresentation(
  renderer: CliRenderer,
  appRuntime: AppRuntime,
  provider: OpenTuiProviderIdentity,
  options: OpenTuiPresentationOptions = {},
): Effect.Effect<OpenTuiPresentation, never, Scope.Scope> {
  return Effect.gen(function*() {
    const actions = yield* Queue.unbounded<QueuedAction>()
    const stopped = yield* Deferred.make<void, ApplicationShutdownError>()
    const presentation = new OpenTuiPresentationController(
      renderer,
      appRuntime,
      provider,
      options,
      (action, reportFailure = true) => Queue.offerUnsafe(actions, { effect: action, reportFailure }),
      stopped,
    )

    yield* Effect.forkScoped(Effect.forever(
      Queue.take(actions).pipe(
        Effect.flatMap((action) => Effect.catchCause(action.effect, (cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
          if (!action.reportFailure || presentation.isStopping) {
            return Effect.logError("Presentation action failed", cause)
          }
          const failure = Cause.squash(cause)
          if (isReportedApplicationFailure(failure)) {
            return Effect.logError("Presentation action failed after the application reported it", cause)
          }
          const message = `Action failed: ${errorMessage(failure)}`
          return Effect.suspend(() => appRuntime.openModal({ _tag: "Error", message })).pipe(
            Effect.catchCause((reportCause) => Cause.hasInterrupts(reportCause)
              ? Effect.failCause(reportCause)
              : Effect.logError("Unable to report presentation action failure", reportCause)),
          )
        })),
      ),
    ))
    yield* Effect.forkScoped(Effect.forever(
      Stream.runForEach(
        appRuntime.viewModels,
        (viewModel) => Effect.sync(() => presentation.applyViewModel(viewModel)).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
            return Effect.sync(() => presentation.reportRenderFailure("Render update", Cause.squash(cause)))
          }),
        ),
      ),
    ))

    const api: OpenTuiPresentation = {
      run: Effect.gen(function*() {
        const initial = yield* appRuntime.getViewModel
        yield* Effect.sync(() => presentation.start(initial))
      }),
      wait: Deferred.await(stopped),
      stop: presentation.stop,
    }
    yield* Effect.addFinalizer(() => api.stop.pipe(Effect.catch((error) => Effect.die(error))))
    return api
  })
}

class OpenTuiPresentationController {
  private readonly navigator: BoxRenderable
  private readonly header: TextRenderable
  private readonly headerSeparator: TextRenderable
  private readonly content: TextRenderable
  private readonly footerSeparator: TextRenderable
  private readonly footer: TextRenderable
  private readonly dialogOverlay: BoxRenderable
  private readonly dialogPanel: BoxRenderable
  private readonly dialogTitle: TextRenderable
  private readonly dialogEscape: TextRenderable
  private readonly dialogBody: TextRenderable
  private readonly dialogActions: TextRenderable

  private viewModel: ApplicationViewModel | undefined
  private selectedRootSessionId: string | null = null
  private rootViewportStart = 0
  private graphViewportOffset: ViewportOffset | null = null
  private graphNavigationIntent: GraphNavigationIntent | null = null
  private graphSignature: string | null = null
  private footerHitRegions: readonly FooterHitRegion[] = []
  private pendingMouseAction: PendingMouseAction | null = null
  private leafPicker: LeafPickerState | null = null
  private modalChoice: "confirm" | "cancel" = "cancel"
  private modalIdentity: string | null = null
  private actionPending = false
  private terminalOpening = false
  private started = false
  private stopping = false
  private spinnerFrame = 0
  private spinnerTimer: ReturnType<typeof setTimeout> | undefined
  private currentTitle: string | undefined
  private nextRemovalRequest = 1
  private pendingHostEscapeRelease = false
  private readonly shownGraphWarnings = new Set<string>()
  private renderFailurePending = false

  get isStopping(): boolean {
    return this.stopping
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly appRuntime: AppRuntime,
    private readonly provider: OpenTuiProviderIdentity,
    private readonly options: OpenTuiPresentationOptions,
    private readonly enqueue: (action: Effect.Effect<unknown, unknown>, reportFailure?: boolean) => void,
    private readonly stopped: Deferred.Deferred<void, ApplicationShutdownError>,
  ) {
    this.navigator = new BoxRenderable(renderer, {
      id: "next-navigator",
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
      id: "next-header",
      height: HEADER_HEIGHT,
      marginX: HORIZONTAL_MARGIN,
      fg: theme.text,
      bg: theme.background,
      selectable: false,
      wrapMode: "none",
      content: "",
    })
    this.headerSeparator = this.separator("next-header-separator")
    this.content = new TextRenderable(renderer, {
      id: "next-content",
      flexGrow: 1,
      marginX: HORIZONTAL_MARGIN,
      fg: theme.text,
      bg: theme.background,
      selectable: false,
      wrapMode: "none",
      content: "",
      onMouseDown: this.guardedOnContentMouseDown,
      onMouseUp: this.guardedOnContentMouseUp,
      onMouseScroll: this.guardedOnContentMouseScroll,
    })
    this.footerSeparator = this.separator("next-footer-separator")
    this.footer = new TextRenderable(renderer, {
      id: "next-footer",
      height: FOOTER_HEIGHT,
      marginX: HORIZONTAL_MARGIN,
      fg: theme.textMuted,
      bg: theme.background,
      selectable: false,
      wrapMode: "none",
      content: "",
      onMouseDown: this.guardedOnFooterMouseDown,
      onMouseUp: this.guardedOnFooterMouseUp,
    })
    this.navigator.add(this.header)
    this.navigator.add(this.headerSeparator)
    this.navigator.add(this.content)
    this.navigator.add(this.footerSeparator)
    this.navigator.add(this.footer)
    renderer.root.add(this.navigator)

    this.dialogOverlay = new BoxRenderable(renderer, {
      id: "next-dialog-overlay",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 3000,
      alignItems: "center",
      paddingTop: Math.floor(renderer.terminalHeight / 4),
      backgroundColor: RGBA.fromInts(0, 0, 0, 150),
      visible: false,
      onMouseDown: this.guardedOnDialogBackdropMouseDown,
      onMouseUp: this.guardedOnDialogBackdropMouseUp,
    })
    this.dialogPanel = new BoxRenderable(renderer, {
      id: "next-dialog-panel",
      width: 60,
      maxWidth: Math.max(1, renderer.terminalWidth - 2),
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      rowGap: 1,
      backgroundColor: theme.element,
      onMouseDown: this.guardedStopDialogMouse,
      onMouseUp: this.guardedStopDialogMouse,
    })
    const dialogHeader = new BoxRenderable(renderer, {
      id: "next-dialog-header",
      flexDirection: "row",
      justifyContent: "space-between",
      backgroundColor: theme.element,
    })
    this.dialogTitle = new TextRenderable(renderer, {
      id: "next-dialog-title",
      fg: theme.text,
      bg: theme.element,
      attributes: TextAttributes.BOLD,
      selectable: false,
      content: "",
    })
    this.dialogEscape = new TextRenderable(renderer, {
      id: "next-dialog-escape",
      fg: theme.textMuted,
      bg: theme.element,
      selectable: false,
      content: "esc",
      onMouseUp: this.guardedOnDialogEscapeMouseUp,
    })
    dialogHeader.add(this.dialogTitle)
    dialogHeader.add(this.dialogEscape)
    this.dialogBody = new TextRenderable(renderer, {
      id: "next-dialog-body",
      flexGrow: 1,
      fg: theme.textMuted,
      bg: theme.element,
      selectable: false,
      wrapMode: "word",
      content: "",
      onMouseDown: this.guardedOnDialogBodyMouseDown,
      onMouseUp: this.guardedOnDialogBodyMouseUp,
      onMouseScroll: this.guardedOnDialogBodyMouseScroll,
    })
    this.dialogActions = new TextRenderable(renderer, {
      id: "next-dialog-actions",
      height: 1,
      fg: theme.textMuted,
      bg: theme.element,
      selectable: false,
      wrapMode: "none",
      content: "",
      onMouseDown: this.guardedOnDialogActionsMouseDown,
      onMouseUp: this.guardedOnDialogActionsMouseUp,
    })
    this.dialogPanel.add(dialogHeader)
    this.dialogPanel.add(this.dialogBody)
    this.dialogPanel.add(this.dialogActions)
    this.dialogOverlay.add(this.dialogPanel)
    renderer.root.add(this.dialogOverlay)
  }

  readonly stop: Effect.Effect<void, ApplicationShutdownError> = Effect.suspend(() => {
    if (this.stopping) return Deferred.await(this.stopped)
    this.stopping = true
    const self = this
    const cleanup = Effect.gen(function*() {
      yield* Effect.sync(() => self.teardown())
      yield* self.appRuntime.shutdown
    })
    return Effect.uninterruptible(Effect.matchCauseEffect(cleanup, {
      onFailure: (cause) => Effect.sync(() => {
        Deferred.doneUnsafe(self.stopped, Effect.failCause(cause))
      }).pipe(Effect.andThen(Effect.failCause(cause))),
      onSuccess: () => Deferred.succeed(self.stopped, undefined),
    }))
  })

  start(initial: ApplicationViewModel): void {
    if (this.started || this.stopping) return
    this.applyViewModel(initial)
    this.started = true
    this.renderer.keyInput.on("keypress", this.guardedOnKeyPress)
    this.renderer.keyInput.on("keyrelease", this.guardedOnKeyRelease)
    this.renderer.on(CliRenderEvents.RESIZE, this.guardedOnResize)
    this.renderer.start()
    this.renderSafely("Initial render")
  }

  applyViewModel(viewModel: ApplicationViewModel): void {
    if (this.stopping) return
    const previous = this.viewModel
    this.viewModel = viewModel
    if (viewModel.surface._tag === "Roots") {
      const roots = viewModel.surface.roots
      const selectedByRuntime = roots.find((root) => root.selected)?.sessionId
      const localSurvives = roots.some((root) => root.sessionId === this.selectedRootSessionId)
      this.selectedRootSessionId = selectedByRuntime ?? (localSurvives ? this.selectedRootSessionId : roots[0]?.sessionId ?? null)
      this.graphSignature = null
      this.graphViewportOffset = null
      this.graphNavigationIntent = null
    } else if (viewModel.surface._tag === "Graph") {
      const signature = viewModel.surface.nodes
        .map((node) => `${node.id}:${node.x}:${node.y}:${node.parentIds.join(",")}:${node.childIds.join(",")}`)
        .join("|")
      if (this.graphSignature !== null && signature !== this.graphSignature) {
        this.graphViewportOffset = null
        this.graphNavigationIntent = null
        this.leafPicker = null
      }
      this.graphSignature = signature
      if (viewModel.surface.nodes.length === 0 && previous?.surface._tag === "Graph" && previous.surface.nodes.length > 0) {
        this.enqueue(this.appRuntime.selectRoot(null))
      }
    }
    this.reconcileModal(viewModel.modal)
    this.surfaceGraphWarning()
    if (this.started) this.render()
    this.renderFailurePending = false
  }

  reportRenderFailure(operation: string, cause: unknown): void {
    if (this.stopping || this.renderFailurePending) return
    this.renderFailurePending = true
    try {
      this.enqueue(this.appRuntime.openModal({
        _tag: "Error",
        message: `${operation}: ${errorMessage(cause)}`,
      }), false)
    } catch {
      // A failure in the reporting path must not re-enter the render boundary.
    }
  }

  private separator(id: string): TextRenderable {
    return new TextRenderable(this.renderer, {
      id,
      width: "100%",
      height: SEPARATOR_HEIGHT,
      fg: theme.separator,
      bg: theme.background,
      selectable: false,
      wrapMode: "none",
      content: "",
    })
  }

  private readonly onResize = () => {
    this.graphViewportOffset = null
    this.graphNavigationIntent = null
    this.leafPicker = null
    if (this.tooSmall() && this.viewModel?.modal) this.enqueue(this.appRuntime.closeModal)
    this.render()
  }

  private readonly onKeyPress = (key: KeyEvent) => {
    const surface = this.viewModel?.surface
    if (surface?._tag === "Terminal") {
      if (!isHostEscape(key)) return
      key.stopPropagation()
      this.pendingHostEscapeRelease = key.source === "kitty"
      if (!key.repeated) this.runAction(this.appRuntime.returnFromTerminal)
      return
    }
    if (!surface || this.stopping) return
    if (this.leafPicker) {
      key.stopPropagation()
      this.handleLeafPickerKey(key)
      return
    }
    if (this.viewModel?.modal) {
      key.stopPropagation()
      this.handleModalKey(key)
      return
    }
    if (isQuestionMarkKey(key) && !key.repeated) {
      key.stopPropagation()
      this.enqueue(this.appRuntime.openModal({ _tag: "About" }))
      return
    }
    if (surface._tag === "Roots") this.handleRootsKey(key)
    else if (surface._tag === "Graph") this.handleGraphKey(key)
  }

  private readonly onKeyRelease = (key: KeyEvent) => {
    if (!this.pendingHostEscapeRelease || !isHostEscape(key)) return
    this.pendingHostEscapeRelease = false
    key.stopPropagation()
  }

  private handleRootsKey(key: KeyEvent): void {
    const movement = listNavigationDelta(key)
    const quit = isUnmodifiedKey(key, "q") || isUnmodifiedKey(key, "escape") || isExitKey(key)
    if (
      !quit && movement === undefined && !isEnterKey(key) &&
      !["d", "n", "r"].some((name) => isUnmodifiedKey(key, name))
    ) return
    key.stopPropagation()
    if (quit) {
      this.enqueue(this.stop)
    } else if (isUnmodifiedKey(key, "r") && !key.repeated) {
      this.runAction(this.appRuntime.refresh())
    } else if (this.interactionBlocked()) {
      return
    } else if (movement !== undefined) {
      this.moveRoot(movement)
    } else if (isEnterKey(key) && !key.repeated) {
      this.enterSelectedRoot()
    } else if (isUnmodifiedKey(key, "d") && !key.repeated) {
      this.showRemovalConfirmation()
    } else if (isUnmodifiedKey(key, "n") && !key.repeated) {
      this.runTerminalAction(this.appRuntime.newSession)
    }
  }

  private handleGraphKey(key: KeyEvent): void {
    const back = isUnmodifiedKey(key, "q") || isUnmodifiedKey(key, "escape")
    const jumpToTop = isUnmodifiedKey(key, "g")
    const jumpToLeaf = isShiftedKey(key, "g")
    const direction = graphDirection(key)
    const recognized = isExitKey(key) || back || jumpToTop || jumpToLeaf || direction !== undefined || isEnterKey(key) ||
      ["f", "d", "x", "n", "r"].some((name) => isUnmodifiedKey(key, name))
    if (!recognized) return
    key.stopPropagation()
    if (isExitKey(key)) {
      this.enqueue(this.stop)
    } else if (isUnmodifiedKey(key, "r") && !key.repeated) {
      this.runAction(this.appRuntime.refresh())
    } else if (this.interactionBlocked()) {
      return
    } else if (back) {
      this.showRoots()
    } else if (jumpToTop && !key.repeated) {
      this.jumpGraphToTop()
    } else if (jumpToLeaf && !key.repeated) {
      this.jumpGraphToLeaf()
    } else if (direction) {
      this.moveGraph(direction)
    } else if (isEnterKey(key) && !key.repeated) {
      this.openSelected()
    } else if (isUnmodifiedKey(key, "f") && !key.repeated) {
      this.forkSelected()
    } else if (isUnmodifiedKey(key, "d") && !key.repeated) {
      this.showRemovalConfirmation()
    } else if (isUnmodifiedKey(key, "x") && !key.repeated) {
      this.showStopConfirmation()
    } else if (isUnmodifiedKey(key, "n") && !key.repeated) {
      this.runTerminalAction(this.appRuntime.newSession)
    }
  }

  private handleLeafPickerKey(key: KeyEvent): void {
    if (isExitKey(key)) {
      this.enqueue(this.stop)
      return
    }
    if (isUnmodifiedKey(key, "escape") || isUnmodifiedKey(key, "q")) {
      this.leafPicker = null
      this.render()
      return
    }
    const movement = listNavigationDelta(key)
    if (movement !== undefined) {
      this.movePicker(movement)
    } else if (isEnterKey(key) && !key.repeated) {
      this.activatePicker()
    }
  }

  private handleModalKey(key: KeyEvent): void {
    const modal = this.viewModel?.modal
    if (!modal) return
    if (isExitKey(key)) {
      this.enqueue(this.stop)
      return
    }
    if (modal._tag === "About" || modal._tag === "Error") {
      if (
        isUnmodifiedKey(key, "escape") || isUnmodifiedKey(key, "q") ||
        isEnterKey(key) || isQuestionMarkKey(key)
      ) this.enqueue(this.appRuntime.closeModal)
      return
    }
    if (isUnmodifiedKey(key, "escape") || isUnmodifiedKey(key, "q")) {
      this.completeConfirmation("cancel")
      return
    }
    if (["tab", "left", "right", "up", "down", "h", "j", "k", "l"].some((name) => isUnmodifiedKey(key, name))) {
      this.modalChoice = this.modalChoice === "confirm" ? "cancel" : "confirm"
      this.render()
      return
    }
    if (isEnterKey(key) && !key.repeated) this.completeConfirmation(this.modalChoice)
  }

  private moveRoot(delta: number): void {
    const surface = this.rootsSurface()
    if (!surface || surface.roots.length === 0) return
    const current = Math.max(0, surface.roots.findIndex((root) => root.sessionId === this.selectedRootSessionId))
    const index = clamp(current + delta, 0, surface.roots.length - 1)
    const root = surface.roots[index]!
    if (root.sessionId === this.selectedRootSessionId) return
    this.selectedRootSessionId = root.sessionId
    this.enqueue(this.appRuntime.selectRoot(root.sessionId))
    this.render()
  }

  private enterSelectedRoot(): void {
    const root = this.selectedRoot()
    if (root) this.runAction(this.appRuntime.enterRoot(root.sessionId))
  }

  private showRoots(): void {
    const graph = this.graphSurface()
    this.leafPicker = null
    this.graphViewportOffset = null
    this.graphNavigationIntent = null
    this.enqueue(this.appRuntime.selectRoot(graph?.familySessionId ?? null))
  }

  private moveGraph(direction: GraphDirection): void {
    const graph = this.graphSurface()
    const selected = this.selectedGraphNode()
    if (!graph || !selected) return
    const move = directionalMove(
      navigationLayout(graph.nodes),
      selected.id,
      direction,
      this.graphNavigationIntent ?? undefined,
    )
    if (!move) return
    const target = graph.nodes.find((node) => node.id === move.nodeId)
    if (!target) return
    this.graphNavigationIntent = move.intent
    this.graphViewportOffset = null
    this.enqueue(this.appRuntime.selectGraph(graph.familySessionId, target.target))
  }

  private jumpGraphToTop(): void {
    const graph = this.graphSurface()
    const selected = this.selectedGraphNode()
    if (!graph || !selected) return
    const nodeId = topVisibleGraphNodeId(navigationLayout(graph.nodes), selected.id)
    if (nodeId && nodeId !== selected.id) this.selectGraphNode(nodeId)
  }

  private jumpGraphToLeaf(): void {
    const selected = this.selectedGraphNode()
    if (!selected) return
    const destinations = new Map<string, PickerOption>()
    for (const endpoint of selected.reachableEndpoints) {
      if (!endpoint.visibleNodeId || destinations.has(endpoint.visibleNodeId)) continue
      destinations.set(endpoint.visibleNodeId, {
        ...endpoint,
        distance: Math.max(0, endpoint.distance - (endpoint.visibleNodeId === selected.id ? 0 : 1)),
      })
    }
    const options = [...destinations.values()]
    if (options.length === 0) return
    if (options.length === 1) {
      this.selectGraphNode(options[0]!.visibleNodeId!)
      return
    }
    this.leafPicker = {
      title: "Jump to Leaf",
      options,
      selectedIndex: 0,
      viewportStart: 0,
      action: "jump",
    }
    this.pendingMouseAction = null
    this.render()
  }

  private selectGraphNode(nodeId: string): void {
    const graph = this.graphSurface()
    const node = graph?.nodes.find((candidate) => candidate.id === nodeId)
    if (!graph || !node) return
    this.graphNavigationIntent = null
    this.graphViewportOffset = null
    this.enqueue(this.appRuntime.selectGraph(graph.familySessionId, node.target))
  }

  private openSelected(): void {
    const selected = this.selectedGraphNode()
    if (!selected) return
    const options = [...selected.reachableEndpoints]
    if (options.length === 0) {
      this.showError(`No ${this.provider.displayName} session is reachable from this node`)
    } else if (options.length === 1) {
      this.runTerminalAction(this.appRuntime.openEndpoint(options[0]!.session.id))
    } else {
      this.leafPicker = { title: "Open leaf", options, selectedIndex: 0, viewportStart: 0, action: "open" }
      this.pendingMouseAction = null
      this.render()
    }
  }

  private forkSelected(): void {
    const selected = this.selectedGraphNode()
    if (selected?._tag !== "Message") {
      this.showError("Select a historical message to fork")
      return
    }
    const supported = this.provider.capabilities?.historicalBranching ??
      this.provider.historicalBranching ?? false
    if (!supported) {
      this.showError(`${this.provider.displayName} does not support historical branching`)
      return
    }
    const target = selected.target.kind === "message"
      ? selected.target.preferred
      : selected.aliases.at(-1)
    if (target) this.runAction(this.appRuntime.branchFrom(target))
  }

  private showStopConfirmation(): void {
    const selected = this.selectedGraphNode()
    if (selected?._tag !== "Endpoint") {
      this.showError("Select a live Draft or Agent to stop")
      return
    }
    this.modalChoice = "confirm"
    this.enqueue(this.appRuntime.openModal({
      _tag: "ConfirmStop",
      sessionId: selected.session.id,
      activity: selected.status === "blocked" ? "blocked" : selected.status === "working" ? "working" : "idle",
    }))
  }

  private showRemovalConfirmation(): void {
    const now = new Date().toISOString()
    const requestId = `presentation-removal-${this.nextRemovalRequest++}`
    const roots = this.rootsSurface()
    if (roots) {
      const root = this.selectedRoot()
      if (!root) return
      const removal: ConversationRemoval = {
        kind: "tree",
        rootSessionId: root.sessionId,
        memberSessionIds: root.memberSessionIds,
        createdAt: now,
      }
      this.modalChoice = "cancel"
      this.enqueue(this.appRuntime.openModal({
        _tag: "ConfirmRemoval",
        requestId,
        removal,
        affectedSessionIds: root.memberSessionIds,
      }))
      return
    }

    const selected = this.selectedGraphNode()
    if (!selected) return
    const removal: ConversationRemoval = selected._tag === "Message"
      ? {
          kind: "subtree",
          target: { kind: "message", aliases: selected.aliases },
          createdAt: now,
        }
      : {
          kind: "subtree",
          target: {
            kind: "endpoint",
            sessionId: selected.session.id,
            afterMessageId: this.parentMessageId(selected),
          },
          createdAt: now,
        }
    this.modalChoice = "cancel"
    this.enqueue(this.appRuntime.openModal({
      _tag: "ConfirmRemoval",
      requestId,
      removal,
      affectedSessionIds: selected.reachableEndpoints.map((option) => option.session.id),
    }))
  }

  private completeConfirmation(choice: "confirm" | "cancel"): void {
    const modal = this.viewModel?.modal
    if (!modal || (modal._tag !== "ConfirmRemoval" && modal._tag !== "ConfirmStop")) return
    if (choice === "cancel") {
      this.enqueue(this.appRuntime.closeModal)
      return
    }
    const self = this
    this.runAction(Effect.gen(function*() {
      yield* self.appRuntime.closeModal
      if (modal._tag === "ConfirmStop") {
        yield* self.appRuntime.stopSession(modal.sessionId)
      } else {
        yield* self.appRuntime.remove(modal.removal, modal.affectedSessionIds, modal.requestId)
      }
    }))
  }

  private showError(message: string): void {
    this.enqueue(this.appRuntime.openModal({ _tag: "Error", message }))
  }

  private parentMessageId(endpoint: EndpointNodeViewModel): string | null {
    const graph = this.graphSurface()
    const parent = graph?.nodes.find((node) => node.id === endpoint.parentIds[0])
    return parent?._tag === "Message" && parent.target.kind === "message"
      ? parent.target.preferred.messageId
      : null
  }

  private movePicker(delta: -1 | 1): void {
    const picker = this.leafPicker
    if (!picker || picker.options.length === 0) return
    picker.selectedIndex = (picker.selectedIndex + delta + picker.options.length) % picker.options.length
    this.render()
  }

  private activatePicker(): void {
    const picker = this.leafPicker
    const option = picker?.options[picker.selectedIndex]
    if (!picker || !option) return
    this.leafPicker = null
    if (picker.action === "jump") {
      if (option.visibleNodeId) this.selectGraphNode(option.visibleNodeId)
      else this.render()
      return
    }
    this.runTerminalAction(this.appRuntime.openEndpoint(option.session.id))
  }

  private runTerminalAction(action: Effect.Effect<unknown, unknown>): void {
    this.runAction(action, true)
  }

  private runAction(action: Effect.Effect<unknown, unknown>, opensTerminal = false): void {
    if (this.actionPending || this.stopping) return
    this.actionPending = true
    this.terminalOpening = opensTerminal
    this.renderSafely("Render pending action")
    this.enqueue(action.pipe(Effect.ensuring(Effect.sync(() => {
      this.actionPending = false
      this.terminalOpening = false
      this.renderSafely("Render action result")
    }))))
  }

  private interactionBlocked(): boolean {
    return this.actionPending || Boolean(this.viewModel?.refreshing || this.viewModel?.shuttingDown)
  }

  private reconcileModal(modal: ApplicationModal | null): void {
    const identity = modal ? JSON.stringify(modal) : null
    if (identity === this.modalIdentity) return
    this.modalIdentity = identity
    this.pendingMouseAction = null
    if (modal?._tag === "ConfirmStop") this.modalChoice = "confirm"
    if (modal?._tag === "ConfirmRemoval") this.modalChoice = "cancel"
  }

  private surfaceGraphWarning(): void {
    const graph = this.graphSurface()
    const warning = graph?.warnings[0]
    if (!graph || !warning || this.viewModel?.modal) return
    const identity = `${graph.familySessionId}:${warning}`
    if (this.shownGraphWarnings.has(identity)) return
    this.shownGraphWarnings.add(identity)
    this.enqueue(this.appRuntime.openModal({
      _tag: "Error",
      message: `Graph integrity warning: ${warning}`,
    }))
  }

  private render(): void {
    if (!this.started || this.renderer.isDestroyed || !this.viewModel) return
    this.updateTitle()
    const surface = this.viewModel.surface
    const terminal = surface._tag === "Terminal" || this.terminalOpening
    this.navigator.visible = !terminal
    this.dialogOverlay.visible = false
    if (terminal) {
      this.stopSpinner()
      return
    }

    const tooSmall = this.tooSmall()
    this.header.content = tooSmall ? this.minimumSizeHeader() : this.renderHeader()
    this.content.visible = !tooSmall
    this.headerSeparator.visible = !tooSmall
    this.footerSeparator.visible = !tooSmall
    this.footer.visible = !tooSmall
    if (tooSmall) {
      this.footerHitRegions = []
      this.graphViewportOffset = null
      this.graphNavigationIntent = null
      this.stopSpinner()
      return
    }

    const separator = styledText([chunk("─".repeat(this.renderer.terminalWidth), theme.separator)])
    this.headerSeparator.content = separator
    this.footerSeparator.content = separator
    const width = Math.max(1, this.renderer.terminalWidth - HORIZONTAL_MARGIN * 2)
    const height = Math.max(1, this.renderer.terminalHeight - CHROME_HEIGHT)
    if (surface._tag === "Roots") {
      if (this.viewModel.initialLoadPending) {
        this.content.content = styledText([
          chunk(`${BRAILLE_SPINNER_FRAMES[this.spinnerFrame % BRAILLE_SPINNER_FRAMES.length]} Loading conversations`, theme.textMuted),
        ])
      } else {
        const rendered = renderRoots(
          surface.roots,
          this.selectedRootSessionId,
          height,
          width,
          this.rootViewportStart,
        )
        this.rootViewportStart = rendered.startIndex
        this.content.content = rendered.content
      }
      const footer = renderControls(ROOT_CONTROLS, this.refreshFrame())
      this.footer.content = styledText([
        ...footer.chunks,
        chunk("\n", theme.text),
        ...this.rootStatusChunks(),
      ])
      this.footerHitRegions = footer.hitRegions
    } else {
      const rendered = renderGraph(
        surface,
        width,
        height,
        this.spinnerFrame,
        this.graphViewportOffset ?? undefined,
        this.viewModel.liveSessionIds,
      )
      this.graphViewportOffset = { x: rendered.offsetX, y: rendered.offsetY }
      this.content.content = rendered.content
      const footer = renderControls(GRAPH_CONTROLS, this.refreshFrame())
      this.footer.content = styledText([
        ...footer.chunks,
        chunk("\n", theme.text),
        chunk(this.selectedDescription(), theme.textMuted),
      ])
      this.footerHitRegions = footer.hitRegions
    }
    this.renderDialog()
    this.updateSpinner()
  }

  private minimumSizeHeader() {
    return styledText([
      ...this.identityChunks(),
      chunk("\nResize to at least ", theme.textMuted),
      chunk(`${MINIMUM_PRESENTATION_WIDTH}×${MINIMUM_PRESENTATION_HEIGHT}`, theme.warning),
      chunk(` · current ${this.renderer.terminalWidth}×${this.renderer.terminalHeight}`, theme.textMuted),
    ])
  }

  private renderHeader() {
    const surface = this.viewModel!.surface
    const secondLine = surface._tag === "Roots"
      ? [chunk("Conversation roots", theme.text, TextAttributes.BOLD)]
      : surface._tag === "Graph"
        ? [
            chunk(truncateToWidth(surface.title, Math.max(1, this.renderer.terminalWidth - 18)), theme.text, TextAttributes.BOLD),
            chunk("  Message graph", theme.textMuted),
          ]
        : []
    return styledText([...this.identityChunks(), chunk("\n", theme.text), ...secondLine])
  }

  private identityChunks(): TextChunk[] {
    return [
      chunk("󰙅 claude-tree", theme.primary, TextAttributes.BOLD),
      chunk("  ", theme.textMuted),
      chunk(this.provider.label ?? this.provider.displayName, this.providerColor(), TextAttributes.BOLD),
    ]
  }

  private rootStatusChunks(): TextChunk[] {
    const root = this.selectedRoot()
    if (!root) return [chunk("No conversation selected", theme.textMuted)]
    const label = root.status === "blocked"
      ? "● Needs user"
      : root.status === "unviewed"
        ? "● New updates"
        : root.status === "working"
          ? "● Live"
          : undefined
    return [
      ...(label
        ? [chunk(label, statusColor(root.status), TextAttributes.BOLD), chunk(" · ", theme.textMuted)]
        : []),
      chunk(truncateToWidth(root.title, Math.max(1, this.renderer.terminalWidth - 20)), theme.textMuted),
    ]
  }

  private selectedDescription(): string {
    const selected = this.selectedGraphNode()
    if (!selected) return "No node selected"
    if (selected._tag === "Endpoint") {
      if (selected.status === "blocked") return `Selected agent · needs user · ${selected.session.id.slice(0, 8)}`
      if (selected.status === "working") return `Selected agent · generating · ${selected.session.id.slice(0, 8)}`
      if (selected.fork?.empty && !this.viewModel?.liveSessionIds.has(selected.session.id)) {
        const label = selected.fork.number === undefined ? "fork" : `fork ${selected.fork.number}`
        return `Selected ${label} · ${selected.session.id.slice(0, 8)}`
      }
      const draft = selected.draft?.text.replace(/\s+/g, " ").trim() || "blank"
      return `Selected ${selected.draft ? "draft" : "session"} · ${truncateToWidth(draft, Math.max(20, this.renderer.terminalWidth - 32))} · ${selected.session.id.slice(0, 8)}`
    }
    return `Selected ${selected.role} · ${truncateToWidth(selected.preview, Math.max(20, this.renderer.terminalWidth - 24))}`
  }

  private renderDialog(): void {
    const picker = this.leafPicker
    const modal = this.viewModel?.modal
    if (!picker && !modal) {
      this.dialogOverlay.visible = false
      return
    }
    this.dialogOverlay.paddingTop = Math.floor(this.renderer.terminalHeight / 4)
    this.dialogPanel.maxWidth = Math.max(1, this.renderer.terminalWidth - 2)
    if (picker) {
      const maximumRows = Math.max(1, Math.floor(this.renderer.terminalHeight / 2) - 2)
      const rows = Math.min(picker.options.length, maximumRows)
      if (picker.selectedIndex < picker.viewportStart) picker.viewportStart = picker.selectedIndex
      if (picker.selectedIndex >= picker.viewportStart + rows) picker.viewportStart = picker.selectedIndex - rows + 1
      picker.viewportStart = clamp(picker.viewportStart, 0, Math.max(0, picker.options.length - rows))
      this.dialogPanel.height = Math.min(this.renderer.terminalHeight - 2, rows + 4)
      this.dialogTitle.content = picker.title
      this.dialogBody.wrapMode = "none"
      this.dialogBody.content = this.pickerContent(picker, rows)
      this.dialogActions.visible = false
    } else if (modal) {
      const content = modalContent(modal)
      const about = modal._tag === "About"
      this.dialogPanel.width = Math.min(about ? 76 : 60, this.renderer.terminalWidth - 4)
      this.dialogPanel.height = Math.min(
        about ? 18 : modal._tag === "Error" ? 9 : 12,
        this.renderer.terminalHeight - 2,
      )
      this.dialogTitle.content = content.title
      this.dialogBody.wrapMode = "word"
      this.dialogBody.content = content.body
      this.dialogActions.visible = true
      this.dialogActions.content = this.modalActions(modal)
    }
    this.dialogOverlay.visible = true
  }

  private pickerContent(picker: LeafPickerState, rows: number) {
    const chunks: TextChunk[] = []
    const width = Math.max(1, Math.min(56, this.renderer.terminalWidth - 6))
    const end = Math.min(picker.options.length, picker.viewportStart + rows)
    for (let index = picker.viewportStart; index < end; index += 1) {
      const option = picker.options[index]!
      const selected = index === picker.selectedIndex
      const background = selected ? theme.selected : theme.element
      const foreground = selected ? theme.selectedText : theme.text
      const live = this.viewModel?.liveSessionIds.has(option.session.id) ?? false
      const marker = option.status === "blocked" || option.status === "unviewed"
        ? "● "
        : live ? "• " : "  "
      const distance = option.distance === 0
        ? "selected leaf"
        : `${option.distance} ${option.distance === 1 ? "node" : "nodes"} down`
      const suffix = `  ${distance} · ${option.session.id.slice(0, 8)}`
      const titleWidth = Math.max(0, width - displayWidth(marker) - displayWidth(suffix))
      const title = `${truncateToWidth(option.session.title, titleWidth)}${suffix}`
      const markerColor = option.status === "blocked"
        ? theme.danger
        : option.status === "unviewed"
          ? theme.warning
          : theme.success
      chunks.push(
        chunk(marker, markerColor, marker.trim() || selected ? TextAttributes.BOLD : TextAttributes.NONE, theme.element),
        chunk(
        title.padEnd(width - displayWidth(marker)),
        foreground,
        selected ? TextAttributes.BOLD : TextAttributes.NONE,
        background,
      ))
      if (index < end - 1) chunks.push(chunk("\n", theme.text, TextAttributes.NONE, theme.element))
    }
    return styledText(chunks)
  }

  private modalActions(modal: ApplicationModal) {
    if (modal._tag === "About" || modal._tag === "Error") {
      return styledText([chunk("esc close", theme.selectedText, TextAttributes.BOLD, theme.primary)])
    }
    const label = modal._tag === "ConfirmStop" ? "Stop" : "Delete"
    return styledText([
      chunk(
        "Cancel",
        this.modalChoice === "cancel" ? theme.selectedText : theme.textMuted,
        this.modalChoice === "cancel" ? TextAttributes.BOLD : TextAttributes.NONE,
        this.modalChoice === "cancel" ? theme.primary : theme.element,
      ),
      chunk("  ", theme.textMuted, TextAttributes.NONE, theme.element),
      chunk(
        label,
        this.modalChoice === "confirm" ? theme.selectedText : theme.textMuted,
        this.modalChoice === "confirm" ? TextAttributes.BOLD : TextAttributes.NONE,
        this.modalChoice === "confirm" ? theme.primary : theme.element,
      ),
    ])
  }

  private refreshFrame(): string | undefined {
    return this.viewModel?.refreshing
      ? REFRESH_SPINNER_FRAMES[this.spinnerFrame % REFRESH_SPINNER_FRAMES.length]
      : undefined
  }

  private updateSpinner(): void {
    const graphWorking = this.graphSurface()?.nodes.some((node) =>
      node._tag === "Endpoint" && node.status === "working"
    ) ?? false
    const animate = !this.tooSmall() && Boolean(this.viewModel?.refreshing || graphWorking)
    if (!animate) {
      this.stopSpinner()
      return
    }
    if (this.spinnerTimer) return
    const schedule = () => {
      const timer = setTimeout(() => {
        if (this.spinnerTimer !== timer) return
        this.spinnerFrame += 1
        this.renderSafely("Render animation")
        if (this.spinnerTimer === timer) schedule()
      }, SPINNER_INTERVAL_MS)
      this.spinnerTimer = timer
    }
    schedule()
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) clearTimeout(this.spinnerTimer)
    this.spinnerTimer = undefined
    this.spinnerFrame = 0
  }

  private updateTitle(): void {
    const surface = this.viewModel?.surface
    const context = surface?._tag === "Graph" || surface?._tag === "Terminal" ? surface.title : undefined
    const title = context ? `${PROCESS_TITLE_PREFIX}: ${context}` : PROCESS_TITLE_PREFIX
    if (title === this.currentTitle) return
    this.options.setProcessTitle?.(title)
    if (this.started) (this.options.setTerminalTitle ?? this.renderer.setTerminalTitle.bind(this.renderer))(title)
    this.currentTitle = title
  }

  private providerColor(): Color {
    if (this.provider.color) return this.provider.color
    if (this.provider.id === "claude") return theme.claude
    if (this.provider.id === "codex") return theme.codex
    return theme.secondary
  }

  private tooSmall(): boolean {
    return this.renderer.terminalWidth < MINIMUM_PRESENTATION_WIDTH ||
      this.renderer.terminalHeight < MINIMUM_PRESENTATION_HEIGHT
  }

  private rootsSurface(): Extract<ApplicationViewModel["surface"], { readonly _tag: "Roots" }> | undefined {
    const surface = this.viewModel?.surface
    return surface?._tag === "Roots" ? surface : undefined
  }

  private graphSurface(): Extract<ApplicationViewModel["surface"], { readonly _tag: "Graph" }> | undefined {
    const surface = this.viewModel?.surface
    return surface?._tag === "Graph" ? surface : undefined
  }

  private selectedRoot(): RootViewModel | undefined {
    return this.rootsSurface()?.roots.find((root) => root.sessionId === this.selectedRootSessionId)
  }

  private selectedGraphNode(): GraphNodeViewModel | undefined {
    return this.graphSurface()?.nodes.find((node) => node.selected)
  }

  private readonly onContentMouseDown = (event: MouseEvent) => {
    this.pendingMouseAction = null
    if (event.button !== 0 || this.interactionBlocked() || this.viewModel?.modal || this.leafPicker) return
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
      event.button !== 0 || this.interactionBlocked() || this.viewModel?.modal || this.leafPicker ||
      !pending || (pending.kind !== "root" && pending.kind !== "graph")
    ) return
    const action = this.contentMouseActionAt(event)
    if (!action || !sameContentAction(pending, action)) return
    event.preventDefault()
    event.stopPropagation()
    if (action.kind === "root") {
      if (action.sessionId === this.selectedRootSessionId) this.enterSelectedRoot()
      else {
        this.selectedRootSessionId = action.sessionId
        this.enqueue(this.appRuntime.selectRoot(action.sessionId))
        this.render()
      }
    } else {
      const selected = this.selectedGraphNode()
      if (action.nodeId === selected?.id) this.openSelected()
      else {
        const graph = this.graphSurface()
        const node = graph?.nodes.find((candidate) => candidate.id === action.nodeId)
        if (graph && node) {
          this.graphNavigationIntent = null
          this.enqueue(this.appRuntime.selectGraph(graph.familySessionId, node.target))
        }
      }
    }
  }

  private contentMouseActionAt(event: MouseEvent): ContentMouseAction | undefined {
    const localX = event.x - this.content.screenX
    const localY = event.y - this.content.screenY
    if (localX < 0 || localY < 0) return undefined
    const roots = this.rootsSurface()
    if (roots) {
      const root = roots.roots[this.rootViewportStart + localY]
      return root ? { kind: "root", sessionId: root.sessionId } : undefined
    }
    const graph = this.graphSurface()
    const offset = this.graphViewportOffset
    if (!graph || !offset) return undefined
    const worldX = offset.x + localX
    const worldY = offset.y + localY
    const node = graph.nodes.find((candidate) =>
      worldX >= candidate.x && worldX < candidate.x + candidate.width &&
      worldY >= candidate.y && worldY < candidate.y + candidate.height
    )
    return node ? { kind: "graph", nodeId: node.id } : undefined
  }

  private readonly onContentMouseScroll = (event: MouseEvent) => {
    if (this.interactionBlocked() || this.viewModel?.modal || this.leafPicker) return
    const direction = event.scroll?.direction
    if (!direction) return
    event.preventDefault()
    event.stopPropagation()
    const distance = Math.max(1, Math.round(event.scroll?.delta ?? 1))
    if (this.rootsSurface() && (direction === "up" || direction === "down")) {
      this.moveRoot(direction === "up" ? -distance : distance)
      return
    }
    if (!this.graphSurface() || !this.graphViewportOffset) return
    if (direction === "up" || direction === "down") {
      this.graphViewportOffset = {
        ...this.graphViewportOffset,
        y: this.graphViewportOffset.y + (direction === "up" ? -distance : distance),
      }
    } else {
      this.graphViewportOffset = {
        ...this.graphViewportOffset,
        x: this.graphViewportOffset.x + (direction === "left" ? -distance : distance),
      }
    }
    this.render()
  }

  private readonly onFooterMouseDown = (event: MouseEvent) => {
    this.pendingMouseAction = null
    if (event.button !== 0 || this.viewModel?.modal || this.leafPicker) return
    const action = this.footerActionAt(event)
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    this.pendingMouseAction = { kind: "footer", action }
  }

  private readonly onFooterMouseUp = (event: MouseEvent) => {
    const pending = this.pendingMouseAction
    this.pendingMouseAction = null
    if (event.button !== 0 || pending?.kind !== "footer") return
    const action = this.footerActionAt(event)
    if (!action || action !== pending.action) return
    event.preventDefault()
    event.stopPropagation()
    this.runFooterAction(action)
  }

  private footerActionAt(event: MouseEvent): FooterAction | undefined {
    const x = event.x - this.footer.screenX
    const y = event.y - this.footer.screenY
    if (y !== 0) return undefined
    return this.footerHitRegions.find((region) => x >= region.startX && x < region.endX)?.action
  }

  private runFooterAction(action: FooterAction): void {
    if (action !== "quit" && action !== "about" && this.interactionBlocked()) return
    if (action === "enter-root") this.enterSelectedRoot()
    else if (action === "new") this.runTerminalAction(this.appRuntime.newSession)
    else if (action === "refresh") this.runAction(this.appRuntime.refresh())
    else if (action === "quit") this.enqueue(this.stop)
    else if (action === "open") this.openSelected()
    else if (action === "fork") this.forkSelected()
    else if (action === "stop") this.showStopConfirmation()
    else if (action === "remove") this.showRemovalConfirmation()
    else if (action === "roots") this.showRoots()
    else if (action === "about") this.enqueue(this.appRuntime.openModal({ _tag: "About" }))
  }

  private readonly onDialogBackdropMouseDown = (event: MouseEvent) => {
    this.pendingMouseAction = { kind: "dialog-action", choice: "cancel" }
    event.preventDefault()
    event.stopPropagation()
  }

  private readonly onDialogBackdropMouseUp = (event: MouseEvent) => {
    const close = this.pendingMouseAction?.kind === "dialog-action"
    this.pendingMouseAction = null
    if (!close || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    this.dismissDialog()
  }

  private readonly stopDialogMouse = (event: MouseEvent) => {
    this.pendingMouseAction = null
    event.stopPropagation()
  }

  private readonly onDialogEscapeMouseUp = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    this.dismissDialog()
  }

  private dismissDialog(): void {
    if (this.leafPicker) {
      this.leafPicker = null
      this.render()
    } else if (this.viewModel?.modal?._tag === "ConfirmRemoval" || this.viewModel?.modal?._tag === "ConfirmStop") {
      this.completeConfirmation("cancel")
    } else if (this.viewModel?.modal) {
      this.enqueue(this.appRuntime.closeModal)
    }
  }

  private readonly onDialogBodyMouseDown = (event: MouseEvent) => {
    if (!this.leafPicker || event.button !== 0) return
    const index = this.leafPicker.viewportStart + event.y - this.dialogBody.screenY
    if (!this.leafPicker.options[index]) return
    event.preventDefault()
    event.stopPropagation()
    this.pendingMouseAction = { kind: "picker", index }
    this.leafPicker.selectedIndex = index
    this.render()
  }

  private readonly onDialogBodyMouseUp = (event: MouseEvent) => {
    const pending = this.pendingMouseAction
    this.pendingMouseAction = null
    if (!this.leafPicker || pending?.kind !== "picker" || event.button !== 0) return
    const index = this.leafPicker.viewportStart + event.y - this.dialogBody.screenY
    if (index !== pending.index) return
    event.preventDefault()
    event.stopPropagation()
    this.leafPicker.selectedIndex = index
    this.activatePicker()
  }

  private readonly onDialogBodyMouseScroll = (event: MouseEvent) => {
    if (!this.leafPicker || this.interactionBlocked()) return
    const direction = event.scroll?.direction
    if (direction !== "up" && direction !== "down") return
    event.preventDefault()
    event.stopPropagation()
    const distance = Math.max(1, Math.round(event.scroll?.delta ?? 1))
    const maximum = this.leafPicker.options.length - 1
    this.leafPicker.selectedIndex = clamp(
      this.leafPicker.selectedIndex + (direction === "up" ? -distance : distance),
      0,
      maximum,
    )
    this.render()
  }

  private readonly onDialogActionsMouseDown = (event: MouseEvent) => {
    const choice = this.dialogActionAt(event)
    if (!choice || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    this.pendingMouseAction = { kind: "dialog-action", choice }
  }

  private readonly onDialogActionsMouseUp = (event: MouseEvent) => {
    const pending = this.pendingMouseAction
    this.pendingMouseAction = null
    if (pending?.kind !== "dialog-action" || event.button !== 0) return
    const choice = this.dialogActionAt(event)
    if (choice !== pending.choice) return
    event.preventDefault()
    event.stopPropagation()
    if (choice === "close") this.enqueue(this.appRuntime.closeModal)
    else this.completeConfirmation(choice)
  }

  private dialogActionAt(event: MouseEvent): "confirm" | "cancel" | "close" | undefined {
    const modal = this.viewModel?.modal
    if (!modal || event.y - this.dialogActions.screenY !== 0) return undefined
    if (modal._tag === "About" || modal._tag === "Error") return "close"
    const x = event.x - this.dialogActions.screenX
    return x < displayWidth("Cancel  ") ? "cancel" : "confirm"
  }

  private renderSafely(operation: string): void {
    try {
      this.render()
    } catch (cause) {
      this.reportRenderFailure(operation, cause)
    }
  }

  private guardCallback<A extends readonly unknown[]>(
    operation: string,
    callback: (...args: A) => void,
  ): (...args: A) => void {
    return (...args) => {
      try {
        callback(...args)
      } catch (cause) {
        this.reportRenderFailure(operation, cause)
      }
    }
  }

  private readonly guardedOnResize = this.guardCallback("Handle resize", this.onResize)
  private readonly guardedOnKeyPress = this.guardCallback("Handle keyboard input", this.onKeyPress)
  private readonly guardedOnKeyRelease = this.guardCallback("Handle keyboard input", this.onKeyRelease)
  private readonly guardedOnContentMouseDown = this.guardCallback("Handle pointer input", this.onContentMouseDown)
  private readonly guardedOnContentMouseUp = this.guardCallback("Handle pointer input", this.onContentMouseUp)
  private readonly guardedOnContentMouseScroll = this.guardCallback("Handle pointer input", this.onContentMouseScroll)
  private readonly guardedOnFooterMouseDown = this.guardCallback("Handle pointer input", this.onFooterMouseDown)
  private readonly guardedOnFooterMouseUp = this.guardCallback("Handle pointer input", this.onFooterMouseUp)
  private readonly guardedOnDialogBackdropMouseDown = this.guardCallback("Handle dialog input", this.onDialogBackdropMouseDown)
  private readonly guardedOnDialogBackdropMouseUp = this.guardCallback("Handle dialog input", this.onDialogBackdropMouseUp)
  private readonly guardedStopDialogMouse = this.guardCallback("Handle dialog input", this.stopDialogMouse)
  private readonly guardedOnDialogEscapeMouseUp = this.guardCallback("Handle dialog input", this.onDialogEscapeMouseUp)
  private readonly guardedOnDialogBodyMouseDown = this.guardCallback("Handle dialog input", this.onDialogBodyMouseDown)
  private readonly guardedOnDialogBodyMouseUp = this.guardCallback("Handle dialog input", this.onDialogBodyMouseUp)
  private readonly guardedOnDialogBodyMouseScroll = this.guardCallback("Handle dialog input", this.onDialogBodyMouseScroll)
  private readonly guardedOnDialogActionsMouseDown = this.guardCallback("Handle dialog input", this.onDialogActionsMouseDown)
  private readonly guardedOnDialogActionsMouseUp = this.guardCallback("Handle dialog input", this.onDialogActionsMouseUp)

  private teardown(): void {
    this.stopSpinner()
    if (this.started) {
      this.renderer.keyInput.off("keypress", this.guardedOnKeyPress)
      this.renderer.keyInput.off("keyrelease", this.guardedOnKeyRelease)
      this.renderer.off(CliRenderEvents.RESIZE, this.guardedOnResize)
    }
    if (!this.renderer.isDestroyed) this.renderer.destroy()
  }
}

function modalContent(modal: ApplicationModal): {
  readonly title: string
  readonly body: string | ReturnType<typeof styledText>
} {
  if (modal._tag === "About") {
    return {
      title: "About",
      body: styledText([
        chunk(PROGRAM_NAME, theme.text, TextAttributes.BOLD, theme.element),
        chunk(`\nVersion ${PROGRAM_VERSION}`, theme.textMuted, TextAttributes.NONE, theme.element),
        chunk(
          "\n\nNote: Branches are not isolated. All conversations share this working directory and can modify the same files.",
          theme.warning,
          TextAttributes.NONE,
          theme.element,
        ),
      ]),
    }
  }
  if (modal._tag === "Error") return { title: "Error", body: modal.message }
  if (modal._tag === "ConfirmStop") {
    return {
      title: "Stop live session",
      body: modal.activity === "working"
        ? "Interrupt this working Agent?\nPersisted response text remains resumable."
        : modal.activity === "blocked"
          ? "Stop this Agent that needs user input?\nPersisted response text remains resumable."
          : "Stop this Draft?\nIts unsent text will be discarded.",
    }
  }
  const liveCount = modal.affectedSessionIds.length
  return {
    title: modal.removal.kind === "tree" ? "Delete conversation tree" : "Delete conversation path",
    body: styledText([
      chunk(
        modal.removal.kind === "tree"
          ? "Delete this conversation tree?"
          : "Delete this node and all descendants?",
        theme.text,
        TextAttributes.NONE,
        theme.element,
      ),
      chunk("\n\n• Deletion cannot be undone.", theme.danger, TextAttributes.NONE, theme.element),
      chunk("\n• Transcripts and project files are not deleted.", theme.textMuted, TextAttributes.NONE, theme.element),
      ...(liveCount > 0
        ? [chunk(
            `\n• Up to ${liveCount} live ${liveCount === 1 ? "session" : "sessions"} will be stopped first.`,
            theme.textMuted,
            TextAttributes.NONE,
            theme.element,
          )]
        : []),
    ]),
  }
}

function renderControls(
  controls: readonly FooterControl[],
  refreshFrame?: string,
): { readonly chunks: TextChunk[]; readonly hitRegions: FooterHitRegion[] } {
  const chunks: TextChunk[] = []
  const hitRegions: FooterHitRegion[] = []
  let x = 0
  for (const [index, control] of controls.entries()) {
    if (index > 0) {
      chunks.push(chunk(" ", theme.textMuted))
      x += 1
    }
    const key = control.action === "refresh" && refreshFrame ? refreshFrame : control.key
    const text = `${key} ${control.description}`
    chunks.push(
      chunk(key, theme.text, TextAttributes.BOLD),
      chunk(` ${control.description}`, theme.textMuted),
    )
    if (control.action) hitRegions.push({ startX: x, endX: x + displayWidth(text), action: control.action })
    x += displayWidth(text)
  }
  return { chunks, hitRegions }
}

function navigationLayout(nodes: readonly GraphNodeViewModel[]): ConversationGraphLayout {
  return {
    nodes: new Map(nodes.map((node) => [node.id, {
      node: navigationNode(node),
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    }])),
    nodeWidth: nodes[0]?.width ?? 1,
    worldWidth: Math.max(0, ...nodes.map((node) => node.x + node.width)),
    worldHeight: Math.max(0, ...nodes.map((node) => node.y + node.height)),
  }
}

function navigationNode(node: GraphNodeViewModel): MessageGraphNodeOrEndpoint {
  const base = {
    id: node.id,
    parentId: node.parentIds[0] ?? null,
    childIds: [...node.childIds],
  }
  return node._tag === "Endpoint"
    ? { ...base, kind: "endpoint", session: node.session }
    : {
        ...base,
        kind: "message",
        role: node.role,
        preview: node.preview,
        internal: node.childIds.length > 1,
        aliases: [...node.aliases],
      }
}

function graphDirection(key: KeyEvent): GraphDirection | undefined {
  if (isUnmodifiedKey(key, "up") || isUnmodifiedKey(key, "k")) return "up"
  if (isUnmodifiedKey(key, "down") || isUnmodifiedKey(key, "j")) return "down"
  if (isUnmodifiedKey(key, "left") || isUnmodifiedKey(key, "h")) return "left"
  if (isUnmodifiedKey(key, "right") || isUnmodifiedKey(key, "l")) return "right"
  return undefined
}

function listNavigationDelta(key: KeyEvent): -1 | 1 | undefined {
  if (isUnmodifiedKey(key, "up") || isUnmodifiedKey(key, "k")) return -1
  if (isUnmodifiedKey(key, "down") || isUnmodifiedKey(key, "j")) return 1
  if (isControlKey(key, "p")) return -1
  if (isControlKey(key, "n")) return 1
  return undefined
}

function isEnterKey(key: KeyEvent): boolean {
  return (key.name === "return" || key.name === "linefeed" || key.name === "kpenter") && !hasModifiers(key)
}

function isUnmodifiedKey(key: KeyEvent, name: string): boolean {
  return key.name === name && !hasModifiers(key)
}

function isShiftedKey(key: KeyEvent, name: string): boolean {
  return key.name === name && Boolean(key.shift) &&
    !key.ctrl && !key.meta && !key.option && !key.super && !key.hyper
}

function isControlKey(key: KeyEvent, name: string): boolean {
  return key.name === name && Boolean(key.ctrl) &&
    !key.shift && !key.meta && !key.option && !key.super && !key.hyper
}

function isExitKey(key: KeyEvent): boolean {
  return isControlKey(key, "c")
}

function isHostEscape(key: KeyEvent): boolean {
  return isControlKey(key, "space")
}

function isQuestionMarkKey(key: KeyEvent): boolean {
  return key.name === "?" && !key.ctrl && !key.meta && !key.option && !key.super && !key.hyper
}

function hasModifiers(key: KeyEvent): boolean {
  return Boolean(key.ctrl || key.shift || key.meta || key.option || key.super || key.hyper)
}

function sameContentAction(left: ContentMouseAction, right: ContentMouseAction): boolean {
  return left.kind === "root" && right.kind === "root"
    ? left.sessionId === right.sessionId
    : left.kind === "graph" && right.kind === "graph"
      ? left.nodeId === right.nodeId
      : false
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function isReportedApplicationFailure(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("_tag" in value)) return false
  return value._tag === "ApplicationOperationError" || value._tag === "RemovalOperationError"
}

function errorMessage(error: unknown): string {
  try {
    return typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error)
  } catch {
    return "Unknown presentation error"
  }
}
