import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { makeNavigationWriter, NAVIGATION_SAVE_INTERVAL_MS } from "../../src/application/navigation-writer"
import { PersistenceError, SessionOwnedError } from "../../src/domain/errors"
import type { ProjectState } from "../../src/domain/persistence"

test("navigation writes fail promptly after explicit close", async () => {
  let writes = 0
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const writer = yield* makeNavigationWriter({
      saveNavigation: () => Effect.sync(() => {
        writes += 1
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
      saveNavigation: (navigation) => Effect.gen(function*() {
        writes += 1
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        state = { ...state, navigation }
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

test("a held durable write retains only the latest of a thousand accepted cursor positions", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let state: ProjectState = { relations: [], removals: [] }
    let writes = 0
    const writer = yield* makeNavigationWriter({
      saveNavigation: (navigation) => Effect.gen(function*() {
        writes++
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        state = { ...state, navigation }
      }),
    }, undefined, 0)
    yield* writer.schedule({ view: "roots", selectedSessionId: "first" })
    yield* Deferred.await(started)
    for (let index = 0; index < 1_000; index++) {
      yield* writer.schedule({ view: "roots", selectedSessionId: `root-${index}` })
    }
    expect(writes).toBe(1)
    const flush = yield* Effect.forkChild(writer.flush)
    yield* Effect.yieldNow
    expect(flush.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(flush)
    expect(writes).toBe(2)
    expect(state.navigation).toEqual({ view: "roots", selectedSessionId: "root-999" })
  })))
})

test("sustained movement saves at a bounded cadence and flush bypasses the remaining delay", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const saved: string[] = []
    const writer = yield* makeNavigationWriter({ saveNavigation: (navigation) => Effect.sync(() => {
      if (navigation.view === "roots") saved.push(navigation.selectedSessionId!)
    }) })
    for (let index = 0; index < 8; index++) {
      yield* writer.schedule({ view: "roots", selectedSessionId: String(index) })
      yield* Effect.yieldNow
      yield* TestClock.adjust(NAVIGATION_SAVE_INTERVAL_MS / 4)
    }
    expect(saved).toEqual(["3", "7"])
    yield* writer.schedule({ view: "roots", selectedSessionId: "final" })
    yield* writer.flush
    expect(saved).toEqual(["3", "7", "final"])
    yield* writer.schedule({ view: "roots", selectedSessionId: "after-flush" })
    yield* Effect.yieldNow
    expect(saved).toHaveLength(3)
    yield* TestClock.adjust(NAVIGATION_SAVE_INTERVAL_MS)
    expect(saved.at(-1)).toBe("after-flush")
  })).pipe(Effect.provide(TestClock.layer())))
})

test("scheduled persistence failures are reported and flush observes them", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const error = new PersistenceError({ operation: "save navigation", path: "/state", message: "worker failed" })
    const reported: PersistenceError[] = []
    const writer = yield* makeNavigationWriter({ saveNavigation: () => Effect.fail(error) },
      (failure) => Effect.sync(() => { reported.push(failure) }))
    yield* writer.schedule({ view: "roots", selectedSessionId: "root" })
    yield* Effect.yieldNow
    yield* TestClock.adjust(NAVIGATION_SAVE_INTERVAL_MS)
    expect(reported).toEqual([error])
    expect(yield* Effect.flip(writer.flush)).toBe(error)
  })).pipe(Effect.provide(TestClock.layer())))
})
