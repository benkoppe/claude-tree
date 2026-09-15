import { Effect } from "effect"

import type { OwnershipBlockReason, TerminalOwner } from "../domain/persistence"
import type { PersistencePlatformApi } from "../infrastructure/metadata/platform"

export interface OwnerRecoveryOutcome {
  readonly sessionId: string
  readonly ownerToken: string
  readonly reason?: OwnershipBlockReason
}

/** Only observes processes. Numeric identities never authorize orphan signaling. */
export function inspectOrphan(
  platform: PersistencePlatformApi,
  owner: TerminalOwner,
): Effect.Effect<OwnershipBlockReason | undefined> {
  const inspect = (probe: () => Promise<"alive" | "absent" | "unknown">) =>
    Effect.interruptible(Effect.tryPromise(probe).pipe(
      Effect.timeoutOrElse({ duration: 250, orElse: () => Effect.succeed("unknown" as const) }),
      Effect.catchCause(() => Effect.succeed("unknown" as const)),
    ))
  return Effect.gen(function*() {
    const application = yield* inspect(() => platform.processLiveness(owner.ownerPid))
    if (application === "unknown") return "liveness-unknown"
    if (application === "alive") return "application-present"
    if (owner.resources.kind === "acquiring" || owner.processGroupId === undefined) {
      return "acquisition-incomplete"
    }
    const terminal = yield* inspect(() => platform.processGroupLiveness(owner.processGroupId!))
    if (terminal === "unknown") return "liveness-unknown"
    if (terminal === "alive") return "terminal-present"
    if (owner.resources.kind === "codex") {
      const group = owner.resources.sidecarProcessGroupId
      const sidecar = yield* inspect(() => platform.processGroupLiveness(group))
      if (sidecar === "unknown") return "liveness-unknown"
      if (sidecar === "alive") return "sidecar-present"
    }
    return undefined
  })
}
