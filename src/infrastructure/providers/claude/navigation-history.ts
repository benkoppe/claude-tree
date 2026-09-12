import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"
import {
  isLinkedCompaction, NavigationHistoryError, object, parentOf, RecordEvidence,
  type LinkedCompactionRecord, type TranscriptRecord,
} from "./record-evidence"

export { isLinkedCompaction, NavigationHistoryError } from "./record-evidence"

export interface NavigationHistoryProjection {
  /** Effective SDK records in their last-occurrence order, before logical rewiring. */
  readonly sourceRecords: readonly SessionStoreEntry[]
  readonly records: readonly SessionStoreEntry[]
  readonly changed: boolean
}

/** The SDK resolves repeated transcript UUIDs last-write-wins, ignoring metadata
 * record types. Physical position never proves ancestry or a cycle. */
export function projectNavigationHistory(
  entries: readonly SessionStoreEntry[],
  selectedRecordIds: readonly string[],
  ancestors: ReadonlyMap<string, readonly SessionStoreEntry[]> = new Map(),
): NavigationHistoryProjection {
  const evidence = new RecordEvidence(entries, ancestors)
  const effective = evidence.current.effective
  const sourceRecords = evidence.current.ordered
  // Without logical compaction links there is no application-owned reconstruction:
  // the ordinary SDK read already supplies the authoritative conversation.
  if (!sourceRecords.some(isLinkedCompaction)) return { sourceRecords, records: sourceRecords, changed: false }
  const repairs = preservationRepairs(evidence, new Set(selectedRecordIds))
  const complete = new Set<string>()
  const boundaries = new Set<string>()

  for (const selectedId of selectedRecordIds) {
    if (!effective.has(selectedId)) throw new NavigationHistoryError("missing-active-record",
      `SDK-selected record ${selectedId} is missing from the imported transcript`, selectedId)
    const path: TranscriptRecord[] = []
    const visiting = new Map<string, number>()
    let currentId: string | undefined = selectedId
    while (currentId !== undefined && !complete.has(currentId)) {
      const cycleStart = visiting.get(currentId)
      if (cycleStart !== undefined) {
        const cycle = [...path.slice(cycleStart).map((record) => record.uuid), currentId]
        const boundary = path.findLast(isLinkedCompaction)
        const description = cycle.slice(0, 8).join(" -> ") + (cycle.length > 8 ? " -> …" : "")
        throw new NavigationHistoryError("cycle",
          `${boundary ? `Compaction boundary ${boundary.uuid}` : `SDK-selected record ${selectedId}`} has cyclic navigation ancestry: ${description}`,
          boundary?.uuid ?? selectedId, boundary?.logicalParentUuid)
      }
      const record: TranscriptRecord | undefined = effective.get(currentId)
      // Ordinary dangling parents are an SDK-supported truncated prefix. An
      // explicit compaction history link, however, promises a resolvable record.
      if (!record) break
      const problem = repairs.problems.get(currentId)
      if (problem) throw problem
      visiting.set(currentId, path.length)
      path.push(record)
      if (isLinkedCompaction(record)) {
        const parentId: string = repairs.parents.get(record.uuid) ?? record.logicalParentUuid
        if (parentId.length === 0 || !effective.has(parentId)) throw new NavigationHistoryError("missing-logical-parent",
          `Compaction boundary ${record.uuid} references missing logical parent ${parentId || "(empty UUID)"}`, record.uuid, parentId)
        boundaries.add(record.uuid)
        currentId = parentId
      } else {
        const parentId: unknown = repairs.parents.has(record.uuid) ? repairs.parents.get(record.uuid) : record.parentUuid
        currentId = typeof parentId === "string" && parentId.length > 0 ? parentId : undefined
      }
    }
    for (const record of path) complete.add(record.uuid)
  }

  return {
    sourceRecords,
    records: boundaries.size === 0 ? sourceRecords : sourceRecords.map((record) => {
      if (boundaries.has(record.uuid)) return { ...record, parentUuid: repairs.parents.get(record.uuid) ?? record.logicalParentUuid, compactMetadata: undefined }
      if (complete.has(record.uuid) && repairs.parents.has(record.uuid)) return { ...record, parentUuid: repairs.parents.get(record.uuid) }
      // SDK preservation rewrites operate globally by UUID. An older, unselected
      // boundary must not reapply a context edge to restored navigation history.
      if (record.type === "system" && record.subtype === "compact_boundary" && object(record.compactMetadata)) {
        const messages = record.compactMetadata.preservedMessages
        const segment = record.compactMetadata.preservedSegment
        if ((object(messages) && Array.isArray(messages.uuids) && messages.uuids.some((id) => typeof id === "string" && complete.has(id))) ||
          (object(segment) && typeof segment.headUuid === "string" && complete.has(segment.headUuid))) {
          return { ...record, compactMetadata: undefined }
        }
      }
      return record
    }),
    changed: boundaries.size > 0,
  }
}

