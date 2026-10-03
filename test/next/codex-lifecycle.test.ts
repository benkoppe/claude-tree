import { expect, test } from "bun:test"
import { CodexLifecycleObserver } from "../../src/infrastructure/providers/codex/lifecycle"

const frame = (method: string, params: unknown) => JSON.stringify({ method, params })
const turn = (id: string, status: string, threadId = "root") => ({ threadId, turn: { id, status } })

test("native Codex lifecycle preserves root completion, blocked state, and duplicate ordering", () => {
  const observer = new CodexLifecycleObserver()
  const replay = (method: string, params: unknown) => observer.observe(frame(method, params), "root")
  expect(replay("turn/started", turn("one", "inProgress")).map((event) => event._tag)).toEqual(["Observation", "Activity"])
  expect(replay("turn/started", turn("one", "inProgress"))).toEqual([])
  expect(replay("thread/status/changed", { threadId: "root", status: { type: "active", activeFlags: ["waitingOnApproval"] } })).toEqual([
    { _tag: "Activity", sessionId: "root", activity: "blocked" },
  ])
  expect(replay("thread/status/changed", { threadId: "root", status: { type: "idle" } })).toEqual([])
  expect(replay("turn/completed", turn("child", "completed", "child"))).toEqual([])
  expect(replay("turn/started", turn("two", "inProgress"))).toHaveLength(2)
  expect(replay("turn/started", turn("one", "inProgress"))).toEqual([])
  expect(replay("turn/completed", turn("one", "completed"))).toEqual([])
  expect(replay("turn/completed", turn("two", "completed"))).toEqual([
    { _tag: "Activity", sessionId: "root", activity: "idle" },
  ])
  expect(replay("turn/completed", turn("two", "completed"))).toEqual([])
  expect(replay("turn/started", turn("two", "inProgress"))).toEqual([])
})

test("malformed, unknown, and incomplete terminal frames cannot mark idle", () => {
  const observer = new CodexLifecycleObserver()
  for (const text of ["invalid JSON", "null", frame("turn/completed", turn("one", "inProgress")),
    frame("turn/completed", turn("", "completed")), frame("turn/completed", turn("one", "future")),
    frame("turn/completed", { threadId: "root", turn: null }), frame("future/event", {})]) {
    expect(observer.observe(text, "root")).toEqual([])
  }
})

test("identity adoption resets turn correlation and ignores former-thread evidence", () => {
  const observer = new CodexLifecycleObserver()
  observer.observe(frame("turn/started", turn("one", "inProgress")), "root")
  expect(observer.observe(frame("turn/completed", turn("one", "completed")), "fork")).toEqual([])
  expect(observer.observe(frame("turn/started", turn("one", "inProgress", "fork")), "fork")).toHaveLength(2)
})

test("only the lifecycle contributor can release authority and reconnect does not resubmit", () => {
  const observer = new CodexLifecycleObserver()
  const primary = {}
  const ancillary = {}
  const reconnect = {}
  const started = frame("turn/started", turn("one", "inProgress"))
  expect(observer.observe(started, "root", primary)).toHaveLength(2)
  expect(observer.observe(frame("turn/completed", turn("one", "completed")), "root", ancillary)).toEqual([])
  expect(observer.disconnect(ancillary, "root")).toEqual([])
  expect(observer.disconnect(primary, "root")).toEqual([{ _tag: "Unavailable", sessionId: "root" }])
  expect(observer.observe(started, "root", reconnect)).toEqual([
    { _tag: "Activity", sessionId: "root", activity: "working" },
  ])
  expect(observer.disconnect(primary, "root")).toEqual([])
  expect(observer.observe(started, "root", reconnect)).toEqual([])
  expect(observer.observe(frame("turn/completed", turn("one", "completed")), "root", reconnect)).toEqual([
    { _tag: "Activity", sessionId: "root", activity: "idle" },
  ])
})

test("a reconnect can reassert blocked status without replaying turn start", () => {
  const observer = new CodexLifecycleObserver()
  const primary = {}
  observer.observe(frame("turn/started", turn("one", "inProgress")), "root", primary)
  observer.disconnect(primary, "root")
  const reconnect = {}
  expect(observer.observe(frame("thread/status/changed", {
    threadId: "root", status: { type: "active", activeFlags: ["waitingOnUserInput"] },
  }), "root", reconnect)).toEqual([{ _tag: "Activity", sessionId: "root", activity: "blocked" }])
  expect(observer.observe(frame("turn/started", turn("one", "inProgress")), "root", reconnect)).toEqual([])
})

