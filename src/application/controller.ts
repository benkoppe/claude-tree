import { Cause, Clock, Deferred, Effect, Exit, PubSub, Queue, Scope } from "effect"

import type {
  AgentSession,
  BranchDerivation,
  MessageRef,
  NavigationState,
  NavigationTarget,
  TranscriptRead,
} from "../domain/model"
import type { BranchRelation, ConversationRemoval, ProjectState } from "../domain/persistence"
import type { MetadataRepositoryApi } from "../services/metadata-repository"
import type { AgentProviderApi, BranchOutcome, PreparedTerminal } from "../services/provider"
import type {
  TerminalActivityEvent,
  TerminalExitEvent,
  TerminalSessionChangedEvent,
  TerminalSessionTransitionErrorEvent,
  TerminalSupervisorApi,
  TerminalSupervisorEvents,
} from "../services/terminal-supervisor"
import { makeAppCommandExecutor } from "./command-executor"
import {
  makeApplicationCoordinator,
  type ApplicationCoordinator,
} from "./coordinator"
import type { AppEvent, RefreshReason } from "./events"
import { makeNavigationPersistence } from "./navigation-persistence"
import { selectConversationForest, selectFamilyRootSessionId, selectProjectedData } from "./selectors"
import {
  available,
  makeInitialApplicationState,
  type ApplicationModal,
  type ApplicationState,
  type NavigatorSurface,
} from "./state"
import {
  projectApplicationViewModel,
  projectGraphViewModel,
  type ApplicationViewModel,
} from "./view-model"

export interface AppRuntimeOptions {
  readonly provider: AgentProviderApi
  readonly metadata: MetadataRepositoryApi
  readonly terminals: TerminalSupervisorApi
  readonly projectState?: ProjectState
  readonly completionDelaysMs?: readonly number[]
}

export interface AppRuntime extends ApplicationCoordinator {
  readonly getViewModel: Effect.Effect<ApplicationViewModel>
  readonly subscribeViewModels: Effect.Effect<
    PubSub.Subscription<ApplicationViewModel>,
    never,
    Scope.Scope
  >
  readonly preparedTerminals: ReadonlyMap<string, PreparedTerminal>
  readonly terminalEvents: TerminalSupervisorEvents
  readonly refresh: (reason?: RefreshReason) => Effect.Effect<boolean>
  readonly selectRoot: (sessionId: string | null) => Effect.Effect<boolean>
  readonly enterRoot: (sessionId: string) => Effect.Effect<boolean>
  readonly selectGraph: (
    familySessionId: string,
    target: NavigationTarget,
  ) => Effect.Effect<boolean>
  readonly newSession: Effect.Effect<boolean>
  readonly resumeSession: (sessionId: string) => Effect.Effect<boolean>
  readonly openEndpoint: (sessionId: string) => Effect.Effect<boolean>
  readonly branchFrom: (target: MessageRef) => Effect.Effect<boolean>
  readonly returnFromTerminal: Effect.Effect<boolean>
  readonly stopSession: (sessionId: string) => Effect.Effect<boolean>
  readonly remove: (
    removal: ConversationRemoval,
    affectedSessionIds: readonly string[],
    requestId?: string,
  ) => Effect.Effect<boolean>
  readonly openModal: (modal: ApplicationModal) => Effect.Effect<boolean>
  readonly closeModal: Effect.Effect<boolean>
  readonly handleTerminalActivity: (event: TerminalActivityEvent) => Effect.Effect<boolean>
  readonly handleTerminalExit: (event: TerminalExitEvent) => Effect.Effect<boolean>
  readonly handleTerminalSessionChanged: (
    event: TerminalSessionChangedEvent,
  ) => Effect.Effect<boolean>
  readonly handleTerminalTransitionError: (
    event: TerminalSessionTransitionErrorEvent,
  ) => Effect.Effect<boolean>
}