interface Preservation {
  readonly boundary: LinkedCompactionRecord
  readonly anchor: string
  readonly members: readonly string[]
  readonly contextParents: ReadonlyMap<string, string>
  readonly currentAnchor: boolean
}

interface ParentRepairs {
  readonly parents: Map<string, string | null>
  readonly problems: Map<string, NavigationHistoryError>
}

type ResolvePreservationReference = (boundary: LinkedCompactionRecord, id: string) => string

function preservation(record: LinkedCompactionRecord, evidence: RecordEvidence): Preservation | undefined {
  const source = evidence.current.effective
  const resolve: ResolvePreservationReference = (boundary, id) => evidence.resolveReference(boundary, id)
  if (!object(record.compactMetadata)) return undefined
  const metadata = record.compactMetadata
  const messages = metadata.preservedMessages
  const segment = metadata.preservedSegment
  if (messages === undefined && segment === undefined) return undefined
  const invalid = (detail: string): never => {
    throw new NavigationHistoryError("invalid-preservation", `Compaction boundary ${record.uuid}: ${detail}`, record.uuid)
  }
  let members: string[]
  let anchor: string
  if (messages !== undefined) {
    if (!object(messages) || !Array.isArray(messages.uuids) || !messages.uuids.every((id) => typeof id === "string" && id.length > 0) ||
      typeof messages.anchorUuid !== "string") return invalid("invalid preserved-message metadata")
    if (messages.uuids.length === 0) return undefined
    members = messages.uuids.map((id) => resolve(record, id))
    anchor = resolve(record, messages.anchorUuid)
    if (members.length === 0) return undefined
  } else {
    if (!object(segment) || typeof segment.headUuid !== "string" || typeof segment.tailUuid !== "string" ||
      typeof segment.anchorUuid !== "string") return invalid("invalid preserved-segment metadata")
    anchor = resolve(record, segment.anchorUuid)
    const head = resolve(record, segment.headUuid)
    const tail = resolve(record, segment.tailUuid)
    members = []
    const visited = new Set<string>()
    let id: string | null = tail
    while (id !== null && !visited.has(id)) {
      visited.add(id)
      const member = source.get(id)
      if (!member) break
      members.push(id)
      if (id === head) break
      id = parentOf(member)
    }
    if (members.at(-1) !== head) return invalid("preserved segment does not reach its declared head")
    members.reverse()
  }
  if (!anchor || !source.has(anchor) || members.includes(anchor) || members.includes(record.uuid) || new Set(members).size !== members.length ||
    members.some((id) => !source.has(id))) return invalid("preservation references missing or contradictory records")
  const currentAnchor = reaches(anchor, record.uuid, (id) => {
    const parent = source.get(id)
    return parent ? parentOf(parent) : undefined
  })
  if (!currentAnchor && !evidence.hasHistoricalParent(source.get(anchor)!, record.uuid)) {
    return invalid("preservation anchor does not belong to this boundary")
  }
  const contextParents = messages !== undefined
    ? new Map(members.map((id, index) => [id, index === 0 ? anchor : members[index - 1]!]))
    : new Map([[members[0]!, anchor]])
  return { boundary: record, anchor, members, contextParents, currentAnchor }
}

/** Walk only identities. A forward reference or a later physical re-emission is
 * not evidence of a historical parent. */