test("reconnect status remains observable when the next turn start was missed", () => {
  const observer = new CodexLifecycleObserver()
  const primary = {}
  observer.observe(frame("turn/started", turn("one", "inProgress")), "root", primary)
  observer.observe(frame("turn/completed", turn("one", "completed")), "root", primary)
  observer.disconnect(primary, "root")
  const reconnect = {}
  for (const [flags, activity] of [[[], "working"], [["waitingOnApproval"], "blocked"]] as const) {
    expect(observer.observe(frame("thread/status/changed", {
      threadId: "root", status: { type: "active", activeFlags: flags },
    }), "root", reconnect)).toEqual([{ _tag: "Activity", sessionId: "root", activity }])
  }
  expect(observer.observe(frame("turn/completed", turn("two", "completed")), "root", reconnect)).toEqual([
    { _tag: "Activity", sessionId: "root", activity: "idle" },
  ])
  expect(observer.observe(frame("thread/status/changed", {
    threadId: "root", status: { type: "active", activeFlags: [] },
  }), "root", reconnect)).toEqual([])
})

test("disconnect drops stale active-turn correlation when reconnect misses a new start", () => {
  const observer = new CodexLifecycleObserver()
  const primary = {}
  const reconnect = {}
  observer.observe(frame("turn/started", turn("one", "inProgress")), "root", primary)
  observer.disconnect(primary, "root")
  expect(observer.observe(frame("thread/status/changed", {
    threadId: "root", status: { type: "active", activeFlags: [] },
  }), "root", reconnect)).toEqual([{ _tag: "Activity", sessionId: "root", activity: "working" }])
  expect(observer.observe(frame("turn/completed", turn("two", "completed")), "root", reconnect)).toEqual([
    { _tag: "Activity", sessionId: "root", activity: "idle" },
  ])
  expect(observer.observe(frame("turn/started", turn("two", "inProgress")), "root", reconnect)).toEqual([])
})

test("unsupported authoritative root payloads release authority without losing start deduplication", () => {
  for (const unsupported of [
    frame("turn/started", turn("one", "future")),
    frame("turn/completed", { threadId: "root", turn: null }),
    frame("thread/status/changed", { threadId: "root", status: { type: "active", activeFlags: ["futureFlag"] } }),
  ]) {
    const observer = new CodexLifecycleObserver()
    const primary = {}
    const reconnect = {}
    const started = frame("turn/started", turn("one", "inProgress"))
    observer.observe(started, "root", primary)
    expect(observer.observe(unsupported, "root", primary)).toEqual([{ _tag: "Unavailable", sessionId: "root" }])
    expect(observer.observe(unsupported, "root", primary)).toEqual([])
    expect(observer.observe(started, "root", reconnect)).toEqual([
      { _tag: "Activity", sessionId: "root", activity: "working" },
    ])
    expect(observer.observe(frame("turn/completed", turn("one", "completed")), "root", reconnect)).toEqual([
      { _tag: "Activity", sessionId: "root", activity: "idle" },
    ])
  }
})

test("malformed child, ancillary, uncorrelated, and unknown frames cannot release root authority", () => {
  const observer = new CodexLifecycleObserver()
  const primary = {}
  const ancillary = {}
  observer.observe(frame("turn/started", turn("one", "inProgress")), "root", primary)
  expect(observer.observe(frame("turn/completed", { threadId: "child", turn: null }), "root", primary)).toEqual([])
  expect(observer.observe(frame("turn/completed", { threadId: "root", turn: null }), "root", ancillary)).toEqual([])
  expect(observer.observe(frame("turn/completed", { turn: null }), "root", primary)).toEqual([])
  expect(observer.observe(frame("future/event", { threadId: "root" }), "root", primary)).toEqual([])
  expect(observer.observe(frame("turn/completed", turn("one", "completed")), "root", primary)).toEqual([
    { _tag: "Activity", sessionId: "root", activity: "idle" },
  ])
})

test("identity changes reset retained start deduplication", () => {
  const observer = new CodexLifecycleObserver()
  const primary = {}
  observer.observe(frame("turn/started", turn("one", "inProgress")), "root", primary)
  observer.disconnect(primary, "root")
  expect(observer.observe(frame("turn/started", turn("one", "inProgress", "fork")), "fork", {})).toHaveLength(2)
})
