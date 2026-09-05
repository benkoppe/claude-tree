import { describe, expect, test } from "bun:test"

import {
  buildConversationForest,
  type ConversationGraph,
  type MessageGraphNode,
  reachableSessionEndpoints,
  indexReachableSessionEndpoints,
  resolveForkTarget,
} from "../../src/domain/conversation-graph"
import {
  directionalMove,
  layoutConversationGraph,
  visibleGraphNodeId,
} from "../../src/domain/graph-layout"
import type { AgentMessage, AgentSession, MessageRef } from "../../src/domain/model"
import type {
  BranchRelation,
  ConversationRemoval,
} from "../../src/domain/persistence"

const ROOT = "root:opaque/id"
const CHILD = "child:opaque/id"
const GRANDCHILD = "grandchild:opaque/id"

describe("next conversation graph", () => {
  test("collapses remapped prefixes and retains aliases for exact fork boundaries", () => {
    const parent = [
      message("parent:user", "user", "question", 0),
      message("parent:first", "agent", "first", 1, true, "parent:user"),
      message("parent:source", "agent", "source", 2, true, "parent:user"),
      message("parent:later", "agent", "later", 3, true, "parent:user"),
    ]
    const child = [
      message("child:user", "user", "question", 0),
      message("child:first", "agent", "first", 1, true, "child:user"),
      message("child:source", "agent", "source", 2, true, "child:user"),
      message("child:tail", "user", "fork tail", 3),
    ]
    const graph = buildConversationForest(
      [session(ROOT, 20), session(CHILD, 10)],
      new Map([[ROOT, parent], [CHILD, child]]),
      [relation(CHILD, ROOT, parent[2]!.id, shared(parent, child, 3))],
    ).graphs[0]!

    expect(previews(graph)).toEqual(["question", "first source", "later", "fork tail"])
    const source = nodes(graph).find((node) => node.preview === "first source")!
    expect(source.aliases).toEqual([
      { sessionId: ROOT, messageId: "parent:first" },
      { sessionId: ROOT, messageId: "parent:source" },
      { sessionId: CHILD, messageId: "child:first" },
      { sessionId: CHILD, messageId: "child:source" },
    ])
    expect(resolveForkTarget(graph, source.id)).toEqual({
      sessionId: ROOT,
      messageId: "parent:source",
    })
    expect(graph.nodes.get(graph.endpointBySessionId.get(CHILD)!)?.parentId).toBe(
      nodes(graph).find((node) => node.preview === "fork tail")!.id,
    )
  })

  test("accepts compacted subsequences and restores omitted retained history", () => {
    const parent = [
      message("parent-a", "user", "A", 0),
      message("parent-b", "agent", "B", 1),
      message("parent-c", "user", "C", 2),
      message("parent-source", "agent", "source", 3),
    ]
    const copied = parent.map((entry, index) => ({ ...entry, id: `child-${index}` }))
    const activeChild = [
      copied[0]!,
      { ...copied[2]!, ordinal: 1 },
      { ...copied[3]!, ordinal: 2 },
      message("child-tail", "user", "continued", 3),
    ]
    const graph = buildConversationForest(
      [session(ROOT, 20), session(CHILD, 10)],
      new Map([[ROOT, parent], [CHILD, activeChild]]),
      [relation(CHILD, ROOT, parent[3]!.id, shared(parent, copied, 4))],
    ).graphs[0]!

    expect(previews(graph)).toEqual(["A", "B", "C", "source", "continued"])
    expect(nodes(graph).find((node) => node.preview === "B")?.aliases).toContainEqual({
      sessionId: CHILD,
      messageId: copied[1]!.id,
    })
    expect(graph.warnings).toEqual([])
  })

  test("keeps an unread validated fork attached to its exact source", () => {
    const parent = [
      message("parent-a", "user", "A", 0),
      message("parent-source", "agent", "source", 1),
      message("parent-later", "user", "later", 2),
    ]
    const copied = parent.slice(0, 2).map((entry, index) => ({
      ...entry,
      id: `child-${index}`,
    }))
    const graph = buildConversationForest(
      [session(ROOT, 20), session(CHILD, 10)],
      new Map([[ROOT, parent], [CHILD, []]]),
      [relation(CHILD, ROOT, parent[1]!.id, shared(parent, copied, 2))],
    ).graphs[0]!

    const source = nodes(graph).find((node) => node.preview === "source")!
    const endpoint = graph.nodes.get(graph.endpointBySessionId.get(CHILD)!)!
    expect(endpoint.parentId).toBe(source.id)
    expect(source.childIds).toContain(endpoint.id)
    expect(graph.nodes.get(graph.originNodeId)?.childIds).not.toContain(endpoint.id)
    expect(graph.warnings).toEqual([])
  })

  test("materializes an empty fork after compaction removes all mapped history", () => {
    const currentParent = message("current-parent", "user", "after compaction", 0)
    const sessions = [session(ROOT, 20), session(CHILD, 10)]
    const transcripts = new Map([[ROOT, [currentParent]], [CHILD, []]])
    const relations = [relation(CHILD, ROOT, "missing-source", [{
      parentMessageId: "missing-source",
      childMessageId: "missing-copy",
    }])]
    const graph = buildConversationForest(
      sessions,
      transcripts,
      relations,
    ).graphs[0]!
    const endpointId = graph.endpointBySessionId.get(CHILD)!
    const endpoint = graph.nodes.get(endpointId)
    const layout = layoutConversationGraph(graph, 100)

    expect(endpoint).toMatchObject({
      kind: "endpoint",
      parentId: graph.originNodeId,
      fork: {
        sourceNodeId: `message:${encodeURIComponent(ROOT)}:${encodeURIComponent("missing-source")}`,
        empty: true,
      },
    })
    expect(layout.nodes.has(endpointId)).toBeTrue()

    const removed = buildConversationForest(
      sessions,
      transcripts,
      relations,
      [messageRemoval([{ sessionId: ROOT, messageId: "missing-source" }])],
    ).graphs[0]!
    expect(removed.endpointBySessionId.has(CHILD)).toBeFalse()
  })

  test("retains descendant history after its parent rewinds", () => {
    const root = [message("root-source", "agent", "root", 0)]
    const originalChild = [
      message("child-root", "agent", "root", 0),
      message("child-old", "user", "old path", 1),
    ]
    const grandchild = [
      message("grandchild-root", "agent", "root", 0),
      message("grandchild-old", "user", "old path", 1),
      message("grandchild-tail", "agent", "retained tail", 2),
    ]
    const graph = buildConversationForest(
      [session(ROOT, 30), session(CHILD, 20), session(GRANDCHILD, 10)],
      new Map([
        [ROOT, root],
        [CHILD, originalChild.slice(0, 1)],
        [GRANDCHILD, grandchild],
      ]),
      [
        relation(CHILD, ROOT, root[0]!.id, shared(root, originalChild, 1), 1),
        relation(
          GRANDCHILD,
          CHILD,
          originalChild[1]!.id,
          shared(originalChild, grandchild, 2),
          2,
        ),
      ],
    ).graphs[0]!

    expect(previews(graph)).toEqual(["root", "old path", "retained tail"])
    const endpointIndex = indexReachableSessionEndpoints(graph)
    for (const node of graph.nodes.values()) {
      expect(endpointIndex.get(node.id) ?? []).toEqual(reachableSessionEndpoints(graph, node.id))
    }
    expect(graph.nodes.get(graph.endpointBySessionId.get(CHILD)!)?.parentId).toBe(graph.rootNodeId)
    expect(nodes(graph).find((node) => node.preview === "old path")?.aliases).toContainEqual({
      sessionId: CHILD,
      messageId: "child-old",
    })
  })

  test("fails closed without partially applying contradictory retained evidence", () => {
    const sibling = "sibling"
    const root = [message("root", "agent", "root", 0)]
    const originalChild = [
      message("child-root", "agent", "root", 0),
      message("child-old", "user", "old", 1),
    ]
    const firstCopy = [
      message("first-root", "agent", "root", 0),
      message("first-old", "user", "old", 1),
    ]
    const contradiction = [
      message("second-root", "agent", "root", 0),
      message("second-old", "user", "different", 1),
    ]
    const forest = buildConversationForest(
      [session(ROOT, 40), session(CHILD, 30), session(GRANDCHILD, 20), session(sibling, 10)],
      new Map([
        [ROOT, root],
        [CHILD, originalChild.slice(0, 1)],
        [GRANDCHILD, firstCopy],
        [sibling, contradiction],
      ]),
      [
        relation(CHILD, ROOT, root[0]!.id, shared(root, originalChild, 1), 1),
        relation(
          GRANDCHILD,
          CHILD,
          originalChild[1]!.id,
          shared(originalChild, firstCopy, 2),
          2,
        ),
        relation(
          sibling,
          CHILD,
          originalChild[1]!.id,
          shared(originalChild, contradiction, 2),
          3,
        ),
      ],
    )

    expect(forest.warnings.some((warning) => warning.includes("contradictory"))).toBeTrue()
    expect(forest.graphBySessionId.get(GRANDCHILD)?.rootSessionId).toBe(GRANDCHILD)
    expect(forest.graphBySessionId.get(sibling)?.rootSessionId).toBe(sibling)
    expect(
      nodes(forest.graphBySessionId.get(ROOT)!).flatMap((node) => node.aliases)
        .some((alias) => alias.sessionId === GRANDCHILD || alias.sessionId === sibling),
    ).toBeFalse()
  })

  test("applies endpoint and alias removals after family construction", () => {
    const parent = [
      message("source", "user", "source", 0),
      message("parent-tail", "agent", "parent tail", 1),
    ]
    const child = [
      message("child-source", "user", "source", 0),
      message("child-tail", "agent", "child tail", 1),
      message("child-later", "user", "later", 2),
    ]
    const baseRelation = relation(CHILD, ROOT, parent[0]!.id, shared(parent, child, 1))
    const endpointPruned = buildConversationForest(
      [session(ROOT, 20), session(CHILD, 10)],
      new Map([[ROOT, parent], [CHILD, child]]),
      [baseRelation],
      [endpointRemoval(CHILD, child[1]!.id)],
    ).graphs[0]!

    expect(previews(endpointPruned)).toEqual(["source", "parent tail", "child tail"])
    expect(endpointPruned.endpointBySessionId.has(CHILD)).toBeFalse()

    const aliasPruned = buildConversationForest(
      [session(ROOT, 20), session(CHILD, 10)],
      new Map([[ROOT, parent], [CHILD, child]]),
      [baseRelation],
      [messageRemoval([{ sessionId: CHILD, messageId: child[0]!.id }])],
    )
    expect(aliasPruned.graphs).toEqual([])
    expect(aliasPruned.graphBySessionId.size).toBe(0)
  })

  test("source removal preserves ancestors of an ordinarily attached empty fork", () => {
    const parent = [
      message("before", "user", "before", 0),
      message("source", "agent", "source", 1),
      message("parent-tail", "user", "parent tail", 2),
    ]
    const child = [
      message("child-before", "user", "before", 0),
      message("child-source", "agent", "source", 1),
    ]
    const forest = buildConversationForest(
      [session(ROOT, 20), session(CHILD, 10)],
      new Map([[ROOT, parent], [CHILD, child]]),
      [relation(CHILD, ROOT, parent[1]!.id, shared(parent, child, 2))],
      [messageRemoval([{ sessionId: ROOT, messageId: parent[1]!.id }])],
    )

    expect(forest.graphs).toHaveLength(1)
    expect(previews(forest.graphs[0]!)).toEqual(["before"])
    expect(forest.graphs[0]!.endpointBySessionId.has(CHILD)).toBeFalse()
  })

  test("groups assistant records and forks from the latest represented record", () => {
    const messages = [
      message("user", "user", "question", 0),
      message("assistant-1", "agent", "first", 1, true, "user"),
      message("tool", "user", "tool result", 2, false),
      message("assistant-2", "agent", "second", 3, true, "user"),
    ]
    const graph = buildConversationForest(
      [session(ROOT, 10)],
      new Map([[ROOT, messages]]),
      [],
    ).graphs[0]!
    const grouped = nodes(graph).find((node) => node.role === "agent")!

    expect(grouped.preview).toBe("first second")
    expect(grouped.aliases.map((alias) => alias.messageId)).toEqual(["assistant-1", "assistant-2"])
    expect(resolveForkTarget(graph, grouped.id)).toEqual({
      sessionId: ROOT,
      messageId: "assistant-2",
    })
  })

  test("keeps zero-prefix replay paths in one synthetic family", () => {
    const rootMessage = message("root prompt", "user", "original", 0)
    const replayMessage = message("replay prompt", "user", "edited", 0)
    const sessions = [session(ROOT, 20), session(CHILD, 10)]
    const transcripts = new Map([[ROOT, [rootMessage]], [CHILD, [replayMessage]]])
    const relations = [relation(CHILD, ROOT, rootMessage.id, [])]
    const graph = buildConversationForest(
      sessions,
      transcripts,
      relations,
    ).graphs[0]!
    const origin = graph.nodes.get(graph.originNodeId)!

    expect(origin.kind).toBe("origin")
    expect(origin.childIds).toEqual([
      graph.rootNodeId,
      `message:${encodeURIComponent(CHILD)}:${encodeURIComponent(replayMessage.id)}`,
    ])
    expect(reachableSessionEndpoints(graph, graph.rootNodeId).map(({ endpoint }) => endpoint.session.id))
      .toEqual([ROOT])
    expect(buildConversationForest(
      sessions,
      transcripts,
      relations,
      [messageRemoval([{ sessionId: ROOT, messageId: rootMessage.id }])],
    ).graphs).toEqual([])
  })

  test("materializes empty forks and preserves reversible navigation intent", () => {
    const parent = [
      message("source", "user", "source", 0),
      message("main", "agent", "main", 1),
    ]
    const child = [message("child-source", "user", "source", 0)]
    const graph = buildConversationForest(
      [session(ROOT, 20), session(CHILD, 10)],
      new Map([[ROOT, parent], [CHILD, child]]),
      [relation(CHILD, ROOT, parent[0]!.id, shared(parent, child, 1))],
    ).graphs[0]!
    const endpointId = graph.endpointBySessionId.get(CHILD)!
    const layout = layoutConversationGraph(graph, 100)
    const mainId = nodes(graph).find((node) => node.preview === "main")!.id

    expect(layout.nodes.has(endpointId)).toBeTrue()
    expect(visibleGraphNodeId(graph, endpointId, new Set())).toBe(endpointId)
    const up = directionalMove(layout, endpointId, "up")!
    const down = directionalMove(layout, up.nodeId, "down", up.intent)
    expect(down?.nodeId).toBe(endpointId)
    expect(directionalMove(layout, endpointId, "left")?.nodeId).toBe(mainId)
  })

  test("builds and lays out 10,000 messages without recursive overflow", () => {
    const messages = Array.from({ length: 10_000 }, (_, index) =>
      message(`message:${index}`, index % 2 === 0 ? "user" : "agent", `${index}`, index)
    )
    const graph = buildConversationForest(
      [session(ROOT, 10)],
      new Map([[ROOT, messages]]),
      [],
    ).graphs[0]!
    const layout = layoutConversationGraph(graph, 100)

    expect(nodes(graph)).toHaveLength(10_000)
    const endpointIndex = indexReachableSessionEndpoints(graph)
    expect(endpointIndex.get(graph.rootNodeId)).toEqual(reachableSessionEndpoints(graph, graph.rootNodeId))
    expect(layout.nodes.size).toBe(10_000)
    expect(layout.nodes.get(graph.rootNodeId)).toMatchObject({ x: 0, y: 0 })
    expect(layout.worldHeight).toBe(39_998)
  })
})

