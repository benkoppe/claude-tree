import { Data } from "effect"

export class CodexProtocolError extends Data.TaggedError("CodexProtocolError")<{
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class CodexRpcError extends Data.TaggedError("CodexRpcError")<{
  readonly method: string
  readonly code: number
  readonly message: string
  readonly data?: unknown
}> {}

export type CodexIncomingMessage =
  | { readonly kind: "notification"; readonly method: string }
  | { readonly kind: "request"; readonly method: string; readonly id: string | number }
  | { readonly kind: "response"; readonly id: number; readonly result: unknown }
  | { readonly kind: "error"; readonly id: number; readonly error: {
      readonly code: number; readonly message: string; readonly data?: unknown
    } }

/** Decode only the envelopes needed by the metadata client. Payload codecs live with their consumers. */
export function decodeCodexMessage(line: string): CodexIncomingMessage {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch (cause) {
    throw invalidMessage("Codex app-server emitted invalid JSONL", cause)
  }
  if (!isRecord(message)) throw invalidMessage("Codex app-server emitted a non-object message")
  const hasId = Object.hasOwn(message, "id")
  if (Object.hasOwn(message, "method")) {
    if (typeof message.method !== "string") throw invalidMessage("Codex app-server emitted a non-string method")
    if (!hasId) return { kind: "notification", method: message.method }
    if (typeof message.id !== "string" && (typeof message.id !== "number" || !Number.isSafeInteger(message.id))) {
      throw invalidMessage("Codex app-server emitted a server request with an invalid id")
    }
    return { kind: "request", id: message.id, method: message.method }
  }
  if (!hasId || typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
    throw invalidMessage("Codex app-server emitted a response with an invalid id")
  }
  const hasResult = Object.hasOwn(message, "result")
  const hasError = Object.hasOwn(message, "error")
  if (hasResult === hasError) throw invalidMessage("Codex app-server returned a malformed response")
  if (!hasError) return { kind: "response", id: message.id, result: message.result }
  if (!isRecord(message.error) || typeof message.error.code !== "number" ||
    !Number.isSafeInteger(message.error.code) || typeof message.error.message !== "string") {
    throw invalidMessage("Codex app-server returned a malformed error")
  }
  return { kind: "error", id: message.id, error: {
    code: message.error.code,
    message: message.error.message,
    ...(message.error.data === undefined ? {} : { data: message.error.data }),
  } }
}

function invalidMessage(message: string, cause?: unknown): CodexProtocolError {
  return new CodexProtocolError({ operation: "read", message, ...(cause === undefined ? {} : { cause }) })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
