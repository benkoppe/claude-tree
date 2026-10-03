import { Effect, Fiber, Scope, type Exit } from "effect"

export interface CommandCompleted<Command> {
  readonly _tag: "CommandCompleted"
  readonly key: string
  readonly token: number
  readonly command: Command
  readonly exit: Exit.Exit<unknown, unknown>
}

interface ActiveCommand<Command> {
  readonly token: number
  readonly command: Command
  fiber?: Fiber.Fiber<void, never>
}

/** Admission and this registry belong to the actor; only external work runs in fibers. */
export function makeCommandExecutor<Command>(
  scope: Scope.Scope,
  deliver: (completion: CommandCompleted<Command>) => Effect.Effect<unknown>,
) {
  const active = new Map<string, ActiveCommand<Command>>()
  const start = Effect.fn("CommandExecutor.start")(function*<A, E>(
    key: string, token: number, command: Command, effect: Effect.Effect<A, E>,
  ) {
    active.set(key, { token, command })
    const run = effect.pipe(
      Effect.onExit((exit) => deliver({ _tag: "CommandCompleted", key, token, command, exit })),
      Effect.exit,
      Effect.asVoid,
    )
    const fiber = yield* Effect.forkIn(run, scope)
    const entry = active.get(key)
    if (entry?.token === token) entry.fiber = fiber
    else fiber.interruptUnsafe()
  })
  return { active, start }
}
