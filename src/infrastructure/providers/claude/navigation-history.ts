import { isDeepStrictEqual } from "node:util"

import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"

const TRANSCRIPT_TYPES = new Set(["user", "assistant", "progress", "system", "attachment"])

interface TranscriptRecord extends SessionStoreEntry {
  readonly uuid: string
}

interface LinkedCompactionRecord extends TranscriptRecord {
  readonly logicalParentUuid: string
}

export interface NavigationHistoryProjection {
  /** Effective SDK records in their last-occurrence order, before logical rewiring. */
  readonly sourceRecords: readonly SessionStoreEntry[]
  readonly records: readonly SessionStoreEntry[]
  readonly changed: boolean
}

export class NavigationHistoryError extends Error {
  constructor(
    readonly kind: "missing-active-record" | "missing-logical-parent" | "cycle" | "invalid-preservation" | "ambiguous-preservation" | "missing-preservation-source",
    message: string,
    readonly recordId: string,
    readonly parentId?: string,
    readonly sourceSessionId?: string,
  ) {
    super(message)
    this.name = "NavigationHistoryError"
  }
}

export function isLinkedCompaction(entry: SessionStoreEntry): entry is LinkedCompactionRecord {
  return isTranscriptRecord(entry) && entry.type === "system" &&
    entry.subtype === "compact_boundary" && typeof entry.logicalParentUuid === "string"
}

function isTranscriptRecord(entry: SessionStoreEntry): entry is TranscriptRecord {
  return typeof entry === "object" && entry !== null && TRANSCRIPT_TYPES.has(entry.type) && typeof entry.uuid === "string"
}

/** The SDK resolves repeated transcript UUIDs last-write-wins, ignoring metadata
 * record types. Physical position never proves ancestry or a cycle. */
