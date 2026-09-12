import { expect, test } from "bun:test"
import { getSessionMessages, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { NavigationHistoryError, projectNavigationHistory } from "../../src/infrastructure/providers/claude/navigation-history"
import { ClaudeProvider } from "../../src/infrastructure/providers/claude/provider"
import { RecordEvidence } from "../../src/infrastructure/providers/claude/record-evidence"

function fixture() {
  const question = { type: "user", uuid: "question", parentUuid: null, message: { role: "user", content: "question" } }
  const answer = { type: "assistant", uuid: "answer", parentUuid: "question", message: { role: "assistant", content: "answer" } }
  const attachment = { type: "attachment", uuid: "attachment", parentUuid: "answer", attachment: { type: "fixture", value: "evidence" } }
  const boundary = { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: null, logicalParentUuid: "attachment",
    compactMetadata: { preservedMessages: { uuids: ["answer", "attachment"], anchorUuid: "summary" } } }
  const summary = { type: "user", uuid: "summary", parentUuid: "boundary", isCompactSummary: true, message: { role: "user", content: "summary" } }
  const parents: SessionStoreEntry[] = [question, answer, attachment, boundary, summary]
  const compacted = [question, boundary, summary, { ...answer, parentUuid: "summary" }, attachment]
  const current = copy(compacted, "parent", "child")
  current.push({ type: "user", uuid: "continuation", parentUuid: "child:attachment", message: { role: "user", content: "continuation" } })
  return { parents, current, selected: ["child:summary", "child:answer", "continuation", "child:boundary"] }
}

function copy(records: readonly SessionStoreEntry[], sourceSession: string, prefix: string): SessionStoreEntry[] {
  const id = (value: unknown) => typeof value === "string" ? `${prefix}:${value}` : value
  return records.map((record) => ({ ...record, uuid: id(record.uuid) as string, parentUuid: id(record.parentUuid),
    ...(record.logicalParentUuid === undefined ? {} : { logicalParentUuid: id(record.logicalParentUuid) }),
    forkedFrom: { sessionId: sourceSession, messageUuid: record.uuid },
  }))
}

test("a single child version recovers its parent from the same evidence used to resolve foreign preservation UUIDs", () => {
  const f = fixture()
  const before = JSON.stringify(f)
  expect(f.current.filter((record) => record.uuid === "child:answer")).toHaveLength(1)
  const projection = projectNavigationHistory(f.current, f.selected, new Map([["parent", f.parents]]))
  const records = new Map(projection.records.map((record) => [record.uuid, record]))
  expect(records.get("child:answer")?.parentUuid).toBe("child:question")
  expect(records.get("child:boundary")?.parentUuid).toBe("child:attachment")
  expect(records.get("child:attachment")?.parentUuid).toBe("child:answer")
  expect(records.get("continuation")?.parentUuid).toBe("child:summary")
  expect(JSON.stringify(f)).toBe(before)
})

test("missing original-parent evidence requests the ancestor snapshot instead of declaring local absence final", () => {
  const f = fixture()
  let failure: unknown
  try { projectNavigationHistory(f.current, f.selected) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(NavigationHistoryError)
  expect((failure as NavigationHistoryError).kind).toBe("missing-preservation-source")
  expect((failure as NavigationHistoryError).sourceSessionId).toBe("parent")
})

test("parent lookup follows multiple copy generations and uses the child's identity namespace", () => {
  const f = fixture()
  const grandchild = copy(f.current, "child-session", "grandchild")
  const projection = projectNavigationHistory(grandchild, f.selected.map((id) => `grandchild:${id}`),
    new Map([["child-session", f.current], ["parent", f.parents]]))
  expect(projection.records.find((record) => record.uuid === "grandchild:child:answer")?.parentUuid).toBe("grandchild:child:question")
})

test("attachment payloads are checked when extending copy lineage", () => {
  const f = fixture()
  const grandchild = copy(f.current, "child-session", "grandchild")
  const altered = f.current.map((record) => record.type === "attachment"
    ? { ...record, attachment: { type: "fixture", value: "different evidence" } } : record)
  expect(() => projectNavigationHistory(grandchild, f.selected.map((id) => `grandchild:${id}`),
    new Map([["child-session", altered], ["parent", f.parents]]))).toThrow("cannot resolve preservation reference attachment")
})

test("an unrelated contradictory copy cannot poison a validated parent mapping", () => {
  const f = fixture()
  const current = [...f.current, { type: "user", uuid: "unrelated", parentUuid: null, isSidechain: true,
    message: { role: "user", content: "different payload" }, forkedFrom: { sessionId: "parent", messageUuid: "question" } }]
  const projection = projectNavigationHistory(current, f.selected, new Map([["parent", f.parents]]))
  expect(projection.records.find((record) => record.uuid === "child:answer")?.parentUuid).toBe("child:question")
})

test("unverified competing aliases request source evidence before reporting ambiguity", () => {
  const f = fixture()
  const current = [...f.current, { type: "user", uuid: "unrelated", parentUuid: null,
    message: { role: "user", content: "different payload" }, forkedFrom: { sessionId: "parent", messageUuid: "question" } }]
  const missing = new RecordEvidence(current)
  let failure: unknown
  try { missing.resolveReference(missing.current.effective.get("child:boundary")!, "question") } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(NavigationHistoryError)
  expect((failure as NavigationHistoryError).kind).toBe("missing-preservation-source")
  const available = new RecordEvidence(current, new Map([["parent", f.parents]]))
  expect(available.resolveReference(available.current.effective.get("child:boundary")!, "question")).toBe("child:question")
})

test("an absent copied message is not treated as a root or an SDK-omitted progress record", () => {
  const f = fixture()
  const current = f.current.filter((record) => record.uuid !== "child:question")
  expect(() => projectNavigationHistory(current, f.selected, new Map([["parent", f.parents]])))
    .toThrow("has no evidenced copy in the current transcript")
})

test("an explicitly evidenced ancestor root remains a root", () => {
  const f = fixture()
  const parents = f.parents.map((record) => record.uuid === "answer" ? { ...record, parentUuid: null } : record)
  const projection = projectNavigationHistory(f.current, f.selected, new Map([["parent", parents]]))
  expect(projection.records.find((record) => record.uuid === "child:answer")?.parentUuid).toBeNull()
})

test("SDK-omitted progress ancestry is traversed iteratively", () => {
  const f = fixture()
  const progress: SessionStoreEntry[] = Array.from({ length: 15_000 }, (_, index) => ({
    type: "progress", uuid: `p${index}`, parentUuid: index === 0 ? "question" : `p${index - 1}`, data: { type: "fixture" },
  }))
  const parents = [...f.parents.map((record) => record.uuid === "answer" ? { ...record, parentUuid: "p14999" } : record), ...progress]
  const projection = projectNavigationHistory(f.current, f.selected, new Map([["parent", parents]]))
  expect(projection.records.find((record) => record.uuid === "child:answer")?.parentUuid).toBe("child:question")
})

test("omitted-progress cycles remain errors", () => {
  const f = fixture()
  const parents = [...f.parents.map((record) => record.uuid === "answer" ? { ...record, parentUuid: "p" } : record),
    { type: "progress", uuid: "p", parentUuid: "p", data: { type: "fixture" } }]
  expect(() => projectNavigationHistory(f.current, f.selected, new Map([["parent", parents]]))).toThrow("cyclic omitted-progress ancestry")
})

test("an omitted progress payload update cannot select one of conflicting parent edges", () => {
  const f = fixture()
  const other = { type: "user", uuid: "other", parentUuid: null, message: { role: "user", content: "other" } }
  const parents = [...f.parents.map((record) => record.uuid === "answer" ? { ...record, parentUuid: "p" } : record), other,
    { type: "progress", uuid: "p", parentUuid: "question", data: { stage: "earlier" } },
    { type: "progress", uuid: "p", parentUuid: "other", data: { stage: "later" } },
  ]
  const current = [...f.current, ...copy([other], "parent", "child")]
  expect(() => projectNavigationHistory(current, f.selected, new Map([["parent", parents]]))).toThrow("multiple conflicting historical parents")
})

test("matching content does not excuse conflicting ancestral parent versions", () => {
  const f = fixture()
  const other = { type: "user", uuid: "other", parentUuid: null, message: { role: "user", content: "other" } }
  const parents = [...f.parents, other, { ...f.parents[1]!, parentUuid: "other" }]
  const current = [...f.current, ...copy([other], "parent", "child")]
  expect(() => projectNavigationHistory(current, f.selected, new Map([["parent", parents]]))).toThrow("multiple conflicting historical parents")
})

test("ancestor context parents are excluded even when that old summary was not copied", () => {
  const f = fixture()
  const parents = [...f.parents,
    { type: "system", subtype: "compact_boundary", uuid: "old-boundary", parentUuid: null,
      compactMetadata: { preservedMessages: { uuids: ["answer"], anchorUuid: "old-summary" } } },
    { type: "user", uuid: "old-summary", parentUuid: "old-boundary", isCompactSummary: true, message: { role: "user", content: "old summary" } },
    { ...f.parents[1]!, parentUuid: "old-summary" },
  ]
  const projection = projectNavigationHistory(f.current, f.selected, new Map([["parent", parents]]))
  expect(projection.records.find((record) => record.uuid === "child:answer")?.parentUuid).toBe("child:question")
})

test("cycles in source-session lineage fail without synthesizing an original parent", () => {
  const f = fixture()
  const parents = f.parents.map((record) => record.uuid === "answer" ? { ...record, parentUuid: "summary",
    forkedFrom: { sessionId: "parent", messageUuid: "answer" } } : record)
  expect(() => projectNavigationHistory(f.current, f.selected, new Map([["parent", parents]]))).toThrow("cyclic copy lineage")
})

test("conflicting copy origins cannot supply an otherwise convenient local parent", () => {
  const f = fixture()
  const older = { ...f.current.find((record) => record.uuid === "child:answer")!, parentUuid: "child:question",
    forkedFrom: { sessionId: "different-source", messageUuid: "different-answer" } }
  const current = [older, ...f.current.map((record) => record.uuid === "child:boundary" ? {
    ...record, compactMetadata: { preservedMessages: { uuids: ["child:answer", "child:attachment"], anchorUuid: "child:summary" } },
  } : record)]
  expect(() => projectNavigationHistory(current, f.selected)).toThrow("conflicting copy origins")
})

test("ancestor acquisition shares the read deadline and never retries a provider mutation", async () => {
  const f = fixture()
  const childId = crypto.randomUUID(), parentId = crypto.randomUUID()
  const entries = f.current.map((record) => ({ ...record, sessionId: childId,
    ...(record.forkedFrom ? { forkedFrom: { ...(record.forkedFrom as object), sessionId: parentId } } : {}),
  }))
  const started = Deferred.makeUnsafe<void>()
  let parentReads = 0
  let mutations = 0
  const provider = new ClaudeProvider(process.cwd(), { sdk: {
    listSessions: async () => [],
    getSessionInfo: async (id) => ({ sessionId: id, summary: "fixture", lastModified: 1 }),
    getSessionMessages: (id, options) => getSessionMessages(id, { ...options, sessionStore: {
      load: async () => entries,
      append: async () => { throw new Error("Read-only fixture") },
    } }),
    forkSession: async () => { mutations++; throw new Error("Unexpected mutation") },
    importSessionToStore: async (id, store, options) => {
      if (id === childId) return store.append({ projectKey: "fixture", sessionId: id }, entries)
      expect(id).toBe(parentId)
      expect(options.dir).toBeUndefined()
      parentReads++
      Deferred.doneUnsafe(started, Effect.void)
      await new Promise<void>(() => {})
    },
  } }, { operationTimeoutMs: 50, transcriptReadTimeoutMs: 50, provenanceImportTimeoutMs: 50 })
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(provider.readTranscripts([childId]))
    yield* Deferred.await(started)
    yield* TestClock.adjust(50)
    const result = (yield* Fiber.join(fiber)).get(childId)
    expect(result?._tag).toBe("Unavailable")
    if (result?._tag !== "Unavailable") throw new Error("Expected a bounded ancestor-read failure")
    expect(result.reason).toContain("requires source session")
    expect(result.reason).toContain("timed out")
    expect(parentReads).toBe(1)
    expect(mutations).toBe(0)
  }).pipe(Effect.provide(TestClock.layer()))))
})
