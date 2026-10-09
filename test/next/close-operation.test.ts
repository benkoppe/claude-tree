import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"

import { makeCloseOperation, makeScopeClose } from "../../src/services/close-operation"

test("a timed-out scope observer cannot mistake a second close for finalizer completion", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const scope = yield* Scope.make()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let finalized = 0
    yield* Scope.addFinalizer(scope, Effect.sync(() => { finalized++ }))
    yield* Scope.addFinalizer(scope, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
    const close = makeScopeClose(scope)
    const first = yield* Effect.forkChild(close.pipe(Effect.timeoutOption(10)))
    yield* Deferred.await(entered)
    yield* TestClock.adjust(10)
    yield* Fiber.join(first)
    const second = yield* Effect.forkChild(close, { startImmediately: true })
    expect(second.pollUnsafe()).toBeUndefined()
    expect(finalized).toBe(0)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(second)
    yield* close
    expect(finalized).toBe(1)
  }).pipe(Effect.provide(TestClock.layer())))
})

test("scope close preserves the original finalizer defect for every observer", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const scope = yield* Scope.make()
    const failure = new Error("finalizer failed")
    yield* Scope.addFinalizer(scope, Effect.die(failure))
    const close = makeScopeClose(scope)
    for (let i = 0; i < 2; i++) {
      const exit = yield* Effect.exit(close)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
    }
  }))
})

test("resource cleanup shares an attempt and retries only after verified failure", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    let attempts = 0
    const release = yield* Deferred.make<void>()
    const entered = yield* Deferred.make<void>()
    const close = makeCloseOperation(Effect.gen(function*() {
      attempts++
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
      if (attempts === 1) return yield* Effect.fail("failed")
    }), true)
    const first = yield* Effect.forkChild(Effect.exit(close))
    yield* Deferred.await(entered)
    const second = yield* Effect.forkChild(Effect.exit(close), { startImmediately: true })
    expect(attempts).toBe(1)
    yield* Deferred.succeed(release, undefined)
    expect(Exit.isFailure(yield* Fiber.join(first))).toBeTrue()
    expect(Exit.isFailure(yield* Fiber.join(second))).toBeTrue()
    yield* close
    yield* close
    expect(attempts).toBe(2)
  }))
})
