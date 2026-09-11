import { expect, test } from "bun:test"
import {
  forkSession, getSessionMessages, InMemorySessionStore, type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"

import { ClaudeProvider } from "../../src/infrastructure/providers/claude/provider"
import { NavigationHistoryError, projectNavigationHistory } from "../../src/infrastructure/providers/claude/navigation-history"

const boundary = (uuid: string, logicalParentUuid: string): SessionStoreEntry => ({
  type: "system", subtype: "compact_boundary", uuid, parentUuid: null, logicalParentUuid, compactMetadata: {},
})
const record = (uuid: string, parentUuid: string | null): SessionStoreEntry => ({ type: "user", uuid, parentUuid })

test("logical ancestry permits forward references and uses the SDK's effective UUID records", () => {
  const old = record("answer", "discarded-parent")
  const effective = record("answer", "question")
  const compact = boundary("compact", "answer")
  const entries = Object.freeze([
    record("question", null), old, compact, record("summary", "compact"), effective,
    { type: "custom-title", uuid: "answer" }, record("current", "summary"),
  ])
  const projection = projectNavigationHistory(entries, ["current"])
  expect(projection.changed).toBeTrue()
  expect(projection.sourceRecords.filter((entry) => entry.uuid === "answer")).toEqual([effective])
  expect(projection.records.find((entry) => entry.uuid === "compact")).toEqual({
    ...compact, parentUuid: "answer", compactMetadata: undefined,
  })
  expect(compact.parentUuid).toBeNull()
  expect(compact.compactMetadata).toEqual({})
  expect(projection.records.find((entry) => entry.uuid === "answer")).toBe(effective)
})

test("obsolete versions and unrelated broken boundaries cannot invalidate current history", () => {
  const missing = boundary("abandoned", "missing")
  const cycleA = boundary("cycle-a", "cycle-b")
  const cycleB = boundary("cycle-b", "cycle-a")
  const entries = [missing, cycleA, cycleB, boundary("compact", "missing-old-parent"),
    record("question", null), boundary("compact", "question"), record("current", "compact")]
  const projection = projectNavigationHistory(entries, ["current"])
  expect(projection.records.find((entry) => entry.uuid === "abandoned")).toBe(missing)
  expect(projection.records.find((entry) => entry.uuid === "cycle-a")).toBe(cycleA)
  expect(projection.records.find((entry) => entry.uuid === "cycle-b")).toBe(cycleB)
  expect(projection.records.filter((entry) => entry.uuid === "compact")).toHaveLength(1)
  expect(projection.records.find((entry) => entry.uuid === "compact")?.parentUuid).toBe("question")
})

test("a required missing logical parent identifies the boundary and parent", () => {
  expect(() => projectNavigationHistory([boundary("compact", "missing"), record("current", "compact")], ["current"]))
    .toThrow("Compaction boundary compact references missing logical parent missing")
})

test.each([
  [boundary("compact", "compact"), record("current", "compact")],
  [record("older", "compact"), boundary("compact", "older"), record("current", "compact")],
  [record("older", "bridge"), { type: "progress", uuid: "bridge", parentUuid: "compact" },
    boundary("compact", "older"), record("current", "compact")],
].map((entries) => ({ entries })))("real cycles are rejected regardless of physical ordering", ({ entries }) => {
  let failure: unknown
  try { projectNavigationHistory(entries, ["current"]) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(NavigationHistoryError)
  const error = failure as NavigationHistoryError
  expect(error.kind).toBe("cycle")
  expect(error.recordId).toBe("compact")
  expect(error.message).toContain("cyclic navigation ancestry")
  expect(error.message).toContain("compact")
})

test("ordinary truncated prefixes keep the SDK boundary; absent selected records report an inconsistent read", () => {
  const entries = [record("question", "omitted-prefix"), boundary("compact", "question"), record("current", "compact")]
  expect(projectNavigationHistory(entries, ["current"]).changed).toBeTrue()
  expect(() => projectNavigationHistory(entries, ["not-imported"]))
    .toThrow("SDK-selected record not-imported is missing from the imported transcript")
})

test("deep history validation is iterative and shared ancestors are visited once", () => {
  let parentReads = 0
  const entries: SessionStoreEntry[] = Array.from({ length: 30_000 }, (_, index) => ({
    type: "user", uuid: `m${index}`,
    get parentUuid() { parentReads++; return index ? `m${index - 1}` : null },
  }))
  entries.push(boundary("compact", "m29999"), record("current", "compact"))
  const projection = projectNavigationHistory(entries, ["current", ...entries.map((entry) => entry.uuid as string)])
  expect(projection.records).toHaveLength(entries.length)
  expect(projection.changed).toBeTrue()
  expect(parentReads).toBeGreaterThan(0)
  expect(parentReads).toBeLessThanOrEqual(entries.length * 2)
})

function fixture() {
  const sessionId = crypto.randomUUID()
  const ids = Array.from({ length: 8 }, () => crypto.randomUUID())
  const entry = (uuid: string, parentUuid: string | null, role: "user" | "assistant", text: string): SessionStoreEntry => ({
    type: role, uuid, parentUuid, sessionId, timestamp: "2026-09-11T00:00:00.000Z",
    message: role === "user" ? { role, content: text } : {
      id: `msg_${uuid}`, role, content: [{ type: "text", text }], stop_reason: "end_turn",
    },
  })
  const question = entry(ids[0]!, null, "user", "old question")
  const answer = entry(ids[1]!, ids[0]!, "assistant", "old answer")
  const compact = { ...boundary(ids[2]!, ids[1]!), sessionId }
  const summary = { ...entry(ids[3]!, ids[2]!, "user", "summary"), isCompactSummary: true }
  const current = entry(ids[4]!, ids[3]!, "user", "current question")
  const response = entry(ids[5]!, ids[4]!, "assistant", "current answer")
  return { sessionId, ids, entry, question, answer, compact, summary, current, response }
}

async function providerFor(sessionId: string, entries: readonly SessionStoreEntry[], activeEntries = entries) {
  const store = new InMemorySessionStore()
  const activeStore = activeEntries === entries ? store : new InMemorySessionStore()
  const projectKey = process.cwd().replaceAll("/", "-")
  await store.append({ projectKey, sessionId }, [...entries])
  if (activeStore !== store) await activeStore.append({ projectKey, sessionId }, [...activeEntries])
  let forks = 0
  const provider = new ClaudeProvider(process.cwd(), { resolveExecutable: () => "/usr/bin/claude", sdk: {
    listSessions: async () => [],
    getSessionInfo: async (id) => ({ sessionId: id, summary: "fixture", lastModified: 1 }),
    getSessionMessages: (id, options) => getSessionMessages(id, { ...options,
      sessionStore: id === sessionId ? activeStore : store }),
    importSessionToStore: async (id, destination) => {
      await destination.append({ projectKey, sessionId: id }, store.getEntries({ projectKey, sessionId: id }))
    },
    forkSession: async (id, options) => {
      forks++
      return forkSession(id, { ...options, sessionStore: store })
    },
  } }, { forkValidationRetryDelaysMs: [] })
  return { provider, forks: () => forks }
}

test.each(["forward", "repeated"])("SDK navigation accepts %s parent records and preserves the logical message order", async (kind) => {
  const f = fixture()
  const entries = kind === "forward"
    ? [f.question, f.compact, f.summary, f.answer, f.current, f.response]
    : [f.question, f.answer, f.compact, f.summary, { ...f.answer }, f.current, f.response]
  const { provider } = await providerFor(f.sessionId, entries)
  const read = (await Effect.runPromise(provider.readTranscripts([f.sessionId]))).get(f.sessionId)
  expect(read?._tag).toBe("Available")
  if (read?._tag !== "Available") throw new Error(JSON.stringify(read))
  expect(read.messages.filter((message) => message.visible).map((message) => message.preview)).toEqual([
    "old question", "old answer", "current question", "current answer",
  ])
  expect(read.messages.filter((message) => message.historical).map((message) => message.id)).toEqual(f.ids.slice(0, 2))
})

test("an abandoned broken compaction does not block the SDK-selected replacement conversation", async () => {
  const f = fixture()
  const { provider } = await providerFor(f.sessionId, [
    { ...f.compact, logicalParentUuid: f.ids[6] }, f.summary, { ...f.current, parentUuid: null }, f.response,
  ])
  const read = (await Effect.runPromise(provider.readTranscripts([f.sessionId]))).get(f.sessionId)
  if (read?._tag !== "Available") throw new Error(JSON.stringify(read))
  expect(read.messages.map((message) => message.preview)).toEqual(["current question", "current answer"])
  const branch = await Effect.runPromise(provider.branchFrom({ sessionId: f.sessionId, messageId: f.ids[5]! }))
  expect(branch._tag).toBe("ValidatedBranch")
  if (branch._tag !== "ValidatedBranch") throw new Error(branch.reason)
  expect(branch.derivation.sharedMessages.map((pair) => pair.parentMessageId)).toEqual([f.ids[4]!, f.ids[5]!])
})

test("SDK system evidence recovers compacted history when the active user/agent context is empty", async () => {
  const f = fixture()
  const metaSummary = { ...f.summary, isMeta: true }
  // Model the filesystem reader's postcompaction context while importing all history.
  const { provider } = await providerFor(f.sessionId, [f.question, f.answer, f.compact, metaSummary], [f.compact, metaSummary])
  const read = (await Effect.runPromise(provider.readTranscripts([f.sessionId]))).get(f.sessionId)
  if (read?._tag !== "Available") throw new Error(JSON.stringify(read))
  expect(read.messages.map((message) => message.preview)).toEqual(["old question", "old answer"])
  expect(read.messages.every((message) => message.historical)).toBeTrue()
})

test("empty active context still rejects a missing parent required by its SDK system anchor", async () => {
  const f = fixture()
  const metaSummary = { ...f.summary, isMeta: true }
  const { provider } = await providerFor(f.sessionId, [f.compact, metaSummary])
  const read = (await Effect.runPromise(provider.readTranscripts([f.sessionId]))).get(f.sessionId)
  expect(read?._tag).toBe("Unavailable")
  if (read?._tag !== "Unavailable") throw new Error("Expected a missing required parent")
  expect(read.reason).toContain(f.ids[2]!)
  expect(read.reason).toContain(f.ids[1]!)
})

test("an SDK-empty conversation cannot resurrect unrelated imported history", async () => {
  const f = fixture()
  const { provider } = await providerFor(f.sessionId, [f.question, { ...f.compact, logicalParentUuid: f.ids[6] }, f.summary], [])
  const read = (await Effect.runPromise(provider.readTranscripts([f.sessionId]))).get(f.sessionId)
  expect(read).toEqual({ _tag: "Available", messages: [] })
})

test("historical streamed blocks and tool results remain available to SDK reconstruction", async () => {
  const f = fixture()
  const firstPart = f.entry(f.ids[6]!, f.ids[0]!, "assistant", "first block")
  const sharedApiId = "msg_shared_response"
  firstPart.message = { ...(firstPart.message as object), id: sharedApiId }
  const answer = { ...f.answer, message: { ...(f.answer.message as object), id: sharedApiId } }
  const tool = { ...f.entry(f.ids[7]!, f.ids[6]!, "user", ""), message: {
    role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "tool output" }],
  } }
  const { provider } = await providerFor(f.sessionId, [f.question, firstPart, tool, f.compact, f.summary, answer, f.current, f.response])
  const read = (await Effect.runPromise(provider.readTranscripts([f.sessionId]))).get(f.sessionId)
  if (read?._tag !== "Available") throw new Error(JSON.stringify(read))
  expect(read.messages.find((message) => message.id === f.ids[6])).toMatchObject({ preview: "first block", historical: true })
  expect(read.messages.find((message) => message.id === f.ids[7])).toMatchObject({ visible: false, historical: true })
})

