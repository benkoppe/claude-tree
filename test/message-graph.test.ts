import { describe, expect, test } from "bun:test"

import {
  buildConversationForest,
  reachableSessionEndpoints,
  resolveForkTarget,
  visibleConversationForest,
  type MessageGraphNode,
} from "../src/message-graph"
import type { AgentMessage, AgentSession, SharedMessage } from "../src/agent-provider"
import type { BranchRelation } from "../src/metadata"

const ROOT = "11111111-1111-4111-8111-111111111111"
const CHILD = "22222222-2222-4222-8222-222222222222"
const GRANDCHILD = "33333333-3333-4333-8333-333333333333"

describe("buildConversationForest", () => {
  test("collapses remapped fork prefixes into shared logical message nodes", () => {
    const parentMessages = [
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "root question", 0),
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "agent", "root answer", 1),
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "user", "original path", 2),
    ]
    const childMessages = [
      message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "user", "root question", 0),
      message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", "agent", "root answer", 1),
      message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", "user", "fork path", 2),
    ]
    const forest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Fork", 10)],
      new Map([
        [ROOT, parentMessages],
        [CHILD, childMessages],
      ]),
      [relation(CHILD, ROOT, parentMessages[1]!.id, shared(parentMessages, childMessages, 2))],
    )

    expect(forest.graphs).toHaveLength(1)
    const graph = forest.graphs[0]!
    const messages = [...graph.nodes.values()].filter(
      (node): node is MessageGraphNode => node.kind === "message",
    )
    expect(messages.map((node) => node.preview)).toEqual([
      "root question",
      "root answer",
      "original path",
      "fork path",
    ])

    const sharedAnswer = messages.find((node) => node.preview === "root answer")!
    expect(sharedAnswer.aliases).toEqual([
      { sessionId: ROOT, messageId: parentMessages[1]!.id },
      { sessionId: CHILD, messageId: childMessages[1]!.id },
    ])
    expect(sharedAnswer.childIds.map((id) => graph.nodes.get(id)?.kind)).toEqual([
      "message",
      "message",
    ])
    expect(resolveForkTarget(graph, graph.endpointBySessionId.get(CHILD)!)).toEqual({
      sessionId: CHILD,
      messageId: childMessages[2]!.id,
    })
  })

  test("attaches empty and nested forks through session-specific UUID aliases", () => {
    const parentMessages = [
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "first", 0),
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "agent", "second", 1),
    ]
    const childMessages = [
      message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "user", "first", 0),
      message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", "agent", "second", 1),
    ]
    const grandchildMessages = [
      message("cccccccc-cccc-4ccc-8ccc-ccccccccccc1", "user", "first", 0),
      message("cccccccc-cccc-4ccc-8ccc-ccccccccccc2", "agent", "alternate", 1),
    ]
    const forest = buildConversationForest(
      [session(ROOT, "Root", 30), session(CHILD, "Empty fork", 20), session(GRANDCHILD, "Nested", 10)],
      new Map([
        [ROOT, parentMessages],
        [CHILD, childMessages],
        [GRANDCHILD, grandchildMessages],
      ]),
      [
        relation(CHILD, ROOT, parentMessages[1]!.id, shared(parentMessages, childMessages, 2), 1),
        relation(GRANDCHILD, CHILD, childMessages[0]!.id, shared(childMessages, grandchildMessages, 1), 2),
      ],
    )

    const graph = forest.graphs[0]!
    const first = [...graph.nodes.values()].find(
      (node): node is MessageGraphNode => node.kind === "message" && node.preview === "first",
    )!
    expect(first.aliases.map((alias) => alias.sessionId)).toEqual([ROOT, CHILD, GRANDCHILD])
    expect(first.childIds.map((id) => graph.nodes.get(id)?.kind)).toEqual(["message", "message"])
    expect(graph.nodes.get(graph.endpointBySessionId.get(CHILD)!)?.parentId).toBe(
      `message:${ROOT}:${parentMessages[1]!.id}`,
    )
    expect(resolveForkTarget(graph, graph.endpointBySessionId.get(CHILD)!)).toEqual({
      sessionId: CHILD,
      messageId: childMessages[1]!.id,
    })
  })

  test("fails closed and exposes a child as an independent root when its boundary is invalid", () => {
    const source = message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "source", 0)
    const copied = message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "user", "source", 0)
    const forest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Fork", 10)],
      new Map([
        [ROOT, [source]],
        [CHILD, [copied]],
      ]),
      [
        relation(
          CHILD,
          ROOT,
          source.id,
          [{ parentMessageId: source.id, childMessageId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }],
        ),
      ],
    )

    expect(forest.graphs).toHaveLength(2)
    expect(forest.graphBySessionId.get(CHILD)?.rootSessionId).toBe(CHILD)
    expect(forest.warnings[0]).toContain("shared history does not match")
  })
})