export function makeAppRuntime(
  options: AppRuntimeOptions,
): Effect.Effect<AppRuntime, unknown, Scope.Scope> {
  return Effect.gen(function*() {
    const projectState = options.projectState ?? (yield* options.metadata.load)
    const snapshotExit = yield* Effect.exit(options.provider.loadSessionSnapshot)
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
          refresh: { generation: 0, active: null, initialPending: false },
        }
      : {
          ...initial,
          refresh: { generation: 0, active: null, initialPending: false },
          modal: { _tag: "Error", message: errorMessage(Cause.squash(snapshotExit.cause)) },
        }
    const initialState = {
      ...loaded,
      surface: restoreNavigatorSurface(loaded, projectState.navigation),
    }
    const preparedTerminals = new Map<string, PreparedTerminal>()
    const transitions = yield* PubSub.unbounded<AppEvent>()
    const viewModels = yield* PubSub.unbounded<ApplicationViewModel>()
    const terminalCallbacks = yield* Queue.unbounded<Effect.Effect<unknown>>()
    const navigation = yield* makeNavigationPersistence(options.metadata)
    let coordinatorRef: ApplicationCoordinator | undefined
    const execute = makeAppCommandExecutor({
      provider: options.provider,
      metadata: options.metadata,
      terminals: options.terminals,
      preparedTerminals,
      navigation,
      knownSessionIds: Effect.suspend(() => coordinatorRef
        ? Effect.map(coordinatorRef.getState, (state) => new Set([
            ...state.provider.sessions.keys(),
            ...state.local.sessions.keys(),
          ]))
        : Effect.succeed(new Set())),
      ...(options.completionDelaysMs === undefined
        ? {}
        : { completionDelaysMs: options.completionDelaysMs }),
    })
    const coordinator = yield* makeApplicationCoordinator({
      initialState,
      execute,
      onTransition: (event, result) => {
        PubSub.publishUnsafe(transitions, event)
        PubSub.publishUnsafe(viewModels, projectApplicationViewModel(result.state))
      },
    })
    coordinatorRef = coordinator
    let nextRemovalRequestId = 1

    const dispatchAndWait = <A extends AppEvent>(
      event: AppEvent,
      select: (event: AppEvent) => A | undefined,
    ): Effect.Effect<A> => Effect.scoped(Effect.gen(function*() {
      const subscription = yield* PubSub.subscribe(transitions)
      yield* coordinator.dispatch(event)
      while (true) {
        const observed = yield* PubSub.take(subscription)
        const selected = select(observed)
        if (selected) return selected
      }
    }))

    const reportError = (operation: string, error: unknown): Effect.Effect<boolean> =>
      coordinator.dispatch({
        _tag: "ModalOpened",
        modal: { _tag: "Error", message: `${operation}: ${errorMessage(error)}` },
      }).pipe(Effect.as(false))

    const enqueueTerminalCallback = <A, E>(callback: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.gen(function*() {
        const result = yield* Deferred.make<A, E>()
        Queue.offerUnsafe(
          terminalCallbacks,
          Effect.exit(callback).pipe(Effect.flatMap((exit) => Deferred.done(result, exit))),
        )
        return yield* Deferred.await(result)
      })

    const showPrepared = (
      prepared: PreparedTerminal,
      rollbackRelation?: BranchRelation,
      rollbackOnFailure = true,
      reportFailure = true,
    ): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        const current = yield* coordinator.getState
        const rollbackTransient = Effect.gen(function*() {
          if (preparedTerminals.get(prepared.session.id) === prepared) {
            preparedTerminals.delete(prepared.session.id)
          }
          if (!prepared.session.transient) return
          yield* coordinator.dispatch({
            _tag: "TransientTerminalShowRolledBack",
            sessionId: prepared.session.id,
            restoreTo: current.surface._tag === "Terminal" ? current.surface.returnTo : current.surface,
          })
          if (!rollbackRelation) return
          const rollbackExit = yield* Effect.exit(options.metadata.removeRelation(rollbackRelation))
          if (Exit.isFailure(rollbackExit)) {
            yield* reportError("Roll back branch", Cause.squash(rollbackExit.cause))
          }
        })
        if (current.pendingTerminalShow) {
          yield* reportError("Open session", "Another terminal is still opening")
          if (rollbackOnFailure) yield* rollbackTransient
          return false
        }
        preparedTerminals.set(prepared.session.id, prepared)
        const familySessionId = selectFamilyRootSessionId(current, prepared.session.id)
        yield* coordinator.dispatch({
          _tag: "GraphSelected",
          familySessionId,
          target: { kind: "endpoint", sessionId: prepared.session.id },
        })
        const result = yield* dispatchAndWait(
          {
            _tag: "TerminalShowRequested",
            sessionId: prepared.session.id,
            reportFailure,
          },
          (event) => {
            if (
              (event._tag === "TerminalShowSucceeded" || event._tag === "TerminalShowFailed") &&
              event.sessionId === prepared.session.id
            ) return event
            return undefined
          },
        )
        if (result._tag === "TerminalShowSucceeded") return true
        if (rollbackOnFailure) yield* rollbackTransient
        return false
      })

    const refresh = (reason: RefreshReason = "manual"): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        const before = yield* coordinator.getState
        const generation = before.refresh.generation + 1
        const result = yield* dispatchAndWait(
          { _tag: "RefreshRequested", reason },
          (event) => {
            if (
              (event._tag === "RefreshSucceeded" || event._tag === "RefreshFailed") &&
              event.generation >= generation
            ) return event
            return undefined
          },
        )
        return result._tag === "RefreshSucceeded" && result.generation === generation
      })

    const resumeSessionWith = (
      sessionId: string,
      reportFailure: boolean,
    ): Effect.Effect<boolean> =>
      Effect.matchCauseEffect(
        Effect.gen(function*() {
          const state = yield* coordinator.getState
          const session = selectProjectedData(state).sessions.get(sessionId)
          if (!session || session.transient) {
            return yield* Effect.fail(new Error(`Session ${sessionId} is not resumable`))
          }
          return yield* showPrepared(
            yield* options.provider.prepareResume(session),
            undefined,
            true,
            reportFailure,
          )
        }),
        {
          onFailure: (cause) => reportFailure
            ? reportError("Resume session", Cause.squash(cause))
            : Effect.succeed(false),
          onSuccess: Effect.succeed,
        },
      )

    const resumeSession = (sessionId: string): Effect.Effect<boolean> =>
      resumeSessionWith(sessionId, true)

    const openEndpoint = (sessionId: string): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        const runningSessionIds = yield* options.terminals.runningSessionIds
        if (!runningSessionIds.has(sessionId)) return yield* resumeSession(sessionId)
        const prepared = preparedTerminals.get(sessionId)
        if (!prepared) {
          return yield* reportError(
            "Open session",
            `No prepared terminal is available for running session ${sessionId}`,
          )
        }
        return yield* showPrepared(prepared, undefined, false)
      })

    const newSession = Effect.matchCauseEffect(
      Effect.gen(function*() {
        const prepared = yield* options.provider.prepareNewSession
        yield* coordinator.dispatch({
          _tag: "LocalSessionProjected",
          session: prepared.session,
          transcript: available([]),
          temporary: true,
        })
        return yield* showPrepared(prepared)
      }),
      {
        onFailure: (cause) => reportError("Create session", Cause.squash(cause)),
        onSuccess: Effect.succeed,
      },
    )

    const branchFrom = (target: MessageRef): Effect.Effect<boolean> =>
      Effect.matchCauseEffect(
        Effect.gen(function*() {
          const outcome = yield* options.provider.branchFrom(target)
          return yield* handleBranchOutcome(outcome, options, coordinator, showPrepared)
        }),
        {
          onFailure: (cause) => reportError("Create branch", Cause.squash(cause)),
          onSuccess: Effect.succeed,
        },
      )

    const returnFromTerminal = Effect.gen(function*() {
      const sessionId = yield* options.terminals.hideActive
      if (!sessionId) return false
      const drafts = yield* options.terminals.draftPreviews
      return yield* enqueueTerminalCallback(coordinator.dispatch({
        _tag: "TerminalReturned",
        sessionId,
        ...(drafts.get(sessionId) === undefined ? {} : { draft: drafts.get(sessionId)! }),
      }))
    })

    const stopSession = (sessionId: string): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        const state = yield* coordinator.getState
        if (!state.terminals.has(sessionId)) {
          return yield* reportError("Stop session", `Session ${sessionId} is not running`)
        }
        const result = yield* dispatchAndWait(
          { _tag: "TerminalStopRequested", sessionId },
          (event) => {
            if (
              (event._tag === "TerminalStopped" || event._tag === "TerminalStopFailed") &&
              event.sessionId === sessionId
            ) return event
            return undefined
          },
        )
        if (result._tag === "TerminalStopped") preparedTerminals.delete(sessionId)
        return result._tag === "TerminalStopped"
      })

    const remove = (
      removal: ConversationRemoval,
      affectedSessionIds: readonly string[],
      requestId = `removal-${nextRemovalRequestId++}`,
    ): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        const result = yield* dispatchAndWait(
          { _tag: "RemovalRequested", requestId, removal, affectedSessionIds },
          (event) => {
            if (
              (event._tag === "RemovalPersisted" || event._tag === "RemovalFailed") &&
              event.requestId === requestId
            ) return event
            if (
              event._tag === "TerminalStopFailed" && affectedSessionIds.includes(event.sessionId)
            ) return event
            return undefined
          },
        )
        return result._tag === "RemovalPersisted"
      })

    const handleTerminalActivity = (event: TerminalActivityEvent) =>
      coordinator.dispatch({
        _tag: "TerminalActivityChanged",
        sessionId: event.sessionId,
        activity: event.activity,
        wasVisible: event.wasActive,
      })

    const handleTerminalExit = (event: TerminalExitEvent): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        preparedTerminals.delete(event.sessionId)
        if (event.draftPreview) {
          yield* coordinator.dispatch({
            _tag: "TerminalDraftObserved",
            sessionId: event.sessionId,
            draft: event.draftPreview,
          })
        }
        const acknowledged = yield* coordinator.dispatch({
          _tag: "TerminalExited",
          sessionId: event.sessionId,
          exitCode: event.exitCode,
          ...(event.cleanupError === undefined ? {} : { cleanupIncomplete: true }),
        })
        if (event.exitCode !== 0 || event.cleanupError) {
          const details = [
            event.exitCode === 0 ? undefined : `Agent session exited with code ${event.exitCode}`,
            event.cleanupError ? errorMessage(event.cleanupError) : undefined,
          ].filter((message): message is string => message !== undefined).join("; ")
          yield* coordinator.dispatch({
            _tag: "ModalOpened",
            modal: { _tag: "Error", message: details },
          })
        }
        return acknowledged
      })

    const handleTerminalSessionChanged = (
      event: TerminalSessionChangedEvent,
    ): Effect.Effect<boolean> => Effect.gen(function*() {
      const state = yield* coordinator.getState
      const derivationExit = event.derivation
        ? yield* Effect.exit(event.derivation)
        : Exit.succeed<BranchDerivation | undefined>(undefined)
      let derivation: BranchDerivation | undefined
      let ancestryFailure: { readonly operation: string; readonly error: unknown } | undefined
      if (Exit.isFailure(derivationExit)) {
        ancestryFailure = {
          operation: "Derive switched session",
          error: Cause.squash(derivationExit.cause),
        }
      } else if (
        derivationExit.value && derivationExit.value.childSessionId !== event.session.id
      ) {
        ancestryFailure = {
          operation: "Derive switched session",
          error: "Provider returned ancestry for a different child session",
        }
      } else {
        derivation = derivationExit.value
      }

      if (state.local.temporarySessionIds.has(event.previousSessionId)) {
        const result = yield* dispatchAndWait(
          {
            _tag: "SessionIdentityAdoptionRequested",
            temporarySessionId: event.previousSessionId,
            session: event.session,
            ...(derivation === undefined ? {} : { derivation }),
          },
          (observed) => {
            if (
              (observed._tag === "SessionIdentityAdopted" ||
                observed._tag === "SessionIdentityAdoptionFailed") &&
              observed.temporarySessionId === event.previousSessionId
            ) return observed
            return undefined
          },
        )
        if (ancestryFailure) yield* reportError(ancestryFailure.operation, ancestryFailure.error)
        yield* coordinator.dispatch({
          _tag: "RefreshRequested",
          reason: "terminal-return",
          ...(event.wasActive && result._tag === "SessionIdentityAdopted"
            ? { focusSessionId: event.session.id }
            : {}),
          sessionIds: new Set([
            event.previousSessionId,
            result._tag === "SessionIdentityAdopted" ? event.session.id : event.previousSessionId,
          ]),
        })
        return result._tag === "SessionIdentityAdopted"
      }

      let relation: BranchRelation | undefined
      if (derivation) {
        const now = yield* Clock.currentTimeMillis
        const relationExit = yield* Effect.exit(options.metadata.saveRelation({
          ...derivation,
          createdAt: new Date(now).toISOString(),
        }))
        if (Exit.isSuccess(relationExit)) relation = relationExit.value
        else {
          ancestryFailure = {
            operation: "Save switched-session ancestry",
            error: Cause.squash(relationExit.cause),
          }
        }
      }

      const prepared = preparedTerminals.get(event.previousSessionId)
      preparedTerminals.delete(event.previousSessionId)
      if (prepared) preparedTerminals.set(event.session.id, { ...prepared, session: event.session })
      const acknowledged = yield* coordinator.dispatch({
        _tag: "TerminalSessionTransitioned",
        previousSessionId: event.previousSessionId,
        session: event.session,
        wasVisible: event.wasActive,
        ...(relation === undefined ? {} : { relation }),
      })
      if (ancestryFailure) yield* reportError(ancestryFailure.operation, ancestryFailure.error)
      yield* coordinator.dispatch({
        _tag: "RefreshRequested",
        reason: "terminal-return",
        ...(event.wasActive ? { focusSessionId: event.session.id } : {}),
        sessionIds: new Set([event.previousSessionId, event.session.id]),
      })
      return acknowledged
    })

    const handleTerminalTransitionError = (
      event: TerminalSessionTransitionErrorEvent,
    ): Effect.Effect<boolean> => Effect.gen(function*() {
      const acknowledged = yield* reportError("Agent session transition", event.error)
      yield* coordinator.dispatch({
        _tag: "RefreshRequested",
        reason: "terminal-return",
        sessionIds: new Set([event.sessionId]),
      })
      return acknowledged
    })

    yield* Effect.forkScoped(Effect.forever(
      Queue.take(terminalCallbacks).pipe(Effect.flatMap((callback) => callback), Effect.asVoid),
    ))

    const runtime: AppRuntime = {
      ...coordinator,
      getViewModel: Effect.map(coordinator.getState, projectApplicationViewModel),
      subscribeViewModels: PubSub.subscribe(viewModels),
      preparedTerminals,
      terminalEvents: {
        onActivityChanged: (event) => {
          Queue.offerUnsafe(terminalCallbacks, handleTerminalActivity(event))
        },
        onProcessExited: (event) => {
          Queue.offerUnsafe(terminalCallbacks, handleTerminalExit(event))
        },
        onSessionChanged: (event) => {
          Queue.offerUnsafe(terminalCallbacks, handleTerminalSessionChanged(event))
        },
        onSessionTransitionError: (event) => {
          Queue.offerUnsafe(terminalCallbacks, handleTerminalTransitionError(event))
        },
      },
      refresh,
      selectRoot: (sessionId) => coordinator.dispatch({ _tag: "RootsSelected", sessionId }),
      enterRoot: (sessionId) => Effect.gen(function*() {
        const state = yield* coordinator.getState
        const graph = projectGraphViewModel(state, sessionId)
        const selected = graph.nodes.find((node) => node.selected)
        if (!selected) return false
        return yield* coordinator.dispatch({
          _tag: "GraphSelected",
          familySessionId: graph.familySessionId,
          target: selected.target,
        })
      }),
      selectGraph: (familySessionId, target) => coordinator.dispatch({
        _tag: "GraphSelected",
        familySessionId,
        target,
      }),
      newSession,
      resumeSession,
      openEndpoint,
      branchFrom,
      returnFromTerminal,
      stopSession,
      remove,
      openModal: (modal) => coordinator.dispatch({ _tag: "ModalOpened", modal }),
      closeModal: coordinator.dispatch({ _tag: "ModalClosed" }),
      handleTerminalActivity,
      handleTerminalExit,
      handleTerminalSessionChanged,
      handleTerminalTransitionError,
    }

    if (projectState.navigation?.view === "terminal" && Exit.isSuccess(snapshotExit)) {
      yield* resumeSessionWith(projectState.navigation.sessionId, false)
    }
    return runtime
  })
}

