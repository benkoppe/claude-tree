import { buildConversationForest, type ConversationForest } from "../domain/conversation-graph"
import type { AgentMessage, AgentSession } from "../domain/model"
import type { BranchRelation, ConversationRemoval } from "../domain/persistence"

interface FamilyInputs {
  readonly sessions: readonly AgentSession[]
  readonly histories: readonly (readonly AgentMessage[] | undefined)[]
  readonly relations: readonly BranchRelation[]
  readonly removals: readonly ConversationRemoval[]
  readonly forest: ConversationForest
}

const families = new WeakMap<AgentSession, FamilyInputs>()
const sameItems = <A>(left: readonly A[], right: readonly A[]) =>
  left.length === right.length && left.every((item, index) => item === right[index])

/** Partition by recorded connectivity, including unavailable parents and invalid attachments.
 * Each component still runs the complete transactional graph validation. */
export function projectForest(
  sessions: ReadonlyMap<string, AgentSession>,
  transcripts: ReadonlyMap<string, readonly AgentMessage[]>,
  relations: readonly BranchRelation[],
  removals: readonly ConversationRemoval[],
): ConversationForest {
  const groups = groupSessionFamilies(sessions, relations)
  const graphs: ConversationForest["graphs"] = []
  const graphBySessionId: ConversationForest["graphBySessionId"] = new Map()
  const graphByRootSessionId: ConversationForest["graphByRootSessionId"] = new Map()
  const warnings: string[] = []
  for (const group of groups.values()) {
    const histories = group.sessions.map((session) => transcripts.get(session.id))
    const key = group.sessions[0]!
    const previous = families.get(key)
    const forest = previous && sameItems(previous.sessions, group.sessions) &&
      sameItems(previous.histories, histories) && sameItems(previous.relations, group.relations) &&
      sameItems(previous.removals, removals)
      ? previous.forest
      : buildConversationForest(group.sessions, new Map(group.sessions.flatMap((session, index) =>
        histories[index] === undefined ? [] : [[session.id, histories[index]!] as const])), group.relations, removals)
    families.set(key, { ...group, histories, removals, forest })
    graphs.push(...forest.graphs)
    for (const [id, graph] of forest.graphBySessionId) graphBySessionId.set(id, graph)
    for (const [id, graph] of forest.graphByRootSessionId) graphByRootSessionId.set(id, graph)
    warnings.push(...forest.warnings)
  }
  graphs.sort((left, right) => right.rootSession.lastModified - left.rootSession.lastModified ||
    left.rootSessionId.localeCompare(right.rootSessionId))
  return { graphs, graphBySessionId, graphByRootSessionId, warnings }
}

export function groupSessionFamilies(sessions: ReadonlyMap<string, AgentSession>, relations: readonly BranchRelation[]) {
  const parents = new Map<string, string>()
  const root = (id: string): string => {
    let current = id
    while (parents.has(current) && parents.get(current) !== current) current = parents.get(current)!
    while (parents.has(id) && parents.get(id) !== current) {
      const next = parents.get(id)!
      parents.set(id, current)
      id = next
    }
    return current
  }
  for (const relation of relations) {
    const parent = root(relation.parentSessionId)
    const child = root(relation.childSessionId)
    if (parent !== child) parents.set(child, parent)
  }
  const groups = new Map<string, { sessions: AgentSession[]; relations: BranchRelation[] }>()
  for (const session of sessions.values()) {
    const key = root(session.id)
    let group = groups.get(key)
    if (!group) groups.set(key, group = { sessions: [], relations: [] })
    group.sessions.push(session)
  }
  for (const relation of relations) groups.get(root(relation.parentSessionId))?.relations.push(relation)
  for (const group of groups.values()) group.sessions.sort((left, right) => left.id.localeCompare(right.id))
  return groups
}