describe("message ordering", () => {
  test("preserves consecutive messages with the same role", () => {
    const messages = [
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "first user", 0),
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "user", "second user", 1),
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "agent", "first agent", 2),
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", "agent", "second agent", 3),
    ]
    const graph = buildConversationForest(
      [session(ROOT, "Root", 10)],
      new Map([[ROOT, messages]]),
      [],
    ).graphs[0]!

    const nodeIds = messages.map((entry) => `message:${ROOT}:${entry.id}`)
    expect(graph.nodes.get(nodeIds[1]!)?.parentId).toBe(nodeIds[0])
    expect(graph.nodes.get(nodeIds[2]!)?.parentId).toBe(nodeIds[1])
    expect(graph.nodes.get(nodeIds[3]!)?.parentId).toBe(nodeIds[2])
  })
})

describe("reachableSessionEndpoints", () => {
  test("finds the only endpoint below an interior message", () => {
    const messages = [
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "first", 0),
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "agent", "second", 1),
    ]
    const graph = buildConversationForest(
      [session(ROOT, "Root", 10)],
      new Map([[ROOT, messages]]),
      [],
    ).graphs[0]!

    expect(
      reachableSessionEndpoints(graph, graph.rootNodeId).map(({ endpoint, distance }) => ({
        sessionId: endpoint.session.id,
        distance,
      })),
    ).toEqual([{ sessionId: ROOT, distance: 2 }])
  })

  test("orders endpoints by downward distance before recency", () => {
    const rootMessages = [
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "source", 0),
    ]
    const childMessages = [
      message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "user", "source", 0),
      message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", "agent", "fork answer", 1),
    ]
    const graph = buildConversationForest(
      [session(ROOT, "Root", 10), session(CHILD, "Newer fork", 20)],
      new Map([
        [ROOT, rootMessages],
        [CHILD, childMessages],
      ]),
      [relation(CHILD, ROOT, rootMessages[0]!.id, shared(rootMessages, childMessages, 1))],
    ).graphs[0]!

    expect(
      reachableSessionEndpoints(graph, graph.rootNodeId).map(({ endpoint, distance }) => ({
        sessionId: endpoint.session.id,
        distance,
      })),
    ).toEqual([
      { sessionId: ROOT, distance: 1 },
      { sessionId: CHILD, distance: 2 },
    ])
  })

  test("orders equally distant endpoints by recency and session id", () => {
    const rootMessages = [
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "source", 0),
    ]
    const childMessages = [
      message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "user", "source", 0),
    ]
    const grandchildMessages = [
      message("cccccccc-cccc-4ccc-8ccc-ccccccccccc1", "user", "source", 0),
    ]
    const graph = buildConversationForest(
      [
        session(ROOT, "Root", 10),
        session(CHILD, "Older fork", 20),
        session(GRANDCHILD, "Newer fork", 30),
      ],
      new Map([
        [ROOT, rootMessages],
        [CHILD, childMessages],
        [GRANDCHILD, grandchildMessages],
      ]),
      [
        relation(CHILD, ROOT, rootMessages[0]!.id, shared(rootMessages, childMessages, 1), 1),
        relation(
          GRANDCHILD,
          ROOT,
          rootMessages[0]!.id,
          shared(rootMessages, grandchildMessages, 1),
          2,
        ),
      ],
    ).graphs[0]!

    expect(
      reachableSessionEndpoints(graph, graph.rootNodeId).map(({ endpoint }) =>
        endpoint.session.id
      ),
    ).toEqual([GRANDCHILD, CHILD, ROOT])
  })

  test("does not cross the synthetic origin into sibling root chains", () => {
    const rootMessage = message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "root", 0)
    const replayMessage = message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "user", "replay", 0)
    const graph = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Replay", 10)],
      new Map([
        [ROOT, [rootMessage]],
        [CHILD, [replayMessage]],
      ]),
      [
        {
          schemaVersion: 1,
          childSessionId: CHILD,
          parentSessionId: ROOT,
          sourceMessageId: rootMessage.id,
          sharedMessages: [],
          createdAt: "2026-08-30T12:00:00.000Z",
        },
      ],
    ).graphs[0]!

    expect(
      reachableSessionEndpoints(graph, graph.rootNodeId).map(({ endpoint }) =>
        endpoint.session.id
      ),
    ).toEqual([ROOT])
    expect(
      reachableSessionEndpoints(graph, graph.endpointBySessionId.get(CHILD)!).map(
        ({ endpoint, distance }) => ({ sessionId: endpoint.session.id, distance }),
      ),
    ).toEqual([{ sessionId: CHILD, distance: 0 }])
  })
})

describe("fork targets", () => {
  test("uses an endpoint's exact final message even when that message is hidden", () => {
    const messages = [
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "visible", 0),
      message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "agent", "tool call", 1, false),
    ]
    const graph = buildConversationForest(
      [session(ROOT, "Root", 10)],
      new Map([[ROOT, messages]]),
      [],
    ).graphs[0]!
    const endpointId = graph.endpointBySessionId.get(ROOT)!

    expect(graph.nodes.get(endpointId)?.parentId).toBe(graph.rootNodeId)
    expect(resolveForkTarget(graph, endpointId)).toEqual({
      sessionId: ROOT,
      messageId: messages[1]!.id,
    })
  })
})

