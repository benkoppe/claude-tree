import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import type { GraphNodeViewModel, RootViewModel } from "../../src/application/view-model"
import { ContentSearchIndex } from "../../src/infrastructure/search/index"
import { SearchClient } from "../../src/infrastructure/search/client"
import { cursorRelativeHit, retainedSearchNodeId, retainedSearchRootId, searchDocuments } from "../../src/presentation/search"

test("search indexes full content and preserves literal punctuation, all-term matching, and tree order", () => {
  const index = new ContentSearchIndex()
  try {
    index.replace([
      { id: "first", text: "intro ".repeat(10_000) + "foo.bar worker C++ 🌲" },
      { id: "second", text: "worker foo bar C" },
      { id: "third", text: "foo.bar worker" },
    ])
    expect(index.search("foo.bar worker").hits).toEqual(["first", "third"])
    expect(index.search("WORKER foo.bar", "first").excerpt).toContain("foo.bar")
    expect(index.search("++").hits).toEqual(["first"])
    expect(index.search("🌲").hits).toEqual(["first"])
    expect(index.search('" OR worker').hits).toEqual([])
    expect(index.search("  ").hits).toEqual([])
    index.replace([{ id: "replacement", text: "new history" }])
    expect(index.search("worker").hits).toEqual([])
    expect(index.search("history").hits).toEqual(["replacement"])
  } finally { index.close() }
})

test("cursor-relative selection starts at a matching cursor and wraps only past the last match", () => {
  const documents = ["a", "b", "c", "d"].map((id) => ({ id, text: id }))
  expect(cursorRelativeHit(["a", "c"], documents, "c")).toBe(1)
  expect(cursorRelativeHit(["a", "c"], documents, "b")).toBe(1)
  expect(cursorRelativeHit(["a", "c"], documents, "d")).toBe(0)
  expect(cursorRelativeHit([], documents, "b")).toBe(0)
})

test("root corpus contains only catalogue titles", () => {
  expect(searchDocuments({ _tag: "Roots", selectedSessionId: null, roots: [] })).toEqual([])
  expect(searchDocuments({ _tag: "Terminal", sessionId: "private", title: "private", status: "idle", draft: undefined })).toEqual([])
})

test("root search retains family identity through surviving members but never guesses from equal titles", () => {
  const root = (sessionId: string, members: string[]): RootViewModel => ({ sessionId, memberSessionIds: members,
    title: "same title", lastModified: 0, messageCount: 0, status: "idle", history: { _tag: "Ready" }, activation: "open" })
  const old = root("old", ["old", "child", "other-child"])
  expect(retainedSearchRootId([old], [root("new", ["new", "child"])], "old")).toBe("new")
  expect(retainedSearchRootId([old], [root("parent", ["parent", "old"])], "old")).toBe("parent")
  expect(retainedSearchRootId([old], [root("unrelated", ["unrelated"])], "old")).toBeNull()
  expect(retainedSearchRootId([old], [root("one", ["child"]), root("two", ["other-child"])], "old")).toBeNull()
})

test("search worker coalesces bursts without losing an unsent corpus replacement and closes idempotently", async () => {
  const client = new SearchClient()
  try {
    const first = client.request({ id: 1, documents: [{ id: "old", text: "old" }], query: "old" })
    const second = client.request({ id: 2, documents: [{ id: "new", text: "new needle" }], query: "new" })
    const latest = client.request({ id: 3, query: "needle" })
    await Promise.all([first, second])
    expect((await latest).hits).toEqual(["new"])
    expect((await client.request({ id: 4, query: "old" })).hits).toEqual([])
  } finally { await client.close() }
  await client.close()
  await expect(client.request({ id: 5, query: "new" })).rejects.toThrow("closed")
})

test("search order follows graph edges rather than layout or node-array order, and preserves validated aliases", () => {
  const message = (id: string, parentIds: string[], childIds: string[], aliases = [{ sessionId: "root", messageId: id }]): GraphNodeViewModel => ({
    _tag: "Message", id, parentIds, childIds, x: 0, y: 0, width: 30, height: 2, selected: false,
    reachableEndpoints: [], target: { kind: "message", preferred: aliases[0]!, aliases }, aliases,
    role: "agent", preview: "short", text: "same full content",
  })
  const root = message("root", [], ["left", "right"])
  const left = message("left", ["root"], ["tail"])
  const right = message("right", ["root"], [])
  const tail = message("tail", ["left"], [])
  const nodes = [root, right, tail, left]
  const surface = { _tag: "Graph" as const, familySessionId: "root", title: "Tree", nodes, selectedNodeId: "root",
    status: "idle" as const, warnings: [], worldWidth: 100, worldHeight: 100 }
  expect(searchDocuments(surface).map((document) => document.id)).toEqual(["root", "left", "tail", "right"])
  const copied = message("copied", [], [], [{ sessionId: "root", messageId: "left" }, { sessionId: "child", messageId: "copied" }])
  expect(retainedSearchNodeId(nodes, [copied], "left")).toBe("copied")
  expect(retainedSearchNodeId(nodes, [copied], "right")).toBeNull()
})

class ControlledSearchWorker extends EventEmitter {
  terminated = 0
  postMessage() {}
  terminate() { this.terminated++; this.emit("exit", 0); return Promise.resolve(0) }
}

test.each(["failure", "close"] as const)("search worker settles active and queued callers on %s", async (mode) => {
  const worker = new ControlledSearchWorker()
  const client = new SearchClient(() => worker as unknown as Worker)
  const active = client.request({ id: 1, query: "one" }).catch((error) => error)
  const queued = client.request({ id: 2, query: "two" }).catch((error) => error)
  const failure = new Error("worker failed")
  if (mode === "failure") worker.emit("error", failure)
  else await client.close()
  expect(await active).toBeInstanceOf(Error)
  expect(await queued).toBeInstanceOf(Error)
  if (mode === "failure") expect(await active).toBe(failure)
  await client.close()
  await client.close()
  expect(worker.terminated).toBe(1)
})