function reaches(start: string | null, target: string, parent: (id: string) => string | null | undefined): boolean {
  const visited = new Set<string>()
  let id: string | null | undefined = start
  while (id !== null && id !== undefined && !visited.has(id)) {
    if (id === target) return true
    visited.add(id)
    id = parent(id)
  }
  return false
}

function preservationRepairs(
  evidence: RecordEvidence,
  selected: ReadonlySet<string>,
): ParentRepairs {
  const source = evidence.current.effective
  const result: ParentRepairs = { parents: new Map(), problems: new Map() }
  const preservations: Preservation[] = []
  for (const record of source.values()) {
    if (!isLinkedCompaction(record)) continue
    try {
      const retained = preservation(record, evidence)
      if (retained) preservations.push(retained)
    } catch (error) {
      if (!(error instanceof NavigationHistoryError)) throw error
      result.problems.set(record.uuid, error)
    }
  }
  if (preservations.length === 0) return result
  const logicalParent = (id: string): string | null | undefined => {
    const record = source.get(id)
    if (!record) return undefined
    return result.parents.has(id) ? result.parents.get(id)
      : isLinkedCompaction(record) ? record.logicalParentUuid : parentOf(record)
  }
  const headAnchors = new Map<string, Set<string>>()
  for (const retained of preservations) {
    const head = retained.members[0]!
    const anchors = headAnchors.get(head) ?? new Set()
    anchors.add(retained.anchor)
    headAnchors.set(head, anchors)
  }
  const historicalProblems = new Map<string, { boundaryId: string; recordId: string; error: NavigationHistoryError }>()
  let changed = true
  while (changed) {
    changed = false
    const required = new Set<string>()
    const visited = new Set<string>()
    for (const selectedId of selected) {
      let id: string | null | undefined = selectedId
      while (id != null && !visited.has(id)) {
        visited.add(id)
        const record = source.get(id)
        if (record && isLinkedCompaction(record)) required.add(id)
        id = logicalParent(id)
      }
    }
    for (const retained of preservations) {
      if (!required.has(retained.boundary.uuid)) continue
      const ancestors = new Set<string>()
      let ancestor: string | null | undefined = retained.boundary.logicalParentUuid
      while (ancestor != null && !ancestors.has(ancestor)) {
        ancestors.add(ancestor)
        ancestor = logicalParent(ancestor)
      }
      for (const [id, contextParent] of retained.contextParents) {
        const record = source.get(id)!
        if (parentOf(record) !== contextParent || !ancestors.has(id)) continue
        let candidates: ReadonlySet<string | null>
        try {
          const excluded = new Set([contextParent, ...(headAnchors.get(id) ?? [])])
          // A head parented to its own summary needs historical evidence. An
          // internal predecessor may already be an unchanged historical edge.
          candidates = id === retained.members[0] ? evidence.historicalParents(record, excluded)
            : new Set([...evidence.availableParents(record)].filter((parent) => parent === null || !excluded.has(parent)))
        } catch (error) {
          if (!(error instanceof NavigationHistoryError)) throw error
          historicalProblems.set(JSON.stringify([retained.boundary.uuid, id]), { boundaryId: retained.boundary.uuid, recordId: id, error })
          continue
        }
        if (candidates.size === 1) {
          const parent = [...candidates][0]!
          if (!result.parents.has(id) || result.parents.get(id) !== parent) {
            result.parents.set(id, parent)
            changed = true
          }
        } else if (candidates.size > 1 || id === retained.members[0]) {
          historicalProblems.set(JSON.stringify([retained.boundary.uuid, id]), {
            boundaryId: retained.boundary.uuid, recordId: id,
            error: new NavigationHistoryError("ambiguous-preservation",
              `Compaction boundary ${retained.boundary.uuid}: preserved record ${id} has ${candidates.size === 0 ? "no evidenced" : "multiple conflicting"} historical parents`,
              retained.boundary.uuid, id),
          })
        }
      }
    }
  }
  const contextSelected = (retained: Preservation) => selected.has(retained.boundary.uuid) ||
    (retained.currentAnchor && selected.has(retained.anchor))

  const historicalRegion = (retained: Preservation): string[] => {
    const declared = new Set(retained.members)
    const path: string[] = []
    let id = logicalParent(retained.boundary.uuid)
    const visited = new Set<string>()
    let headIndex = -1
    while (id != null && !visited.has(id)) {
      if (declared.has(id)) headIndex = path.length
      visited.add(id)
      path.push(id)
      id = logicalParent(id)
    }
    return path.slice(0, headIndex + 1)
  }
  // A selected continuation that bypasses later preserved conversation records
  // is a selected prefix, not permission to resurrect that discarded tail.
  for (const retained of preservations) {
    if (!contextSelected(retained)) continue
    const region = historicalRegion(retained)
    const indexes = new Map(region.map((id, index) => [id, index]))
    const declared = new Set(retained.members)
    let cutIndex: number | undefined
    for (const id of selected) {
      const record = source.get(id)
      if (!record || indexes.has(id) || isLinkedCompaction(record)) continue
      const parent = parentOf(record)
      const index = parent === null ? undefined : indexes.get(parent)
      if (index === undefined || !selected.has(parent!) || (cutIndex !== undefined && index >= cutIndex)) continue
      const later = region.slice(0, index).filter((id) => {
        const member = source.get(id)!
        return declared.has(id) && (member.type === "user" || member.type === "assistant") && !member.isMeta && !member.isSidechain && !member.teamName
      })
      if (later.length && later.every((id) => !selected.has(id))) cutIndex = index
    }
    if (cutIndex !== undefined) result.parents.set(retained.boundary.uuid, region[cutIndex]!)
  }

  // Context retention can also pull ordinary descendants of the declared tail
  // into the summary. Keep historical source ancestors before the boundary.
  const byParent = new Map<string, Array<{ retained: Preservation; historical: ReadonlySet<string>; continuation: string }>>()
  const contextPlacements = new Map<string, string>()
  for (const retained of preservations) {
    const historical = new Set(historicalRegion(retained))
    const contextOnly = retained.members.filter((id) => !historical.has(id) && selected.has(id))
    if (contextSelected(retained)) {
      for (const [index, id] of contextOnly.entries()) {
        const parent = index === 0 ? retained.anchor : contextOnly[index - 1]!
        if (contextPlacements.has(id) && contextPlacements.get(id) !== parent) {
          result.problems.set(id, new NavigationHistoryError("ambiguous-preservation",
            `Preserved record ${id} has conflicting selected context placements`, retained.boundary.uuid, id))
          continue
        }
        if (!reaches(parent, id, logicalParent)) {
          contextPlacements.set(id, parent)
          result.parents.set(id, parent)
        }
      }
    }
    const continuation = contextOnly.at(-1) ?? retained.anchor
    for (const member of historical) {
      const contexts = byParent.get(member) ?? []
      contexts.push({ retained, historical, continuation })
      byParent.set(member, contexts)
    }
  }
  for (const record of source.values()) {
    if (isLinkedCompaction(record)) continue
    const parent = result.parents.has(record.uuid) ? result.parents.get(record.uuid) : parentOf(record)
    if (parent == null) continue
    const candidates = new Map<string, Preservation>()
    for (const { retained, historical, continuation } of byParent.get(parent) ?? []) {
      if (historical.has(record.uuid)) continue
      const selectedContinuation = selected.has(record.uuid) && contextSelected(retained)
      const originalAnchor = evidence.availableParents(record).has(retained.anchor)
      if ((selectedContinuation || originalAnchor) && !reaches(continuation, record.uuid, logicalParent)) candidates.set(continuation, retained)
    }
    if (candidates.size === 1) result.parents.set(record.uuid, candidates.keys().next().value!)
    else if (candidates.size > 1) result.problems.set(record.uuid, new NavigationHistoryError("ambiguous-preservation",
      `Record ${record.uuid} has multiple evidenced compaction continuations`, record.uuid))
  }
  for (const { boundaryId, recordId, error } of historicalProblems.values()) {
    if (reaches(logicalParent(boundaryId) ?? null, recordId, logicalParent)) result.problems.set(boundaryId, error)
  }
  return result
}
