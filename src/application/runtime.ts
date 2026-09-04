import { isDeepStrictEqual } from "node:util"

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Scope,
  Stream,
  SubscriptionRef,
  type Deferred as DeferredType,
} from "effect"

import type {
  AgentSession,
  AgentSessionSnapshot,
  MessageRef,
  NavigationState,
  NavigationTarget,
} from "../domain/model"
import type {
  BranchRelation,
  ConversationRemoval,
  PendingIdentityAdoption,
  ProjectState,
} from "../domain/persistence"
import type {
  AgentProviderApi,
  AmbiguousBranchMutation,
  PreparedTerminal,
} from "../services/provider"
import type {
  TerminalActivityEvent,
  TerminalExitEvent,
  TerminalSessionChangedEvent,
  TerminalSessionTransitionErrorEvent,
  TerminalCleanupError,
  TerminalSupervisorApi,
  TerminalSupervisorEvents,
} from "../services/terminal-supervisor"
import { makeNavigationWriter, type NavigationWriter } from "./navigation-writer"
import {
  makeApplicationOperations,
  rollbackPersistedBranch,
  type ApplicationMetadataFacet,
  type ApplicationOperations,
  type IndependentBranch,
  type PersistedBranch,
  type RemovalResult,
} from "./operations"
import {
  ApplicationOperationError,
  ApplicationShutdownError,
  IntentRejectedError,
  RemovalOperationError,
  type ApplicationIntent,
  type ApplicationIntentEffect,
  type ApplicationIntentError,
  type IntentEnvelope,
  type RefreshReason,
  type StateQueryEnvelope,
  type TerminalActorEvent,
} from "./protocol"
import {
  navigationForSurface,
  reduceApplicationState,
  type StateEvent,
} from "./reducer"
import { selectConversationForest, selectProjectedData } from "./selectors"
import {
  makeInitialApplicationState,
  type ActiveRefresh,
  type ApplicationModal,
  type ApplicationState,
  type NavigatorSurface,
} from "./state"
import {
  projectApplicationViewModel,
  projectGraphViewModel,
  type ApplicationViewModel,
} from "./view-model"

const DEFAULT_COMPLETION_DELAYS_MS = [100, 250, 500, 1_000] as const
const DEFAULT_SHUTDOWN_NAVIGATION_TIMEOUT_MS = 500
const COMMAND_SCOPE_CLOSE_TIMEOUT_MS = 100
const RECONCILIATION_FAILURE_BACKOFF_MS = 100

export interface AppRuntimeOptions {
  readonly provider: AgentProviderApi
  readonly metadata: ApplicationMetadataFacet
  readonly terminals: TerminalSupervisorApi
  readonly completionDelaysMs?: readonly number[]
  readonly shutdownNavigationTimeoutMs?: number
}

export interface AppRuntime {
  readonly getState: Effect.Effect<ApplicationState>
  readonly getViewModel: Effect.Effect<ApplicationViewModel>
  readonly viewModels: Stream.Stream<ApplicationViewModel>
  readonly terminalEvents: TerminalSupervisorEvents
  readonly refresh: () => ApplicationIntentEffect
  readonly selectRoot: (sessionId: string | null) => ApplicationIntentEffect
  readonly enterRoot: (sessionId: string) => ApplicationIntentEffect
  readonly selectGraph: (familySessionId: string, target: NavigationTarget) => ApplicationIntentEffect
  readonly newSession: ApplicationIntentEffect
  readonly resumeSession: (sessionId: string) => ApplicationIntentEffect
  readonly openEndpoint: (sessionId: string) => ApplicationIntentEffect
  readonly branchFrom: (target: MessageRef) => ApplicationIntentEffect
  readonly returnFromTerminal: ApplicationIntentEffect
  readonly stopSession: (sessionId: string) => ApplicationIntentEffect
  readonly remove: (
    removal: ConversationRemoval,
    affectedSessionIds: readonly string[],
    requestId?: string,
  ) => ApplicationIntentEffect
  readonly openModal: (modal: ApplicationModal) => ApplicationIntentEffect
  readonly closeModal: ApplicationIntentEffect
  readonly handleTerminalActivity: (event: TerminalActivityEvent) => Effect.Effect<boolean>
  readonly handleTerminalExit: (event: TerminalExitEvent) => Effect.Effect<boolean>
  readonly handleTerminalSessionChanged: (event: TerminalSessionChangedEvent) => Effect.Effect<boolean>
  readonly handleTerminalTransitionError: (
    event: TerminalSessionTransitionErrorEvent,
  ) => Effect.Effect<boolean>
  readonly shutdown: Effect.Effect<void, ApplicationShutdownError>
}

type CommandCompletedMessage = {
  readonly _tag: "CommandCompleted"
  readonly key: string
  readonly token: number
  readonly command: ActorCommand
  readonly exit: Exit.Exit<unknown, unknown>
}

type LifecycleControlMessage =
  | { readonly _tag: "BeginShutdown"; readonly reply: DeferredType.Deferred<void> }
  | { readonly _tag: "FinishShutdown"; readonly error?: ApplicationShutdownError; readonly reply: DeferredType.Deferred<void> }

type ActorMessage =
  | IntentEnvelope
  | StateQueryEnvelope
  | (TerminalActorEvent & { readonly reply?: DeferredType.Deferred<boolean> })
  | CommandCompletedMessage
  | LifecycleControlMessage
  | { readonly _tag: "TerminalCleanupError"; readonly error: TerminalCleanupError }
  | { readonly _tag: "BackgroundFailure"; readonly operation: string; readonly cause: unknown }
  | { readonly _tag: "BranchMutationReconciliation"; readonly outcome: AmbiguousBranchMutation }

type ActorControlMessage = LifecycleControlMessage | CommandCompletedMessage

type ActorCommand =
  | { readonly _tag: "Refresh"; readonly refresh: ActiveRefresh; readonly reply?: IntentEnvelope["reply"] }
  | { readonly _tag: "PrepareNew"; readonly restoreTo: NavigatorSurface; readonly reply: IntentEnvelope["reply"] }
  | { readonly _tag: "PrepareResume"; readonly session: AgentSession; readonly reportFailure: boolean; readonly restoreTo: NavigatorSurface; readonly reply: IntentEnvelope["reply"] }
  | { readonly _tag: "Branch"; readonly restoreTo: NavigatorSurface; readonly reply: IntentEnvelope["reply"] }
  | { readonly _tag: "Show"; readonly prepared: PreparedTerminal; readonly restoreTo: NavigatorSurface; readonly reportFailure: boolean; readonly rollbackRelation?: BranchRelation; readonly reply: IntentEnvelope["reply"] }
  | { readonly _tag: "Hide"; readonly reply: IntentEnvelope["reply"] }
  | { readonly _tag: "Stop"; readonly sessionId: string; readonly reply: IntentEnvelope["reply"] }
  | { readonly _tag: "Remove"; readonly reply: IntentEnvelope["reply"] }
  | { readonly _tag: "AcknowledgeTransition"; readonly event: TerminalSessionChangedEvent }
  | { readonly _tag: "Navigation"; readonly navigation: NavigationState; readonly reply?: IntentEnvelope["reply"] }
  | { readonly _tag: "CompletionTimer"; readonly sessionId: string; readonly ownerId: string; readonly version: number }

interface ActiveCommand {
  readonly token: number
  readonly command: ActorCommand
  fiber?: Fiber.Fiber<void, never>
}

interface OwnerCursor {
  sessionId: string
  lastSequenceId: number
  transitioning: boolean
  readonly buffered: Array<TerminalActorEvent & { readonly reply?: DeferredType.Deferred<boolean> }>
}

