import { describe, expect, test } from "bun:test"

import {
  buildConversationForest,
  reachableSessionEndpoints,
  resolveForkTarget,
  type ConversationGraph,
  visibleConversationForest,
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

  test("numbers visually empty forks in relation order and compacts after continuation", () => {
    const parentMessages = [
      message("source", "user", "source", 0),
      message("continuation", "agent", "main path", 1),
    ]
    const firstMessages = [message("first-copy", "user", "source", 0)]
    const secondMessages = [
      message("second-copy", "user", "source", 0),
      message("second-answer", "agent", "continued fork", 1),
    ]
    const thirdMessages = [message("third-copy", "user", "source", 0)]
    const first = "first-fork"
    const second = "second-fork"
    const third = "third-fork"
    const relations = [
      relation(first, ROOT, parentMessages[0]!.id, shared(parentMessages, firstMessages, 1), 1),
      relation(second, ROOT, parentMessages[0]!.id, shared(parentMessages, secondMessages, 1), 2),
      relation(third, ROOT, parentMessages[0]!.id, shared(parentMessages, thirdMessages, 1), 3),
    ]
    const graph = buildConversationForest(
      [
        session(third, "Third", 10),
        session(ROOT, "Root", 40),
        session(first, "First", 30),
        session(second, "Second", 20),
      ],
      new Map([
        [ROOT, parentMessages],
        [first, firstMessages],
        [second, secondMessages],
        [third, thirdMessages],
      ]),
      [relations[2]!, relations[0]!, relations[1]!],
    ).graphs[0]!

    const firstEndpoint = graph.nodes.get(graph.endpointBySessionId.get(first)!)
    const secondEndpoint = graph.nodes.get(graph.endpointBySessionId.get(second)!)
    const thirdEndpoint = graph.nodes.get(graph.endpointBySessionId.get(third)!)
    expect(firstEndpoint?.kind === "endpoint" ? firstEndpoint.fork?.number : undefined).toBe(1)
    expect(secondEndpoint?.kind === "endpoint" ? secondEndpoint.fork?.number : undefined).toBeUndefined()
    expect(thirdEndpoint?.kind === "endpoint" ? thirdEndpoint.fork?.number : undefined).toBe(2)

    const pruned = buildConversationForest(
      [
        session(third, "Third", 10),
        session(ROOT, "Root", 40),
        session(first, "First", 30),
        session(second, "Second", 20),
      ],
      new Map([
        [ROOT, parentMessages],
        [first, firstMessages],
        [second, secondMessages],
        [third, thirdMessages],
      ]),
      relations,
      [endpointRemoval(first, firstMessages[0]!.id)],
    ).graphs[0]!
    const survivingEndpoint = pruned.nodes.get(pruned.endpointBySessionId.get(third)!)
    expect(
      survivingEndpoint?.kind === "endpoint" ? survivingEndpoint.fork?.empty : undefined,
    ).toBeTrue()
    expect(
      survivingEndpoint?.kind === "endpoint" ? survivingEndpoint.fork?.number : undefined,
    ).toBeUndefined()
  })

  test("keeps descendant history when its parent rewinds before the descendant source", () => {
    const rootMessages = [message("root-source", "agent", "shared root", 0)]
    const originalChildMessages = [
      message("child-root", "agent", "shared root", 0),
      message("child-question", "user", "old question", 1),
      message("child-answer", "agent", "old answer", 2),
    ]
    const rewoundChildMessages = originalChildMessages.slice(0, 1)
    const grandchildMessages = [
      message("grandchild-root", "agent", "shared root", 0),
      message("grandchild-question", "user", "old question", 1),
      message("grandchild-answer", "agent", "old answer", 2),
      message("grandchild-tail", "user", "continued descendant", 3),
    ]
    const forest = buildConversationForest(
      [session(ROOT, "Root", 30), session(CHILD, "Rewound", 20), session(GRANDCHILD, "Retained", 10)],
      new Map([
        [ROOT, rootMessages],
        [CHILD, rewoundChildMessages],
        [GRANDCHILD, grandchildMessages],
      ]),
      [
        relation(CHILD, ROOT, rootMessages[0]!.id, shared(rootMessages, originalChildMessages, 1), 1),
        relation(
          GRANDCHILD,
          CHILD,
          originalChildMessages[2]!.id,
          shared(originalChildMessages, grandchildMessages, 3),
          2,
        ),
      ],
    )

    expect(forest.warnings).toEqual([])
    expect(forest.graphs).toHaveLength(1)
    const graph = forest.graphs[0]!
    expect(messagePreviews(graph)).toEqual([
      "shared root",
      "old question",
      "old answer",
      "continued descendant",
    ])
    expect(graph.nodes.get(graph.endpointBySessionId.get(CHILD)!)?.parentId).toBe(graph.rootNodeId)
    const oldAnswer = messageNodes(graph).find((node) => node.preview === "old answer")!
    expect(oldAnswer.aliases).toContainEqual({
      sessionId: CHILD,
      messageId: originalChildMessages[2]!.id,
    })
    expect(oldAnswer.aliases).toContainEqual({
      sessionId: GRANDCHILD,
      messageId: grandchildMessages[2]!.id,
    })
    expect(oldAnswer.forkTarget).toEqual({
      sessionId: GRANDCHILD,
      messageId: grandchildMessages[2]!.id,
    })
  })

  test("renders rewound and retained descendant continuations as sibling paths", () => {
    const rootMessages = [message("root-source", "agent", "shared root", 0)]
    const originalChildMessages = [
      message("child-root", "agent", "shared root", 0),
      message("child-old", "user", "old path", 1),
    ]
    const rewoundChildMessages = [
      originalChildMessages[0]!,
      message("child-new", "user", "new path", 1),
    ]
    const grandchildMessages = [
      message("grandchild-root", "agent", "shared root", 0),
      message("grandchild-old", "user", "old path", 1),
      message("grandchild-tail", "agent", "old path answer", 2),
    ]
    const forest = buildConversationForest(
      [session(ROOT, "Root", 30), session(CHILD, "Rewound", 20), session(GRANDCHILD, "Retained", 10)],
      new Map([
        [ROOT, rootMessages],
        [CHILD, rewoundChildMessages],
        [GRANDCHILD, grandchildMessages],
      ]),
      [
        relation(CHILD, ROOT, rootMessages[0]!.id, shared(rootMessages, originalChildMessages, 1), 1),
        relation(
          GRANDCHILD,
          CHILD,
          originalChildMessages[1]!.id,
          shared(originalChildMessages, grandchildMessages, 2),
          2,
        ),
      ],
    )

    expect(forest.graphs).toHaveLength(1)
    expect(forest.warnings).toEqual([])
    const graph = forest.graphs[0]!
    const rootNode = graph.nodes.get(graph.rootNodeId)!
    expect(rootNode.childIds.flatMap((id) => {
      const node = graph.nodes.get(id)
      return node?.kind === "message" ? [node.preview] : []
    })).toEqual(["new path", "old path"])
    expect(graph.nodes.get(graph.endpointBySessionId.get(CHILD)!)?.parentId).toBe(
      messageNodes(graph).find((node) => node.preview === "new path")!.id,
    )
  })

  test("merges sibling copies of history missing from their rewound parent", () => {
    const rootMessages = [message("root-source", "agent", "shared root", 0)]
    const originalChildMessages = [
      message("child-root", "agent", "shared root", 0),
      message("child-old", "user", "old path", 1),
    ]
    const firstGrandchildMessages = [
      message("first-root", "agent", "shared root", 0),
      message("first-old", "user", "old path", 1),
      message("first-tail", "agent", "first tail", 2),
    ]
    const secondGrandchild = "44444444-4444-4444-8444-444444444444"
    const secondGrandchildMessages = [
      message("second-root", "agent", "shared root", 0),
      message("second-old", "user", "old path", 1),
      message("second-tail", "agent", "second tail", 2),
    ]
    const forest = buildConversationForest(
      [
        session(ROOT, "Root", 40),
        session(CHILD, "Rewound", 30),
        session(GRANDCHILD, "First", 20),
        session(secondGrandchild, "Second", 10),
      ],
      new Map([
        [ROOT, rootMessages],
        [CHILD, originalChildMessages.slice(0, 1)],
        [GRANDCHILD, firstGrandchildMessages],
        [secondGrandchild, secondGrandchildMessages],
      ]),
      [
        relation(CHILD, ROOT, rootMessages[0]!.id, shared(rootMessages, originalChildMessages, 1), 1),
        relation(
          GRANDCHILD,
          CHILD,
          originalChildMessages[1]!.id,
          shared(originalChildMessages, firstGrandchildMessages, 2),
          2,
        ),
        relation(
          secondGrandchild,
          CHILD,
          originalChildMessages[1]!.id,
          shared(originalChildMessages, secondGrandchildMessages, 2),
          3,
        ),
      ],
    )

    expect(forest.graphs).toHaveLength(1)
    expect(forest.warnings).toEqual([])
    const oldPathNodes = messageNodes(forest.graphs[0]!).filter((node) => node.preview === "old path")
    expect(oldPathNodes).toHaveLength(1)
    expect(oldPathNodes[0]!.aliases.map((alias) => alias.sessionId)).toEqual([
      GRANDCHILD,
      CHILD,
      secondGrandchild,
    ])
  })

  test("recovers retained history through multiple rewound generations", () => {
    const greatGrandchild = "55555555-5555-4555-8555-555555555555"
    const rootOriginal = [
      message("root-kept", "agent", "root kept", 0),
      message("root-old", "user", "root old", 1),
    ]
    const childOriginal = [
      message("child-kept", "agent", "root kept", 0),
      message("child-root-old", "user", "root old", 1),
      message("child-old", "agent", "child old", 2),
    ]
    const grandchildOriginal = [
      message("grandchild-kept", "agent", "root kept", 0),
      message("grandchild-root-old", "user", "root old", 1),
      message("grandchild-child-old", "agent", "child old", 2),
    ]
    const retained = [
      message("great-kept", "agent", "root kept", 0),
      message("great-root-old", "user", "root old", 1),
      message("great-child-old", "agent", "child old", 2),
      message("great-tail", "user", "retained tail", 3),
    ]
    const forest = buildConversationForest(
      [
        session(ROOT, "Root", 40),
        session(CHILD, "Child", 30),
        session(GRANDCHILD, "Grandchild", 20),
        session(greatGrandchild, "Great-grandchild", 10),
      ],
      new Map([
        [ROOT, rootOriginal.slice(0, 1)],
        [CHILD, childOriginal.slice(0, 1)],
        [GRANDCHILD, grandchildOriginal.slice(0, 1)],
        [greatGrandchild, retained],
      ]),
      [
        relation(CHILD, ROOT, rootOriginal[1]!.id, shared(rootOriginal, childOriginal, 2), 1),
        relation(
          GRANDCHILD,
          CHILD,
          childOriginal[2]!.id,
          shared(childOriginal, grandchildOriginal, 3),
          2,
        ),
        relation(
          greatGrandchild,
          GRANDCHILD,
          grandchildOriginal[2]!.id,
          shared(grandchildOriginal, retained, 3),
          3,
        ),
      ],
    )

    expect(forest.graphs).toHaveLength(1)
    expect(forest.warnings).toEqual([])
    expect(messagePreviews(forest.graphs[0]!)).toEqual([
      "root kept",
      "root old",
      "child old",
      "retained tail",
    ])
    expect(forest.graphs[0]!.sessionIds).toEqual(
      new Set([ROOT, CHILD, GRANDCHILD, greatGrandchild]),
    )
    const currentIds = new Map([
      [ROOT, new Set(rootOriginal.slice(0, 1).map((item) => item.id))],
      [CHILD, new Set(childOriginal.slice(0, 1).map((item) => item.id))],
      [GRANDCHILD, new Set(grandchildOriginal.slice(0, 1).map((item) => item.id))],
      [greatGrandchild, new Set(retained.map((item) => item.id))],
    ])
    for (const node of messageNodes(forest.graphs[0]!)) {
      if (!node.forkTarget) continue
      expect(currentIds.get(node.forkTarget.sessionId)?.has(node.forkTarget.messageId)).toBeTrue()
    }
  })

  test("keeps a recorded family when both sides completely rewrite their copied history", () => {
    const parent = [message("new-parent", "user", "new parent path", 0)]
    const child = [message("new-child", "user", "new child path", 0)]
    const forest = buildConversationForest(
      [session(ROOT, "Parent", 20), session(CHILD, "Child", 10)],
      new Map([
        [ROOT, parent],
        [CHILD, child],
      ]),
      [relation(CHILD, ROOT, "old-parent", [{
        parentMessageId: "old-parent",
        childMessageId: "old-child",
      }])],
    )

    expect(forest.graphs).toHaveLength(1)
    expect(forest.warnings).toEqual([])
    expect(forest.graphs[0]!.sessionIds).toEqual(new Set([ROOT, CHILD]))
    expect(messagePreviews(forest.graphs[0]!)).toEqual(["new parent path", "new child path"])
  })

  test("fails closed when descendants disagree about retained history", () => {
    const sibling = "66666666-6666-4666-8666-666666666666"
    const rootMessages = [message("root", "agent", "root", 0)]
    const childOriginal = [
      message("child-root", "agent", "root", 0),
      message("child-old", "user", "old path", 1),
    ]
    const firstCopy = [
      message("first-root", "agent", "root", 0),
      message("first-old", "user", "old path", 1),
    ]
    const contradictoryCopy = [
      message("second-root", "agent", "root", 0),
      message("second-old", "user", "different old path", 1),
    ]
    const forest = buildConversationForest(
      [
        session(ROOT, "Root", 40),
        session(CHILD, "Child", 30),
        session(GRANDCHILD, "First", 20),
        session(sibling, "Second", 10),
      ],
      new Map([
        [ROOT, rootMessages],
        [CHILD, childOriginal.slice(0, 1)],
        [GRANDCHILD, firstCopy],
        [sibling, contradictoryCopy],
      ]),
      [
        relation(CHILD, ROOT, rootMessages[0]!.id, shared(rootMessages, childOriginal, 1), 1),
        relation(
          GRANDCHILD,
          CHILD,
          childOriginal[1]!.id,
          shared(childOriginal, firstCopy, 2),
          2,
        ),
        relation(
          sibling,
          CHILD,
          childOriginal[1]!.id,
          shared(childOriginal, contradictoryCopy, 2),
          3,
        ),
      ],
    )

    expect(forest.warnings.some((warning) => warning.includes("contradictory"))).toBeTrue()
    expect(forest.graphBySessionId.get(GRANDCHILD)?.rootSessionId).toBe(GRANDCHILD)
    expect(forest.graphBySessionId.get(sibling)?.rootSessionId).toBe(sibling)
  })

  test("accepts a rewritten child prefix when the retained parent validates its ancestry", () => {
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

    expect(forest.graphs).toHaveLength(1)
    expect(forest.graphBySessionId.get(CHILD)?.rootSessionId).toBe(ROOT)
    expect(forest.warnings).toEqual([])
  })

  test("accepts an ordered active-child subsequence of validated shared history", () => {
    const parentMessages = [
      message("parent-a", "user", "A", 0),
      message("parent-preserved", "agent", "preserved", 1),
      message("parent-c", "user", "C", 2),
      message("parent-source", "agent", "source", 3),
    ]
    const copiedChildMessages = [
      message("child-a", "user", "A", 0),
      message("child-preserved", "agent", "preserved", 1),
      message("child-c", "user", "C", 2),
      message("child-source", "agent", "source", 3),
    ]
    const activeChildMessages = [
      copiedChildMessages[0]!,
      { ...copiedChildMessages[2]!, ordinal: 1 },
      { ...copiedChildMessages[3]!, ordinal: 2 },
      message("child-tail", "user", "continued fork", 3),
    ]
    const forest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Fork", 10)],
      new Map([
        [ROOT, parentMessages],
        [CHILD, activeChildMessages],
      ]),
      [
        relation(
          CHILD,
          ROOT,
          parentMessages[3]!.id,
          shared(parentMessages, copiedChildMessages, 4),
        ),
      ],
    )

    expect(forest.graphs).toHaveLength(1)
    expect(forest.warnings).toEqual([])
    const graph = forest.graphs[0]!
    const preserved = messageNodes(graph).find((node) => node.preview === "preserved")!
    expect(preserved.aliases).toContainEqual({
      sessionId: CHILD,
      messageId: copiedChildMessages[1]!.id,
    })
    const tail = messageNodes(graph).find((node) => node.preview === "continued fork")!
    const source = messageNodes(graph).find((node) => node.preview === "source")!
    expect(tail.parentId).toBe(source.id)
    expect(graph.nodes.get(graph.endpointBySessionId.get(CHILD)!)?.parentId).toBe(tail.id)
  })

  test("fails closed when validated shared child IDs are out of order", () => {
    const parentMessages = [
      message("parent-a", "user", "A", 0),
      message("parent-b", "agent", "B", 1),
      message("parent-c", "user", "C", 2),
    ]
    const copiedChildMessages = [
      message("child-a", "user", "A", 0),
      message("child-b", "agent", "B", 1),
      message("child-c", "user", "C", 2),
    ]
    const forest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Fork", 10)],
      new Map([
        [ROOT, parentMessages],
        [CHILD, [copiedChildMessages[0]!, copiedChildMessages[2]!, copiedChildMessages[1]!]],
      ]),
      [
        relation(
          CHILD,
          ROOT,
          parentMessages[2]!.id,
          shared(parentMessages, copiedChildMessages, 3),
        ),
      ],
    )

    expect(forest.graphs).toHaveLength(2)
    expect(forest.warnings[0]).toContain("recorded order")
  })

  test("attaches descendants through a parent with sparse active shared history", () => {
    const parentMessages = [
      message("parent-a", "user", "A", 0),
      message("parent-preserved", "agent", "preserved", 1),
      message("parent-c", "user", "C", 2),
      message("parent-source", "agent", "source", 3),
    ]
    const copiedChildMessages = [
      message("child-a", "user", "A", 0),
      message("child-preserved", "agent", "preserved", 1),
      message("child-c", "user", "C", 2),
      message("child-source", "agent", "source", 3),
    ]
    const activeChildMessages = [
      copiedChildMessages[0]!,
      { ...copiedChildMessages[2]!, ordinal: 1 },
      { ...copiedChildMessages[3]!, ordinal: 2 },
      message("child-tail", "user", "child tail", 3),
    ]
    const grandchildMessages = activeChildMessages.map((entry, index) => ({
      ...entry,
      id: `grandchild-${index}`,
    }))
    grandchildMessages.push(message("grandchild-tail", "agent", "grandchild tail", 4))
    const forest = buildConversationForest(
      [
        session(ROOT, "Root", 30),
        session(CHILD, "Fork", 20),
        session(GRANDCHILD, "Nested fork", 10),
      ],
      new Map([
        [ROOT, parentMessages],
        [CHILD, activeChildMessages],
        [GRANDCHILD, grandchildMessages],
      ]),
      [
        relation(
          CHILD,
          ROOT,
          parentMessages[3]!.id,
          shared(parentMessages, copiedChildMessages, 4),
          1,
        ),
        relation(
          GRANDCHILD,
          CHILD,
          activeChildMessages[3]!.id,
          shared(activeChildMessages, grandchildMessages, 4),
          2,
        ),
      ],
    )

    expect(forest.warnings).toEqual([])
    expect(forest.graphs).toHaveLength(1)
    expect(forest.graphs[0]!.sessionIds).toEqual(new Set([ROOT, CHILD, GRANDCHILD]))
    expect(messagePreviews(forest.graphs[0]!)).toContain("grandchild tail")
  })

  test("retains an existing descendant after its parent active history becomes sparse", () => {
    const parentMessages = [
      message("parent-a", "user", "A", 0),
      message("parent-preserved", "agent", "preserved", 1),
      message("parent-c", "user", "C", 2),
      message("parent-source", "agent", "source", 3),
    ]
    const copiedChildMessages = parentMessages.map((entry, index) => ({
      ...entry,
      id: `child-${index}`,
    }))
    const fullChildMessages = [
      ...copiedChildMessages,
      message("child-tail", "user", "child tail", 4),
    ]
    const activeChildMessages = [
      copiedChildMessages[0]!,
      { ...copiedChildMessages[2]!, ordinal: 1 },
      { ...copiedChildMessages[3]!, ordinal: 2 },
      { ...fullChildMessages[4]!, ordinal: 3 },
    ]
    const grandchildMessages = fullChildMessages.map((entry, index) => ({
      ...entry,
      id: `grandchild-${index}`,
    }))
    grandchildMessages.push(message("grandchild-tail", "agent", "grandchild tail", 5))
    const forest = buildConversationForest(
      [
        session(ROOT, "Root", 30),
        session(CHILD, "Fork", 20),
        session(GRANDCHILD, "Nested fork", 10),
      ],
      new Map([
        [ROOT, parentMessages],
        [CHILD, activeChildMessages],
        [GRANDCHILD, grandchildMessages],
      ]),
      [
        relation(
          CHILD,
          ROOT,
          parentMessages[3]!.id,
          shared(parentMessages, copiedChildMessages, 4),
          1,
        ),
        relation(
          GRANDCHILD,
          CHILD,
          fullChildMessages[4]!.id,
          shared(fullChildMessages, grandchildMessages, 5),
          2,
        ),
      ],
    )

    expect(forest.warnings).toEqual([])
    expect(forest.graphs).toHaveLength(1)
    expect(forest.graphs[0]!.sessionIds).toEqual(new Set([ROOT, CHILD, GRANDCHILD]))
  })

  test("restores an interior parent message retained only by its child", () => {
    const parentHistory = [
      message("parent-a", "user", "A", 0),
      message("parent-b", "agent", "B", 1),
      message("parent-c", "user", "C", 2),
    ]
    const activeParent = [parentHistory[0]!, { ...parentHistory[2]!, ordinal: 1 }]
    const childMessages = parentHistory.map((entry, index) => ({
      ...entry,
      id: `child-${index}`,
    }))
    childMessages.push(message("child-tail", "agent", "tail", 3))
    const forest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Fork", 10)],
      new Map([
        [ROOT, activeParent],
        [CHILD, childMessages],
      ]),
      [
        relation(
          CHILD,
          ROOT,
          parentHistory[2]!.id,
          shared(parentHistory, childMessages, 3),
        ),
      ],
    )

    expect(forest.warnings).toEqual([])
    expect(forest.graphs).toHaveLength(1)
    const nodesByPreview = new Map(
      messageNodes(forest.graphs[0]!).map((node) => [node.preview, node]),
    )
    expect(nodesByPreview.get("B")?.parentId).toBe(nodesByPreview.get("A")?.id)
    expect(nodesByPreview.get("C")?.parentId).toBe(nodesByPreview.get("B")?.id)
    expect(nodesByPreview.get("B")?.aliases.map((alias) => alias.sessionId)).toEqual([
      CHILD,
      ROOT,
    ])
  })

  test("propagates retained sparse history across multiple generations", () => {
    const rootMessages = [
      message("root-a", "user", "A", 0),
      message("root-b", "agent", "B", 1),
      message("root-c", "user", "C", 2),
    ]
    const fullChildMessages = rootMessages.map((entry, index) => ({
      ...entry,
      id: `child-${index}`,
    }))
    const activeChildMessages = [
      fullChildMessages[0]!,
      { ...fullChildMessages[2]!, ordinal: 1 },
    ]
    const fullGrandchildMessages = fullChildMessages.map((entry, index) => ({
      ...entry,
      id: `grandchild-${index}`,
    }))
    const activeGrandchildMessages = [
      fullGrandchildMessages[0]!,
      { ...fullGrandchildMessages[2]!, ordinal: 1 },
      message("grandchild-tail", "agent", "tail", 2),
    ]
    const forest = buildConversationForest(
      [
        session(ROOT, "Root", 30),
        session(CHILD, "Fork", 20),
        session(GRANDCHILD, "Nested fork", 10),
      ],
      new Map([
        [ROOT, rootMessages],
        [CHILD, activeChildMessages],
        [GRANDCHILD, activeGrandchildMessages],
      ]),
      [
        relation(
          CHILD,
          ROOT,
          rootMessages[2]!.id,
          shared(rootMessages, fullChildMessages, 3),
          1,
        ),
        relation(
          GRANDCHILD,
          CHILD,
          fullChildMessages[2]!.id,
          shared(fullChildMessages, fullGrandchildMessages, 3),
          2,
        ),
      ],
    )

    expect(forest.warnings).toEqual([])
    expect(forest.graphs).toHaveLength(1)
    const retainedNode = messageNodes(forest.graphs[0]!).find((node) => node.preview === "B")
    expect(retainedNode?.aliases.map((alias) => alias.sessionId)).toEqual([
      ROOT,
      CHILD,
      GRANDCHILD,
    ])
  })

  test("restores an omitted record inside a provider display group", () => {
    const parentMessages = [
      message("parent-user", "user", "question", 0),
      message("parent-first", "agent", "first", 1, true, "parent-user"),
      message("parent-second", "agent", "second", 2, true, "parent-user"),
    ]
    const activeParent = [parentMessages[0]!, { ...parentMessages[2]!, ordinal: 1 }]
    const childMessages = [
      message("child-user", "user", "question", 0),
      message("child-first", "agent", "first", 1, true, "child-user"),
      message("child-second", "agent", "second", 2, true, "child-user"),
    ]
    const forest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Fork", 10)],
      new Map([
        [ROOT, activeParent],
        [CHILD, childMessages],
      ]),
      [
        relation(
          CHILD,
          ROOT,
          parentMessages[2]!.id,
          shared(parentMessages, childMessages, 3),
        ),
      ],
    )

    expect(forest.warnings).toEqual([])
    const agentNodes = messageNodes(forest.graphs[0]!).filter((node) => node.role === "agent")
    expect(agentNodes).toHaveLength(1)
    expect(agentNodes[0]!.preview).toBe("first second")
    expect(agentNodes[0]!.aliases.map((alias) => alias.messageId)).toEqual([
      "parent-second",
      "child-first",
      "parent-first",
      "child-second",
    ])
  })

  test("splits a display group merged across an omitted user message", () => {
    const parentHistory = [
      message("parent-user-one", "user", "first question", 0),
      message("parent-answer-one", "agent", "first answer", 1, true, "parent-user-one"),
      message("parent-user-two", "user", "second question", 2),
      message("parent-answer-two", "agent", "second answer", 3, true, "parent-user-two"),
    ]
    const activeParent = [
      parentHistory[0]!,
      parentHistory[1]!,
      {
        ...parentHistory[3]!,
        ordinal: 2,
        displayGroupId: "parent-user-one",
      },
    ]
    const childMessages = [
      message("child-user-one", "user", "first question", 0),
      message("child-answer-one", "agent", "first answer", 1, true, "child-user-one"),
      message("child-user-two", "user", "second question", 2),
      message("child-answer-two", "agent", "second answer", 3, true, "child-user-two"),
    ]
    const forest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Fork", 10)],
      new Map([
        [ROOT, activeParent],
        [CHILD, childMessages],
      ]),
      [
        relation(
          CHILD,
          ROOT,
          parentHistory[3]!.id,
          shared(parentHistory, childMessages, 4),
        ),
      ],
    )

    expect(forest.warnings).toEqual([])
    const visibleNodes = messageNodes(forest.graphs[0]!).filter((node) => !node.internal)
    expect(visibleNodes.map((node) => node.preview)).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
    ])
    expect(visibleNodes[2]!.parentId).toBe(visibleNodes[1]!.id)
    expect(visibleNodes[3]!.parentId).toBe(visibleNodes[2]!.id)
  })

  test("uses the fuller parent history when child compaction changes display grouping", () => {
    const parentMessages = [
      message("parent-user-one", "user", "first question", 0),
      message("parent-answer-one", "agent", "first answer", 1, true, "parent-user-one"),
      message("parent-user-two", "user", "second question", 2),
      message("parent-answer-two", "agent", "second answer", 3, true, "parent-user-two"),
    ]
    const fullChildMessages = [
      message("child-user-one", "user", "first question", 0),
      message("child-answer-one", "agent", "first answer", 1, true, "child-user-one"),
      message("child-user-two", "user", "second question", 2),
      message("child-answer-two", "agent", "second answer", 3, true, "child-user-two"),
    ]
    const activeChild = [
      fullChildMessages[0]!,
      fullChildMessages[1]!,
      {
        ...fullChildMessages[3]!,
        ordinal: 2,
        displayGroupId: "child-user-one",
      },
    ]
    const forest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Fork", 10)],
      new Map([
        [ROOT, parentMessages],
        [CHILD, activeChild],
      ]),
      [
        relation(
          CHILD,
          ROOT,
          parentMessages[3]!.id,
          shared(parentMessages, fullChildMessages, 4),
        ),
      ],
    )

    expect(forest.warnings).toEqual([])
    expect(messageNodes(forest.graphs[0]!).map((node) => node.preview)).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
    ])
  })

  test("uses the nearest retained user when sparse grouping metadata disagrees", () => {
    const parentHistory = [
      message("parent-u0", "user", "zero", 0),
      message("parent-a0", "agent", "zero answer", 1, true, "parent-u0"),
      message("parent-u1", "user", "one", 2),
      message("parent-a1", "agent", "one answer", 3, true, "parent-u1"),
      message("parent-u2", "user", "two", 4),
      message("parent-a2", "agent", "two first", 5, true, "parent-u2"),
      message("parent-a3", "agent", "two second", 6, true, "parent-u2"),
    ]
    const activeParent = [
      ...parentHistory.slice(0, 4),
      {
        ...parentHistory[6]!,
        ordinal: 4,
        displayGroupId: "parent-u1",
      },
    ]
    const childHistory = parentHistory.map((entry) => ({
      ...entry,
      id: entry.id.replace("parent-", "child-"),
      ...(entry.displayGroupId === undefined
        ? {}
        : { displayGroupId: entry.displayGroupId.replace("parent-", "child-") }),
    }))
    const activeChild = [
      childHistory[0]!,
      { ...childHistory[4]!, ordinal: 1 },
      { ...childHistory[5]!, ordinal: 2 },
      { ...childHistory[6]!, ordinal: 3 },
    ]
    const forest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Fork", 10)],
      new Map([
        [ROOT, activeParent],
        [CHILD, activeChild],
      ]),
      [
        relation(
          CHILD,
          ROOT,
          parentHistory[6]!.id,
          shared(parentHistory, childHistory, 7),
        ),
      ],
    )

    expect(forest.warnings).toEqual([])
    expect(messageNodes(forest.graphs[0]!).map((node) => node.preview)).toEqual([
      "zero",
      "zero answer",
      "one",
      "one answer",
      "two",
      "two first two second",
    ])
  })

  test("renders a fully rewritten Claude child chain from the family origin", () => {
    const parentMessages = [
      message("parent-user", "user", "initial prompt", 0),
      message("parent-thinking", "agent", "thinking", 1, false),
      message("parent-answer", "agent", "initial answer", 2),
    ]
    const originalChildMessages = [
      message("old-child-user", "user", "initial prompt", 0),
      message("old-child-thinking", "agent", "thinking", 1, false),
      message("old-child-answer", "agent", "initial answer", 2),
    ]
    const rewrittenChildMessages = [
      message("new-child-user", "user", "edited prompt", 0),
      message("new-child-answer", "agent", "new answer", 1),
    ]
    const forest = buildConversationForest(
      [session(ROOT, "Parent", 20), session(CHILD, "Rewound child", 10)],
      new Map([
        [ROOT, parentMessages],
        [CHILD, rewrittenChildMessages],
      ]),
      [
        relation(
          CHILD,
          ROOT,
          parentMessages[2]!.id,
          shared(parentMessages, originalChildMessages, 3),
        ),
      ],
    )

    expect(forest.graphs).toHaveLength(1)
    expect(forest.warnings).toEqual([])
    const graph = forest.graphs[0]!
    const childEndpoint = graph.nodes.get(graph.endpointBySessionId.get(CHILD)!)!
    const newAnswer = graph.nodes.get(childEndpoint.parentId!)!
    const editedPrompt = graph.nodes.get(newAnswer.parentId!)!
    expect(newAnswer.kind === "message" ? newAnswer.preview : undefined).toBe("new answer")
    expect(editedPrompt.kind === "message" ? editedPrompt.preview : undefined).toBe("edited prompt")
    expect(editedPrompt.parentId).toBe(graph.originNodeId)
    expect(messagePreviews(graph)).toContain("initial answer")
  })

  test("fails closed when rewound history reuses a mapped ID after diverging", () => {
    const parentMessages = [
      message("parent-a", "user", "A", 0),
      message("parent-b", "agent", "B", 1),
    ]
    const originalChild = [
      message("child-a", "user", "A", 0),
      message("child-b", "agent", "B", 1),
    ]
    const malformedChild = [
      originalChild[0]!,
      message("child-new", "user", "new path", 1),
      { ...originalChild[1]!, ordinal: 2 },
    ]
    const forest = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Fork", 10)],
      new Map([
        [ROOT, parentMessages],
        [CHILD, malformedChild],
      ]),
      [
        relation(
          CHILD,
          ROOT,
          parentMessages[1]!.id,
          shared(parentMessages, originalChild, 2),
        ),
      ],
    )

    expect(forest.graphs).toHaveLength(2)
    expect(forest.warnings[0]).toContain("recorded order")
    const parentGraph = forest.graphBySessionId.get(ROOT)!
    expect(
      messageNodes(parentGraph).flatMap((node) => node.aliases).some(
        (alias) => alias.sessionId === CHILD,
      ),
    ).toBeFalse()

    const removedChild = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Fork", 10)],
      new Map([
        [ROOT, parentMessages],
        [CHILD, malformedChild],
      ]),
      [relation(CHILD, ROOT, parentMessages[1]!.id, shared(parentMessages, originalChild, 2))],
      [messageRemoval([{ sessionId: CHILD, messageId: originalChild[0]!.id }])],
    )
    expect(removedChild.graphBySessionId.has(ROOT)).toBeTrue()
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
      "missing-source",
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

  test("keeps grouped history before a removed endpoint boundary", () => {
    const displayGroupId = "removed-endpoint-turn"
    const messages = [
      message("removal-user", "user", "question", 0),
      message("removal-anchor", "agent", "kept answer", 1, true, displayGroupId),
      message("removal-late", "agent", "late continuation", 2, true, displayGroupId),
    ]
    const rebuilt = buildConversationForest(
      [session(ROOT, "Root", 20)],
      new Map([[ROOT, messages]]),
      [],
      [endpointRemoval(ROOT, "removal-anchor")],
    ).graphs[0]!

    expect(messagePreviews(rebuilt)).toEqual(["question", "kept answer"])
    expect(rebuilt.endpointBySessionId.size).toBe(0)
  })

  test("keeps grouped history before an invisible removed endpoint boundary", () => {
    const displayGroupId = "hidden-removal-turn"
    const messages = [
      message("hidden-removal-user", "user", "question", 0),
      message("hidden-removal-answer", "agent", "kept answer", 1, true, displayGroupId),
      message("hidden-removal-anchor", "user", "tool result", 2, false),
      message("hidden-removal-late", "agent", "late continuation", 3, true, displayGroupId),
    ]
    const rebuilt = buildConversationForest(
      [session(ROOT, "Root", 20)],
      new Map([[ROOT, messages]]),
      [],
      [endpointRemoval(ROOT, "hidden-removal-anchor")],
    ).graphs[0]!

    expect(messagePreviews(rebuilt)).toEqual(["question", "kept answer"])
    expect(rebuilt.endpointBySessionId.size).toBe(0)
  })
})

