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
    readonly kind: "missing-active-record" | "missing-logical-parent" | "cycle",
    message: string,
    readonly recordId: string,
    readonly parentId?: string,
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
): NavigationHistoryProjection {
  const effective = new Map<string, { readonly record: TranscriptRecord; readonly index: number }>()
  entries.forEach((entry, index) => {
    if (isTranscriptRecord(entry)) {
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
      visiting.set(currentId, path.length)
      path.push(record)
      if (isLinkedCompaction(record)) {
        const parentId: string = record.logicalParentUuid
        if (parentId.length === 0 || !effective.has(parentId)) throw new NavigationHistoryError("missing-logical-parent",
          `Compaction boundary ${record.uuid} references missing logical parent ${parentId || "(empty UUID)"}`, record.uuid, parentId)
        boundaries.add(record.uuid)
        currentId = parentId
      } else {
        const parentId: unknown = record.parentUuid
        currentId = typeof parentId === "string" && parentId.length > 0 ? parentId : undefined
      }
    }
    for (const record of path) complete.add(record.uuid)
  }

  return {
    sourceRecords,
    records: boundaries.size === 0 ? sourceRecords : sourceRecords.map((record) => boundaries.has(record.uuid)
      ? { ...record, parentUuid: record.logicalParentUuid, compactMetadata: undefined }
      : record),
    changed: boundaries.size > 0,
  }
}
