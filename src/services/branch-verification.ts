import { Effect } from "effect"
import type { ProviderError, ProviderProtocolError } from "../domain/errors"
import type { BranchOutcome, BranchVerificationReceipt } from "./provider"
import { HISTORY_RETRY_DELAYS_MS } from "./lifecycle-policy"

/** Poll only compatible incomplete evidence. Read failures require an explicit retry. */
export function awaitBranchVerification(
  receipt: BranchVerificationReceipt,
  initial?: BranchOutcome,
): Effect.Effect<BranchOutcome, ProviderError | ProviderProtocolError> {
  return Effect.gen(function*() {
    let result = initial ?? (yield* receipt.verify)
    let attempt = 0
    while (result._tag === "CreatedIndependentSession" && result.verification?.status === "pending") {
      yield* Effect.sleep(HISTORY_RETRY_DELAYS_MS[Math.min(attempt++, HISTORY_RETRY_DELAYS_MS.length - 1)]!)
      result = yield* receipt.verify
    }
    return result
  })
}
