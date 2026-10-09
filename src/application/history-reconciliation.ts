import type { AgentMessage, TranscriptRead } from "../domain/model"
import { MAX_HISTORY_CONFIRMATION_READS } from "../services/lifecycle-policy"
import type { PendingCompletion, RewindAnchor, TerminalState } from "./state"

export function reconcileTranscript(
  previous: TranscriptRead | undefined,
  incoming: TranscriptRead,
  nonIdle: boolean,
  anchor: RewindAnchor | undefined,
  completion: PendingCompletion | undefined,
  candidate: { readonly messages: readonly AgentMessage[]; readonly attempts: number; readonly userPrefix?: boolean } | undefined,
  terminal: TerminalState | undefined,
): {
  readonly read: TranscriptRead
  readonly accepted: boolean
  readonly clearAnchor?: boolean
  readonly completed?: boolean
  readonly candidate?: { readonly messages: readonly AgentMessage[]; readonly attempts: number; readonly userPrefix?: boolean }
  readonly replacement?: TerminalState["replacement"]
  readonly unstable?: boolean
  readonly coverageChanged?: boolean
} {
  const retained = completion ? { ...(previous?._tag === "Available" ? previous : {}), _tag: "Available" as const, messages: completion.baseline } : previous ?? incoming
  // Limited context is readable but cannot replace verified navigation or prove completion.
  if (incoming._tag === "Available" && incoming.coverage) return {
    read: previous?._tag === "Available" ? retained : incoming,
    accepted: false,
  }
  if (previous?._tag === "Available" && previous.coverage && incoming._tag === "Available") {
    if (terminal?.replacement && incoming.messages.some((message) => terminal.replacement!.discardedMessageIds.has(message.id))) {
      return { read: retained, accepted: false }
    }
    if (terminal?.replacement && !terminal.replacement.settled) {
      const records = new Map(incoming.messages.map((message, index) => [message.id, { message, index }]))
      let previousPosition = -1
      if (terminal.replacement.prefix.some((message) => {
        const entry = records.get(message.id)
        if (!entry) return true
        if (!message.historyBoundary) {
          if (entry.index <= previousPosition) return true
          previousPosition = entry.index
        }
        const current = entry.message
        const { displayGroupId: _, ...content } = message
        return !sameLogicalMessage({ ...content, ordinal: current.ordinal,
          ...(current.displayGroupId !== undefined ? { displayGroupId: current.displayGroupId } : {}) }, current)
      })) return { read: retained, accepted: false }
    }
    if (anchor && incoming.messages.some((message) => message.id === anchor.targetMessageId)) return { read: retained, accepted: false }
    if (!candidate || !sameTranscript(candidate.messages, incoming.messages)) {
      const attempts = (candidate?.attempts ?? 0) + 1
      return { read: retained, accepted: false, ...(attempts >= MAX_HISTORY_CONFIRMATION_READS
        ? { unstable: true } : { candidate: { messages: incoming.messages, attempts } }) }
    }
    const messages = nonIdle || completion
      ? incoming.messages.slice(0, incoming.messages.findLastIndex((message) => message.visible && message.role === "user") + 1)
      : incoming.messages
    return { read: { ...incoming, messages }, accepted: true, coverageChanged: true, clearAnchor: anchor !== undefined,
      ...(terminal?.replacement ? { replacement: { ...terminal.replacement, prefix: messages } } : {}) }
  }
  if (incoming._tag !== "Available" && previous?._tag === "Available") return { read: retained, accepted: false }
  if (incoming._tag !== "Available" && (nonIdle || terminal?.unresolvedRewind || terminal?.replacement)) {
    return { read: retained, accepted: false }
  }
  const targetIndex = previous?._tag === "Available" && anchor
    ? previous.messages.findIndex((message) => message.id === anchor.targetMessageId) : -1
  let baseline = targetIndex >= 0 && previous?._tag === "Available"
    ? previous.messages.slice(0, targetIndex)
    : retained._tag === "Available" ? retained.messages : []
  const replacement = terminal?.replacement
  if (incoming._tag === "Available" && (
    (replacement && ((!replacement.settled && !isTranscriptPrefix(replacement.prefix, incoming.messages)) ||
      incoming.messages.some((message) => replacement.discardedMessageIds.has(message.id)))) ||
    (!replacement && targetIndex >= 0 && (!isTranscriptPrefix(baseline, incoming.messages) ||
      (previous?._tag === "Available" && incoming.messages.some((message) =>
        previous.messages.slice(targetIndex).some((old) => old.id === message.id)))))
  )) return { read: retained, accepted: false }
  const unexpectedReplacement = incoming._tag === "Available" && previous?._tag === "Available" &&
    !isTranscriptPrefix(previous.messages, incoming.messages) && !anchor && (!replacement || replacement.settled)
  const replacedCompletedTurn = unexpectedReplacement && completion !== undefined &&
    !isTranscriptPrefix(incoming.messages, previous.messages) && completionTranscriptReady([], incoming.messages)
  const recoverUserPrefix = unexpectedReplacement &&
    (terminal?.unresolvedRewind || terminal?.pendingSubmission !== undefined || completion !== undefined)
  let recoveredReplacement: TerminalState["replacement"]
  let confirmedReplacement = false
  // Matching reads are bounded consistency evidence, not provider revision numbers.
  if (recoverUserPrefix && incoming._tag === "Available" && previous?._tag === "Available") {
    let commonLength = 0
    while (commonLength < previous.messages.length && sameLogicalMessage(previous.messages[commonLength]!, incoming.messages[commonLength])) commonLength += 1
    const oldIds = new Set(previous.messages.map((message) => message.id))
    const suffix = incoming.messages.slice(commonLength)
    if (suffix.some((message) => oldIds.has(message.id))) return { read: retained, accepted: false }
    const novelUser = suffix.some((message) => message.visible && message.role === "user")
    if (novelUser || terminal?.unresolvedRewind) {
      baseline = incoming.messages.slice(0, commonLength)
      const userPrefix = stableTranscriptWhileNonIdle(baseline, incoming.messages)
      confirmedReplacement = candidate?.userPrefix === true && isTranscriptPrefix(candidate.messages, userPrefix) &&
        candidate.messages.length === userPrefix.length
      if (!confirmedReplacement) {
        const attempts = (candidate?.attempts ?? 0) + 1
        return { read: retained, accepted: false, ...(attempts >= MAX_HISTORY_CONFIRMATION_READS
          ? { unstable: true } : { candidate: { messages: userPrefix, attempts, userPrefix: true } }) }
      }
      recoveredReplacement = { prefix: baseline,
        discardedMessageIds: new Set([
          ...(replacement?.discardedMessageIds ?? []),
          ...previous.messages.slice(commonLength).map((message) => message.id),
        ]) }
    }
  }
  if (unexpectedReplacement && !confirmedReplacement && !nonIdle && (!completion || replacedCompletedTurn)) {
    confirmedReplacement = candidate !== undefined && !candidate.userPrefix && sameTranscript(candidate.messages, incoming.messages)
    if (!confirmedReplacement) {
      const attempts = (candidate?.attempts ?? 0) + 1
      return {
        read: retained, accepted: false,
        ...(attempts >= MAX_HISTORY_CONFIRMATION_READS
          ? { unstable: true }
          : { candidate: { messages: incoming.messages, attempts } }),
      }
    }
  }
  if (unexpectedReplacement && nonIdle && !confirmedReplacement) return { read: retained, accepted: false }
  const completed = completion !== undefined && !completion.coverageChanged && incoming._tag === "Available" &&
    completionTranscriptReady(confirmedReplacement && !recoveredReplacement ? [] : baseline, incoming.messages)
  if (completion && !completed && incoming._tag !== "Available") return { read: retained, accepted: false }
  const read = incoming._tag === "Available" && (nonIdle || (completion && !completed))
    ? { ...incoming, messages: stableTranscriptWhileNonIdle(baseline, incoming.messages) }
    : incoming
  if (confirmedReplacement && !recoveredReplacement && terminal && previous?._tag === "Available" && read._tag === "Available") {
    const retainedIds = new Set(read.messages.map((message) => message.id))
    recoveredReplacement = { prefix: read.messages, settled: !completion || completed,
      discardedMessageIds: new Set([
        ...(replacement?.discardedMessageIds ?? []),
        ...previous.messages.filter((message) => !retainedIds.has(message.id)).map((message) => message.id),
      ]) }
  }
  const clearAnchor = anchor !== undefined && read._tag === "Available" &&
    !read.messages.some((message) => message.id === anchor.targetMessageId)
  return { read, accepted: true, completed, clearAnchor, ...(recoveredReplacement ? { replacement: recoveredReplacement } : {}) }
}

