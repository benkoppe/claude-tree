import { describe, expect, test } from "bun:test"

import type { ConversationGraph, MessageGraphNodeOrEndpoint } from "../../src/domain/conversation-graph"
import {
  directionalMove,
  layoutConversationGraph,
  type ConversationGraphLayout,
  type GraphNavigationIntent,
} from "../../src/domain/graph-layout"

describe("preferred-row graph navigation", () => {
  test("visits the adjacent shorter leaf in the screenshot topology", () => {
    const tree = fixture()
    tree.message("shared", "origin")
    const left = tree.chain("left", "shared", 11)
    const middle = tree.chain("middle", "shared", 6)
    const right = tree.chain("right", "origin", 6)
    tree.endpoint("left-draft", left.at(-1)!)
    tree.endpoint("middle-draft", middle.at(-1)!)
    tree.endpoint("right-draft", right.at(-1)!)
    const layout = tree.layout()

    const first = directionalMove(layout, "left-draft", "right")!
    expect(first.nodeId).toBe("middle-draft")
    const second = directionalMove(layout, first.nodeId, "right", first.intent)!
    expect(second.nodeId).toBe("right-draft")
    const reverse = directionalMove(layout, second.nodeId, "left", second.intent)!
    expect(reverse.nodeId).toBe("middle-draft")
    expect(directionalMove(layout, reverse.nodeId, "left", reverse.intent)?.nodeId).toBe("left-draft")
  })

  test.each(["left", "right"] as const)("does not skip an extremely short branch moving %s", (direction) => {
    const tree = fixture()
    tree.message("shared", "origin")
    const left = tree.chain("left", "shared", 12)
    const middle = tree.chain("middle", "shared", 1)
    const right = tree.chain("right", "shared", 12)
    const selected = direction === "right" ? left.at(-1)! : right.at(-1)!
    expect(directionalMove(tree.layout(), selected, direction)?.nodeId).toBe(middle[0]!)
  })

  test("recovers the original depth after crossing short branches and preserves blocked intent", () => {
    const tree = fixture()
    const branches = [12, 7, 6, 14].map((length, index) => tree.chain(`branch-${index}`, "origin", length))
    const layout = tree.layout()
    let move = directionalMove(layout, branches[0]!.at(-1)!, "right")!
    const preferredCoordinate = move.intent.preferredCoordinate
    expect(move.nodeId).toBe(branches[1]!.at(-1)!)
    move = directionalMove(layout, move.nodeId, "right", move.intent)!
    expect(move.nodeId).toBe(branches[2]!.at(-1)!)
    move = directionalMove(layout, move.nodeId, "right", move.intent)!
    expect(move.nodeId).toBe(branches[3]![11]!)
    expect(move.intent.preferredCoordinate).toBe(preferredCoordinate)
    expect(directionalMove(layout, move.nodeId, "right", move.intent)).toBeUndefined()
    expect(directionalMove(layout, move.nodeId, "left", move.intent)?.nodeId).toBe(branches[2]!.at(-1)!)
  })

  test("uses historical messages and excludes both shared ancestors and later forks", () => {
    const tree = fixture()
    tree.message("shared", "origin")
    const left = tree.chain("left", "shared", 5)
    const middle = tree.chain("middle", "shared", 3)
    tree.chain("middle-left", middle.at(-1)!, 3)
    tree.chain("middle-right", middle.at(-1)!, 3)
    const right = tree.chain("right", "shared", 5)
    const layout = tree.layout()
    const first = directionalMove(layout, left[1]!, "right")!
    expect(first.nodeId).toBe(middle[1]!)
    expect(directionalMove(layout, first.nodeId, "right", first.intent)?.nodeId).toBe(right[1]!)
    expect(directionalMove(layout, "shared", "right")).toBeUndefined()
    expect(directionalMove(layout, "shared", "left")).toBeUndefined()
  })

  test("expands nested forks before the preferred depth into adjacent destinations", () => {
    const tree = fixture()
    const left = tree.chain("left", "origin", 6)
    tree.message("nested", "origin")
    const short = tree.chain("nested-short", "nested", 1)
    const deep = tree.chain("nested-deep", "nested", 7)
    const right = tree.chain("right", "origin", 6)
    const layout = tree.layout()
    const first = directionalMove(layout, left.at(-1)!, "right")!
    expect(first.nodeId).toBe(short[0]!)
    const second = directionalMove(layout, first.nodeId, "right", first.intent)!
    expect(second.nodeId).toBe(deep[4]!)
    expect(directionalMove(layout, second.nodeId, "right", second.intent)?.nodeId).toBe(right.at(-1)!)
  })

  test("a collapsed endpoint leaves its positioned parent as the shorter branch representative", () => {
    const tree = fixture()
    const left = tree.chain("left", "origin", 8)
    const middle = tree.chain("middle", "origin", 2)
    tree.endpoint("stopped", middle.at(-1)!)
    tree.chain("right", "origin", 8)
    const collapsed = layoutConversationGraph(tree.graph, 100)
    expect(collapsed.nodes.has("stopped")).toBeFalse()
    expect(tree.graph.nodes.get(middle.at(-1)!)!.childIds).toEqual(["stopped"])
    expect(directionalMove(collapsed, left.at(-1)!, "right")?.nodeId).toBe(middle.at(-1)!)
    expect(directionalMove(tree.layout(), left.at(-1)!, "right")?.nodeId).toBe("stopped")
  })

  test("axis changes, explicit selection, and absent or stale intent start a new preferred row", () => {
    const tree = fixture()
    const left = tree.chain("left", "origin", 8)
    const middle = tree.chain("middle", "origin", 3)
    const right = tree.chain("right", "origin", 8)
    const layout = tree.layout()
    const horizontal = directionalMove(layout, left.at(-1)!, "right")!
    const up = directionalMove(layout, horizontal.nodeId, "up", horizontal.intent)!
    expect(up.nodeId).toBe(middle[1]!)
    expect(directionalMove(layout, up.nodeId, "right", up.intent)?.nodeId).toBe(right[1]!)
    expect(directionalMove(layout, middle.at(-1)!, "right")?.nodeId).toBe(right[2]!)
    expect(directionalMove(layout, middle[0]!, "right", horizontal.intent)?.nodeId).toBe(right[0]!)
    const down = directionalMove(layout, up.nodeId, "down", up.intent)!
    expect(down.nodeId).toBe(middle.at(-1)!)
  })

  test("top-level roots navigate across chains without selecting the synthetic origin", () => {
    const tree = fixture()
    const left = tree.chain("left", "origin", 4)
    const right = tree.chain("right", "origin", 4)
    const layout = tree.layout()
    expect(layout.nodes.has("origin")).toBeFalse()
    expect(directionalMove(layout, left[0]!, "up")).toBeUndefined()
    expect(directionalMove(layout, left[0]!, "right")?.nodeId).toBe(right[0]!)
    expect(directionalMove(layout, right[0]!, "left")?.nodeId).toBe(left[0]!)
    expect(directionalMove(layout, "missing", "right")).toBeUndefined()
  })

  test("horizontal destinations remain adjacent and reversible across generated nested forests", () => {
    let seed = 12345
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    for (let sample = 0; sample < 25; sample++) {
      const tree = fixture()
      const queue: Array<{ id: string; depth: number }> = []
      for (let root = 0; root < 3; root++) {
        const id = `root-${root}`
        tree.message(id, "origin")
        queue.push({ id, depth: 0 })
      }
      for (let index = 0; index < queue.length && queue.length < 100; index++) {
        const { id, depth } = queue[index]!
        if (depth === 6) continue
        const count = random() < 0.3 ? 0 : 1 + Math.floor(random() * 3)
        for (let child = 0; child < count; child++) {
          const childId = `${id}/${child}`
          tree.message(childId, id)
          queue.push({ id: childId, depth: depth + 1 })
        }
      }
      const layout = tree.layout()
      for (let depth = 0; depth <= 6; depth++) {
        const row = treeRow(tree.graph, layout, depth)
        for (let index = 0; index < row.length; index++) {
          const selected = row[index]!
          const intent: GraphNavigationIntent = {
            axis: "horizontal", preferredCoordinate: depth * 8 + 2,
            atNodeId: selected, returnNodeId: "missing", lastDirection: "right",
          }
          for (const direction of ["left", "right"] as const) {
            const move = directionalMove(layout, selected, direction, intent)
            expect(move?.nodeId).toBe(row[index + (direction === "right" ? 1 : -1)])
            if (move) {
              expect(directionalMove(layout, move.nodeId, direction === "right" ? "left" : "right", move.intent)?.nodeId)
                .toBe(selected)
            }
          }
        }
      }
    }
  })
})