export function makeAppRuntime(
  options: AppRuntimeOptions,
): Effect.Effect<AppRuntime, unknown, Scope.Scope> {
  return Effect.gen(function*() {
    const orphanedAdoptions = [...yield* options.metadata.orphanedAdoptions].sort((left, right) =>
      left.adoptionToken.localeCompare(right.adoptionToken))
    for (const adoption of orphanedAdoptions) {
      yield* options.metadata.reconcileOrphanedAdoption(adoption.adoptionToken)
    }

    const projectState = yield* options.metadata.loadMetadata
    const pendingAdoptions = [...yield* options.metadata.pendingAdoptions].sort((left, right) =>
      left.adoptionToken.localeCompare(right.adoptionToken))
    const snapshotExit = yield* Effect.exit(options.provider.loadSessionSnapshot)
    if (pendingAdoptions.length > 0 && Exit.isFailure(snapshotExit)) {
      return yield* Effect.failCause(snapshotExit.cause)
    }
    const initial = makeInitialApplicationState({
      relations: projectState.relations,
      removals: projectState.removals,
    })
    const loaded: ApplicationState = Exit.isSuccess(snapshotExit)
      ? {
          ...initial,
          provider: {
            sessions: new Map(snapshotExit.value.sessions.map((session) => [session.id, session])),
            transcripts: new Map(snapshotExit.value.transcripts),
          },
          refresh: { generation: 0, active: new Map(), initialPending: false },
        }
      : {
          ...initial,
          refresh: { generation: 0, active: new Map(), initialPending: false },
          modal: { _tag: "Error", message: errorMessage(Cause.squash(snapshotExit.cause)) },
        }
    let state: ApplicationState = {
      ...loaded,
      surface: restoreNavigatorSurface(loaded, projectState.navigation),
    }
    for (const adoption of pendingAdoptions) {
      yield* Effect.try({
        try: () => validateStartupAdoption(state, projectState, adoption),
        catch: (cause) => cause,
      })
      yield* options.metadata.ack(adoption.adoptionToken)
    }
    const publication = yield* SubscriptionRef.make(projectApplicationViewModel(state))
    const inbox = yield* Queue.unbounded<ActorMessage>()
    const controlInbox = yield* Queue.unbounded<ActorControlMessage>()
    const actorStopped = yield* Deferred.make<void>()
    const commandScope = yield* Scope.make("parallel")
    const closeCommandScope = Effect.suspend(() =>
      Scope.closeUnsafe(commandScope, Exit.void) ?? Effect.void)
    yield* Effect.addFinalizer(() => Effect.interruptible(closeCommandScope).pipe(
      Effect.timeoutOrElse({
        duration: COMMAND_SCOPE_CLOSE_TIMEOUT_MS,
        orElse: () => Effect.void,
      }),
    ))
    const operations = makeApplicationOperations(options)
    const navigation = yield* makeNavigationWriter(options.metadata)
    const preparedTerminals = new Map<string, PreparedTerminal>()
    const owners = new Map<string, OwnerCursor>()
    const unclaimedOwnerEvents = new Map<string, OwnerCursor["buffered"]>()
    const activeCommands = new Map<string, ActiveCommand>()
    const completionDelays = options.completionDelaysMs ?? DEFAULT_COMPLETION_DELAYS_MS
    const shutdownNavigationTimeoutMs = options.shutdownNavigationTimeoutMs ??
      DEFAULT_SHUTDOWN_NAVIGATION_TIMEOUT_MS
    let nextCorrelationId = 1
    let nextCommandToken = 1
    let nextRemovalRequestId = 1
    let accepting = true
    let shutdownResult: DeferredType.Deferred<void, ApplicationShutdownError> | undefined

    const publish = (event: StateEvent): Effect.Effect<void> => Effect.gen(function*() {
      const next = reduceApplicationState(state, event)
      if (next === state) return
      const viewModel = projectApplicationViewModel(next)
      yield* SubscriptionRef.set(publication, viewModel)
      state = next
    })

    const reject = (
      reply: IntentEnvelope["reply"],
      intent: ApplicationIntent["_tag"],
      reason: IntentRejectedError["reason"],
      message: string,
    ) => Deferred.fail(reply, new IntentRejectedError({ intent, reason, message }))

    const failReply = (
      reply: IntentEnvelope["reply"],
      intent: ApplicationIntent["_tag"],
      operation: string,
      cause: unknown,
      report = true,
    ): Effect.Effect<void> => Effect.gen(function*() {
      const error = new ApplicationOperationError({
        intent,
        operation,
        message: errorMessage(cause),
        cause,
      })
      if (report) yield* publish({ _tag: "ModalOpened", modal: { _tag: "Error", message: `${operation}: ${error.message}` } })
      yield* Deferred.fail(reply, error)
    })

    const failTerminalBarrier = (
      message: TerminalActorEvent & { readonly reply?: DeferredType.Deferred<boolean> },
      cause: unknown,
    ): Effect.Effect<void> => Effect.gen(function*() {
      if (message._tag === "TerminalSessionChanged" && message.event.acknowledgment) {
        yield* Deferred.fail(message.event.acknowledgment, cause)
      }
      if (message.reply) yield* Deferred.succeed(message.reply, false)
    })

    const transitionRejected = (message: string): Error =>
      new Error(`Application rejected terminal session transition: ${message}`)

    const commandReply = (command: ActorCommand): IntentEnvelope["reply"] | undefined =>
      "reply" in command ? command.reply : undefined

    const rejectCommandCollision = (
      key: string,
      command: ActorCommand,
    ): Effect.Effect<void> => Effect.gen(function*() {
      const message = `Operation ${key} is already in progress`
      const reply = commandReply(command)
      if (reply) yield* reject(reply, commandIntent(command), "busy", message)
      if (command._tag === "AcknowledgeTransition" && command.event.acknowledgment) {
        yield* Deferred.fail(command.event.acknowledgment, transitionRejected(message))
      }
    })

    const supersede = (key: string, reason = "A newer request superseded this operation"): Effect.Effect<void> =>
      Effect.gen(function*() {
        const active = activeCommands.get(key)
        if (!active) return
        activeCommands.delete(key)
        active.fiber?.interruptUnsafe()
        if (active.command._tag === "Refresh") {
          yield* publish({
            _tag: "RefreshSuperseded",
            key: active.command.refresh.key,
            generation: active.command.refresh.generation,
          })
        }
        const reply = commandReply(active.command)
        if (reply) {
          const intent = commandIntent(active.command)
          yield* reject(reply, intent, "superseded", reason)
        }
        if (active.command._tag === "AcknowledgeTransition") {
          const acknowledgment = active.command.event.acknowledgment
          if (acknowledgment) yield* Deferred.fail(acknowledgment, transitionRejected(reason))
        }
      })

    const launch = <A, E>(
      key: string,
      command: ActorCommand,
      effect: Effect.Effect<A, E>,
      replace = true,
    ): Effect.Effect<void> => Effect.gen(function*() {
      if (replace) yield* supersede(key)
      else if (activeCommands.has(key)) {
        yield* rejectCommandCollision(key, command)
        return
      }
      const token = nextCommandToken++
      activeCommands.set(key, { token, command })
      const run = Effect.exit(effect).pipe(
        Effect.flatMap((exit) => {
          const completion: CommandCompletedMessage = {
            _tag: "CommandCompleted",
            key,
            token,
            command,
            exit,
          }
          return Queue.offer(
            command._tag === "AcknowledgeTransition" ? controlInbox : inbox,
            completion,
          )
        }),
        Effect.asVoid,
      )
      const fiber = yield* Effect.forkIn(run, commandScope)
      const active = activeCommands.get(key)
      if (active?.token === token) active.fiber = fiber
      else fiber.interruptUnsafe()
    })

    const navigatorSurface = (sessionId?: string): NavigatorSurface => {
      if (state.surface._tag === "Terminal") return state.surface.returnTo
      if (state.surface._tag === "Graph") return state.surface
      if (!sessionId) return state.surface
      return {
        _tag: "Graph",
        familySessionId: selectConversationForest(state).graphBySessionId.get(sessionId)?.rootSessionId ?? sessionId,
        target: { kind: "endpoint", sessionId },
      }
    }

    const startNavigation = (
      surface: ApplicationState["surface"],
      reply?: IntentEnvelope["reply"],
    ): Effect.Effect<void, never, Scope.Scope> => {
      const navigationState = navigationForSurface(surface)
      const key = `navigation:${nextCommandToken}`
      return launch(key, {
        _tag: "Navigation",
        navigation: navigationState,
        ...(reply === undefined ? {} : { reply }),
      }, Effect.suspend(() => navigation.write(navigationState)), false)
    }

    const startRefresh = (
      reason: RefreshReason,
      sessionIds: ReadonlySet<string>,
      ownerId?: string,
      completionVersion?: number,
      reply?: IntentEnvelope["reply"],
      ambiguityReason?: string,
    ): Effect.Effect<void, never, Scope.Scope> => Effect.gen(function*() {
      const mode = reason === "manual" || reason === "initial" || reason === "ambiguity"
        ? "full" as const
        : "incremental" as const
      const key = mode === "full" ? "refresh:full" : `refresh:owner:${ownerId ?? [...sessionIds].join("|")}`
      if (mode === "full") {
        for (const activeKey of [...activeCommands.keys()]) {
          if (activeKey.startsWith("refresh:") || activeKey.startsWith("completion:")) {
            yield* supersede(activeKey)
          }
        }
      }
      const generation = state.refresh.generation + 1
      const refresh: ActiveRefresh = {
        key,
        generation,
        reason,
        mode,
        sessionIds: new Set(sessionIds),
        ...(completionVersion === undefined ? {} : { completionVersion }),
        ...(ambiguityReason === undefined ? {} : { ambiguityReason }),
      }
      yield* publish({ _tag: "RefreshStarted", refresh, ...(mode === "full" ? { replaceAll: true } : {}) })
      yield* launch(key, {
        _tag: "Refresh",
        refresh,
        ...(reply === undefined ? {} : { reply }),
      }, operations.loadSnapshot(mode, [...sessionIds]))
    })

    const scheduleCompletion = (sessionId: string): Effect.Effect<void, never, Scope.Scope> => {
      const completion = state.pendingCompletions.get(sessionId)
      if (!completion) return Effect.void
      const delay = completionDelays[Math.min(completion.attempt, completionDelays.length - 1)] ?? 0
      return launch(
        `completion:${completion.ownerId}`,
        {
          _tag: "CompletionTimer",
          sessionId,
          ownerId: completion.ownerId,
          version: completion.version,
        },
        Effect.sleep(delay),
      )
    }

    const startShow = (
      prepared: PreparedTerminal,
      restoreTo: NavigatorSurface,
      reply: IntentEnvelope["reply"],
      reportFailure: boolean,
      rollbackRelation?: BranchRelation,
    ): Effect.Effect<void, never, Scope.Scope> => Effect.gen(function*() {
      if (activeCommands.has("terminal:show")) {
        yield* reject(reply, "OpenEndpoint", "busy", "Another terminal is still opening")
        return
      }
      preparedTerminals.set(prepared.session.id, prepared)
      const familySessionId = selectConversationForest(state).graphBySessionId.get(prepared.session.id)?.rootSessionId ?? prepared.session.id
      yield* publish({
        _tag: "Navigated",
        surface: {
          _tag: "Graph",
          familySessionId,
          target: { kind: "endpoint", sessionId: prepared.session.id },
        },
      })
      yield* publish({ _tag: "TerminalShowStarted", sessionId: prepared.session.id })
      const show = rollbackRelation === undefined
        ? operations.show(prepared)
        : operations.show(prepared).pipe(
            Effect.tapError(() => rollbackPersistedBranch(options.metadata, rollbackRelation)),
          )
      yield* launch("terminal:show", {
        _tag: "Show",
        prepared,
        restoreTo,
        reportFailure,
        ...(rollbackRelation === undefined ? {} : { rollbackRelation }),
        reply,
      }, show, false)
    })

    let processMessageWithBoundary: (message: ActorMessage) => Effect.Effect<void, never, Scope.Scope>

    const claimBufferedOwnerEvents = (ownerId: string): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        const pending = unclaimedOwnerEvents.get(ownerId) ?? []
        unclaimedOwnerEvents.delete(ownerId)
        pending.sort((left, right) => terminalSequence(left) - terminalSequence(right))
        for (const event of pending) yield* processMessageWithBoundary(event)
      })

    const rejectUnclaimedSessionEvents = (sessionId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        for (const [ownerId, pending] of unclaimedOwnerEvents) {
          const retained: typeof pending = []
          for (const message of pending) {
            const eventSessionId = message._tag === "TerminalSessionChanged"
              ? message.event.previousSessionId
              : message.event.sessionId
            if (eventSessionId === sessionId) {
              yield* failTerminalBarrier(
                message,
                transitionRejected(`terminal opening failed for ${sessionId}`),
              )
            } else retained.push(message)
          }
          if (retained.length === 0) unclaimedOwnerEvents.delete(ownerId)
          else unclaimedOwnerEvents.set(ownerId, retained)
        }
      })

    const processTerminalEvent = (
      message: TerminalActorEvent & { readonly reply?: DeferredType.Deferred<boolean> },
    ): Effect.Effect<void, never, Scope.Scope> => Effect.gen(function*() {
      if (state.shutdown !== "running") {
        yield* failTerminalBarrier(message, transitionRejected("application is shutting down"))
        return
      }
      const ownerId = message.event.ownerId
      const cursor = owners.get(ownerId)
      if (!cursor) {
        if (terminalMayBeOpening(state, message)) {
          const pending = unclaimedOwnerEvents.get(ownerId) ?? []
          pending.push(message)
          unclaimedOwnerEvents.set(ownerId, pending)
          return
        }
        yield* failTerminalBarrier(message, transitionRejected(`terminal owner ${ownerId} is unavailable`))
        return
      }
      if (message.event.sequenceId <= cursor.lastSequenceId) {
        yield* failTerminalBarrier(message, transitionRejected("event sequence is stale or duplicated"))
        return
      }
      if (cursor.transitioning && message._tag !== "TerminalSessionChanged") {
        cursor.buffered.push(message)
        return
      }
      cursor.lastSequenceId = message.event.sequenceId

      if (message._tag === "TerminalActivity") {
        const event = message.event
        if (event.sessionId !== cursor.sessionId) {
          yield* failTerminalBarrier(message, transitionRejected("activity session does not match its owner"))
          return
        }
        yield* publish({
          _tag: "TerminalActivityObserved",
          sessionId: event.sessionId,
          ownerId,
          activity: event.activity,
          wasVisible: event.wasActive,
        })
        if (event.activity === "idle") yield* scheduleCompletion(event.sessionId)
        else yield* supersede(`completion:${ownerId}`, "Terminal activity superseded the completion timer")
      } else if (message._tag === "TerminalExit") {
        const event = message.event
        if (event.sessionId !== cursor.sessionId) {
          yield* failTerminalBarrier(message, transitionRejected("exit session does not match its owner"))
          return
        }
        if (event.draftPreview) {
          yield* publish({ _tag: "TerminalDraftObserved", sessionId: event.sessionId, draft: event.draftPreview })
        }
        yield* publish({
          _tag: "TerminalStopped",
          sessionId: event.sessionId,
          ...(event.cleanupError === undefined ? {} : { cleanupIncomplete: true }),
        })
        preparedTerminals.delete(event.sessionId)
        owners.delete(ownerId)
        yield* supersede(`completion:${ownerId}`)
        if (event.exitCode !== 0 || event.cleanupError) {
          const details = [
            event.exitCode === 0 ? undefined : `Agent session exited with code ${event.exitCode}`,
            event.cleanupError ? errorMessage(event.cleanupError) : undefined,
          ].filter((value): value is string => value !== undefined).join("; ")
          yield* publish({ _tag: "ModalOpened", modal: { _tag: "Error", message: details } })
        }
        yield* startRefresh("stop", new Set([event.sessionId]), ownerId)
      } else if (message._tag === "TerminalSessionChanged") {
        const event = message.event
        if (event.previousSessionId !== cursor.sessionId || cursor.transitioning) {
          yield* failTerminalBarrier(message, transitionRejected("transition does not match the current owner identity"))
          return
        }
        if (!event.acknowledgment) {
          yield* failTerminalBarrier(message, transitionRejected("transition acknowledgment barrier is missing"))
          return
        }
        cursor.transitioning = true
        const replacePrevious = state.local.temporarySessionIds.has(event.previousSessionId)
        yield* publish({
          _tag: "SessionIdentityAdopted",
          previousSessionId: event.previousSessionId,
          session: event.session,
          replacePrevious,
          ...(event.relation === undefined ? {} : { relation: event.relation }),
        })
        const prepared = preparedTerminals.get(event.previousSessionId)
        preparedTerminals.delete(event.previousSessionId)
        if (prepared) preparedTerminals.set(event.session.id, { ...prepared, session: event.session })
        cursor.sessionId = event.session.id
        yield* launch(
          `transition:${ownerId}`,
          { _tag: "AcknowledgeTransition", event },
          Effect.suspend(() => options.metadata.ack(event.adoptionToken)),
          false,
        )
      } else {
        const event = message.event
        if (event.sessionId !== cursor.sessionId) {
          yield* failTerminalBarrier(message, transitionRejected("transition error session does not match its owner"))
          return
        }
        yield* publish({
          _tag: "ModalOpened",
          modal: { _tag: "Error", message: `Agent session transition: ${errorMessage(event.error)}` },
        })
        yield* startRefresh("terminal-return", new Set([event.sessionId]), ownerId)
      }
      if (message.reply) yield* Deferred.succeed(message.reply, true)
    })

    const drainOwner = (ownerId: string): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        const cursor = owners.get(ownerId)
        if (!cursor) return
        cursor.transitioning = false
        cursor.buffered.sort((left, right) => terminalSequence(left) - terminalSequence(right))
        while (!cursor.transitioning && cursor.buffered.length > 0) {
          const event = cursor.buffered.shift()!
          yield* processMessageWithBoundary(event)
        }
      })

    const completeCommand = (
      message: Extract<ActorMessage, { readonly _tag: "CommandCompleted" }>,
    ): Effect.Effect<void, never, Scope.Scope> => Effect.gen(function*() {
      const active = activeCommands.get(message.key)
      if (!active || active.token !== message.token) return
      activeCommands.delete(message.key)
      const command = message.command
      const exit = message.exit

      if (command._tag === "Refresh") {
        if (Exit.isSuccess(exit)) {
          yield* publish({
            _tag: "RefreshSucceeded",
            key: command.refresh.key,
            generation: command.refresh.generation,
            snapshot: exit.value as AgentSessionSnapshot,
          })
        } else {
          const cause = Cause.squash(exit.cause)
          yield* publish({
            _tag: "RefreshFailed",
            key: command.refresh.key,
            generation: command.refresh.generation,
            message: errorMessage(cause),
          })
        }
        const completionSessionIds = command.refresh.mode === "full"
          ? [...state.pendingCompletions.keys()]
          : [...command.refresh.sessionIds]
        for (const sessionId of completionSessionIds) {
          const pending = state.pendingCompletions.get(sessionId)
          if (
            pending !== undefined &&
            (command.refresh.completionVersion === undefined ||
              pending.version === command.refresh.completionVersion)
          ) yield* scheduleCompletion(sessionId)
        }
        if (command.reply) {
          if (Exit.isSuccess(exit)) yield* Deferred.succeed(command.reply, undefined)
          else yield* failReply(
            command.reply,
            "Refresh",
            "Refresh conversations",
            Cause.squash(exit.cause),
            false,
          )
        }
        return
      }

      if (command._tag === "CompletionTimer") {
        if (Exit.isFailure(exit)) return
        const pending = state.pendingCompletions.get(command.sessionId)
        const cursor = owners.get(command.ownerId)
        if (
          !pending || pending.version !== command.version || pending.ownerId !== command.ownerId ||
          cursor?.sessionId !== command.sessionId
        ) return
        yield* startRefresh(
          "completion",
          new Set([command.sessionId]),
          command.ownerId,
          command.version,
        )
        return
      }

      if (command._tag === "Navigation") {
        if (Exit.isSuccess(exit)) {
          if (command.reply) yield* Deferred.succeed(command.reply, undefined)
        } else if (command.reply) {
          yield* failReply(command.reply, navigationIntent(state.surface), "Save navigation", Cause.squash(exit.cause))
        } else {
          yield* publish({ _tag: "ModalOpened", modal: { _tag: "Error", message: `Save navigation: ${errorMessage(Cause.squash(exit.cause))}` } })
        }
        return
      }

      if (command._tag === "PrepareNew") {
        if (Exit.isFailure(exit)) {
          yield* failReply(command.reply, "NewSession", "Create session", Cause.squash(exit.cause))
          return
        }
        const prepared = exit.value as PreparedTerminal
        yield* publish({ _tag: "LocalSessionProjected", session: prepared.session, temporary: true })
        yield* startShow(prepared, command.restoreTo, command.reply, true)
        return
      }

      if (command._tag === "PrepareResume") {
        if (Exit.isFailure(exit)) {
          yield* failReply(command.reply, "ResumeSession", "Resume session", Cause.squash(exit.cause), command.reportFailure)
          return
        }
        yield* startShow(exit.value as PreparedTerminal, command.restoreTo, command.reply, command.reportFailure)
        return
      }

      if (command._tag === "Branch") {
        if (Exit.isFailure(exit)) {
          yield* failReply(command.reply, "BranchFrom", "Create branch", Cause.squash(exit.cause))
          return
        }
        const outcome = exit.value as PersistedBranch | IndependentBranch
        if ("prepared" in outcome) {
          yield* publish({
            _tag: "PersistedBranchProjected",
            session: outcome.prepared.session,
            relation: outcome.relation,
          })
          yield* startShow(
            outcome.prepared,
            command.restoreTo,
            command.reply,
            true,
            outcome.prepared.session.transient ? outcome.relation : undefined,
          )
          return
        }
        if (outcome.outcome._tag === "AmbiguousBranchMutation") {
          yield* publish({ _tag: "ModalOpened", modal: { _tag: "Error", message: outcome.outcome.reason } })
          yield* startRefresh(
            "ambiguity",
            new Set(),
            undefined,
            undefined,
            undefined,
            outcome.outcome.reason,
          )
          yield* failReply(command.reply, "BranchFrom", "Create branch", outcome.outcome.reason, false)
          return
        }
        yield* publish({
          _tag: "LocalSessionProjected",
          session: outcome.outcome.session,
          transcript: outcome.outcome.transcript,
          ...(outcome.outcome.session.transient === undefined
            ? {}
            : { temporary: outcome.outcome.session.transient }),
        })
        yield* publish({ _tag: "ModalOpened", modal: { _tag: "Error", message: outcome.outcome.reason } })
        if (outcome.outcome.acquireLaunch) {
          yield* startShow({
            session: outcome.outcome.session,
            acquireLaunch: outcome.outcome.acquireLaunch,
          }, command.restoreTo, command.reply, true)
        } else {
          yield* failReply(command.reply, "BranchFrom", "Create branch", outcome.outcome.reason, false)
        }
        return
      }

      if (command._tag === "Show") {
        if (Exit.isFailure(exit)) {
          preparedTerminals.delete(command.prepared.session.id)
          yield* rejectUnclaimedSessionEvents(command.prepared.session.id)
          yield* publish({
            _tag: "TerminalShowFailed",
            sessionId: command.prepared.session.id,
            restoreTo: command.restoreTo,
            ...(command.reportFailure ? { message: errorMessage(Cause.squash(exit.cause)) } : {}),
          })
          if (command.prepared.session.transient) {
            yield* publish({
              _tag: "TransientSessionRolledBack",
              sessionId: command.prepared.session.id,
              restoreTo: command.restoreTo,
            })
          }
          yield* failReply(command.reply, "OpenEndpoint", "Open session", Cause.squash(exit.cause), false)
          return
        }
        const ownerId = exit.value as string
        const sessionId = command.prepared.session.id
        yield* publish({ _tag: "TerminalShown", sessionId, ownerId, returnTo: command.restoreTo })
        const cursor = owners.get(ownerId) ?? {
          sessionId,
          lastSequenceId: 0,
          transitioning: false,
          buffered: [],
        }
        cursor.sessionId = sessionId
        owners.set(ownerId, cursor)
        yield* claimBufferedOwnerEvents(ownerId)
        yield* startNavigation(state.surface, command.reply)
        return
      }

      if (command._tag === "Hide") {
        if (Exit.isFailure(exit)) {
          yield* failReply(command.reply, "ReturnFromTerminal", "Return to navigator", Cause.squash(exit.cause))
          return
        }
        const hidden = exit.value as { readonly sessionId: string | null; readonly drafts: ReadonlyMap<string, import("../domain/model").DraftPreview> }
        if (!hidden.sessionId) {
          yield* reject(command.reply, "ReturnFromTerminal", "invalid", "No active terminal is available")
          return
        }
        const draft = hidden.drafts.get(hidden.sessionId)
        yield* publish({
          _tag: "TerminalReturned",
          sessionId: hidden.sessionId,
          ...(draft === undefined ? {} : { draft }),
        })
        const ownerId = state.terminals.get(hidden.sessionId)?.ownerId
        yield* startRefresh("terminal-return", new Set([hidden.sessionId]), ownerId)
        yield* startNavigation(state.surface, command.reply)
        return
      }

      if (command._tag === "Stop") {
        if (Exit.isFailure(exit)) {
          yield* publish({ _tag: "TerminalStopped", sessionId: command.sessionId, cleanupIncomplete: true })
          yield* failReply(command.reply, "StopSession", "Stop session", Cause.squash(exit.cause))
          return
        }
        const terminal = state.terminals.get(command.sessionId)
        const ownerId = terminal?.ownerId
        preparedTerminals.delete(command.sessionId)
        if (ownerId) owners.delete(ownerId)
        yield* publish({ _tag: "TerminalStopped", sessionId: command.sessionId })
        yield* startRefresh("stop", new Set([command.sessionId]), ownerId)
        yield* Deferred.succeed(command.reply, undefined)
        return
      }

      if (command._tag === "Remove") {
        if (Exit.isFailure(exit)) {
          const cause = Cause.squash(exit.cause)
          if (cause instanceof RemovalOperationError) {
            for (const sessionId of cause.stoppedSessionIds) {
              const ownerId = state.terminals.get(sessionId)?.ownerId
              if (ownerId) owners.delete(ownerId)
              preparedTerminals.delete(sessionId)
              yield* publish({ _tag: "TerminalStopped", sessionId })
            }
            if (cause.failedSessionId) {
              yield* publish({
                _tag: "TerminalStopped",
                sessionId: cause.failedSessionId,
                cleanupIncomplete: true,
              })
            }
            if (cause.stoppedSessionIds.length > 0) {
              yield* startRefresh("stop", new Set(cause.stoppedSessionIds))
            }
            yield* publish({
              _tag: "ModalOpened",
              modal: { _tag: "Error", message: `Remove conversation: ${cause.message}` },
            })
            yield* Deferred.fail(command.reply, cause)
            return
          }
          yield* failReply(command.reply, "Remove", "Remove conversation", cause)
          return
        }
        const result = exit.value as RemovalResult
        for (const sessionId of result.stoppedSessionIds) {
          const ownerId = state.terminals.get(sessionId)?.ownerId
          if (ownerId) owners.delete(ownerId)
          preparedTerminals.delete(sessionId)
        }
        yield* publish({ _tag: "RemovalPersisted", ...result })
        if (result.stoppedSessionIds.length > 0) {
          yield* startRefresh("stop", new Set(result.stoppedSessionIds))
        }
        yield* Deferred.succeed(command.reply, undefined)
        return
      }

      if (command._tag === "AcknowledgeTransition") {
        const ownerId = command.event.ownerId
        if (Exit.isFailure(exit)) {
          const cause = Cause.squash(exit.cause)
          yield* publish({
            _tag: "ModalOpened",
            modal: { _tag: "Error", message: `Acknowledge session identity: ${errorMessage(cause)}` },
          })
          if (command.event.acknowledgment) {
            yield* Deferred.fail(command.event.acknowledgment, cause)
          }
          yield* drainOwner(ownerId)
          return
        }
        yield* startRefresh(
          "terminal-return",
          new Set([command.event.previousSessionId, command.event.session.id]),
          ownerId,
        )
        if (command.event.acknowledgment) {
          yield* Deferred.succeed(command.event.acknowledgment, undefined)
        }
        yield* drainOwner(ownerId)
        return
      }
    })

    const applyQueuedTransitionCompletions: Effect.Effect<void, never, Scope.Scope> =
      Effect.gen(function*() {
        const retained: ActorControlMessage[] = []
        for (const pending of yield* Queue.clear(controlInbox)) {
          if (pending._tag === "CommandCompleted" && pending.command._tag === "AcknowledgeTransition") {
            yield* completeCommand(pending)
          } else retained.push(pending)
        }
        for (const pending of retained) yield* Queue.offer(controlInbox, pending)
      })

    const processIntent = (envelope: IntentEnvelope): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function*() {
        const intent = envelope.intent
        if (!accepting || state.shutdown !== "running") {
          yield* reject(envelope.reply, intent._tag, "shutting-down", "Application is shutting down")
          return
        }
        switch (intent._tag) {
          case "Refresh":
            yield* startRefresh("manual", new Set(), undefined, undefined, envelope.reply)
            return
          case "SelectRoot": {
            const surface = { _tag: "Roots" as const, selectedSessionId: intent.sessionId }
            yield* publish({ _tag: "Navigated", surface })
            yield* startNavigation(surface, envelope.reply)
            return
          }
          case "EnterRoot": {
            const graph = projectGraphViewModel(state, intent.sessionId)
            const selected = graph.nodes.find((node) => node.selected)
            if (!selected) {
              yield* reject(envelope.reply, intent._tag, "invalid", `Conversation ${intent.sessionId} is unavailable`)
              return
            }
            const surface = {
              _tag: "Graph" as const,
              familySessionId: graph.familySessionId,
              target: selected.target,
            }
            yield* publish({ _tag: "Navigated", surface })
            yield* startNavigation(surface, envelope.reply)
            return
          }
          case "SelectGraph": {
            const surface = {
              _tag: "Graph" as const,
              familySessionId: intent.familySessionId,
              target: intent.target,
            }
            yield* publish({ _tag: "Navigated", surface })
            yield* startNavigation(surface, envelope.reply)
            return
          }
          case "NewSession": {
            const restoreTo = navigatorSurface()
            yield* launch(`prepare:new:${envelope.correlationId}`, {
              _tag: "PrepareNew",
              restoreTo,
              reply: envelope.reply,
            }, operations.prepareNew, false)
            return
          }
          case "ResumeSession": {
            const session = selectProjectedData(state).sessions.get(intent.sessionId)
            if (!session || session.transient) {
              yield* reject(envelope.reply, intent._tag, "invalid", `Session ${intent.sessionId} is not resumable`)
              return
            }
            yield* launch(`prepare:resume:${envelope.correlationId}`, {
              _tag: "PrepareResume",
              session,
              reportFailure: intent.reportFailure,
              restoreTo: navigatorSurface(session.id),
              reply: envelope.reply,
            }, operations.prepareResume(session), false)
            return
          }
          case "OpenEndpoint": {
            const running = state.terminals.get(intent.sessionId)
            if (running?.phase === "running") {
              const prepared = preparedTerminals.get(intent.sessionId)
              if (!prepared) {
                yield* reject(envelope.reply, intent._tag, "invalid", `No prepared terminal is available for ${intent.sessionId}`)
                return
              }
              yield* startShow(prepared, navigatorSurface(intent.sessionId), envelope.reply, true)
              return
            }
            if (running) {
              yield* reject(envelope.reply, intent._tag, "busy", `Session ${intent.sessionId} is ${running.phase}`)
              return
            }
            const session = selectProjectedData(state).sessions.get(intent.sessionId)
            if (!session || session.transient) {
              yield* reject(envelope.reply, intent._tag, "invalid", `Session ${intent.sessionId} is not resumable`)
              return
            }
            yield* launch(`prepare:resume:${envelope.correlationId}`, {
              _tag: "PrepareResume",
              session,
              reportFailure: true,
              restoreTo: navigatorSurface(session.id),
              reply: envelope.reply,
            }, operations.prepareResume(session), false)
            return
          }
          case "BranchFrom":
            yield* launch(`branch:${envelope.correlationId}`, {
              _tag: "Branch",
              restoreTo: navigatorSurface(intent.target.sessionId),
              reply: envelope.reply,
            }, operations.branch(intent.target), false)
            return
          case "ReturnFromTerminal":
            yield* launch(`hide:${envelope.correlationId}`, { _tag: "Hide", reply: envelope.reply }, operations.hideActive, false)
            return
          case "StopSession": {
            const terminal = state.terminals.get(intent.sessionId)
            if (!terminal) {
              yield* reject(envelope.reply, intent._tag, "invalid", `Session ${intent.sessionId} is not running`)
              return
            }
            if (activeCommands.has(`stop:${intent.sessionId}`)) {
              yield* reject(envelope.reply, intent._tag, "busy", `Session ${intent.sessionId} is already stopping`)
              return
            }
            yield* publish({ _tag: "TerminalStopping", sessionId: intent.sessionId })
            yield* launch(`stop:${intent.sessionId}`, {
              _tag: "Stop",
              sessionId: intent.sessionId,
              reply: envelope.reply,
            }, operations.stop(intent.sessionId), false)
            return
          }
          case "Remove":
            yield* launch(`remove:${intent.requestId}`, {
              _tag: "Remove",
              reply: envelope.reply,
            }, operations.remove(intent.removal, intent.affectedSessionIds), false)
            return
          case "OpenModal":
            yield* publish({ _tag: "ModalOpened", modal: intent.modal })
            yield* Deferred.succeed(envelope.reply, undefined)
            return
          case "CloseModal":
            yield* publish({ _tag: "ModalClosed" })
            yield* Deferred.succeed(envelope.reply, undefined)
            return
        }
      })

    const processMessage = (message: ActorMessage): Effect.Effect<void, never, Scope.Scope> => {
      if (message._tag === "Intent") return processIntent(message)
      if (message._tag === "StateQuery") return Deferred.succeed(message.reply, state).pipe(Effect.asVoid)
      if (message._tag === "CommandCompleted") return completeCommand(message)
      if (message._tag === "TerminalCleanupError") {
        return publish({
          _tag: "ModalOpened",
          modal: { _tag: "Error", message: `Terminal cleanup: ${errorMessage(message.error)}` },
        })
      }
      if (message._tag === "BackgroundFailure") {
        if (!accepting || state.shutdown !== "running") return Effect.void
        return publish({
          _tag: "ModalOpened",
          modal: { _tag: "Error", message: `${message.operation}: ${errorMessage(message.cause)}` },
        })
      }
      if (message._tag === "BranchMutationReconciliation") {
        if (!accepting || state.shutdown !== "running") return Effect.void
        return Effect.gen(function*() {
          yield* publish({
            _tag: "ModalOpened",
            modal: { _tag: "Error", message: message.outcome.reason },
          })
          yield* startRefresh(
            "ambiguity",
            new Set(),
            undefined,
            undefined,
            undefined,
            message.outcome.reason,
          )
        })
      }
      if (message._tag === "BeginShutdown") {
        return Effect.gen(function*() {
          yield* Effect.yieldNow
          yield* applyQueuedTransitionCompletions
          yield* publish({ _tag: "ShutdownStarted" })
          for (const key of [...activeCommands.keys()]) {
            yield* supersede(key, "Application shutdown cancelled this operation")
          }
          for (const cursor of owners.values()) {
            for (const buffered of cursor.buffered.splice(0)) {
              yield* failTerminalBarrier(
                buffered,
                transitionRejected("application shutdown discarded this buffered event"),
              )
            }
          }
          for (const buffered of unclaimedOwnerEvents.values()) {
            for (const pending of buffered) {
              yield* failTerminalBarrier(
                pending,
                transitionRejected("application shutdown discarded this unclaimed event"),
              )
            }
          }
          unclaimedOwnerEvents.clear()
          yield* Deferred.succeed(message.reply, undefined)
        })
      }
      if (message._tag === "FinishShutdown") {
        return Effect.gen(function*() {
          yield* publish(message.error
            ? { _tag: "ShutdownFailed", message: message.error.message }
            : { _tag: "ShutdownCompleted" })
          yield* Deferred.succeed(message.reply, undefined)
        })
      }
      return processTerminalEvent(message)
    }

    const recoverCommandState = (
      command: ActorCommand,
      cause: unknown,
    ): Effect.Effect<void, never, Scope.Scope> => {
      if (command._tag === "Refresh") {
        return publish({
          _tag: "RefreshFailed",
          key: command.refresh.key,
          generation: command.refresh.generation,
          message: errorMessage(cause),
        }).pipe(Effect.catchCause((recoveryCause) => Cause.hasInterrupts(recoveryCause)
          ? Effect.failCause(recoveryCause)
          : Effect.void))
      }
      if (command._tag === "AcknowledgeTransition") {
        const cursor = owners.get(command.event.ownerId)
        if (cursor) cursor.transitioning = false
        return drainOwner(command.event.ownerId).pipe(Effect.catchCause((recoveryCause) =>
          Cause.hasInterrupts(recoveryCause) ? Effect.failCause(recoveryCause) : Effect.void))
      }
      return Effect.void
    }

    const settleMessageDefect = (
      message: ActorMessage,
      failure: ApplicationOperationError,
    ): Effect.Effect<void> => Effect.gen(function*() {
      if (message._tag === "Intent") {
        if (!Deferred.isDoneUnsafe(message.reply)) yield* Deferred.fail(message.reply, failure)
        return
      }
      if (message._tag === "StateQuery") {
        if (!Deferred.isDoneUnsafe(message.reply)) yield* Deferred.succeed(message.reply, state)
        return
      }
      if (message._tag === "CommandCompleted") {
        const reply = commandReply(message.command)
        if (reply && !Deferred.isDoneUnsafe(reply)) yield* Deferred.fail(reply, failure)
        if (
          message.command._tag === "AcknowledgeTransition" &&
          message.command.event.acknowledgment &&
          !Deferred.isDoneUnsafe(message.command.event.acknowledgment)
        ) yield* Deferred.fail(message.command.event.acknowledgment, failure)
        return
      }
      if (message._tag === "BeginShutdown" || message._tag === "FinishShutdown") return
      if (
        message._tag === "TerminalCleanupError" || message._tag === "BackgroundFailure" ||
        message._tag === "BranchMutationReconciliation"
      ) return
      if (
        message._tag === "TerminalSessionChanged" && message.event.acknowledgment &&
        !Deferred.isDoneUnsafe(message.event.acknowledgment)
      ) yield* Deferred.fail(message.event.acknowledgment, failure)
      if (message.reply && !Deferred.isDoneUnsafe(message.reply)) {
        yield* Deferred.succeed(message.reply, false)
      }
    })

    const containMessageDefect = (
      message: ActorMessage,
      cause: Cause.Cause<never>,
    ): Effect.Effect<void, never, Scope.Scope> => {
      if (
        Cause.hasInterrupts(cause) || message._tag === "BeginShutdown" ||
        message._tag === "FinishShutdown"
      ) return Effect.failCause(cause)

      const defect = Cause.squash(cause)
      const context = messageFailureContext(message)
      const failure = new ApplicationOperationError({
        intent: context.intent,
        operation: context.operation,
        message: errorMessage(defect),
        cause: defect,
      })
      return Effect.gen(function*() {
        const relatedCommands: ActorCommand[] = message._tag === "CommandCompleted"
          ? [message.command]
          : []
        const reply = message._tag === "Intent"
          ? message.reply
          : message._tag === "CommandCompleted"
            ? commandReply(message.command)
            : undefined
        const acknowledgment = message._tag === "TerminalSessionChanged"
          ? message.event.acknowledgment
          : message._tag === "CommandCompleted" && message.command._tag === "AcknowledgeTransition"
            ? message.command.event.acknowledgment
            : undefined

        for (const [key, active] of activeCommands) {
          if (
            (message._tag === "CommandCompleted" && key === message.key && active.token === message.token) ||
            (reply !== undefined && commandReply(active.command) === reply) ||
            (acknowledgment !== undefined && active.command._tag === "AcknowledgeTransition" &&
              active.command.event.acknowledgment === acknowledgment)
          ) {
            activeCommands.delete(key)
            active.fiber?.interruptUnsafe()
            if (!relatedCommands.includes(active.command)) relatedCommands.push(active.command)
          }
        }

        if (message._tag === "TerminalSessionChanged") {
          const cursor = owners.get(message.event.ownerId)
          if (cursor) cursor.transitioning = false
        }
        yield* settleMessageDefect(message, failure)
        for (const command of relatedCommands) yield* recoverCommandState(command, defect)
        if (message._tag === "TerminalSessionChanged") {
          yield* drainOwner(message.event.ownerId).pipe(Effect.catchCause((recoveryCause) =>
            Cause.hasInterrupts(recoveryCause) ? Effect.failCause(recoveryCause) : Effect.void))
        }
        if (state.shutdown === "running") {
          yield* publish({
            _tag: "ModalOpened",
            modal: { _tag: "Error", message: `${context.operation}: ${failure.message}` },
          }).pipe(Effect.catchCause((reportCause) => Cause.hasInterrupts(reportCause)
            ? Effect.failCause(reportCause)
            : Effect.void))
        }
      })
    }

    processMessageWithBoundary = (message) => Effect.catchCause(
      Effect.suspend(() => processMessage(message)),
      (cause) => containMessageDefect(message, cause),
    )

    const settleActorAbandonment = Effect.gen(function*() {
      accepting = false
      const unavailable = transitionRejected("application actor stopped")
      for (const active of activeCommands.values()) {
        const reply = commandReply(active.command)
        if (reply) {
          yield* Deferred.fail(reply, new IntentRejectedError({
            intent: commandIntent(active.command),
            reason: "shutting-down",
            message: "Application actor is unavailable",
          }))
        }
        if (active.command._tag === "AcknowledgeTransition" && active.command.event.acknowledgment) {
          yield* Deferred.fail(active.command.event.acknowledgment, unavailable)
        }
      }
      for (const cursor of owners.values()) {
        for (const buffered of cursor.buffered.splice(0)) {
          yield* failTerminalBarrier(buffered, unavailable)
        }
      }
      for (const buffered of unclaimedOwnerEvents.values()) {
        for (const pending of buffered) yield* failTerminalBarrier(pending, unavailable)
      }
      unclaimedOwnerEvents.clear()
      for (const pending of yield* Queue.clear(inbox)) {
        if (pending._tag === "Intent") {
          yield* Deferred.fail(pending.reply, new IntentRejectedError({
            intent: pending.intent._tag,
            reason: "shutting-down",
            message: "Application actor is unavailable",
          }))
        } else if (pending._tag === "StateQuery") {
          yield* Deferred.succeed(pending.reply, state)
        } else if (
          pending._tag !== "CommandCompleted" && pending._tag !== "TerminalCleanupError"
          && pending._tag !== "BackgroundFailure"
          && pending._tag !== "BranchMutationReconciliation"
          && pending._tag !== "BeginShutdown" && pending._tag !== "FinishShutdown"
        ) {
          yield* failTerminalBarrier(pending, unavailable)
        }
      }
      for (const pending of yield* Queue.clear(controlInbox)) {
        if (pending._tag !== "CommandCompleted") {
          yield* Deferred.succeed(pending.reply, undefined)
        }
      }
      yield* Deferred.succeed(actorStopped, undefined)
    })

    const takeActorMessage: Effect.Effect<ActorMessage> = Effect.flatMap(
      Queue.poll(controlInbox),
      Option.match({
        onNone: () => Effect.raceFirst(Queue.take(controlInbox), Queue.take(inbox)),
        onSome: Effect.succeed,
      }),
    )

    yield* Effect.forkScoped(
      Effect.forever(takeActorMessage.pipe(
        Effect.flatMap((message) => Effect.uninterruptible(processMessageWithBoundary(message))),
      )).pipe(
        Effect.ensuring(settleActorAbandonment),
      ),
    )

    if ("takeBranchMutationReconciliation" in options.provider) {
      let consecutiveFailures = 0
      yield* Effect.forkScoped(Effect.forever(
        Effect.matchCauseEffect(Effect.suspend(() =>
          options.provider.takeBranchMutationReconciliation ?? Effect.never), {
          onFailure: (cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
            consecutiveFailures += 1
            const failure = Cause.squash(cause)
            return Effect.gen(function*() {
              if (accepting && consecutiveFailures === 1) {
                yield* Queue.offer(inbox, {
                  _tag: "BackgroundFailure",
                  operation: "Branch reconciliation",
                  cause: failure,
                })
              }
              yield* Effect.sleep(Math.min(
                RECONCILIATION_FAILURE_BACKOFF_MS * consecutiveFailures,
                1_000,
              ))
            })
          },
          onSuccess: (outcome) => {
            consecutiveFailures = 0
            return Effect.suspend(() => accepting
              ? Queue.offer(inbox, { _tag: "BranchMutationReconciliation", outcome }).pipe(Effect.asVoid)
              : Effect.void)
          },
        }),
      ))
    }

    const actorUnavailable = (intent: ApplicationIntent["_tag"]): IntentRejectedError =>
      new IntentRejectedError({
        intent,
        reason: "shutting-down",
        message: "Application actor is unavailable",
      })

    const awaitActorReply = <A, E>(
      reply: DeferredType.Deferred<A, E>,
      unavailable: E,
    ): Effect.Effect<A, E> => Effect.raceFirst(
      Deferred.await(reply),
      Deferred.await(actorStopped).pipe(Effect.andThen(Effect.fail(unavailable))),
    )

    const request = (intent: ApplicationIntent): ApplicationIntentEffect => Effect.suspend(() => {
      if (!accepting) {
        return Effect.fail(new IntentRejectedError({
          intent: intent._tag,
          reason: "shutting-down",
          message: "Application is shutting down",
        }))
      }
      return Effect.gen(function*() {
        const reply = yield* Deferred.make<void, ApplicationIntentError>()
        const offered = yield* Queue.offer(inbox, {
          _tag: "Intent",
          correlationId: nextCorrelationId++,
          intent,
          reply,
        })
        if (!offered) {
          return yield* Effect.fail(new IntentRejectedError({
            intent: intent._tag,
            reason: "shutting-down",
            message: "Application actor is unavailable",
          }))
        }
        return yield* awaitActorReply(reply, actorUnavailable(intent._tag))
      })
    })

    const terminalRequest = (
      event: TerminalActorEvent,
    ): Effect.Effect<boolean> => Effect.gen(function*() {
      if (!accepting) {
        yield* failTerminalBarrier(event, transitionRejected("application is shutting down"))
        return false
      }
      const reply = yield* Deferred.make<boolean>()
      const offered = yield* Queue.offer(inbox, { ...event, reply })
      if (!offered) {
        yield* failTerminalBarrier(event, transitionRejected("application event queue is closed"))
        return false
      }
      return yield* Effect.raceFirst(
        Deferred.await(reply),
        Deferred.await(actorStopped).pipe(Effect.as(false)),
      )
    })

    const sendControl = (
      message: (reply: DeferredType.Deferred<void>) => LifecycleControlMessage,
    ): Effect.Effect<boolean> => Effect.gen(function*() {
      const reply = yield* Deferred.make<void>()
      const offered = yield* Queue.offer(controlInbox, message(reply))
      if (!offered) return false
      return yield* Effect.raceFirst(
        Deferred.await(reply).pipe(Effect.as(true)),
        Deferred.await(actorStopped).pipe(Effect.as(false)),
      )
    })

    const performShutdown = (
      result: DeferredType.Deferred<void, ApplicationShutdownError>,
    ): Effect.Effect<void> => Effect.gen(function*() {
      const lifecycleShutdown = Effect.gen(function*() {
        const began = yield* sendControl((reply) => ({ _tag: "BeginShutdown", reply }))
        if (!began) return yield* Effect.fail(new Error("Application actor could not begin shutdown"))
        const navigationExit = yield* Effect.exit(Effect.interruptible(navigation.flush).pipe(
          Effect.timeoutOrElse({
            duration: shutdownNavigationTimeoutMs,
            orElse: () => Effect.fail(new Error(
              `Timed out after ${shutdownNavigationTimeoutMs}ms while saving navigation`,
            )),
          }),
        ))
        yield* Effect.interruptible(Effect.suspend(() => navigation.close)).pipe(Effect.timeoutOrElse({
          duration: shutdownNavigationTimeoutMs,
          orElse: () => Effect.void,
        }))
        yield* Effect.interruptible(closeCommandScope).pipe(
          Effect.timeoutOrElse({
            duration: COMMAND_SCOPE_CLOSE_TIMEOUT_MS,
            orElse: () => Effect.void,
          }),
        )
        if (Exit.isFailure(navigationExit)) yield* Effect.failCause(navigationExit.cause)
      })
      const [lifecycleExit, terminalExit] = yield* Effect.all([
        Effect.exit(lifecycleShutdown),
        Effect.exit(Effect.suspend(() => options.terminals.shutdown())),
      ], { concurrency: "unbounded" })
      const failures = [lifecycleExit, terminalExit].flatMap((exit) =>
        Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [])
      const error = failures.length === 0
        ? undefined
        : new ApplicationShutdownError({
            message: `Application shutdown failed: ${failures.map(errorMessage).join("; ")}`,
            cause: failures.length === 1 ? failures[0] : failures,
          })
      const finished = yield* sendControl((reply) => ({
        _tag: "FinishShutdown",
        ...(error === undefined ? {} : { error }),
        reply,
      }))
      if (!finished) {
        const finishError = error ?? new ApplicationShutdownError({
          message: "Application shutdown failed: application actor could not finish shutdown",
        })
        yield* Deferred.fail(result, finishError)
        return
      }
      if (error) yield* Deferred.fail(result, error)
      else yield* Deferred.succeed(result, undefined)
    }).pipe(Effect.catchCause((cause) => {
      const error = new ApplicationShutdownError({
        message: `Application shutdown failed: ${errorMessage(Cause.squash(cause))}`,
        cause: Cause.squash(cause),
      })
      return Deferred.fail(result, error).pipe(Effect.asVoid)
    }))

    const shutdown: Effect.Effect<void, ApplicationShutdownError> = Effect.suspend(() => {
      if (shutdownResult) return Deferred.await(shutdownResult)
      accepting = false
      const result = Deferred.makeUnsafe<void, ApplicationShutdownError>()
      shutdownResult = result
      return Effect.forkDetach(performShutdown(result), {
        startImmediately: true,
        uninterruptible: false,
      }).pipe(Effect.andThen(Deferred.await(result)))
    })

    const getState = Effect.suspend(() =>
      state.shutdown === "stopped" || state.shutdown === "cleanup-incomplete"
        ? Effect.succeed(state)
        : Effect.gen(function*() {
            const reply = yield* Deferred.make<ApplicationState>()
            const offered = yield* Queue.offer(inbox, { _tag: "StateQuery", reply })
            if (!offered) return state
            return yield* Effect.raceFirst(
              Deferred.await(reply),
              Deferred.await(actorStopped).pipe(Effect.as(state)),
            )
          }))

    const offerTerminalCallback = (message: TerminalActorEvent): void => {
      if (accepting && Queue.offerUnsafe(inbox, message)) return
      if (message._tag === "TerminalSessionChanged" && message.event.acknowledgment) {
        Deferred.doneUnsafe(
          message.event.acknowledgment,
          Effect.fail(transitionRejected("application event queue is unavailable")),
        )
      }
    }

    const runtime: AppRuntime = {
      getState,
      getViewModel: SubscriptionRef.get(publication),
      viewModels: SubscriptionRef.changes(publication),
      terminalEvents: {
        onActivityChanged: (event) => offerTerminalCallback({ _tag: "TerminalActivity", event }),
        onProcessExited: (event) => offerTerminalCallback({ _tag: "TerminalExit", event }),
        onSessionChanged: (event) => offerTerminalCallback({ _tag: "TerminalSessionChanged", event }),
        onSessionTransitionError: (event) => offerTerminalCallback({ _tag: "TerminalTransitionError", event }),
        onCleanupError: (error) => {
          if (accepting) Queue.offerUnsafe(inbox, { _tag: "TerminalCleanupError", error })
        },
      },
      refresh: () => request({ _tag: "Refresh", reason: "manual" }),
      selectRoot: (sessionId) => request({ _tag: "SelectRoot", sessionId }),
      enterRoot: (sessionId) => request({ _tag: "EnterRoot", sessionId }),
      selectGraph: (familySessionId, target) => request({ _tag: "SelectGraph", familySessionId, target }),
      newSession: request({ _tag: "NewSession" }),
      resumeSession: (sessionId) => request({ _tag: "ResumeSession", sessionId, reportFailure: true }),
      openEndpoint: (sessionId) => request({ _tag: "OpenEndpoint", sessionId }),
      branchFrom: (target) => request({ _tag: "BranchFrom", target }),
      returnFromTerminal: request({ _tag: "ReturnFromTerminal" }),
      stopSession: (sessionId) => request({ _tag: "StopSession", sessionId }),
      remove: (removal, affectedSessionIds, requestId = `removal-${nextRemovalRequestId++}`) =>
        request({ _tag: "Remove", requestId, removal, affectedSessionIds }),
      openModal: (modal) => request({ _tag: "OpenModal", modal }),
      closeModal: request({ _tag: "CloseModal" }),
      handleTerminalActivity: (event) => terminalRequest({ _tag: "TerminalActivity", event }),
      handleTerminalExit: (event) => terminalRequest({ _tag: "TerminalExit", event }),
      handleTerminalSessionChanged: (event) => terminalRequest({ _tag: "TerminalSessionChanged", event }),
      handleTerminalTransitionError: (event) => terminalRequest({ _tag: "TerminalTransitionError", event }),
      shutdown,
    }

    if (projectState.navigation?.view === "terminal" && Exit.isSuccess(snapshotExit)) {
      yield* Effect.exit(request({
        _tag: "ResumeSession",
        sessionId: projectState.navigation.sessionId,
        reportFailure: false,
      }))
    }

    yield* Effect.addFinalizer(() => shutdown.pipe(
      Effect.catch((error) => Effect.die(error)),
    ))
    return runtime
  })
}

