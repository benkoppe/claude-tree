import { Cause, Deferred, Effect, FiberHandle, Queue, Ref, Scope } from "effect"

import type { AppCommand, AppEvent, ReduceResult } from "./events"
import { reduceApplicationState } from "./reducer"
import type { ApplicationState } from "./state"

export type CommandCompletion = AppEvent | readonly AppEvent[] | void

export type AppCommandExecutor<E = never, R = never> = (
  command: AppCommand,
) => Effect.Effect<CommandCompletion, E, R>

export interface ApplicationCoordinator {
  readonly dispatch: (event: AppEvent) => Effect.Effect<boolean>
  readonly getState: Effect.Effect<ApplicationState>
  readonly shutdown: Effect.Effect<boolean>
}

export interface ApplicationCoordinatorOptions<E, R> {
  readonly initialState: ApplicationState
  readonly execute: AppCommandExecutor<E, R>
  readonly onTransition?: (event: AppEvent, result: ReduceResult) => void
}

interface EventEnvelope {
  readonly event: AppEvent
  readonly acknowledgment?: Deferred.Deferred<boolean>
}

export function makeApplicationCoordinator<E, R>(
  options: ApplicationCoordinatorOptions<E, R>,
): Effect.Effect<ApplicationCoordinator, never, R | Scope.Scope> {
  return Effect.gen(function*() {
    const events = yield* Queue.unbounded<EventEnvelope>()
    const state = yield* Ref.make(options.initialState)
    const shutdownResult = yield* Deferred.make<boolean>()
    const refreshFiber = yield* FiberHandle.make<void, never>()
    const loopFiber = yield* FiberHandle.make<void, never>()

    const enqueueCompletions = (completion: CommandCompletion): Effect.Effect<void> => {
      if (completion === undefined) return Effect.void
      const completions = Array.isArray(completion) ? completion : [completion]
      return Queue.offerAll(events, completions.map((event) => ({ event }))).pipe(Effect.asVoid)
    }

    const executeCommand = (command: AppCommand): Effect.Effect<void, never, R> =>
      Effect.matchCauseEffect(options.execute(command), {
        onFailure: (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Queue.offer(events, {
                event: commandFailureEvent(command, failureMessage(Cause.squash(cause))),
              }).pipe(Effect.asVoid),
        onSuccess: enqueueCompletions,
      })

    const startCommand = (command: AppCommand): Effect.Effect<void, never, R | Scope.Scope> =>
      Effect.gen(function*() {
        if (command._tag === "RefreshProvider") {
          yield* FiberHandle.run(refreshFiber, executeCommand(command))
          return
        }
        yield* Effect.forkScoped(
          command._tag === "Shutdown"
            ? Effect.uninterruptible(executeCommand(command))
            : executeCommand(command),
        )
      })

    const processEvent = (envelope: EventEnvelope): Effect.Effect<void, never, R | Scope.Scope> =>
      Effect.gen(function*() {
        const event = envelope.event
        const result = yield* Ref.modify(state, (current) => {
          const reduced = reduceApplicationState(current, event)
          return [reduced, reduced.state] as const
        })
        if (options.onTransition) {
          yield* Effect.exit(Effect.sync(() => options.onTransition!(event, result)))
        }
        for (const command of result.commands) yield* startCommand(command)
        if (event._tag === "ShutdownCompleted") yield* Deferred.succeed(shutdownResult, true)
        if (event._tag === "ShutdownFailed") yield* Deferred.succeed(shutdownResult, false)
        if (envelope.acknowledgment) yield* Deferred.succeed(envelope.acknowledgment, true)
      })

    const loop = Effect.forever(
      Effect.flatMap(Queue.take(events), processEvent),
    ).pipe(Effect.asVoid)
    yield* FiberHandle.run(loopFiber, loop)

    const dispatch = (event: AppEvent): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        const acknowledgment = yield* Deferred.make<boolean>()
        const offered = yield* Queue.offer(events, { event, acknowledgment })
        if (!offered) return false
        return yield* Deferred.await(acknowledgment)
      })

    return {
      dispatch,
      getState: Ref.get(state),
      shutdown: Effect.gen(function*() {
        const current = yield* Ref.get(state)
        if (current.shutdown === "stopped") return true
        if (current.shutdown === "cleanup-incomplete") return false
        yield* dispatch({ _tag: "ShutdownRequested" })
        return yield* Deferred.await(shutdownResult)
      }),
    }
  })
}

function failureMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message)
  }
  return String(error)
}

function commandFailureEvent(command: AppCommand, message: string): AppEvent {
  switch (command._tag) {
    case "RefreshProvider":
      return { _tag: "RefreshFailed", generation: command.generation, message }
    case "StopSession":
      return { _tag: "TerminalStopFailed", sessionId: command.sessionId, message }
    case "ShowTerminal":
      return { _tag: "TerminalShowFailed", sessionId: command.sessionId, message }
    case "PersistRemoval":
      return { _tag: "RemovalFailed", requestId: command.requestId, message }
    case "Shutdown":
      return { _tag: "ShutdownFailed", message }
    case "PersistRelation":
      return { _tag: "RelationPersistenceFailed", derivation: command.derivation, message }
    case "AdoptSessionIdentity":
      return {
        _tag: "SessionIdentityAdoptionFailed",
        temporarySessionId: command.temporarySessionId,
        message,
      }
    case "ScheduleCompletionRefresh":
      return {
        _tag: "CompletionRefreshFailed",
        sessionId: command.sessionId,
        version: command.version,
        message,
      }
    case "PersistNavigation":
      return { _tag: "CommandFailed", command, message }
  }
}
