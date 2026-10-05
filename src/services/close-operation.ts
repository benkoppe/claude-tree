import { Deferred, Effect, Exit, Scope } from "effect"

/** Cancelling an observer must not cancel the resource's close attempt. */
export function makeCloseOperation<A, E, R>(
  close: Effect.Effect<A, E, R>,
  retryOnFailure = false,
): Effect.Effect<A, E, R> {
  let completion: Deferred.Deferred<A, E> | undefined
  let completed: Exit.Exit<A, E> | undefined
  return Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
    let reply = completion
    if (!completion || (retryOnFailure && completed && Exit.isFailure(completed))) {
      const next = Deferred.makeUnsafe<A, E>()
      reply = next
      completion = next
      completed = undefined
      yield* Effect.forkDetach(close.pipe(
        Effect.onExit((exit) => {
          completed = exit
          return Deferred.done(next, exit)
        }),
        Effect.exit,
        Effect.asVoid,
      ), { startImmediately: true, uninterruptible: true })
    }
    return yield* restore(Deferred.await(reply!))
  }))
}

/** Scope.close is one-shot; retain the original finalizers' completion and cause. */
export function makeScopeClose(scope: Scope.Scope, exit: Exit.Exit<unknown, unknown> = Exit.void): Effect.Effect<void> {
  return makeCloseOperation(Scope.close(scope, exit))
}