test("logical rewiring must not switch the SDK-selected conversation to a detached newer leaf", async () => {
  const f = fixture()
  const detached = f.entry(f.ids[6]!, f.ids[0]!, "assistant", "context-only parent")
  const { provider } = await providerFor(f.sessionId, [f.question, f.answer,
    { ...f.compact, parentUuid: f.ids[6] }, f.summary, f.current, f.response, detached])
  const read = (await Effect.runPromise(provider.readTranscripts([f.sessionId]))).get(f.sessionId)
  expect(read?._tag).toBe("Unavailable")
  if (read?._tag !== "Unavailable") throw new Error("Expected a selection mismatch")
  expect(read.reason).toContain(`does not preserve SDK-selected system record ${f.ids[2]}`)
})

test.each(["missing", "cycle"])("required %s ancestry reports a precise read error and prevents a fork mutation", async (kind) => {
  const f = fixture()
  const entries = kind === "missing"
    ? [f.question, { ...f.compact, logicalParentUuid: f.ids[6] }, f.summary, f.current, f.response]
    : [f.question, { ...f.answer, parentUuid: f.ids[2] }, f.compact, f.summary, f.current, f.response]
  const { provider, forks } = await providerFor(f.sessionId, entries)
  const read = (await Effect.runPromise(provider.readTranscripts([f.sessionId]))).get(f.sessionId)
  expect(read?._tag).toBe("Unavailable")
  if (read?._tag !== "Unavailable") throw new Error("Expected an ancestry error")
  expect(read.reason).toContain(f.ids[2]!)
  expect(read.reason).toContain(kind === "missing" ? f.ids[6]! : "cyclic navigation ancestry")
  const error = await Effect.runPromise(Effect.flip(provider.branchFrom({ sessionId: f.sessionId, messageId: f.ids[5]! })))
  expect(error.message).toContain(f.ids[2]!)
  expect(forks()).toBe(0)
})

test("SDK-created forks preserve forward compaction links and validated shared history", async () => {
  const f = fixture()
  const { provider, forks } = await providerFor(f.sessionId, [f.question, f.compact, f.summary, f.answer, f.current, f.response])
  const branch = await Effect.runPromise(provider.branchFrom({ sessionId: f.sessionId, messageId: f.ids[5]! }))
  expect(branch._tag).toBe("ValidatedBranch")
  if (branch._tag !== "ValidatedBranch") throw new Error(branch.reason)
  expect(branch.derivation.sharedMessages.map((pair) => pair.parentMessageId)).toEqual([
    f.ids[0]!, f.ids[1]!, f.ids[3]!, f.ids[4]!, f.ids[5]!,
  ])
  const read = (await Effect.runPromise(provider.readTranscripts([branch.session.id]))).get(branch.session.id)
  expect(read?._tag).toBe("Available")
  expect(forks()).toBe(1)
})