function commandIntent(command: ActorCommand): ApplicationIntent["_tag"] {
  switch (command._tag) {
    case "Refresh": return "Refresh"
    case "PrepareNew": return "NewSession"
    case "PrepareResume": return "ResumeSession"
    case "Branch": return "BranchFrom"
    case "Show": return "OpenEndpoint"
    case "Hide": return "ReturnFromTerminal"
    case "Stop": return "StopSession"
    case "Remove": return "Remove"
    case "Navigation": return "SelectGraph"
    case "CompletionTimer": return "Refresh"
    case "AcknowledgeTransition": return "OpenEndpoint"
  }
}

function messageFailureContext(message: ActorMessage): {
  readonly intent: ApplicationIntent["_tag"]
  readonly operation: string
} {
  if (message._tag === "Intent") {
    return { intent: message.intent._tag, operation: intentOperation(message.intent._tag) }
  }
  if (message._tag === "CommandCompleted") {
    return { intent: commandIntent(message.command), operation: commandOperation(message.command) }
  }
  if (message._tag === "TerminalActivity") {
    return { intent: "OpenEndpoint", operation: "Process terminal activity" }
  }
  if (message._tag === "TerminalExit") {
    return { intent: "StopSession", operation: "Process terminal exit" }
  }
  if (message._tag === "TerminalSessionChanged") {
    return { intent: "OpenEndpoint", operation: "Project terminal session transition" }
  }
  if (message._tag === "TerminalTransitionError") {
    return { intent: "OpenEndpoint", operation: "Process terminal transition error" }
  }
  if (message._tag === "BranchMutationReconciliation") {
    return { intent: "Refresh", operation: "Reconcile branch mutation" }
  }
  if (message._tag === "TerminalCleanupError") {
    return { intent: "StopSession", operation: "Report terminal cleanup" }
  }
  return { intent: "Refresh", operation: "Process application state" }
}