function completionTranscriptReady(previous: readonly AgentMessage[], refreshed: readonly AgentMessage[]): boolean {
  if (!isTranscriptPrefix(previous, refreshed) || previous.length === refreshed.length) return false
  const lastVisibleUserIndex = refreshed.findLastIndex((message) => message.role === "user" && message.visible)
  const afterUser = refreshed.slice(lastVisibleUserIndex + 1)
  const signals = refreshed.slice(Math.max(0, lastVisibleUserIndex)).filter((message) => message.turnComplete !== undefined)
  return signals.at(-1)?.turnComplete ?? afterUser.some((message) => message.role === "agent")
}

export function stableTranscriptWhileNonIdle(previous: readonly AgentMessage[], refreshed: readonly AgentMessage[]): readonly AgentMessage[] {
  if (!isTranscriptPrefix(previous, refreshed)) return previous
  let acceptedLength = previous.length
  for (let index = previous.length; index < refreshed.length; index += 1) {
    if (refreshed[index]?.role === "user" && refreshed[index]?.visible) acceptedLength = index + 1
  }
  return refreshed.slice(0, acceptedLength)
}

export function isTranscriptPrefix(prefix: readonly AgentMessage[], transcript: readonly AgentMessage[]): boolean {
  return prefix === transcript || (prefix.length <= transcript.length && prefix.every((message, index) => sameLogicalMessage(message, transcript[index])))
}

export function sameTranscript(left: readonly AgentMessage[], right: readonly AgentMessage[]): boolean {
  return left === right || (left.length === right.length && left.every((message, index) =>
    sameLogicalMessage(message, right[index]) && message.historical === right[index]?.historical && message.turnComplete === right[index]?.turnComplete &&
    message.forkable === right[index]?.forkable))
}

function sameLogicalMessage(left: AgentMessage, right: AgentMessage | undefined): boolean {
  return right !== undefined && left.id === right.id && left.role === right.role &&
    left.preview === right.preview && left.text === right.text && left.ordinal === right.ordinal && left.visible === right.visible &&
    left.displayGroupId === right.displayGroupId && left.copyIdentity === right.copyIdentity && left.historyBoundary === right.historyBoundary
}
