import type { MessageRef } from "../domain/model"
import type { ConversationRemoval } from "../domain/persistence"
import { selectConversationForest } from "./selectors"
import type { ApplicationState } from "./state"

const messageKey = (ref: MessageRef) => JSON.stringify([ref.sessionId, ref.messageId])

/** Use the navigator's own pruning rules, independently of terminal-stop targets. */
export function projectRemovalImpact(state: ApplicationState, removal: ConversationRemoval) {
  const before = selectConversationForest(state)
  const after = selectConversationForest({ ...state, removals: [...state.removals, removal] })
  const messages = (forest: typeof before) => new Set(forest.graphs.flatMap((graph) =>
    [...graph.nodes.values()].flatMap((node) => node.kind === "message" ? node.aliases.map(messageKey) : [])))
  const survivingMessages = messages(after)
  const removedMessages = new Set([...messages(before)].filter((key) => !survivingMessages.has(key)))
  const survivingEndpoints = new Set(after.graphs.flatMap((graph) => [...graph.endpointBySessionId.keys()]))
  const removedEndpoints = new Set(before.graphs.flatMap((graph) =>
    [...graph.endpointBySessionId.keys()].filter((sessionId) => !survivingEndpoints.has(sessionId))))
  const representedSessions = (forest: typeof before) => new Set(forest.graphs.flatMap((graph) =>
    [...graph.nodes.values()].flatMap((node) => node.kind === "message" ? node.aliases.map((ref) => ref.sessionId)
      : node.kind === "endpoint" ? [node.session.id] : [])))
  const survivingSessions = representedSessions(after)
  const removedSessions = new Set([...representedSessions(before)].filter((sessionId) => !survivingSessions.has(sessionId)))
  return {
    removesMessage: (ref: MessageRef) => removedMessages.has(messageKey(ref)),
    removesEndpoint: (sessionId: string) => removedEndpoints.has(sessionId),
    removesSession: (sessionId: string) => removedSessions.has(sessionId),
  }
}