function commandOperation(command: ActorCommand): string {
  switch (command._tag) {
    case "Refresh": return "Refresh conversations"
    case "PrepareNew": return "Create session"
    case "PrepareResume": return "Resume session"
    case "Branch": return "Create branch"
    case "Show": return "Open session"
    case "Hide": return "Return to navigator"
    case "Stop": return "Stop session"
    case "Remove": return "Remove conversation"
    case "AcknowledgeTransition": return "Acknowledge session identity"
    case "Navigation": return "Save navigation"
    case "CompletionTimer": return "Schedule completion refresh"
  }
}

function intentOperation(intent: ApplicationIntent["_tag"]): string {
  switch (intent) {
    case "Refresh": return "Refresh conversations"
    case "SelectRoot":
    case "EnterRoot":
    case "SelectGraph": return "Navigate conversations"
    case "NewSession": return "Create session"
    case "ResumeSession": return "Resume session"
    case "OpenEndpoint": return "Open session"
    case "BranchFrom": return "Create branch"
    case "ReturnFromTerminal": return "Return to navigator"
    case "StopSession": return "Stop session"
    case "Remove": return "Remove conversation"
    case "OpenModal":
    case "CloseModal": return "Update dialog"
  }
}

function navigationIntent(surface: ApplicationState["surface"]): ApplicationIntent["_tag"] {
  if (surface._tag === "Roots") return "SelectRoot"
  if (surface._tag === "Graph") return "SelectGraph"
  return "OpenEndpoint"
}