describe("visibleConversationForest", () => {
  test("omits inactive families with no visible messages", () => {
    const hidden = message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "command", 0, false)
    const forest = buildConversationForest(
      [session(ROOT, "Command only", 10)],
      new Map([[ROOT, [hidden]]]),
      [],
    )

    const inactive = visibleConversationForest(forest, new Set())
    const active = visibleConversationForest(forest, new Set([ROOT]))

    expect(inactive.graphs).toEqual([])
    expect(inactive.graphBySessionId.size).toBe(0)
    expect(active.graphs).toEqual(forest.graphs)
    expect(active.graphBySessionId.get(ROOT)).toBe(forest.graphBySessionId.get(ROOT))
  })

  test("keeps a family when any related session has a visible message", () => {
    const parentHidden = message(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "user",
      "command",
      0,
      false,
    )
    const childHidden = message(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      "user",
      "command",
      0,
      false,
    )
    const childVisible = message(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      "user",
      "question",
      1,
    )
    const forest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Child", 10)],
      new Map([
        [ROOT, [parentHidden]],
        [CHILD, [childHidden, childVisible]],
      ]),
      [relation(CHILD, ROOT, parentHidden.id, shared([parentHidden], [childHidden], 1))],
    )

    const visible = visibleConversationForest(forest, new Set())

    expect(visible.graphs).toHaveLength(1)
    expect(visible.graphBySessionId.has(ROOT)).toBeTrue()
    expect(visible.graphBySessionId.has(CHILD)).toBeTrue()
  })
})

describe("zero-prefix root replay", () => {
  test("keeps an empty replay session under the same invisible family origin", () => {
    const rootMessage = message(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "user",
      "root prompt",
      0,
      true,
    )
    const relation: BranchRelation = {
      schemaVersion: 1,
      childSessionId: CHILD,
      parentSessionId: ROOT,
      sourceMessageId: rootMessage.id,
      sharedMessages: [],
      createdAt: "2026-08-30T12:00:00.000Z",
    }
    const forest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Replay", 10)],
      new Map([
        [ROOT, [rootMessage]],
        [CHILD, []],
      ]),
      [relation],
    )

    expect(forest.graphs).toHaveLength(1)
    const graph = forest.graphs[0]!
    const origin = graph.nodes.get(graph.originNodeId)
    const childEndpointId = graph.endpointBySessionId.get(CHILD)!
    expect(origin?.kind).toBe("origin")
    expect(origin?.childIds).toEqual([graph.rootNodeId, childEndpointId])
    expect(graph.nodes.get(graph.rootNodeId)?.parentId).toBe(graph.originNodeId)
    expect(graph.nodes.get(childEndpointId)?.parentId).toBe(graph.originNodeId)
    expect(forest.graphBySessionId.get(CHILD)).toBe(graph)
  })

  test("keeps a submitted replay prompt as a separate top-level message", () => {
    const rootMessage = message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "original", 0)
    const replayMessage = message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "user", "edited", 0)
    const relation: BranchRelation = {
      schemaVersion: 1,
      childSessionId: CHILD,
      parentSessionId: ROOT,
      sourceMessageId: rootMessage.id,
      sharedMessages: [],
      createdAt: "2026-08-30T12:00:00.000Z",
    }
    const graph = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Replay", 10)],
      new Map([
        [ROOT, [rootMessage]],
        [CHILD, [replayMessage]],
      ]),
      [relation],
    ).graphs[0]!
    const replayNodeId = `message:${CHILD}:${replayMessage.id}`
    const rootNode = graph.nodes.get(graph.rootNodeId)

    expect(graph.nodes.get(replayNodeId)?.parentId).toBe(graph.originNodeId)
    expect(rootNode?.kind === "message" ? rootNode.aliases : []).toEqual([
      { sessionId: ROOT, messageId: rootMessage.id },
    ])
  })
})

function session(id: string, title: string, lastModified: number): AgentSession {
  return { id, title, lastModified }
}

function message(
  id: string,
  role: AgentMessage["role"],
  preview: string,
  ordinal: number,
  visible = true,
): AgentMessage {
  return {
    id,
    role,
    preview,
    ordinal,
    visible,
  }
}

function relation(
  childSessionId: string,
  parentSessionId: string,
  sourceMessageId: string,
  sharedMessages: SharedMessage[],
  seconds = 0,
): BranchRelation {
  return {
    schemaVersion: 1,
    childSessionId,
    parentSessionId,
    sourceMessageId,
    sharedMessages,
    createdAt: `2026-08-30T12:00:${String(seconds).padStart(2, "0")}.000Z`,
  }
}

function shared(parent: AgentMessage[], child: AgentMessage[], length: number): SharedMessage[] {
  return parent.slice(0, length).map((message, index) => ({
    parentMessageId: message.id,
    childMessageId: child[index]!.id,
  }))
}
