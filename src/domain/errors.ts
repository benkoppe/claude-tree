import { Data } from "effect"

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
}> {}

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
