import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"

import { makeNavigationWriter } from "../../src/application/navigation-writer"
import { PersistenceError, SessionOwnedError } from "../../src/domain/errors"
import type { ProjectState } from "../../src/domain/persistence"

test("navigation writes fail promptly after explicit close", async () => {
  let writes = 0
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const writer = yield* makeNavigationWriter({
      loadMetadata: Effect.succeed({ relations: [], removals: [] }),
      updateMetadata: (transform) => Effect.sync(() => {
        writes += 1
        return transform({ relations: [], removals: [] })
      }),
    })
    yield* writer.close
    yield* writer.close
    const error = yield* Effect.flip(writer.write({ view: "roots", selectedSessionId: null }))
    expect(error).toBeInstanceOf(PersistenceError)
    expect(error.message).toContain("writer has closed")
    expect(writes).toBe(0)
    yield* writer.flush
  })))
})

test("identical in-flight navigation requests share one durable write", async () => {
  let state: ProjectState = { relations: [], removals: [] }
  let writes = 0
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const writer = yield* makeNavigationWriter({
      loadMetadata: Effect.sync(() => state),
      updateMetadata: (transform) => Effect.gen(function*() {
        writes += 1
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        state = transform(state)
        return state
      }),
    })
    const navigation = { view: "roots" as const, selectedSessionId: "root" }
    const first = yield* Effect.forkChild(writer.write(navigation))
    yield* Deferred.await(started)
    const second = yield* Effect.forkChild(writer.write(navigation))
    yield* Effect.yieldNow
    expect(second.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    yield* writer.flush
    expect(writes).toBe(1)
    expect(state.navigation).toEqual(navigation)
  })))
})

test("ownership conflicts explain the reserved session and owning process", () => {
  const error = new SessionOwnedError({ providerId: "claude", sessionId: "session-one", ownerPid: 123 })
  expect(error.message).toContain("session-one")
  expect(error.message).toContain("PID 123")
  expect(error.message).toContain("already owned")
})
