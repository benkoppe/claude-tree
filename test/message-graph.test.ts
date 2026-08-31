import { describe, expect, test } from "bun:test"

import {
  buildConversationForest,
  reachableSessionEndpoints,
  resolveForkTarget,
  type ConversationGraph,
  type MessageGraphNode,
} from "../src/message-graph"
import type { AgentMessage, AgentSession, MessageRef, SharedMessage } from "../src/agent-provider"
import type { BranchRelation, ConversationRemoval } from "../src/metadata"

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

describe("persisted removals", () => {
  test("prunes a message and all later descendants while retaining its ancestor", () => {
    const messages = [
      message("message-a", "user", "A", 0),
      message("message-b", "agent", "B", 1),
      message("message-c", "user", "C", 2),
    ]
    const forest = buildConversationForest(
      [session(ROOT, "Root", 10)],
      new Map([[ROOT, messages]]),
      [],
      [messageRemoval([{ sessionId: ROOT, messageId: messages[1]!.id }])],
    )

    expect(forest.graphs).toHaveLength(1)
    const graph = forest.graphs[0]!
    expect(messagePreviews(graph)).toEqual(["A"])
    expect(graph.endpointBySessionId.size).toBe(0)
    expect([...graph.sessionIds]).toEqual([])
    expect(graph.rootNodeId).toBe(`message:${ROOT}:${messages[0]!.id}`)
  })

  test("removes only an endpoint when the endpoint is targeted", () => {
    const messages = [message("endpoint-parent", "user", "still visible", 0)]
    const graph = buildConversationForest(
      [session(ROOT, "Root", 10)],
      new Map([[ROOT, messages]]),
      [],
      [endpointRemoval(ROOT, messages[0]!.id)],
    ).graphs[0]!

    expect(messagePreviews(graph)).toEqual(["still visible"])
    expect(graph.endpointBySessionId.has(ROOT)).toBe(false)
    expect(graph.nodes.has(`endpoint:${ROOT}`)).toBe(false)
  })

  test("prunes every branch below a shared branch-point alias", () => {
    const rootMessages = [
      message("root-source", "user", "source", 0),
      message("root-branch", "agent", "branch point", 1),
      message("root-tail", "user", "root tail", 2),
    ]
    const childMessages = [
      message("child-source", "user", "source", 0),
      message("child-branch", "agent", "branch point", 1),
      message("child-tail", "user", "child tail", 2),
    ]
    const graph = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Child", 10)],
      new Map([
        [ROOT, rootMessages],
        [CHILD, childMessages],
      ]),
      [relation(CHILD, ROOT, rootMessages[1]!.id, shared(rootMessages, childMessages, 2))],
      [messageRemoval([{ sessionId: CHILD, messageId: childMessages[1]!.id }])],
    ).graphs[0]!

    expect(messagePreviews(graph)).toEqual(["source"])
    expect(graph.endpointBySessionId.size).toBe(0)
  })

  test("preserves ordinary and zero-prefix siblings outside the removed subtree", () => {
    const rootMessages = [
      message("sibling-source", "user", "source", 0),
      message("removed-original", "agent", "removed", 1),
    ]
    const childMessages = [
      message("copied-source", "user", "source", 0),
      message("fork-tail", "agent", "fork", 1),
    ]
    const replayMessages = [message("replay-root", "user", "replay", 0)]
    const graph = buildConversationForest(
      [
        session(ROOT, "Root", 30),
        session(CHILD, "Sibling", 20),
        session(GRANDCHILD, "Replay", 10),
      ],
      new Map([
        [ROOT, rootMessages],
        [CHILD, childMessages],
        [GRANDCHILD, replayMessages],
      ]),
      [
        relation(CHILD, ROOT, rootMessages[0]!.id, shared(rootMessages, childMessages, 1), 1),
        relation(GRANDCHILD, ROOT, rootMessages[0]!.id, [], 2),
      ],
      [messageRemoval([{ sessionId: ROOT, messageId: rootMessages[1]!.id }])],
    ).graphs[0]!

    expect(messagePreviews(graph)).toEqual(["source", "fork", "replay"])
    expect([...graph.sessionIds]).toEqual([CHILD, GRANDCHILD])
    expect(graph.nodes.get(graph.originNodeId)?.childIds).toEqual([
      `message:${ROOT}:${rootMessages[0]!.id}`,
      `message:${GRANDCHILD}:${replayMessages[0]!.id}`,
    ])
  })

  test("resolves every persisted alias after a shared node splits", () => {
    const rootMessages = [
      message("split-root-source", "user", "source", 0),
      message("split-root-target", "agent", "target", 1),
    ]
    const childMessages = [
      message("split-child-source", "user", "source", 0),
      message("split-child-target", "agent", "target", 1),
    ]
    const originallyShared = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Child", 10)],
      new Map([
        [ROOT, rootMessages],
        [CHILD, childMessages],
      ]),
      [relation(CHILD, ROOT, rootMessages[1]!.id, shared(rootMessages, childMessages, 2))],
    ).graphs[0]!
    const aliases = messageNodes(originallyShared).find((node) => node.preview === "target")!.aliases

    const splitGraph = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Child", 10)],
      new Map([
        [ROOT, rootMessages],
        [CHILD, childMessages],
      ]),
      [relation(CHILD, ROOT, rootMessages[0]!.id, shared(rootMessages, childMessages, 1))],
      [messageRemoval(aliases)],
    ).graphs[0]!

    expect(messagePreviews(splitGraph)).toEqual(["source"])
    expect(splitGraph.endpointBySessionId.size).toBe(0)
  })

  test("resolves opaque alias pairs without delimiter collisions", () => {
    const firstSessionId = "opaque:session"
    const secondSessionId = "opaque"
    const firstMessage = message("message", "user", "remove me", 0)
    const secondMessage = message("session:message", "user", "keep me", 0)
    const forest = buildConversationForest(
      [session(firstSessionId, "First", 20), session(secondSessionId, "Second", 10)],
      new Map([
        [firstSessionId, [firstMessage]],
        [secondSessionId, [secondMessage]],
      ]),
      [],
      [messageRemoval([{ sessionId: firstSessionId, messageId: firstMessage.id }])],
    )

    expect(forest.graphs).toHaveLength(1)
    expect(forest.graphs[0]!.rootSessionId).toBe(secondSessionId)
    expect(messagePreviews(forest.graphs[0]!)).toEqual(["keep me"])
  })

  test("applies overlapping removals independently of record order", () => {
    const messages = [
      message("order-a", "user", "A", 0),
      message("order-b", "agent", "B", 1),
      message("order-c", "user", "C", 2),
    ]
    const removeB = messageRemoval([{ sessionId: ROOT, messageId: messages[1]!.id }])
    const removeC = messageRemoval([{ sessionId: ROOT, messageId: messages[2]!.id }])
    const build = (removals: ConversationRemoval[]) =>
      buildConversationForest(
        [session(ROOT, "Root", 10)],
        new Map([[ROOT, messages]]),
        [],
        removals,
      ).graphs[0]!

    expect(graphShape(build([removeB, removeC]))).toEqual(graphShape(build([removeC, removeB])))
    expect(messagePreviews(build([removeB, removeC]))).toEqual(["A"])
  })

  test("removes whole trees by current root or a recorded member fallback", () => {
    const rootMessage = message("tree-root", "user", "root", 0)
    const childMessage = message("tree-child", "user", "root", 0)
    const build = (removal: ConversationRemoval) =>
      buildConversationForest(
        [session(ROOT, "Root", 20), session(CHILD, "Child", 10)],
        new Map([
          [ROOT, [rootMessage]],
          [CHILD, [childMessage]],
        ]),
        [relation(CHILD, ROOT, rootMessage.id, shared([rootMessage], [childMessage], 1))],
        [removal],
      )

    expect(build(treeRemoval(ROOT, [ROOT, CHILD])).graphs).toEqual([])
    expect(build(treeRemoval("former-root", ["former-root", CHILD])).graphs).toEqual([])
  })

  test("drops a graph reduced to only its synthetic origin", () => {
    const forest = buildConversationForest(
      [session(ROOT, "Empty", 10)],
      new Map([[ROOT, []]]),
      [],
      [endpointRemoval(ROOT, null)],
    )

    expect(forest.graphs).toEqual([])
    expect(forest.graphBySessionId.size).toBe(0)
    expect(forest.graphByRootSessionId.size).toBe(0)
  })

  test("retains the root session title after pruning its endpoint", () => {
    const rootSession = session(ROOT, "Persistent title", 10)
    const graph = buildConversationForest(
      [rootSession],
      new Map([[ROOT, [message("title-message", "user", "message", 0)]]]),
      [],
      [endpointRemoval(ROOT, "title-message")],
    ).graphs[0]!

    expect(graph.rootSession).toEqual(rootSession)
    expect(graph.rootSession.title).toBe("Persistent title")
  })

  test("rebuilds endpoint, session, and root indexes from surviving nodes", () => {
    const rootMessage = message("index-root", "user", "source", 0)
    const childMessages = [
      message("index-child-source", "user", "source", 0),
      message("index-child-tail", "agent", "tail", 1),
    ]
    const forest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Child", 10)],
      new Map([
        [ROOT, [rootMessage]],
        [CHILD, childMessages],
      ]),
      [relation(CHILD, ROOT, rootMessage.id, shared([rootMessage], childMessages, 1))],
      [endpointRemoval(ROOT, rootMessage.id)],
    )
    const graph = forest.graphs[0]!

    expect([...graph.endpointBySessionId.keys()]).toEqual([CHILD])
    expect([...graph.sessionIds]).toEqual([CHILD])
    expect(forest.graphBySessionId.has(ROOT)).toBe(false)
    expect(forest.graphBySessionId.get(CHILD)).toBe(graph)
    expect(forest.graphByRootSessionId.get(ROOT)).toBe(graph)
  })

  test("retains warnings only from surviving graphs", () => {
    const rootMessage = message("warning-root", "user", "root", 0)
    const childMessage = message("warning-child", "user", "child", 0)
    const invalidRelation = relation(
      CHILD,
      ROOT,
      rootMessage.id,
      [{ parentMessageId: rootMessage.id, childMessageId: "wrong-child-message" }],
    )
    const rawForest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Child", 10)],
      new Map([
        [ROOT, [rootMessage]],
        [CHILD, [childMessage]],
      ]),
      [invalidRelation],
    )
    expect(rawForest.warnings).toHaveLength(1)

    const filteredForest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Child", 10)],
      new Map([
        [ROOT, [rootMessage]],
        [CHILD, [childMessage]],
      ]),
      [invalidRelation],
      [treeRemoval(ROOT, [ROOT])],
    )

    expect(filteredForest.graphs.map((graph) => graph.rootSessionId)).toEqual([CHILD])
    expect(filteredForest.warnings).toEqual([])
  })

  test("keeps descendants appended after removal persistence hidden on rebuild", () => {
    const originalMessages = [
      message("append-a", "user", "A", 0),
      message("append-b", "agent", "B", 1),
    ]
    const originalGraph = buildConversationForest(
      [session(ROOT, "Root", 10)],
      new Map([[ROOT, originalMessages]]),
      [],
    ).graphs[0]!
    const aliases = messageNodes(originalGraph).find((node) => node.preview === "B")!.aliases
    const appendedMessages = [
      ...originalMessages,
      message("append-c", "user", "C", 2),
      message("append-d", "agent", "D", 3),
    ]

    const rebuilt = buildConversationForest(
      [session(ROOT, "Root", 20)],
      new Map([[ROOT, appendedMessages]]),
      [],
      [
        messageRemoval(aliases),
        messageRemoval([{ sessionId: "unresolved:session", messageId: "unresolved:message" }]),
      ],
    ).graphs[0]!

    expect(messagePreviews(rebuilt)).toEqual(["A"])
    expect(rebuilt.endpointBySessionId.size).toBe(0)
  })

  test("keeps responses persisted while stopping a removed endpoint hidden", () => {
    const originalMessage = message("endpoint-boundary", "user", "kept", 0)
    const removal = endpointRemoval(ROOT, originalMessage.id)
    const rebuilt = buildConversationForest(
      [session(ROOT, "Root", 20)],
      new Map([[
        ROOT,
        [
          originalMessage,
          message("stopped-partial", "agent", "persisted while stopping", 1),
        ],
      ]]),
      [],
      [removal],
    ).graphs[0]!

    expect(messagePreviews(rebuilt)).toEqual(["kept"])
    expect(rebuilt.endpointBySessionId.size).toBe(0)
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

function messageRemoval(aliases: MessageRef[]): ConversationRemoval {
  return {
    schemaVersion: 1,
    kind: "subtree",
    target: { kind: "message", aliases },
    createdAt: "2026-08-30T12:01:00.000Z",
  }
}

function endpointRemoval(sessionId: string, afterMessageId: string | null): ConversationRemoval {
  return {
    schemaVersion: 1,
    kind: "subtree",
    target: { kind: "endpoint", sessionId, afterMessageId },
    createdAt: "2026-08-30T12:01:00.000Z",
  }
}

function treeRemoval(rootSessionId: string, memberSessionIds: string[]): ConversationRemoval {
  return {
    schemaVersion: 1,
    kind: "tree",
    rootSessionId,
    memberSessionIds,
    createdAt: "2026-08-30T12:01:00.000Z",
  }
}

function messageNodes(graph: ConversationGraph): MessageGraphNode[] {
  return [...graph.nodes.values()].filter(
    (node): node is MessageGraphNode => node.kind === "message",
  )
}

function messagePreviews(graph: ConversationGraph): string[] {
  return messageNodes(graph).map((node) => node.preview)
}

function graphShape(graph: ConversationGraph): unknown {
  return [...graph.nodes.values()].map((node) => ({
    id: node.id,
    parentId: node.parentId,
    childIds: node.childIds,
  }))
}