function session(id: string, lastModified: number): AgentSession {
  return { id, title: id, lastModified }
}

function message(
  id: string,
  role: AgentMessage["role"],
  preview: string,
  ordinal: number,
  visible = true,
  displayGroupId?: string,
): AgentMessage {
  return {
    id,
    role,
    preview,
    ordinal,
    visible,
    ...(displayGroupId === undefined ? {} : { displayGroupId }),
  }
}

function relation(
  childSessionId: string,
  parentSessionId: string,
  sourceMessageId: string,
  sharedMessages: BranchRelation["sharedMessages"],
  seconds = 0,
): BranchRelation {
  return {
    childSessionId,
    parentSessionId,
    sourceMessageId,
    sharedMessages,
    createdAt: `2026-09-01T12:00:${String(seconds).padStart(2, "0")}.000Z`,
  }
}

function shared(
  parent: readonly AgentMessage[],
  child: readonly AgentMessage[],
  length: number,
): BranchRelation["sharedMessages"] {
  return parent.slice(0, length).map((entry, index) => ({
    parentMessageId: entry.id,
    childMessageId: child[index]!.id,
  }))
}

function messageRemoval(aliases: readonly MessageRef[]): ConversationRemoval {
  return {
    kind: "subtree",
    target: { kind: "message", aliases },
    createdAt: "2026-09-01T13:00:00.000Z",
  }
}

function endpointRemoval(sessionId: string, afterMessageId: string | null): ConversationRemoval {
  return {
    kind: "subtree",
    target: { kind: "endpoint", sessionId, afterMessageId },
    createdAt: "2026-09-01T13:00:00.000Z",
  }
}

function nodes(graph: ConversationGraph): MessageGraphNode[] {
  return [...graph.nodes.values()].filter(
    (node): node is MessageGraphNode => node.kind === "message",
  )
}

function previews(graph: ConversationGraph): string[] {
  return nodes(graph).map((node) => node.preview)
}
