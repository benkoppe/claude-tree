import { isDeepStrictEqual } from "node:util"

import { Cause, Deferred, Effect, Exit, Scope } from "effect"

import type { PersistenceError } from "../domain/errors"
import type { NavigationState } from "../domain/model"
import type { ProjectState } from "../domain/persistence"

export interface NavigationMetadataFacet {
  readonly loadMetadata: Effect.Effect<ProjectState, PersistenceError>
  readonly updateMetadata: (
    transform: (state: ProjectState) => ProjectState,
  ) => Effect.Effect<ProjectState, PersistenceError>
}

export interface NavigationWriter {
  readonly write: (navigation: NavigationState) => Effect.Effect<void, PersistenceError>
  readonly flush: Effect.Effect<void, PersistenceError>
  readonly close: Effect.Effect<void>
}

interface PendingNavigation {
  readonly navigation: NavigationState
  readonly json: string
  readonly waiters: Deferred.Deferred<void, PersistenceError>[]
}

const DRAIN_SCOPE_CLOSE_TIMEOUT_MS = 100

export function makeNavigationWriter(
  repository: NavigationMetadataFacet,
): Effect.Effect<NavigationWriter, never, Scope.Scope> {
  return Effect.gen(function*() {
    const drainScope = yield* Scope.make("sequential")
    const close = Effect.suspend(() => Scope.closeUnsafe(drainScope, Exit.void) ?? Effect.void)
    yield* Effect.addFinalizer(() => Effect.interruptible(close).pipe(Effect.timeoutOrElse({
      duration: DRAIN_SCOPE_CLOSE_TIMEOUT_MS,
      orElse: () => Effect.void,
    })))
    let draining = false
    let current: PendingNavigation | undefined
    let queued: PendingNavigation | undefined
    let lastFailure: PersistenceError | undefined
    const idleWaiters = new Set<Deferred.Deferred<void, PersistenceError>>()

    const persist = (navigation: NavigationState): Effect.Effect<void, PersistenceError> =>
      Effect.matchCauseEffect(
        Effect.suspend(() => repository.updateMetadata((state) => ({ ...state, navigation }))),
        {
          onFailure: (cause) => Effect.flatMap(Effect.suspend(() => repository.loadMetadata), (state) =>
            isDeepStrictEqual(state.navigation, navigation)
              ? Effect.void
              : Effect.fail(Cause.squash(cause) as PersistenceError)),
          onSuccess: () => Effect.void,
        },
      )

    const completeIdle = (failure?: PersistenceError): Effect.Effect<void> => Effect.gen(function*() {
      const waiters = [...idleWaiters]
      idleWaiters.clear()
      for (const waiter of waiters) {
        if (failure) yield* Deferred.fail(waiter, failure)
        else yield* Deferred.succeed(waiter, undefined)
      }
    })

    const failOutstanding = (failure: PersistenceError): Effect.Effect<void> => Effect.gen(function*() {
      const pending = [current, queued].filter(
        (value): value is PendingNavigation => value !== undefined,
      )
      current = undefined
      queued = undefined
      draining = false
      lastFailure = failure
      for (const item of pending) {
        for (const waiter of item.waiters) yield* Deferred.fail(waiter, failure)
      }
      yield* completeIdle(failure)
    })

    const drain: Effect.Effect<void> = Effect.gen(function*() {
      while (true) {
        const pending = queued
        queued = undefined
        if (!pending) {
          draining = false
          yield* completeIdle(lastFailure)
          return
        }
        current = pending
        const exit = yield* Effect.exit(persist(pending.navigation))
        current = undefined
        if (Exit.isSuccess(exit)) lastFailure = undefined
        else lastFailure = Cause.squash(exit.cause) as PersistenceError
        for (const waiter of pending.waiters) yield* Deferred.done(waiter, exit)
      }
    }).pipe(
      Effect.onExit((exit) => Exit.isFailure(exit) && draining
        ? failOutstanding(Cause.squash(exit.cause) as PersistenceError)
        : Effect.void),
    )

    const write = (navigation: NavigationState): Effect.Effect<void, PersistenceError> =>
      Effect.gen(function*() {
        const waiter = yield* Deferred.make<void, PersistenceError>()
        const json = JSON.stringify(navigation)
        if (queued?.json === json) queued.waiters.push(waiter)
        else {
          queued = {
            navigation,
            json,
            waiters: [...(queued?.waiters ?? []), waiter],
          }
        }
        if (!draining) {
          draining = true
          yield* Effect.forkIn(drain, drainScope)
        }
        return yield* Deferred.await(waiter)
      })

    const flush = Effect.gen(function*() {
      if (!draining && queued === undefined) {
        return lastFailure ? yield* Effect.fail(lastFailure) : undefined
      }
      const waiter = yield* Deferred.make<void, PersistenceError>()
      idleWaiters.add(waiter)
      yield* Deferred.await(waiter)
    })

    return { write, flush, close }
  })
}