function treeRow(graph: ConversationGraph, layout: ConversationGraphLayout, depth: number): string[] {
  const row: string[] = []
  const pending = [...graph.nodes.get(graph.originNodeId)!.childIds].reverse().map((id) => ({ id, depth: 0 }))
  while (pending.length > 0) {
    const current = pending.pop()!
    const children = graph.nodes.get(current.id)!.childIds.filter((id) => layout.nodes.has(id))
    if (current.depth === depth || children.length === 0) row.push(current.id)
    else pending.push(...children.toReversed().map((id) => ({ id, depth: current.depth + 1 })))
  }
  return row
}

function fixture() {
  const session = { id: "root", title: "Tree", lastModified: 0 }
  const graph: ConversationGraph = {
    rootSessionId: session.id, rootSession: session, rootNodeId: "", originNodeId: "origin",
    nodes: new Map([["origin", { id: "origin", kind: "origin", parentId: null, childIds: [] }]]),
    endpointBySessionId: new Map(), sessionIds: new Set(), warnings: [],
  }
  const add = (node: MessageGraphNodeOrEndpoint) => {
    graph.nodes.set(node.id, node)
    graph.nodes.get(node.parentId!)!.childIds.push(node.id)
    graph.rootNodeId ||= node.id
  }
  const message = (id: string, parentId: string) => add({
    id, parentId, childIds: [], kind: "message", role: "user", preview: id, internal: false, aliases: [],
  })
  return {
    graph, message,
    chain(prefix: string, parentId: string, length: number) {
      const ids: string[] = []
      for (let index = 0; index < length; index++) {
        const id = `${prefix}-${index}`
        message(id, parentId)
        ids.push(id)
        parentId = id
      }
      return ids
    },
    endpoint(id: string, parentId: string) {
      add({ id, parentId, childIds: [], kind: "endpoint", session: { ...session, id } })
      graph.sessionIds.add(id)
      graph.endpointBySessionId.set(id, id)
    },
    layout: () => layoutConversationGraph(graph, 100, graph.sessionIds),
  }
}
