import { expect, test } from "bun:test"

import { Effect } from "effect"

import { projectForest } from "../../src/application/forest-projection"
import { selectConversationForest } from "../../src/application/selectors"
import { available, makeInitialApplicationState } from "../../src/application/state"
import { projectGraphViewModel } from "../../src/application/view-model"
import { buildConversationForest } from "../../src/domain/conversation-graph"
import { makeProjectionService } from "../../src/infrastructure/projection/service"

test("production projection worker preserves graph validation and reuses unrelated families", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const projection = yield* makeProjectionService()
    const root = { id: "root", title: "Root", lastModified: 1 }
    const other = { ...root, id: "other" }
    const child = { ...root, id: "child" }
    const messages = [{ id: "q", role: "user" as const, preview: "Question", ordinal: 0, visible: true },
      { id: "a", role: "agent" as const, preview: "Answer", ordinal: 1, visible: true }]
    const copied = messages.map((message) => ({ ...message, id: `c${message.id}` }))
    const relation = { parentSessionId: root.id, childSessionId: child.id, sourceMessageId: "a",
      sharedMessages: [{ parentMessageId: "q", childMessageId: "cq" }, { parentMessageId: "a", childMessageId: "ca" }],
      createdAt: "2026-09-11T00:00:00.000Z" }
    const state = { ...makeInitialApplicationState({ relations: [relation] }), provider: {
      sessions: new Map([root, other, child].map((session) => [session.id, session])),
      transcripts: new Map([[root.id, available(messages)], [other.id, available(messages)], [child.id, available(copied)]]),
    } }
    yield* projection.prepare(state)
    const forest = selectConversationForest(state)
    const expected = buildConversationForest([root, other, child], new Map([[root.id, messages], [other.id, messages], [child.id, copied]]), [relation])
    expect(forest).toEqual(expected)
    const view = projectGraphViewModel(state, root.id)
    expect(view.nodes.filter((node) => node._tag === "Message")).toHaveLength(2)
    const changed = { ...state, provider: { ...state.provider, transcripts: new Map(state.provider.transcripts).set(other.id, available([...messages,
      { id: "q2", role: "user", preview: "Next", ordinal: 2, visible: true }])) } }
    yield* projection.prepare(changed)
    const oldForest = projectForest(new Map([root, other, child].map((session) => [session.id, session])),
      new Map([[root.id, messages], [other.id, messages], [child.id, copied]]), [relation], [])
    expect(oldForest.graphBySessionId.get(other.id)).toBe(forest.graphBySessionId.get(other.id))
    expect(selectConversationForest(changed).graphBySessionId.get(root.id)).toBe(forest.graphBySessionId.get(root.id))
    expect(projectGraphViewModel(changed, root.id).unselectedNodes).toBe(view.unselectedNodes)
    yield* projection.close
  })))
})
