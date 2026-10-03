import { Effect } from "effect"

/** Omitted productive-work limits leave the operation interruptible, without a timer. */
export function optionalOperationTimeout(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new RangeError("Operation timeout must be a finite positive number")
  }
  return value
}

export function withOperationTimeout<A, E, R, E2>(
  effect: Effect.Effect<A, E, R>,
  duration: number | undefined,
  onTimeout: () => Effect.Effect<A, E2, R>,
): Effect.Effect<A, E | E2, R> {
  return duration === undefined ? effect : effect.pipe(Effect.timeoutOrElse({ duration, orElse: onTimeout }))
}
