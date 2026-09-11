import { isDeepStrictEqual } from "node:util"

import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"

const TRANSCRIPT_TYPES = new Set(["user", "assistant", "progress", "system", "attachment"])
const ENVELOPE_FIELDS = new Set([
  "uuid", "parentUuid", "logicalParentUuid", "sessionId", "timestamp", "cwd", "forkedFrom",
  "isSidechain", "teamName", "agentName", "sessionKind", "slug", "sourceToolAssistantUUID", "neutralizedByFork",
])

export interface TranscriptRecord extends SessionStoreEntry {
  readonly uuid: string
}

export interface LinkedCompactionRecord extends TranscriptRecord {
  readonly logicalParentUuid: string
}

export class NavigationHistoryError extends Error {
  constructor(
    readonly kind: "missing-active-record" | "missing-logical-parent" | "cycle" | "invalid-preservation" | "ambiguous-preservation" | "missing-preservation-source" | "invalid-provenance",
    message: string,
    readonly recordId: string,
    readonly parentId?: string,
    readonly sourceSessionId?: string,
  ) {
    super(message)
    this.name = "NavigationHistoryError"
  }
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function isTranscriptRecord(entry: SessionStoreEntry): entry is TranscriptRecord {
  return object(entry) && TRANSCRIPT_TYPES.has(entry.type) && typeof entry.uuid === "string"
}

export function isLinkedCompaction(entry: SessionStoreEntry): entry is LinkedCompactionRecord {
  return isTranscriptRecord(entry) && entry.type === "system" && entry.subtype === "compact_boundary" && typeof entry.logicalParentUuid === "string"
}

export function parentOf(record: TranscriptRecord): string | null {
  return typeof record.parentUuid === "string" && record.parentUuid.length > 0 ? record.parentUuid : null
}

function payload(record: TranscriptRecord): object {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !ENVELOPE_FIELDS.has(key)))
}

export function sameRecordPayload(left: TranscriptRecord, right: TranscriptRecord): boolean {
  if (left === right) return true
  if (left.type !== right.type) return false
  return left.type === "user" || left.type === "assistant"
    ? left.subtype === right.subtype && isDeepStrictEqual(left.message, right.message)
    : isDeepStrictEqual(payload(left), payload(right))
}

type ScopeId = string | null
interface Origin { readonly sessionId: string; readonly messageUuid: string }
interface EvidenceStep {
  readonly scope: ScopeId
  readonly versions: readonly TranscriptRecord[]
}

class RecordIndex {
  readonly effective: ReadonlyMap<string, TranscriptRecord>
  private readonly repeated: ReadonlyMap<string, readonly TranscriptRecord[]>
  readonly ordered: readonly TranscriptRecord[]

  constructor(entries: readonly SessionStoreEntry[]) {
    const effective = new Map<string, TranscriptRecord>()
    const repeated = new Map<string, TranscriptRecord[]>()
    entries.forEach((entry) => {
      if (!isTranscriptRecord(entry)) return
      const previous = effective.get(entry.uuid)
      if (previous) {
        const versions = repeated.get(entry.uuid) ?? [previous]
        versions.push(entry)
        repeated.set(entry.uuid, versions)
        effective.delete(entry.uuid)
      }
      effective.set(entry.uuid, entry)
    })
    this.effective = effective
    this.repeated = repeated
    this.ordered = [...effective.values()]
  }

  versions(id: string): readonly TranscriptRecord[] {
    const repeated = this.repeated.get(id)
    if (repeated) return repeated
    const record = this.effective.get(id)
    return record ? [record] : []
  }
}

/** One immutable snapshot index for references, record versions, and parent
 * evidence. Unloaded lineage is requested explicitly, never treated as absent. */
export class RecordEvidence {
  readonly current: RecordIndex
  private readonly scopes = new Map<ScopeId, RecordIndex>()
  private readonly currentSessionId: string | undefined
  private readonly aliases = new Map<ScopeId, Map<ScopeId, Map<string, Set<string>>>>()
  private readonly parentCache = new Map<string, ReadonlySet<string | null>>()
  private readonly matches = new WeakMap<TranscriptRecord, Map<ScopeId, Map<string, readonly TranscriptRecord[]>>>()

  constructor(entries: readonly SessionStoreEntry[], snapshots: ReadonlyMap<string, readonly SessionStoreEntry[]> = new Map()) {
    this.current = new RecordIndex(entries)
    this.currentSessionId = [...snapshots].find(([, records]) => records === entries)?.[0]
    this.scopes.set(null, this.current)
    for (const [id, records] of snapshots) {
      if (id !== this.currentSessionId) this.scopes.set(id, new RecordIndex(records))
    }
  }

  private scope(id: string): ScopeId { return id === this.currentSessionId ? null : id }