function terminalSequence(event: TerminalActorEvent): number {
  return event.event.sequenceId
}

function terminalMayBeOpening(state: ApplicationState, event: TerminalActorEvent): boolean {
  const sessionId = event._tag === "TerminalSessionChanged"
    ? event.event.previousSessionId
    : event.event.sessionId
  return state.terminals.get(sessionId)?.phase === "showing"
}

function validateStartupAdoption(
  state: ApplicationState,
  projectState: ProjectState,
  adoption: PendingIdentityAdoption,
): void {
  if (!state.provider.sessions.has(adoption.sessionId)) {
    throw new Error(
      `Pending identity adoption ${adoption.adoptionToken} is absent from the provider snapshot`,
    )
  }
  if (adoption.relation !== undefined && !state.relations.some((relation) =>
    isDeepStrictEqual(relation, adoption.relation))) {
    throw new Error(
      `Pending identity adoption ${adoption.adoptionToken} is absent from projected branch metadata`,
    )
  }
  if (projectState.navigation && navigationContainsSession(
    projectState.navigation,
    adoption.previousSessionId,
  )) {
    throw new Error(
      `Pending identity adoption ${adoption.adoptionToken} has stale navigation identity`,
    )
  }
}

function navigationContainsSession(navigation: NavigationState, sessionId: string): boolean {
  if (navigation.view === "roots") return navigation.selectedSessionId === sessionId
  if (navigation.view === "terminal") return navigation.sessionId === sessionId
  if (navigation.familySessionId === sessionId) return true
  if (navigation.target.kind === "endpoint") return navigation.target.sessionId === sessionId
  return navigation.target.preferred.sessionId === sessionId ||
    navigation.target.aliases.some((alias) => alias.sessionId === sessionId)
}

