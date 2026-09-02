import { Deferred, Effect, Exit } from "effect"

import type { PersistenceError } from "../domain/errors"
import type { NavigationState } from "../domain/model"
import type { MetadataRepositoryApi } from "../services/metadata-repository"

export interface NavigationPersistence {
  readonly save: (navigation: NavigationState) => Effect.Effect<void, PersistenceError>
  readonly flush: Effect.Effect<void>
}

interface PendingNavigation {
  readonly navigation: NavigationState
  readonly json: string
  readonly waiters: Deferred.Deferred<void, PersistenceError>[]
}

export function makeNavigationPersistence(
  repository: MetadataRepositoryApi,
): Effect.Effect<NavigationPersistence> {
  return Effect.sync(() => {
    let draining = false
    let queued: PendingNavigation | undefined
    const idleWaiters = new Set<Deferred.Deferred<void>>()

    const drain: Effect.Effect<void> = Effect.gen(function*() {
      while (true) {
        const pending = yield* Effect.sync(() => {
          const next = queued
          queued = undefined
          if (!next) draining = false
          return next
        })
        if (!pending) {
          const waiters = yield* Effect.sync(() => {
            const current = [...idleWaiters]
            idleWaiters.clear()
            return current
          })
          for (const waiter of waiters) yield* Deferred.succeed(waiter, undefined)
          return
        }

        const result = yield* Effect.exit(repository.saveNavigationState(pending.navigation))
        for (const waiter of pending.waiters) yield* Deferred.done(waiter, result)
      }
    })

    const save = (navigation: NavigationState): Effect.Effect<void, PersistenceError> =>
      Effect.gen(function*() {
        const waiter = yield* Deferred.make<void, PersistenceError>()
        const shouldDrain = yield* Effect.sync(() => {
          const json = JSON.stringify(navigation)
          if (queued?.json === json) queued.waiters.push(waiter)
          else {
            queued = {
              navigation,
              json,
              waiters: [...(queued?.waiters ?? []), waiter],
            }
          }
          if (draining) return false
          draining = true
          return true
        })
        if (shouldDrain) yield* drain
        return yield* Deferred.await(waiter)
      })

    const flush = Effect.gen(function*() {
      const waiter = yield* Deferred.make<void>()
      const idle = yield* Effect.sync(() => {
        if (!draining && queued === undefined) return true
        idleWaiters.add(waiter)
        return false
      })
      if (!idle) yield* Deferred.await(waiter)
    })

    return { save, flush }
  })
}