  private origin(versions: readonly TranscriptRecord[]): Origin | undefined {
    const origins = new Map<string, Origin>()
    for (const record of versions) {
      const value = record.forkedFrom
      if (value === undefined) continue
      if (!object(value) || typeof value.sessionId !== "string" || !value.sessionId ||
        typeof value.messageUuid !== "string" || !value.messageUuid) {
        throw new NavigationHistoryError("invalid-provenance", `Record ${record.uuid} has invalid copy provenance`, record.uuid)
      }
      const origin = { sessionId: value.sessionId, messageUuid: value.messageUuid }
      origins.set(JSON.stringify(origin), origin)
    }
    if (origins.size > 1) throw new NavigationHistoryError("ambiguous-preservation",
      `Record ${versions[0]!.uuid} has conflicting copy origins`, versions[0]!.uuid)
    return origins.values().next().value
  }

  private needSource(record: Pick<TranscriptRecord, "uuid">, scope: string): never {
    throw new NavigationHistoryError("missing-preservation-source",
      `Record ${record.uuid} requires copied-record evidence from session ${scope}`, record.uuid, undefined, scope)
  }

  private matchingVersions(record: TranscriptRecord, scope: ScopeId, id: string): readonly TranscriptRecord[] {
    let scopes = this.matches.get(record)
    if (!scopes) this.matches.set(record, scopes = new Map())
    let byId = scopes.get(scope)
    if (!byId) scopes.set(scope, byId = new Map())
    const cached = byId.get(id)
    if (cached) return cached
    const versions = (this.scopes.get(scope)?.versions(id) ?? []).filter((version) => sameRecordPayload(record, version))
    byId.set(id, versions)
    return versions
  }

  private *lineage(record: TranscriptRecord, start: ScopeId, required: boolean): Generator<EvidenceStep> {
    let scope = start
    let id = record.uuid
    const visited = new Set<ScopeId>()
    while (true) {
      if (visited.has(scope)) {
        if (!required) return
        throw new NavigationHistoryError("invalid-provenance", `Record ${record.uuid} has cyclic copy lineage`, record.uuid)
      }
      visited.add(scope)
      const index = this.scopes.get(scope)
      if (!index) {
        if (!required) return
        return this.needSource(record, scope!)
      }
      const versions = this.matchingVersions(record, scope, id)
      if (versions.length === 0) {
        if (!required) return
        throw new NavigationHistoryError("invalid-provenance",
          `Source session ${scope} has no matching ${record.type} version for copied record ${record.uuid}`, record.uuid, id)
      }
      yield { scope, versions }
      let origin: Origin | undefined
      try { origin = this.origin(versions) }
      catch (error) { if (required) throw error; return }
      if (!origin) return
      scope = this.scope(origin.sessionId)
      id = origin.messageUuid
    }
  }

  private aliasesFor(destination: ScopeId): Map<ScopeId, Map<string, Set<string>>> {
    const cached = this.aliases.get(destination)
    if (cached) return cached
    const result = new Map<ScopeId, Map<string, Set<string>>>()
    for (const current of this.scopes.get(destination)!.effective.values()) {
      for (const step of this.lineage(current, destination, false)) {
        let origin: Origin | undefined
        try { origin = this.origin(step.versions) } catch { break }
        if (!origin) break
        const scope = this.scope(origin.sessionId)
        // A known contradictory payload is not copy evidence. Missing source
        // records can still be identified by the child's retained provenance.
        if (this.scopes.get(scope)?.versions(origin.messageUuid).length &&
          this.matchingVersions(current, scope, origin.messageUuid).length === 0) break
        let byId = result.get(scope)
        if (!byId) result.set(scope, byId = new Map())
        const ids = byId.get(origin.messageUuid) ?? new Set<string>()
        ids.add(current.uuid)
        byId.set(origin.messageUuid, ids)
      }
    }
    this.aliases.set(destination, result)
    return result
  }

  private mappedId(destination: ScopeId, scope: ScopeId, id: string, recordId: string): string | undefined {
    if (scope === destination) return this.scopes.get(destination)?.effective.has(id) ? id : undefined
    const candidates = this.aliasesFor(destination).get(scope)?.get(id)
    if (candidates?.size === 1) return candidates.values().next().value
    if (candidates && candidates.size > 1 && scope !== null && !this.scopes.has(scope)) {
      return this.needSource({ uuid: recordId }, scope)
    }
    if (candidates && candidates.size > 1) throw new NavigationHistoryError("ambiguous-preservation",
      `Record ${recordId} has conflicting copies of reference ${id} from session ${scope}`, recordId, id)
    return undefined
  }

  resolveReference(boundary: TranscriptRecord, id: string, destination: ScopeId = null): string {
    const index = this.scopes.get(destination)
    if (!index) return this.needSource(boundary, destination!)
    if (index.effective.has(id)) return id
    for (const step of this.lineage(boundary, destination, true)) {
      const origin = this.origin(step.versions)
      if (!origin) break
      const mapped = this.mappedId(destination, this.scope(origin.sessionId), id, boundary.uuid)
      if (mapped !== undefined) return mapped
    }
    throw new NavigationHistoryError("invalid-preservation",
      `Compaction boundary ${boundary.uuid} cannot resolve preservation reference ${id} through copied-record evidence`, boundary.uuid, id)
  }

