import { expect, test } from "bun:test"
import { reconcileTranscript } from "../../src/application/history-reconciliation"
import type { AgentMessage, TranscriptRead } from "../../src/domain/model"

function message(id: string, ordinal: number): AgentMessage {
  return { id, ordinal, role: ordinal % 2 === 0 ? "user" : "agent", preview: id, visible: true }
}

const retained = Array.from({ length: 1_000 }, (_, index) => message(`old-${index}`, index))
const previous: TranscriptRead = { _tag: "Available", messages: retained }
const anchor = { targetMessageId: retained[500]!.id, submitted: true }
const prefix = retained.slice(0, 500)

test.each([500, 750, 999])("anchored rewind rejects discarded identity %s anywhere in the incoming suffix", (index) => {
  const incoming: TranscriptRead = { _tag: "Available", messages: [
    ...prefix, message("replacement", 500), { ...retained[index]!, ordinal: 501 },
  ] }
  const result = reconcileTranscript(previous, incoming, false, anchor, undefined, undefined, undefined)
  expect(result.accepted).toBeFalse()
  expect(result.read).toBe(previous)
  expect(result.clearAnchor).toBeUndefined()
})

test("anchored rewind accepts a replacement retaining only the unchanged prefix", () => {
  const incoming: TranscriptRead = { _tag: "Available", messages: [...prefix, message("replacement", 500)] }
  const result = reconcileTranscript(previous, incoming, false, anchor, undefined, undefined, undefined)
  expect(result.accepted).toBeTrue()
  expect(result.read).toBe(incoming)
  expect(result.clearAnchor).toBeTrue()
})

test("anchored rewind rejects changes to retained messages even with wholly new suffix identities", () => {
  const incoming: TranscriptRead = { _tag: "Available", messages: [
    ...prefix.map((entry, index) => index === 250 ? { ...entry, preview: "changed" } : entry), message("replacement", 500),
  ] }
  const result = reconcileTranscript(previous, incoming, false, anchor, undefined, undefined, undefined)
  expect(result.accepted).toBeFalse()
  expect(result.read).toBe(previous)
})
