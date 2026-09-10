import { expect, test } from "bun:test"

import { makeInitialApplicationState, available, type ApplicationState } from "../../src/application/state"
import { selectConversationForest } from "../../src/application/selectors"
import { reduceApplicationState } from "../../src/application/reducer"
import { projectGraphViewModel, type GraphNodeViewModel } from "../../src/application/view-model"
import type { AgentMessage } from "../../src/domain/model"
import { renderGraph } from "../../src/presentation/render"

function history(turns: number, blocks: number): AgentMessage[] {
  return Array.from({ length: turns }, (_, turn) => [
    { id: `u${turn}`, role: "user" as const, preview: `Question ${turn}`, ordinal: turn * (blocks + 1), visible: true },
    ...Array.from({ length: blocks }, (_, block) => ({
      id: `a${turn}-${block}`, role: "agent" as const, preview: `Answer ${turn}`, ordinal: turn * (blocks + 1) + block + 1,
      displayGroupId: `u${turn}`, visible: true, copyIdentity: JSON.stringify({ text: "payload ".repeat(128), block }),
    })),
  ]).flat()
}

function fixture(): ApplicationState {
  const session = { id: "root", title: "Root", lastModified: 1 }
  const unrelated = { ...session, id: "unrelated" }
  const initial = makeInitialApplicationState()
  return { ...initial, provider: {
    sessions: new Map([[session.id, session], [unrelated.id, unrelated]]),
    transcripts: new Map([[session.id, available(history(150, 50))], [unrelated.id, available(history(3, 1))]]),
  }, refresh: { ...initial.refresh, initialPending: false } }
}

test("hundreds of grouped Claude-like nodes reuse geometry across cursor movement and forests across activity", () => {
  const state = fixture()
  const forest = selectConversationForest(state)
  const first = projectGraphViewModel(state, "root")
  expect(first.nodes).toHaveLength(300)
  for (let index = 0; index < 150; index++) {
    const next = projectGraphViewModel(state, "root", {
      kind: "message", preferred: { sessionId: "root", messageId: `u${index}` }, aliases: [],
    })
    expect(next.unselectedNodes).toBe(first.unselectedNodes)
    expect(next.nodes.filter((node) => node.selected)).toHaveLength(1)
  }
  const live = { ...state, terminals: new Map([["root", { phase: "running" as const, activity: "working" as const }]]) }
  const liveForest = selectConversationForest(live)
  const idle = { ...live, terminals: new Map([["root", { phase: "running" as const, activity: "idle" as const }]]) }
  expect(selectConversationForest(idle)).toBe(liveForest)
  const changed = { ...state, provider: { ...state.provider, transcripts: new Map(state.provider.transcripts).set("root", available(history(151, 50))) } }
  const updated = selectConversationForest(changed)
  expect(updated.graphBySessionId.get("unrelated")).toBe(forest.graphBySessionId.get("unrelated"))
  expect(updated.graphBySessionId.get("root")).not.toBe(forest.graphBySessionId.get("root"))
})

test("viewport rendering never reads off-screen message content, including on animation frames", () => {
  const view = projectGraphViewModel(fixture(), "root")
  let contentReads = 0
  const nodes = view.nodes.map((node): GraphNodeViewModel => node._tag !== "Message" ? node : {
    ...node,
    get preview() {
      if (node.y >= 20) throw new Error("Rendered off-screen content")
      contentReads++
      return node.preview
    },
  })
  const graph = { ...view, nodes, unselectedNodes: nodes }
  for (let frame = 0; frame < 4; frame++) {
    const rendered = renderGraph(graph, 80, 20, frame, { x: 0, y: 0 })
    expect(rendered.text).toContain("Question 0")
  }
  expect(contentReads).toBe(20)
})

test("connectors crossing the viewport remain visible when both nodes are off-screen", () => {
  const node = projectGraphViewModel(fixture(), "root").nodes[0]!
  const parent = { ...node, id: "parent", x: 0, y: 0, width: 22, height: 2, childIds: ["child"], parentIds: [] }
  const child = { ...node, id: "child", x: 1_000_000, y: 4, width: 22, height: 2, childIds: [], parentIds: ["parent"] }
  const rendered = renderGraph({ _tag: "Graph", familySessionId: "root", title: "Wide", nodes: [parent, child],
    selectedNodeId: "parent", worldWidth: 1_000_022, worldHeight: 6, status: "idle", warnings: [],
  }, 50, 3, 0, { x: 500_000, y: 2 })
  expect(rendered.text.split("\n")[0]).toBe("─".repeat(50))
})

test("progress preserves catalogue selection and a late initial snapshot cannot replace a newer family read", () => {
  const complete = fixture()
  const snapshot = { sessions: [...complete.provider.sessions.values()], transcripts: complete.provider.transcripts }
  let state = reduceApplicationState(makeInitialApplicationState(), { _tag: "RefreshStarted", refresh: {
    key: "initial", generation: 1, reason: "initial", mode: "full", sessionIds: new Set(),
  } })
  state = reduceApplicationState(state, { _tag: "RefreshProgress", key: "initial", generation: 1,
    snapshot: { ...snapshot, transcripts: new Map() } })
  state = reduceApplicationState(state, { _tag: "Navigated", surface: { _tag: "Roots", selectedSessionId: "unrelated" } })
  state = reduceApplicationState(state, { _tag: "RefreshProgress", key: "initial", generation: 1,
    snapshot: { sessions: [], transcripts: new Map([["root", complete.provider.transcripts.get("root")!]]) } })
  expect(state.surface).toEqual({ _tag: "Roots", selectedSessionId: "unrelated" })
  expect(state.refresh.initialPending).toBeTrue()
  state = reduceApplicationState(state, { _tag: "RefreshStarted", refresh: {
    key: "targeted", generation: 2, reason: "terminal-return", mode: "incremental", sessionIds: new Set(["root"]),
  } })
  const newer = available(history(151, 50))
  state = reduceApplicationState(state, { _tag: "RefreshSucceeded", key: "targeted", generation: 2,
    snapshot: { sessions: [], transcripts: new Map([["root", newer]]) } })
  state = reduceApplicationState(state, { _tag: "RefreshSucceeded", key: "initial", generation: 1, snapshot })
  expect(state.provider.transcripts.get("root")).toBe(newer)
  expect(state.provider.transcripts.get("unrelated")).toEqual(snapshot.transcripts.get("unrelated"))
  expect(state.refresh.initialPending).toBeFalse()
  expect(state.refresh.active.size).toBe(0)
})