  /** Only SDK-omitted progress records may be traversed without a local copy. */
  private translateParent(scope: ScopeId, id: string | null, record: TranscriptRecord): ReadonlySet<string | null> {
    if (id === null) return new Set([null])
    if (scope === null) return new Set([id])
    const index = this.scopes.get(scope)!
    const result = new Set<string | null>()
    const stack: Array<{ id: string | null; exit: boolean }> = [{ id, exit: false }]
    const visits = new Map<string, "visiting" | "complete">()
    while (stack.length) {
      const current = stack.pop()!
      if (current.id === null) { result.add(null); continue }
      if (current.exit) { visits.set(current.id, "complete"); continue }
      const mapped = this.mappedId(null, scope, current.id, record.uuid)
      if (mapped !== undefined) { result.add(mapped); continue }
      if (visits.get(current.id) === "complete") continue
      if (visits.get(current.id) === "visiting") throw new NavigationHistoryError("cycle",
        `Record ${record.uuid} has cyclic omitted-progress ancestry in session ${scope}`, record.uuid, current.id)
      const parent = index.effective.get(current.id)
      if (parent?.type !== "progress") throw new NavigationHistoryError("invalid-preservation",
        `Historical parent ${current.id} of record ${record.uuid} in session ${scope} has no evidenced copy in the current transcript`, record.uuid, current.id)
      visits.set(current.id, "visiting")
      stack.push({ id: current.id, exit: true })
      const versions = index.versions(current.id)
      if (versions.some((version) => version.type !== "progress")) throw new NavigationHistoryError("invalid-provenance",
        `Omitted record ${current.id} has conflicting record types in session ${scope}`, record.uuid, current.id)
      // There is no child payload to select a version of an omitted record.
      // Keep every evidenced edge so conflicting progress updates stay ambiguous.
      const parents = new Set(versions.map(parentOf))
      for (const id of parents) stack.push({ id, exit: false })
    }
    return result
  }

  private isContextHeadParent(scope: ScopeId, record: TranscriptRecord, parent: string): boolean {
    const index = this.scopes.get(scope)!
    const visited = new Set<string>()
    let id: string | null = parent
    while (id !== null && !visited.has(id)) {
      visited.add(id)
      const candidate = index.effective.get(id)
      if (!candidate) return false
      if (candidate.type === "system" && candidate.subtype === "compact_boundary" && object(candidate.compactMetadata)) {
        const messages = candidate.compactMetadata.preservedMessages
        const segment = candidate.compactMetadata.preservedSegment
        const head = object(messages) && Array.isArray(messages.uuids) ? messages.uuids[0]
          : object(segment) ? segment.headUuid : undefined
        const anchor = object(messages) ? messages.anchorUuid : object(segment) ? segment.anchorUuid : undefined
        return typeof head === "string" && typeof anchor === "string" &&
          this.resolveReference(candidate, anchor, scope) === parent &&
          this.resolveReference(candidate, head, scope) === record.uuid
      }
      id = parentOf(candidate)
    }
    return false
  }

  availableParents(record: TranscriptRecord): ReadonlySet<string | null> {
    const cached = this.parentCache.get(record.uuid)
    if (cached) return cached
    const local = this.current.versions(record.uuid).filter((version) => sameRecordPayload(record, version))
    try { this.origin(local) }
    catch (error) {
      if (!(error instanceof NavigationHistoryError)) throw error
      return new Set()
    }
    const result = new Set(local.map(parentOf))
    for (const step of this.lineage(record, null, false)) {
      if (step.scope === null) continue
      try { this.origin(step.versions) }
      catch (error) { if (!(error instanceof NavigationHistoryError)) throw error; break }
      for (const version of step.versions) {
        try {
          for (const parent of this.translateParent(step.scope, parentOf(version), record)) result.add(parent)
        } catch (error) {
          if (!(error instanceof NavigationHistoryError)) throw error
          // Optional evidence is not an instruction to read unrelated source files.
        }
      }
    }
    this.parentCache.set(record.uuid, result)
    return result
  }

  hasHistoricalParent(record: TranscriptRecord, parent: string): boolean {
    if (this.availableParents(record).has(parent)) return true
    const currentParent = parentOf(record)
    return this.historicalParents(record, new Set(currentParent === null ? [] : [currentParent])).has(parent)
  }

  historicalParents(record: TranscriptRecord, excluded: ReadonlySet<string>): ReadonlySet<string | null> {
    for (const step of this.lineage(record, null, true)) {
      this.origin(step.versions)
      const candidates = new Set<string | null>()
      for (const version of step.versions) {
        const parent = parentOf(version)
        const mapped = parent === null ? null : step.scope === null ? parent : this.mappedId(null, step.scope, parent, record.uuid)
        if (mapped !== undefined && mapped !== null && excluded.has(mapped)) continue
        if (parent !== null && step.scope !== null && this.isContextHeadParent(step.scope, version, parent)) continue
        for (const value of this.translateParent(step.scope, parent, record)) {
          if (value === null || !excluded.has(value)) candidates.add(value)
        }
      }
      if (candidates.size > 0) return candidates
    }
    return new Set()
  }
}
