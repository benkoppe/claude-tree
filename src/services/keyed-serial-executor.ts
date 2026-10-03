// Adapted from T3 Code's orchestration-v2/KeyedSerialExecutor.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see src/vendor/t3/LICENSE.
import { Effect, Ref, Semaphore } from "effect"

interface LockEntry {
  readonly semaphore: Semaphore.Semaphore
  readonly users: number
}

export interface KeyedSerialExecutor<Key> {
  readonly withLock: <A, E, R>(key: Key, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export const makeKeyedSerialExecutor = <Key>(): Effect.Effect<KeyedSerialExecutor<Key>> =>
  Effect.gen(function*() {
    const locks = yield* Ref.make(new Map<Key, LockEntry>())
    const acquire = (key: Key) => Effect.gen(function*() {
      const candidate = yield* Semaphore.make(1)
      return yield* Ref.modify(locks, (current) => {
        const existing = current.get(key)
        const semaphore = existing?.semaphore ?? candidate
        return [semaphore, new Map(current).set(key, {
          semaphore, users: (existing?.users ?? 0) + 1,
        })] as const
      })
    })
    const release = (key: Key) => Ref.update(locks, (current) => {
      const existing = current.get(key)
      if (!existing) return current
      const next = new Map(current)
      if (existing.users === 1) next.delete(key)
      else next.set(key, { ...existing, users: existing.users - 1 })
      return next
    })
    return {
      withLock: (key, effect) => Effect.acquireUseRelease(
        acquire(key), (semaphore) => semaphore.withPermit(effect), () => release(key),
      ),
    }
  })
