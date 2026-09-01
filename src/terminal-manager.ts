import {
  CliRenderEvents,
  EmbeddedTerminalRenderable,
  type CliRenderer,
  type Selection,
} from "@opentui/core"

import type {
  AgentActivity,
  AgentSession,
  BranchDerivation,
  DraftPreview,
  TerminalLaunch,
  TerminalObserver,
} from "./agent-provider"
import { Osc52Forwarder } from "./clipboard"
import { NULL_HERDR_REPORTER, type HerdrReporter } from "./herdr-reporter"

const SHUTDOWN_GRACE_PERIOD_MS = 200
const FORCED_SHUTDOWN_PERIOD_MS = 200
const NESTED_HERDR_ENVIRONMENT_KEYS = [
  "HERDR_ENV",
  "HERDR_BIN_PATH",
  "HERDR_SOCKET_PATH",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
] as const

interface ManagedTerminal {
  sessionId: string
  process: Bun.Subprocess
  pty: Bun.Terminal
  terminal: EmbeddedTerminalRenderable
  observer: TerminalObserver
  state: "running" | "stopping" | "cleanup-incomplete"
  stopRequest?: TerminalStopRequest
  exitCode: number | null
  draftPreview?: DraftPreview
  inputObserved: boolean
  activity: AgentActivity
  cleanup?: () => Promise<void>
  cleanupPromise?: Promise<void>
  unsubscribeTransitions?: () => void
}

export interface TerminalExitEvent {
  sessionId: string
  exitCode: number
  wasActive: boolean
  draftPreview?: DraftPreview
  cleanupError?: Error
}

export interface TerminalActivityEvent {
  sessionId: string
  activity: AgentActivity
  wasActive: boolean
}

export interface TerminalSessionChangedEvent {
  previousSessionId: string
  session: AgentSession
  wasActive: boolean
  derivation?: Promise<BranchDerivation | undefined>
}

export interface TerminalSessionTransitionErrorEvent {
  sessionId: string
  error: Error
  wasActive: boolean
}

export interface TerminalStopRequest {
  sessionId: string
  wasActive: boolean
  completion: Promise<void>
}