describe("message ordering", () => {
  test("folds only provider-grouped messages and keeps the first node ID stable", () => {
    const displayGroupId = "claude-user-turn"
    const firstMessages = [
      message("group-user", "user", "question", 0),
      message("group-first", "agent", "first blurb", 1, true, displayGroupId),
    ]
    const completedMessages = [
      ...firstMessages,
      message("group-tool-result", "user", "tool result", 2, false),
      message("group-second", "agent", "second blurb", 3, true, displayGroupId),
    ]
    const build = (messages: AgentMessage[]) =>
      buildConversationForest(
        [session(ROOT, "Root", 10)],
        new Map([[ROOT, messages]]),
        [],
      ).graphs[0]!

    const initialGraph = build(firstMessages)
    const completedGraph = build(completedMessages)
    const groupedNodeId = `message:${ROOT}:group-first`
    const initialGroupedNode = initialGraph.nodes.get(groupedNodeId)
    const groupedNode = completedGraph.nodes.get(groupedNodeId)

    expect(initialGroupedNode?.id).toBe(groupedNode?.id)
    expect(completedGraph.rootNodeId).toBe(initialGraph.rootNodeId)
    expect(groupedNode?.kind === "message" ? groupedNode.preview : undefined).toBe(
      "first blurb second blurb",
    )
    expect(groupedNode?.kind === "message" ? groupedNode.aliases : []).toEqual([
      { sessionId: ROOT, messageId: "group-first" },
      { sessionId: ROOT, messageId: "group-second" },
    ])
    expect(resolveForkTarget(completedGraph, groupedNodeId)).toEqual({
      sessionId: ROOT,
      messageId: "group-second",
    })
  })

  test("closes a display group after an exact branch source and preserves inherited aliases", () => {
    const parentGroup = "parent-turn"
    const childGroup = "child-turn"
    const parentMessages = [
      message("branch-user", "user", "question", 0),
      message("branch-first", "agent", "first", 1, true, parentGroup),
      message("branch-source", "agent", "source", 2, true, parentGroup),
      message("branch-later", "agent", "later", 3, true, parentGroup),
    ]
    const childMessages = [
      message("child-user", "user", "question", 0),
      message("child-first", "agent", "first", 1, true, childGroup),
      message("child-source", "agent", "source", 2, true, childGroup),
    ]
    const graph = buildConversationForest(
      [session(ROOT, "Root", 20), session(CHILD, "Fork", 10)],
      new Map([
        [ROOT, parentMessages],
        [CHILD, childMessages],
      ]),
      [relation(CHILD, ROOT, "branch-source", shared(parentMessages, childMessages, 3))],
    ).graphs[0]!
    const sourceNodeId = `message:${ROOT}:branch-first`
    const sourceNode = graph.nodes.get(sourceNodeId)
    const laterNodeId = `message:${ROOT}:branch-later`

    expect(messagePreviews(graph)).toEqual(["question", "first source", "later"])
    expect(sourceNode?.kind === "message" ? sourceNode.aliases : []).toEqual([
      { sessionId: ROOT, messageId: "branch-first" },
      { sessionId: ROOT, messageId: "branch-source" },
      { sessionId: CHILD, messageId: "child-first" },
      { sessionId: CHILD, messageId: "child-source" },
    ])
    expect(resolveForkTarget(graph, sourceNodeId)).toEqual({
      sessionId: ROOT,
      messageId: "branch-source",
    })
    expect(graph.nodes.get(laterNodeId)?.parentId).toBe(sourceNodeId)
    expect(graph.nodes.get(graph.endpointBySessionId.get(CHILD)!)?.parentId).toBe(sourceNodeId)
    expect(resolveForkTarget(graph, graph.endpointBySessionId.get(CHILD)!)).toEqual({
      sessionId: CHILD,
      messageId: "child-source",
    })
  })

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
    expect(inactive.graphByRootSessionId.size).toBe(0)
    expect(active.graphs).toEqual(forest.graphs)
    expect(active.graphBySessionId.get(ROOT)).toBe(forest.graphBySessionId.get(ROOT))
    expect(active.graphByRootSessionId.get(ROOT)).toBe(
      forest.graphByRootSessionId.get(ROOT),
    )
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
