import { Clock, Context, Effect } from "effect"

export interface CleanupBudget {
  readonly remaining: Effect.Effect<number>
  readonly observe: <A, E, R, E2>(effect: Effect.Effect<A, E, R>, expired: () => E2) => Effect.Effect<A, E | E2, R>
}

export const CleanupDeadline = Context.Reference<CleanupBudget | undefined>(
  "claude-tree/CleanupDeadline", { defaultValue: () => undefined },
)

/** A deadline bounds observation across stages, rather than restarting a timer per stage. */
export function makeCleanupBudget(durationMs?: number): Effect.Effect<CleanupBudget> {
  return Effect.gen(function*() {
    const deadline = durationMs === undefined ? undefined : (yield* Clock.monotonicTimeNanos) + BigInt(Math.ceil(durationMs * 1_000_000))
    const parent = yield* CleanupDeadline
    const remaining = Effect.gen(function*() {
      const local = deadline === undefined ? Infinity : Math.max(0, Number(deadline - (yield* Clock.monotonicTimeNanos)) / 1_000_000)
      return parent ? Math.min(local, yield* parent.remaining) : local
    })
    return {
      remaining,
      observe: (effect, expired) => remaining.pipe(Effect.flatMap((duration) => duration === Infinity ? effect : Effect.interruptible(effect).pipe(
        Effect.timeoutOrElse({ duration, orElse: () => Effect.fail(expired()) }),
      ))),
    }
  })
}