function restoreNavigatorSurface(
  state: ApplicationState,
  navigation: NavigationState | undefined,
): NavigatorSurface {
  if (!navigation) return { _tag: "Roots", selectedSessionId: null }
  const forest = selectConversationForest(state)
  if (navigation.view === "roots") {
    const graph = navigation.selectedSessionId
      ? forest.graphBySessionId.get(navigation.selectedSessionId) ??
        forest.graphByRootSessionId.get(navigation.selectedSessionId)
      : undefined
    return { _tag: "Roots", selectedSessionId: graph?.rootSessionId ?? null }
  }
  const sessionId = navigation.view === "terminal" ? navigation.sessionId : navigation.familySessionId
  const graph = forest.graphBySessionId.get(sessionId) ?? forest.graphByRootSessionId.get(sessionId)
  if (!graph) return { _tag: "Roots", selectedSessionId: null }
  const requested: NavigationTarget = navigation.view === "terminal"
    ? { kind: "endpoint", sessionId: navigation.sessionId }
    : navigation.target
  const candidate: ApplicationState = {
    ...state,
    surface: { _tag: "Graph", familySessionId: graph.rootSessionId, target: requested },
  }
  const selected = projectGraphViewModel(candidate, graph.rootSessionId, requested).nodes.find((node) => node.selected)
  return {
    _tag: "Graph",
    familySessionId: graph.rootSessionId,
    target: selected?.target ?? (requested.kind === "endpoint"
      ? { kind: "endpoint", sessionId: graph.rootSession.id }
      : requested),
  }
}

function errorMessage(error: unknown): string {
  try {
    return typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error)
  } catch {
    return "Unknown application error"
  }
}
