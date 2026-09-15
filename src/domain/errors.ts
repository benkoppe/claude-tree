import { Data } from "effect"
import type { OwnershipBlockReason } from "./persistence"

export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly providerId: string
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class ProviderProtocolError extends Data.TaggedError("ProviderProtocolError")<{
  readonly providerId: string
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class ProviderCleanupError extends Data.TaggedError("ProviderCleanupError")<{
  readonly providerId: string
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  readonly operation: string
  readonly path: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class SessionOwnedError extends Data.TaggedError("SessionOwnedError")<{
  readonly providerId: string
  readonly sessionId: string
  readonly ownerPid: number
  readonly reason?: OwnershipBlockReason
}> {
  override get message(): string {
    if (this.reason !== undefined && this.reason !== "application-present") {
      const details: Record<Exclude<OwnershipBlockReason, "application-present">, string> = {
        "liveness-unknown": "process absence could not be verified",
        "acquisition-incomplete": "launch acquisition was interrupted before all process identities were recorded; automatic recovery cannot prove that no process survived",
        "terminal-present": "the previous terminal process group still exists",
        "sidecar-present": "the previous provider sidecar process group still exists",
        "artifact-cleanup-failed": "the previous launch artifacts could not be removed",
        "owner-changed": "ownership changed during recovery",
      }
      return `Session ${this.sessionId} remains reserved after previous cleanup (original application PID ${this.ownerPid}): ${details[this.reason]}. Retry after resolving the reported cleanup condition.`
    }
    return `Session ${this.sessionId} is already owned by another terminal (PID ${this.ownerPid}). Return to that claude-tree instance or stop its terminal before opening this session here.`
  }
}

export class SessionRemovedError extends Data.TaggedError("SessionRemovedError")<{
  readonly providerId: string
  readonly sessionId: string
  readonly message: string
}> {}

export class TerminalError extends Data.TaggedError("TerminalError")<{
  readonly operation: string
  readonly sessionId: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class ApplicationError extends Data.TaggedError("ApplicationError")<{
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}
