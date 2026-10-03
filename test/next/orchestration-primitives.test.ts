import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Queue, Scope } from "effect"
import { makeKeyedSerialExecutor } from "../../src/services/keyed-serial-executor"
import { makeCommandExecutor, type CommandCompleted } from "../../src/application/command-executor"

test("keyed execution isolates identities and cancellation releases a waiting lock user", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const executor = yield* makeKeyedSerialExecutor<string>()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const first = yield* Effect.forkScoped(executor.withLock("one", Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    )))
    yield* Deferred.await(entered)
    let cancelledRan = false
    const waiting = yield* Effect.forkScoped(executor.withLock("one", Effect.sync(() => { cancelledRan = true })))
    expect(yield* executor.withLock("two", Effect.succeed("independent"))).toBe("independent")
    yield* Fiber.interrupt(waiting)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
    expect(cancelledRan).toBeFalse()
    expect(yield* executor.withLock("one", Effect.succeed("reopened"))).toBe("reopened")
  })))
})

test("scoped command interruption delivers completion without replacing a newer command", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const scope = yield* Scope.Scope
    const completed = yield* Queue.unbounded<CommandCompleted<string>>()
    const executor = makeCommandExecutor<string>(scope, (event) => Queue.offer(completed, event))
    const entered = yield* Deferred.make<void>()
    yield* executor.start("owner", 1, "old", Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
    yield* Deferred.await(entered)
    const old = executor.active.get("owner")!.fiber!
    yield* executor.start("owner", 2, "new", Effect.succeed("result"))
    yield* Fiber.interrupt(old)
    const events = yield* Effect.forEach([0, 1], () => Queue.take(completed))
    expect(events.map((event) => event.token).sort()).toEqual([1, 2])
    expect(Exit.isFailure(events.find((event) => event.token === 1)!.exit)).toBeTrue()
    expect(events.find((event) => event.token === 2)!.exit).toEqual(Exit.succeed("result"))
    expect(executor.active.get("owner")!.token).toBe(2)
  })))
})