export function projectNavigationHistory(
  entries: readonly SessionStoreEntry[],
  selectedRecordIds: readonly string[],
  ancestors: ReadonlyMap<string, readonly SessionStoreEntry[]> = new Map(),
): NavigationHistoryProjection {
  const effective = new Map<string, { readonly record: TranscriptRecord; readonly index: number }>()
  const versions = new Map<string, TranscriptRecord[]>()
  entries.forEach((entry, index) => {
    if (isTranscriptRecord(entry)) {
      const previous = effective.get(entry.uuid)
      if (previous) {
        const history = versions.get(entry.uuid) ?? [previous.record]
        history.push(entry)
        versions.set(entry.uuid, history)
      }
      effective.set(entry.uuid, { record: entry, index })
    }
  })
  const sourceRecords: TranscriptRecord[] = []
  entries.forEach((entry, index) => {
    const candidate = isTranscriptRecord(entry) ? effective.get(entry.uuid) : undefined
    if (candidate?.index === index) sourceRecords.push(candidate.record)
  })
  // Without logical compaction links there is no application-owned reconstruction:
  // the ordinary SDK read already supplies the authoritative conversation.
  if (!sourceRecords.some(isLinkedCompaction)) return { sourceRecords, records: sourceRecords, changed: false }
  const source = new Map(sourceRecords.map((record) => [record.uuid, record]))
  const repairs = preservationRepairs(source, versions, new Set(selectedRecordIds), preservationReferenceResolver(source, versions, ancestors))
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
      const record: TranscriptRecord | undefined = effective.get(currentId)?.record
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

function parentOf(record: TranscriptRecord): string | null {
  return typeof record.parentUuid === "string" && record.parentUuid.length > 0 ? record.parentUuid : null
}

function sameRecordPayload(left: TranscriptRecord, right: TranscriptRecord): boolean {
  return left.type === right.type && left.subtype === right.subtype && isDeepStrictEqual(left.message, right.message) &&
    (left.type !== "system" || isDeepStrictEqual(left.compactMetadata, right.compactMetadata))
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

type ResolvePreservationReference = (boundary: LinkedCompactionRecord, id: string) => string

function preservation(record: LinkedCompactionRecord, source: ReadonlyMap<string, TranscriptRecord>, versions: ReadonlyMap<string, readonly TranscriptRecord[]>, resolve: ResolvePreservationReference): Preservation | undefined {
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
  if (!currentAnchor && !(versions.get(anchor) ?? []).some((version) =>
    sameRecordPayload(source.get(anchor)!, version) && parentOf(version) === record.uuid)) {
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
  source: ReadonlyMap<string, TranscriptRecord>,
  versions: ReadonlyMap<string, readonly TranscriptRecord[]>,
  selected: ReadonlySet<string>,
  resolve: ResolvePreservationReference,
): ParentRepairs {
  const result: ParentRepairs = { parents: new Map(), problems: new Map() }
  const preservations: Preservation[] = []
  for (const record of source.values()) {
    if (!isLinkedCompaction(record)) continue
    try {
      const retained = preservation(record, source, versions, resolve)
      if (retained) preservations.push(retained)
    } catch (error) {
      if (!(error instanceof NavigationHistoryError)) throw error
      result.problems.set(record.uuid, error)
    }
  }
  if (preservations.length === 0) return result
  const versionParents = new Map<string, ReadonlySet<string | null>>()
  const parentsFor = (record: TranscriptRecord): ReadonlySet<string | null> => {
    const cached = versionParents.get(record.uuid)
    if (cached) return cached
    const parents = new Set((versions.get(record.uuid) ?? [record]).filter((version) => sameRecordPayload(record, version)).map(parentOf))
    versionParents.set(record.uuid, parents)
    return parents
  }
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
        const candidates = new Set([...parentsFor(record)].filter((parent) => parent !== contextParent && !headAnchors.get(id)?.has(parent ?? "")))
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
      const originalAnchor = parentsFor(record).has(retained.anchor)
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

interface Provenance {
  readonly sessionId: string
  readonly messageUuid: string
}

function provenance(record: TranscriptRecord): Provenance | undefined {
  const value = record.forkedFrom
  return object(value) && typeof value.sessionId === "string" && typeof value.messageUuid === "string"
    ? { sessionId: value.sessionId, messageUuid: value.messageUuid } : undefined
}

/** SDK forks remap record UUIDs but can retain preservation metadata's older
 * UUIDs. Resolve those references only through matching copied-record evidence. */
function preservationReferenceResolver(
  source: ReadonlyMap<string, TranscriptRecord>,
  versions: ReadonlyMap<string, readonly TranscriptRecord[]>,
  ancestors: ReadonlyMap<string, readonly SessionStoreEntry[]>,
): ResolvePreservationReference {
  const indexes = new Map<string, Map<string, TranscriptRecord[]>>()
  for (const [sessionId, entries] of ancestors) {
    const index = new Map<string, TranscriptRecord[]>()
    for (const entry of entries) {
      if (!isTranscriptRecord(entry)) continue
      const versions = index.get(entry.uuid) ?? []
      versions.push(entry)
      index.set(entry.uuid, versions)
    }
    indexes.set(sessionId, index)
  }
  const evidencedVersion = (child: TranscriptRecord, records: readonly TranscriptRecord[]): TranscriptRecord | undefined => {
    const candidates = records.filter((record) => sameRecordPayload(child, record))
    const origins = new Set(candidates.flatMap((record) => {
      const origin = provenance(record)
      return origin ? [JSON.stringify(origin)] : []
    }))
    if (origins.size > 1) return undefined
    return candidates.findLast((record) => provenance(record) !== undefined) ?? candidates.at(-1)
  }
  const parentRecord = (child: TranscriptRecord, ref: Provenance): TranscriptRecord | undefined =>
    evidencedVersion(child, indexes.get(ref.sessionId)?.get(ref.messageUuid) ?? [])
  let aliases: Map<string, Map<string, Set<string>>> | undefined
  const buildAliases = () => {
    const result = new Map<string, Map<string, Set<string>>>()
    for (const current of source.values()) {
      let record = evidencedVersion(current, versions.get(current.uuid) ?? [current])
      const visited = new Set<string>()
      while (record) {
        const ref = provenance(record)
        if (!ref || visited.has(JSON.stringify(ref))) break
        visited.add(JSON.stringify(ref))
        let byId = result.get(ref.sessionId)
        if (!byId) result.set(ref.sessionId, byId = new Map())
        const ids = byId.get(ref.messageUuid) ?? new Set<string>()
        ids.add(current.uuid)
        byId.set(ref.messageUuid, ids)
        record = parentRecord(record, ref)
      }
    }
    return result
  }
  return (boundary, id) => {
    if (source.has(id)) return id
    aliases ??= buildAliases()
    let record = evidencedVersion(boundary, versions.get(boundary.uuid) ?? [boundary])
    const visited = new Set<string>()
    while (record) {
      const ref = provenance(record)
      if (!ref || visited.has(JSON.stringify(ref))) break
      visited.add(JSON.stringify(ref))
      const candidates = aliases.get(ref.sessionId)?.get(id)
      if (candidates?.size === 1) return candidates.values().next().value!
      if (candidates && candidates.size > 1) throw new NavigationHistoryError("ambiguous-preservation",
        `Compaction boundary ${boundary.uuid} has conflicting copies of preservation reference ${id}`, boundary.uuid, id)
      if (!ancestors.has(ref.sessionId)) throw new NavigationHistoryError("missing-preservation-source",
        `Compaction boundary ${boundary.uuid} requires copied-record evidence from session ${ref.sessionId} for preservation reference ${id}`,
        boundary.uuid, id, ref.sessionId)
      record = parentRecord(record, ref)
    }
    throw new NavigationHistoryError("invalid-preservation",
      `Compaction boundary ${boundary.uuid} cannot resolve preservation reference ${id} through copied-record evidence`, boundary.uuid, id)
  }
}