export class TerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>()
  private activeSessionId: string | null = null
  private shuttingDown = false
  private shutdownPromise: Promise<void> | undefined

  constructor(
    private readonly renderer: CliRenderer,
    private readonly onProcessExited: (event: TerminalExitEvent) => void,
    private readonly onActivityChanged: (event: TerminalActivityEvent) => void = () => undefined,
    private readonly onSessionChanged: (event: TerminalSessionChangedEvent) => void = () => undefined,
    private readonly onSessionTransitionError: (
      event: TerminalSessionTransitionErrorEvent,
    ) => void = () => undefined,
    private readonly herdrReporter: HerdrReporter = NULL_HERDR_REPORTER,
  ) {
    renderer.on(CliRenderEvents.SELECTION, this.onSelection)
    this.herdrReporter.report("idle")
  }

  async show(launch: TerminalLaunch): Promise<void> {
    if (this.shuttingDown) {
      await launch.cleanup?.()
      throw new Error("Cannot open an agent session while claude-tree is shutting down")
    }
    let managed = this.terminals.get(launch.sessionId)
    if (managed && managed.state !== "running") {
      await launch.cleanup?.()
      throw new Error(`Agent session ${launch.sessionId} is still stopping`)
    }
    if (managed && managed.exitCode !== null) {
      this.destroyTerminal(managed)
      this.terminals.delete(launch.sessionId)
      managed = undefined
    }
    if (!managed) {
      try {
        managed = this.spawn(launch)
      } catch (error) {
        try {
          await launch.cleanup?.()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Unable to start the agent session")
        }
        throw error
      }
      this.terminals.set(launch.sessionId, managed)
    } else {
      await launch.cleanup?.()
    }

    if (this.activeSessionId) {
      const active = this.terminals.get(this.activeSessionId)
      this.activeSessionId = null
      this.renderer.clearSelection()
      if (active) this.captureDraft(active)
      active?.terminal.blur()
      if (active) active.terminal.visible = false
    }

    this.activeSessionId = managed.sessionId
    managed.terminal.visible = true
    try {
      managed.terminal.focus()
      this.herdrReporter.report(managed.activity)
    } catch (error) {
      this.activeSessionId = null
      managed.terminal.visible = false
      this.herdrReporter.report("idle")
      throw error
    }
  }

  hideActive(): string | null {
    const previous = this.activeSessionId
    this.activeSessionId = null
    this.renderer.clearSelection()
    if (previous) {
      const managed = this.terminals.get(previous)
      if (managed) this.captureDraft(managed)
      managed?.terminal.blur()
      if (managed) managed.terminal.visible = false
    }
    this.pruneExited()
    this.herdrReporter.report("idle")
    return previous
  }

  ownsInput(): boolean {
    return this.activeSessionId !== null
  }

  activeSession(): string | null {
    return this.activeSessionId
  }

  activeTerminalSessionId(): string | null {
    return this.activeSessionId
  }

  runningSessionIds(): Set<string> {
    return new Set(
      [...this.terminals.values()]
        .filter((managed) => managed.state === "running" && managed.exitCode === null)
        .map((managed) => managed.sessionId),
    )
  }

  ownedSessionIds(): Set<string> {
    return new Set(this.terminals.keys())
  }

  replaceSessionId(previousSessionId: string, sessionId: string): boolean {
    const managed = this.terminals.get(previousSessionId)
    if (!managed) return false
    const existing = this.terminals.get(sessionId)
    if (existing && existing !== managed) {
      throw new Error(`Agent session ${sessionId} already has an owned terminal`)
    }
    this.terminals.delete(previousSessionId)
    managed.sessionId = sessionId
    this.terminals.set(sessionId, managed)
    if (this.activeSessionId === previousSessionId) this.activeSessionId = sessionId
    return true
  }

  draftPreviews(): Map<string, DraftPreview> {
    return new Map(
      [...this.terminals.values()]
        .filter(
          (managed) =>
            managed.state === "running" &&
            managed.exitCode === null &&
            managed.draftPreview !== undefined,
        )
        .map((managed) => [managed.sessionId, managed.draftPreview!]),
    )
  }

  workingSessionIds(): Set<string> {
    return new Set(
      [...this.terminals.values()]
        .filter(
          (managed) =>
            managed.state === "running" && managed.exitCode === null && managed.activity !== "idle",
        )
        .map((managed) => managed.sessionId),
    )
  }

  stopSession(
    sessionId: string,
    gracePeriodMs = SHUTDOWN_GRACE_PERIOD_MS,
  ): TerminalStopRequest | undefined {
    const managed = this.terminals.get(sessionId)
    if (!managed) return undefined
    if (managed.stopRequest) return managed.stopRequest
    if (managed.exitCode !== null) return undefined

    managed.state = "stopping"
    const wasActive = this.activeSessionId === sessionId
    if (wasActive) {
      this.activeSessionId = null
      this.renderer.clearSelection()
      this.herdrReporter.report("idle")
    }
    this.destroyEmulator(managed)

    const request: TerminalStopRequest = {
      sessionId,
      wasActive,
      completion: this.performSessionStop(managed, gracePeriodMs),
    }
    managed.stopRequest = request
    return request
  }

  shutdown(gracePeriodMs = SHUTDOWN_GRACE_PERIOD_MS): Promise<void> {
    this.shutdownPromise ??= this.performShutdown(gracePeriodMs)
    return this.shutdownPromise
  }

  private async performShutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true
    this.renderer.off(CliRenderEvents.SELECTION, this.onSelection)
    this.activeSessionId = null
    this.renderer.clearSelection()

    const owned = [...this.terminals.values()]
    const pendingStops = owned.flatMap((managed) =>
      managed.stopRequest ? [managed.stopRequest.completion] : [],
    )
    const errors: unknown[] = []
    const reporterShutdown = this.herdrReporter.shutdown()
    try {
      signalProcessGroups(owned, "SIGTERM", errors)
      for (const managed of owned) this.destroyEmulator(managed)
      this.terminals.clear()

      await waitForProcessGroups(owned, gracePeriodMs)

      const survivors = owned.filter((managed) => isProcessGroupAlive(managed.process.pid))
      signalProcessGroups(survivors, "SIGKILL", errors)
      await waitForProcessGroups(survivors, FORCED_SHUTDOWN_PERIOD_MS)
      for (const managed of survivors) {
        if (isProcessGroupAlive(managed.process.pid)) {
          errors.push(new Error(`Agent process group ${managed.process.pid} did not stop`))
        }
      }
      await Promise.allSettled(pendingStops)
      const cleanups = await Promise.allSettled(owned.map((managed) => this.cleanupManaged(managed)))
      for (const cleanup of cleanups) {
        if (cleanup.status === "rejected") errors.push(cleanup.reason)
      }
      try {
        await reporterShutdown
      } catch (error) {
        errors.push(error)
      }
    } finally {
      for (const managed of owned) {
        if (!managed.pty.closed) managed.pty.close()
        this.destroyEmulator(managed)
        if (managed.process.exitCode === null) managed.process.unref()
      }
    }

    if (errors.length > 0) throw new AggregateError(errors, "Unable to stop every agent process")
  }

  private async performSessionStop(
    managed: ManagedTerminal,
    gracePeriodMs: number,
  ): Promise<void> {
    const errors: unknown[] = []
    try {
      signalProcessGroups([managed], "SIGTERM", errors)
      await waitForProcessGroups([managed], gracePeriodMs)

      if (isProcessGroupAlive(managed.process.pid)) {
        signalProcessGroups([managed], "SIGKILL", errors)
        await waitForProcessGroups([managed], FORCED_SHUTDOWN_PERIOD_MS)
      }
      if (isProcessGroupAlive(managed.process.pid)) {
        errors.push(new Error(`Agent process group ${managed.process.pid} did not stop`))
      }
    } finally {
      if (!managed.pty.closed) managed.pty.close()
      this.destroyEmulator(managed)
      if (managed.process.exitCode === null) managed.process.unref()
      try {
        await this.cleanupManaged(managed)
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length > 0) {
      managed.state = "cleanup-incomplete"
      throw new AggregateError(errors, `Unable to stop agent session ${managed.sessionId}`)
    }
    if (this.terminals.get(managed.sessionId) === managed) {
      this.terminals.delete(managed.sessionId)
    }
  }

  private spawn(launch: TerminalLaunch): ManagedTerminal {
    const cols = Math.max(1, this.renderer.terminalWidth)
    const rows = Math.max(1, this.renderer.terminalHeight)
    let pty: Bun.Terminal | undefined
    const osc52 = new Osc52Forwarder()
    const renderer = this.renderer
    const manager = this
    let observedActivity: AgentActivity = "idle"
    let resolvePtyClosed!: () => void
    const ptyClosed = new Promise<void>((resolve) => {
      resolvePtyClosed = resolve
    })

    let managed: ManagedTerminal | undefined
    const terminal = new EmbeddedTerminalRenderable(this.renderer, {
      id: `agent-session-${encodeURIComponent(launch.sessionId)}`,
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 10,
      visible: false,
      cols,
      rows,
      maxScrollback: 1_000_000,
      onData(data, source) {
        if (managed?.state !== "running") return
        if (source === "input" && managed) {
          managed.inputObserved = true
          managed.observer.observeInput?.(data)
          const observedDraft = managed.observer.observeDraft(managed.terminal.screen())
          if (observedDraft?.rewind) managed.draftPreview = observedDraft
        }
        if (pty && !pty.closed) pty.write(data)
      },
      onTerminalResize(nextCols, nextRows) {
        if (managed?.state !== "running") return
        if (pty && !pty.closed) pty.resize(nextCols, nextRows)
      },
      onScreenChange() {
        if (!managed || managed.state !== "running") return
        const screen = terminal.screen()
        const activity = launch.observer.observeScreen(screen)
        if (activity !== undefined) {
          observedActivity = activity
          manager.setActivity(managed, activity)
        }
      },
    })
    this.renderer.root.add(terminal)

    let process: Bun.Subprocess
    try {
      const environment: NodeJS.ProcessEnv = {
        ...globalThis.process.env,
        ...launch.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      }
      for (const key of NESTED_HERDR_ENVIRONMENT_KEYS) delete environment[key]
      process = Bun.spawn(launch.command, {
        cwd: launch.cwd,
        detached: true,
        env: environment,
        terminal: {
          cols,
          rows,
          data(childPty, data) {
            pty = childPty
            if (manager.shuttingDown || (managed && managed.state !== "running")) return
            const clipboardWrites = osc52.observe(data)
            for (const activity of launch.observer.observeOutput(data)) {
              observedActivity = activity
              if (managed) manager.setActivity(managed, activity)
            }
            if (manager.activeSessionId === (managed?.sessionId ?? launch.sessionId)) {
              for (const text of clipboardWrites) renderer.copyToClipboardOSC52(text)
            }
            terminal.write(data)
          },
          exit() {
            resolvePtyClosed()
          },
        },
      })
    } catch (error) {
      this.renderer.root.remove(terminal)
      terminal.destroy()
      throw error
    }

    pty ??= process.terminal
    if (!pty) {
      process.kill()
      this.renderer.root.remove(terminal)
      terminal.destroy()
      throw new Error("Bun did not create a pseudo-terminal for the agent")
    }

    managed = {
      sessionId: launch.sessionId,
      process,
      pty,
      terminal,
      observer: launch.observer,
      state: "running",
      exitCode: null,
      ...(launch.initialDraft === undefined ? {} : { draftPreview: launch.initialDraft }),
      inputObserved: false,
      activity: observedActivity,
      ...(launch.cleanup === undefined ? {} : { cleanup: launch.cleanup }),
    }
    if (launch.sessionTransitions) {
      managed.unsubscribeTransitions = launch.sessionTransitions.subscribe(
        (transition) => this.applySessionTransition(managed!, transition),
        (error) => this.failSessionTransition(managed!, error),
      )
    }
    void process.exited.then(async (exitCode) => {
      managed.exitCode = exitCode
      await waitForPtyDrain(ptyClosed)
      const reportNaturalExit = managed.state === "running"
      let cleanupError: Error | undefined
      try {
        await this.cleanupManaged(managed)
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error))
        if (reportNaturalExit) managed.state = "cleanup-incomplete"
      }
      if (!reportNaturalExit) return
      if (this.terminals.get(managed.sessionId) !== managed) return
      const wasActive = this.activeSessionId === managed.sessionId
      if (wasActive) {
        this.activeSessionId = null
        this.renderer.clearSelection()
        this.herdrReporter.report("idle")
      }
      this.destroyTerminal(managed)
      if (cleanupError === undefined) this.terminals.delete(managed.sessionId)
      this.onProcessExited({
        sessionId: managed.sessionId,
        exitCode,
        wasActive,
        ...(managed.draftPreview === undefined ? {} : { draftPreview: managed.draftPreview }),
        ...(cleanupError === undefined ? {} : { cleanupError }),
      })
    })
    return managed
  }

  private captureDraft(managed: ManagedTerminal): void {
    const screen = managed.terminal.screen()
    if (!managed.inputObserved && managed.draftPreview?.exact) return
    const observed = managed.observer.observeDraft(screen)
    if (observed !== undefined) {
      managed.draftPreview = observed
    } else if (managed.inputObserved && !managed.draftPreview?.rewind) {
      delete managed.draftPreview
    }
    managed.inputObserved = false
  }

  private setActivity(managed: ManagedTerminal, activity: AgentActivity): void {
    if (managed.state !== "running") return
    if (managed.activity === activity) return
    managed.activity = activity
    this.onActivityChanged({
      sessionId: managed.sessionId,
      activity,
      wasActive: this.activeSessionId === managed.sessionId,
    })
    if (this.activeSessionId === managed.sessionId) this.herdrReporter.report(activity)
  }

  private cleanupManaged(managed: ManagedTerminal): Promise<void> {
    managed.unsubscribeTransitions?.()
    delete managed.unsubscribeTransitions
    managed.cleanupPromise ??= managed.cleanup?.() ?? Promise.resolve()
    return managed.cleanupPromise
  }

  private applySessionTransition(
    managed: ManagedTerminal,
    transition: {
      session: AgentSession
      derivation?: Promise<BranchDerivation | undefined>
    },
  ): void {
    const discardDerivation = () => { void transition.derivation?.catch(() => undefined) }
    if (this.shuttingDown) {
      this.onSessionChanged({
        previousSessionId: managed.sessionId,
        session: transition.session,
        wasActive: false,
        ...(transition.derivation === undefined ? {} : { derivation: transition.derivation }),
      })
      return
    }
    if (managed.state !== "running" || managed.exitCode !== null) {
      discardDerivation()
      return
    }
    const previousSessionId = managed.sessionId
    const sessionId = transition.session.id
    if (sessionId === previousSessionId) {
      discardDerivation()
      return
    }
    if (this.terminals.get(previousSessionId) !== managed) {
      discardDerivation()
      return
    }

    const existing = this.terminals.get(sessionId)
    if (existing && existing !== managed) {
      discardDerivation()
      const wasActive = this.activeSessionId === previousSessionId
      const transitionError = new Error(
        `Agent session ${sessionId} already has an owned terminal; stopped the duplicate process`,
      )
      const request = this.stopSession(previousSessionId)
      this.onSessionTransitionError({
        sessionId: previousSessionId,
        wasActive,
        error: transitionError,
      })
      void request?.completion.catch((cleanupError) =>
        this.onSessionTransitionError({
          sessionId: previousSessionId,
          wasActive,
          error: new AggregateError([transitionError, cleanupError], transitionError.message),
        }),
      )
      return
    }

    const wasActive = this.activeSessionId === previousSessionId
    this.terminals.delete(previousSessionId)
    managed.sessionId = sessionId
    this.terminals.set(sessionId, managed)
    if (wasActive) this.activeSessionId = sessionId
    this.onSessionChanged({
      previousSessionId,
      session: transition.session,
      wasActive,
      ...(transition.derivation === undefined ? {} : { derivation: transition.derivation }),
    })
  }

  private failSessionTransition(managed: ManagedTerminal, error: Error): void {
    if (managed.state !== "running" || managed.exitCode !== null) return
    const sessionId = managed.sessionId
    if (this.terminals.get(sessionId) !== managed) return
    const wasActive = this.activeSessionId === sessionId
    const request = this.stopSession(sessionId)
    this.onSessionTransitionError({ sessionId, error, wasActive })
    void request?.completion.catch((cleanupError) =>
      this.onSessionTransitionError({
        sessionId,
        wasActive,
        error: new AggregateError([error, cleanupError], error.message),
      }),
    )
  }

  private pruneExited(): void {
    for (const [sessionId, managed] of this.terminals) {
      if (
        managed.state !== "running" ||
        managed.exitCode === null ||
        sessionId === this.activeSessionId
      ) {
        continue
      }
      this.destroyTerminal(managed)
      this.terminals.delete(sessionId)
    }
  }

  private destroyTerminal(managed: ManagedTerminal): void {
    if (!managed.pty.closed) managed.pty.close()
    this.destroyEmulator(managed)
  }

  private destroyEmulator(managed: ManagedTerminal): void {
    managed.terminal.blur()
    if (managed.terminal.parent) managed.terminal.parent.remove(managed.terminal)
    if (!managed.terminal.isDestroyed) managed.terminal.destroy()
  }

  private readonly onSelection = (selection: Selection | null) => {
    if (!this.activeSessionId) return
    const terminal = this.terminals.get(this.activeSessionId)?.terminal
    if (!terminal || !selection?.selectedRenderables.includes(terminal)) return
    const selectedText = selection.getSelectedText()
    if (selectedText.length > 0) this.renderer.copyToClipboardOSC52(selectedText)
  }
}

async function waitForPtyDrain(ptyClosed: Promise<void>, timeoutMs = 250): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    ptyClosed,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs)
    }),
  ])
  if (timeout) clearTimeout(timeout)
}

async function waitForProcessGroups(
  terminals: ManagedTerminal[],
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (
    terminals.some((managed) => isProcessGroupAlive(managed.process.pid)) &&
    performance.now() < deadline
  ) {
    await Bun.sleep(Math.min(10, Math.max(0, deadline - performance.now())))
  }
}

function signalProcessGroups(
  terminals: ManagedTerminal[],
  signal: NodeJS.Signals,
  errors: unknown[],
): void {
  for (const managed of terminals) {
    try {
      signalProcessGroup(managed.process, signal)
    } catch (error) {
      errors.push(error)
    }
  }
}

function signalProcessGroup(process: Bun.Subprocess, signal: NodeJS.Signals): void {
  try {
    globalThis.process.kill(-process.pid, signal)
  } catch (error) {
    if (isNoSuchProcessError(error)) return
    try {
      process.kill(signal)
    } catch (fallbackError) {
      if (!isNoSuchProcessError(fallbackError)) throw fallbackError
    }
  }
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    globalThis.process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if (isNoSuchProcessError(error)) return false
    return true
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  )
}
