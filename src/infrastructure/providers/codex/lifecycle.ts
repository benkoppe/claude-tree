import { Schema } from "effect"

import type { ProviderTerminalEvent } from "../../../services/provider"
import {
  V2ThreadStatusChangedNotification,
  V2TurnCompletedNotification__TurnStatus,
} from "../../../vendor/t3/codex/_generated/schema.gen"

// Only lifecycle fields are consumed; stock TUI item payloads pass through unchanged.
const TurnNotification = Schema.Struct({
  threadId: Schema.NonEmptyString,
  turn: Schema.Struct({ id: Schema.NonEmptyString, status: V2TurnCompletedNotification__TurnStatus }),
})
const Envelope = Schema.Struct({ method: Schema.String, params: Schema.Unknown })
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope))
const decodeCorrelation = Schema.decodeUnknownOption(Schema.Struct({ threadId: Schema.NonEmptyString }))
const decodeTurn = Schema.decodeUnknownOption(TurnNotification)
const decodeStatus = Schema.decodeUnknownOption(V2ThreadStatusChangedNotification)

export class CodexLifecycleObserver {
  private threadId: string | undefined
  private activeTurnId: string | undefined
  private readonly startedTurns = new Set<string>()
  private readonly settledTurns = new Set<string>()
  private readonly defaultSource = {}
  // The first root lifecycle contributor owns authority until its connection ends.
  private authority: object | undefined
  private activeStatusObserved = false

  observe(text: string, currentThreadId: string, source: object = this.defaultSource): readonly ProviderTerminalEvent[] {
    if (this.threadId !== currentThreadId) {
      this.threadId = currentThreadId
      this.activeTurnId = undefined
      this.startedTurns.clear()
      this.settledTurns.clear()
      this.authority = undefined
      this.activeStatusObserved = false
    }
    if (this.authority !== undefined && this.authority !== source) return []
    const envelope = decodeEnvelope(text)
    if (envelope._tag === "None") return []
    const { method, params } = envelope.value
    if (method !== "turn/started" && method !== "turn/completed" && method !== "thread/status/changed") return []
    const correlation = decodeCorrelation(params)
    if (correlation._tag === "None" || correlation.value.threadId !== currentThreadId) return []
    if (method === "turn/started" || method === "turn/completed") {
      const decoded = decodeTurn(params)
      if (decoded._tag === "None") return this.disconnect(source, currentThreadId)
      const { turn } = decoded.value
      if (this.settledTurns.has(turn.id)) return []
      if (method === "turn/started") {
        if (turn.status !== "inProgress") return []
        if (this.activeTurnId === turn.id) return []
        if (this.activeTurnId !== undefined) this.retireTurn(this.activeTurnId)
        const alreadyStarted = this.startedTurns.has(turn.id)
        const alreadyAuthoritative = this.authority === source
        this.rememberTurn(this.startedTurns, turn.id)
        this.activeTurnId = turn.id
        this.authority = source
        if (alreadyStarted) return alreadyAuthoritative ? [] : [
          { _tag: "Activity", sessionId: currentThreadId, activity: "working" },
        ]
        return [
          { _tag: "Observation", sessionId: currentThreadId, observation: { _tag: "Submission" } },
          { _tag: "Activity", sessionId: currentThreadId, activity: "working" },
        ]
      }
      if (turn.status === "inProgress" || (this.activeTurnId !== undefined && this.activeTurnId !== turn.id)) return []
      this.activeTurnId = undefined
      this.activeStatusObserved = false
      this.retireTurn(turn.id)
      this.authority = source
      return [{ _tag: "Activity", sessionId: currentThreadId, activity: "idle" }]
    }
    const decoded = decodeStatus(params)
    if (decoded._tag === "None") return this.disconnect(source, currentThreadId)
    const { status } = decoded.value
    if (status.type !== "active") return [] // Idle is not a terminal turn event.
    if (this.authority !== undefined && this.activeTurnId === undefined &&
      this.settledTurns.size > 0 && !this.activeStatusObserved) return []
    this.authority = source
    this.activeStatusObserved = true
    return [{
      _tag: "Activity", sessionId: currentThreadId,
      activity: status.activeFlags.length > 0 ? "blocked" : "working",
    }]
  }

  disconnect(source: object, currentThreadId: string): readonly ProviderTerminalEvent[] {
    if (this.authority !== source) return []
    this.authority = undefined
    this.activeTurnId = undefined
    this.activeStatusObserved = false
    // Deduplication survives reconnect; active-turn correlation belongs to the connection.
    return [{ _tag: "Unavailable", sessionId: currentThreadId }]
  }

  private retireTurn(turnId: string): void {
    this.rememberTurn(this.settledTurns, turnId)
  }

  private rememberTurn(turns: Set<string>, turnId: string): void {
    turns.add(turnId)
    if (turns.size > 128) turns.delete(turns.values().next().value!)
  }
}
