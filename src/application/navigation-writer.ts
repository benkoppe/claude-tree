import { Cause, Deferred, Effect, Exit, Scope } from "effect"

import { PersistenceError } from "../domain/errors"
import type { NavigationState } from "../domain/model"
import { makeCloseOperation, makeScopeClose } from "../services/close-operation"

export interface NavigationMetadataFacet {
  readonly saveNavigation: (navigation: NavigationState) => Effect.Effect<void, PersistenceError>
}

export interface NavigationWriter {
  readonly schedule: (navigation: NavigationState) => Effect.Effect<void, PersistenceError>
  readonly write: (navigation: NavigationState) => Effect.Effect<void, PersistenceError>
  readonly flush: Effect.Effect<void, PersistenceError>
  readonly close: Effect.Effect<void, PersistenceError>
}

interface PendingNavigation {
  readonly save: Effect.Effect<void, PersistenceError>
  readonly json: string
  readonly waiters: Deferred.Deferred<void, PersistenceError>[]
}

export const NAVIGATION_SAVE_INTERVAL_MS = 200

export function makeNavigationWriter(
  repository: NavigationMetadataFacet,
  reportFailure: (error: PersistenceError) => Effect.Effect<unknown> = () => Effect.void,
  intervalMs = NAVIGATION_SAVE_INTERVAL_MS,
): Effect.Effect<NavigationWriter, never, Scope.Scope> {
  return Effect.gen(function*() {
    const drainScope = yield* Scope.make("sequential")
    let closed = false
    const closeScope = makeScopeClose(drainScope)
    const close = makeCloseOperation(Effect.suspend(() => {
      closed = true
      return flush.pipe(Effect.ensuring(closeScope))
    }))
    yield* Effect.addFinalizer(() => close.pipe(Effect.catch((error) => Effect.logError(error))))
    let draining = false
    let current: PendingNavigation | undefined
    let queued: PendingNavigation | undefined
    let lastFailure: Cause.Cause<PersistenceError> | undefined
    const idleWaiters = new Set<Deferred.Deferred<void, PersistenceError>>()
    let wake = Deferred.makeUnsafe<void>()
    let immediate = false

    const completeIdle = (failure?: Cause.Cause<PersistenceError>): Effect.Effect<void> => Effect.gen(function*() {
      const waiters = [...idleWaiters]
      idleWaiters.clear()
      for (const waiter of waiters) {
        if (failure) yield* Deferred.failCause(waiter, failure)
        else yield* Deferred.succeed(waiter, undefined)
      }
    })

    const failOutstanding = (failure: Cause.Cause<PersistenceError>): Effect.Effect<void> => Effect.gen(function*() {
      const pending = [current, queued].filter(
        (value): value is PendingNavigation => value !== undefined,
      )
      current = undefined
      queued = undefined
      draining = false
      lastFailure = failure
      for (const item of pending) {
        for (const waiter of item.waiters) yield* Deferred.failCause(waiter, failure)
      }
      yield* completeIdle(failure)
    })

    const drain: Effect.Effect<void> = Effect.gen(function*() {
      while (true) {
        if (queued && !immediate && intervalMs > 0) yield* Effect.raceFirst(Effect.sleep(intervalMs), Deferred.await(wake))
        wake = Deferred.makeUnsafe<void>()
        immediate = idleWaiters.size > 0
        const pending = queued
        queued = undefined
        if (!pending) {
          draining = false
          immediate = false
          yield* completeIdle(lastFailure)
          return
        }
        current = pending
        const exit = yield* Effect.exit(pending.save)
        current = undefined
        if (Exit.isSuccess(exit)) lastFailure = undefined
        else lastFailure = exit.cause
        for (const waiter of pending.waiters) yield* Deferred.done(waiter, exit)
        if (lastFailure && pending.waiters.length === 0) {
          const failure = Cause.squash(lastFailure)
          yield* reportFailure(failure instanceof PersistenceError ? failure : new PersistenceError({
            operation: "save navigation", path: "", message: "Navigation writer failed unexpectedly", cause: lastFailure,
          }))
        }
        if (queued === undefined) immediate = false
      }
    }).pipe(
      Effect.onExit((exit) => Exit.isFailure(exit) && draining
        ? failOutstanding(exit.cause)
        : Effect.void),
    )

    const enqueue = (navigation: NavigationState, waiter?: Deferred.Deferred<void, PersistenceError>): Effect.Effect<void, PersistenceError> =>
      Effect.gen(function*() {
        if (closed) {
          return yield* Effect.fail(new PersistenceError({
            operation: "save navigation",
            path: "",
            message: "Cannot save navigation after the navigation writer has closed",
          }))
        }
        const json = JSON.stringify(navigation)
        if (queued === undefined && current?.json === json) {
          if (waiter) current.waiters.push(waiter)
        } else if (queued?.json === json) {
          queued = { ...queued, save: repository.saveNavigation(navigation) }
          if (waiter) queued.waiters.push(waiter)
        }
        else {
          queued = {
            save: repository.saveNavigation(navigation),
            json,
            waiters: [...(queued?.waiters ?? []), ...(waiter ? [waiter] : [])],
          }
        }
        if (!draining) {
          draining = true
          yield* Effect.forkIn(drain, drainScope)
        }
        if (waiter) {
          immediate = true
          yield* Deferred.succeed(wake, undefined)
        }
      })

    const write = (navigation: NavigationState) => Effect.gen(function*() {
      const waiter = yield* Deferred.make<void, PersistenceError>()
      yield* enqueue(navigation, waiter)
      yield* Deferred.await(waiter)
    })

    const flush = Effect.gen(function*() {
      if (!draining && queued === undefined) {
        return lastFailure ? yield* Effect.failCause(lastFailure) : undefined
      }
      const waiter = yield* Deferred.make<void, PersistenceError>()
      idleWaiters.add(waiter)
      immediate = true
      yield* Deferred.succeed(wake, undefined)
      yield* Deferred.await(waiter)
    })

    return { write, schedule: (navigation) => enqueue(navigation), flush, close }
  })
}