export const makeApplicationController = makeAppRuntime

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

  const sessionId = navigation.view === "terminal"
    ? navigation.sessionId
    : navigation.familySessionId
  const graph = forest.graphBySessionId.get(sessionId) ?? forest.graphByRootSessionId.get(sessionId)
  if (!graph) return { _tag: "Roots", selectedSessionId: null }
  const requested: NavigationTarget = navigation.view === "terminal"
    ? { kind: "endpoint", sessionId: navigation.sessionId }
    : navigation.target
  const candidate: ApplicationState = {
    ...state,
    surface: { _tag: "Graph", familySessionId: graph.rootSessionId, target: requested },
  }
  const selected = projectGraphViewModel(candidate, graph.rootSessionId, requested)
    .nodes.find((node) => node.selected)
  return {
    _tag: "Graph",
    familySessionId: graph.rootSessionId,
    target: selected?.target ?? fallbackGraphTarget(graph.rootSession, requested),
  }
}

function fallbackGraphTarget(session: AgentSession, requested: NavigationTarget): NavigationTarget {
  return requested.kind === "endpoint"
    ? { kind: "endpoint", sessionId: session.id }
    : requested
}

function handleBranchOutcome(
  outcome: BranchOutcome,
  options: AppRuntimeOptions,
  coordinator: ApplicationCoordinator,
  showPrepared: (
    prepared: PreparedTerminal,
    rollbackRelation?: BranchRelation,
  ) => Effect.Effect<boolean>,
): Effect.Effect<boolean, unknown> {
  if (outcome._tag === "CreatedIndependentSession") {
    return Effect.gen(function*() {
      yield* coordinator.dispatch({
        _tag: "LocalSessionProjected",
        session: outcome.session,
        transcript: outcome.transcript,
        temporary: outcome.session.transient ?? false,
      })
      yield* coordinator.dispatch({
        _tag: "ModalOpened",
        modal: { _tag: "Error", message: outcome.reason },
      })
      if (!outcome.acquireLaunch) return false
      return yield* showPrepared({
        session: outcome.session,
        acquireLaunch: outcome.acquireLaunch,
      })
    })
  }

  return Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    const relationExit = yield* Effect.exit(options.metadata.saveRelation({
      ...outcome.derivation,
      createdAt: new Date(now).toISOString(),
    }))
    if (Exit.isFailure(relationExit)) {
      if (!outcome.session.transient) {
        const readExit = yield* Effect.exit(options.provider.readTranscripts([outcome.session.id]))
        const transcript: TranscriptRead = Exit.isSuccess(readExit)
          ? readExit.value.get(outcome.session.id) ?? { _tag: "Missing" }
          : { _tag: "Unavailable", reason: errorMessage(Cause.squash(readExit.cause)) }
        yield* coordinator.dispatch({
          _tag: "LocalSessionProjected",
          session: outcome.session,
          transcript,
        })
      }
      return yield* Effect.fail(Cause.squash(relationExit.cause))
    }

    yield* coordinator.dispatch({
      _tag: "PersistedBranchProjected",
      session: outcome.session,
      relation: relationExit.value,
      temporary: outcome.session.transient ?? false,
    })
    return yield* showPrepared(
      outcome,
      outcome.session.transient ? relationExit.value : undefined,
    )
  })
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message)
  }
  return String(error)
}
