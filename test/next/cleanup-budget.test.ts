import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { CleanupDeadline, makeCleanupBudget } from "../../src/services/cleanup-budget"
import { waitForProcessGroupExit } from "../../src/infrastructure/process-group"

test("nested cleanup cannot restart its parent's observation budget", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const parent = yield* makeCleanupBudget(100)
    yield* TestClock.adjust(60)
    const child = yield* makeCleanupBudget(100).pipe(Effect.provideService(CleanupDeadline, parent))
    expect(yield* child.remaining).toBe(40)
    const started = yield* Deferred.make<void>()
    const observer = yield* Effect.forkChild(Effect.exit(child.observe(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)), () => "unfinished",
    )))
    yield* Deferred.await(started)
    yield* TestClock.adjust(40)
    const exit = yield* Fiber.join(observer)
    expect(Exit.isFailure(exit)).toBeTrue()
    expect(yield* parent.remaining).toBe(0)
    expect(yield* child.remaining).toBe(0)
  }).pipe(Effect.provide(TestClock.layer())))
})

test("cleanup has no default deadline but unspecified child budgets inherit explicit deadlines", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const unbounded = yield* makeCleanupBudget()
    const release = yield* Deferred.make<void>()
    const observer = yield* Effect.forkChild(unbounded.observe(Deferred.await(release), () => "unfinished"))
    yield* TestClock.adjust(120_000)
    expect(yield* unbounded.remaining).toBe(Infinity)
    expect(observer.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(observer)

    const parent = yield* makeCleanupBudget(100)
    const child = yield* makeCleanupBudget().pipe(Effect.provideService(CleanupDeadline, parent))
    yield* TestClock.adjust(60)
    expect(yield* child.remaining).toBe(40)
    yield* TestClock.adjust(40)
    expect(yield* child.remaining).toBe(0)
    const exit = yield* Effect.exit(child.observe(Effect.never, () => "unfinished"))
    expect(Exit.isFailure(exit)).toBeTrue()
  }).pipe(Effect.provide(TestClock.layer())))
})

test("process polling requires observed absence, not elapsed time", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    let alive = true
    const polling = yield* Effect.forkChild(waitForProcessGroupExit(() => alive, 20))
    yield* Effect.yieldNow
    yield* TestClock.adjust(20)
    expect(yield* Fiber.join(polling)).toBeFalse()
    alive = false
    expect(yield* waitForProcessGroupExit(() => alive, 0)).toBeTrue()
  }).pipe(Effect.provide(TestClock.layer())))
})
