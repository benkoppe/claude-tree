import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { awaitBranchVerification } from "../../src/services/branch-verification"
import type { BranchVerificationReceipt, CreatedIndependentSession, ValidatedBranch } from "../../src/services/provider"

const session = { id: "child", title: "Child", lastModified: 0 }
const verified: ValidatedBranch = { _tag: "ValidatedBranch", session,
  acquireLaunch: Effect.die("Verification must not launch a terminal"),
  derivation: { childSessionId: session.id, parentSessionId: "parent", sourceMessageId: "message", sharedMessages: [] } }

test("compatible pending evidence can outlast every former retry window without losing verification", async () => {
  let reads = 0
  const pending: CreatedIndependentSession = { _tag: "CreatedIndependentSession", session,
    transcript: { _tag: "Missing" }, reason: "Not yet visible",
    verification: { status: "pending", reasonCode: "missing" } }
  const receipt: BranchVerificationReceipt = { session, verify: Effect.sync(() => ++reads > 20 ? verified : pending) }
  await Effect.runPromise(Effect.gen(function*() {
    const waiting = yield* Effect.forkChild(awaitBranchVerification(receipt))
    yield* TestClock.adjust(30_000)
    expect(yield* Fiber.join(waiting)).toBe(verified)
    expect(reads).toBe(21)
  }).pipe(Effect.provide(TestClock.layer())))
})

test.each(["unavailable", "contradicted"] as const)("%s evidence stops automatic polling", async (status) => {
  let reads = 0
  const result: CreatedIndependentSession = { _tag: "CreatedIndependentSession", session,
    transcript: { _tag: "Unavailable", reason: "Cannot verify" }, reason: "Cannot verify",
    verification: { status, reasonCode: status === "unavailable" ? "unsupported" : "copy-mismatch" } }
  const receipt: BranchVerificationReceipt = { session, verify: Effect.sync(() => { reads++; return result }) }
  expect(await Effect.runPromise(awaitBranchVerification(receipt))).toBe(result)
  expect(reads).toBe(1)
})

test("cancellation interrupts a pending read without starting another verification", async () => {
  const started = Deferred.makeUnsafe<void>()
  let reads = 0
  const receipt: BranchVerificationReceipt = { session, verify: Effect.sync(() => { reads++ }).pipe(
    Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)) }
  await Effect.runPromise(Effect.gen(function*() {
    const waiting = yield* Effect.forkChild(awaitBranchVerification(receipt))
    yield* Deferred.await(started)
    yield* Fiber.interrupt(waiting)
    expect(reads).toBe(1)
  }))
})
