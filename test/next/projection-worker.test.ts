import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { Worker } from "node:worker_threads"

import { Cause, Deferred, Effect, Exit, Fiber } from "effect"

import { projectForest } from "../../src/application/forest-projection"
import { selectConversationForest } from "../../src/application/selectors"
import { available, makeInitialApplicationState, type ApplicationState } from "../../src/application/state"
import { projectGraphViewModel, projectRootsViewModel } from "../../src/application/view-model"
import { buildConversationForest, type ConversationGraph } from "../../src/domain/conversation-graph"
import { makeProjectionService } from "../../src/infrastructure/projection/service"
import type { ProjectionRequest, ProjectionResponse } from "../../src/infrastructure/projection/protocol"

class ControlledProjectionWorker extends EventEmitter {
  readonly posted = Deferred.makeUnsafe<void>()
  readonly terminationStarted = Deferred.makeUnsafe<void>()
  readonly releaseTermination = Deferred.makeUnsafe<number>()
  autoTerminate = true
  terminated = 0
  postMessage(_request: ProjectionRequest) { Deferred.doneUnsafe(this.posted, Effect.void) }
  terminate() {
    this.terminated++
    Deferred.doneUnsafe(this.terminationStarted, Effect.void)
    const result = this.autoTerminate ? Promise.resolve(1) : Effect.runPromise(Deferred.await(this.releaseTermination))
    return result.then((code) => { this.emit("exit", code); return code })
  }
  unref() {}
  create = (): Worker => this as unknown as Worker
}

test("interruption during projection worker creation installs and awaits termination", async () => {
  const worker = new ControlledProjectionWorker()
  worker.autoTerminate = false
  await Effect.runPromise(Effect.gen(function*() {
    const acquisition = yield* Effect.forkChild(Effect.scoped(Effect.withFiber((fiber) =>
      makeProjectionService(() => {
        fiber.interruptUnsafe()
        return worker.create()
      }))))
    yield* Deferred.await(worker.terminationStarted)
    expect(worker.terminated).toBe(1)
    expect(acquisition.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(worker.releaseTermination, 1)
    const exit = yield* Fiber.await(acquisition)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
  }))
})

test.each(["exit", "close"] as const)("projection worker preserves its first error after %s", async (mode) => {
  const worker = new ControlledProjectionWorker()
  const original = new Error("original projection failure")
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const projection = yield* makeProjectionService(worker.create)
    const session = { id: "failed", title: "Failed", lastModified: 1 }
    const state = { ...makeInitialApplicationState(), provider: {
      sessions: new Map([[session.id, session]]), transcripts: new Map([[session.id, available([])]]),
    } }
    const preparation = yield* Effect.forkChild(Effect.flip(projection.prepare(state)))
    yield* Deferred.await(worker.posted)
    worker.emit("error", original)
    if (mode === "exit") worker.emit("exit", 1)
    else yield* projection.close
    expect(yield* Fiber.join(preparation)).toBe(original)
    expect(yield* Effect.flip(projection.prepare(state))).toBe(original)
    yield* projection.close
    yield* projection.close
    expect(worker.terminated).toBe(1)
    expect(yield* Effect.flip(projection.prepare(state))).toBe(original)
  })))
})

test("production projection worker preserves graph validation and reuses unrelated families", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const workerGraphs = new Map<string, ConversationGraph>()
    const projection = yield* makeProjectionService(() => {
      const worker = new Worker(new URL("../../src/infrastructure/projection/worker.ts", import.meta.url))
      worker.on("message", (response: ProjectionResponse) => {
        if (response._tag === "Projected") {
          for (const graph of response.forest.graphs) workerGraphs.set(graph.rootSessionId, graph)
        }
      })
      return worker
    })
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
    expect(forest.graphBySessionId.get(root.id)).toBe(workerGraphs.get(root.id))
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
    const contradictory = copied.map((message) => ({ ...message, preview: "Different copied payload" }))
    const invalid = { ...state, provider: { ...state.provider,
      transcripts: new Map(state.provider.transcripts).set(child.id, available(contradictory)),
    } }
    yield* projection.prepare(invalid)
    const rejected = selectConversationForest(invalid)
    const expectedRejected = buildConversationForest([root, other, child],
      new Map([[root.id, messages], [other.id, messages], [child.id, contradictory]]), [relation])
    expect(rejected.graphBySessionId).toEqual(expectedRejected.graphBySessionId)
    expect(rejected.warnings).toEqual(expectedRejected.warnings)
    expect(rejected.warnings.length).toBeGreaterThan(0)
    expect(rejected.graphBySessionId.get(child.id)).toBe(workerGraphs.get(child.id))
    yield* projection.close
  })))
})

test.each([false, true])("worker projection preserves verified origin descendants across provisional promotion and detachment (populated=%s)", async (populated) => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const responses = new Map<string, ConversationGraph>()
    const projection = yield* makeProjectionService(() => {
      const worker = new Worker(new URL("../../src/infrastructure/projection/worker.ts", import.meta.url))
      worker.on("message", (response: ProjectionResponse) => {
        if (response._tag === "Projected") for (const graph of response.forest.graphs) responses.set(graph.rootSessionId, graph)
      })
      return worker
    })
    const sessions = ["root", "child", "replay"].map((id, index) => ({ id, title: id, lastModified: index }))
    const parent = [{ id: "q", role: "user" as const, preview: "Question", ordinal: 0, visible: true },
      { id: "a", role: "agent" as const, preview: "Answer", ordinal: 1, visible: true }]
    const child = parent.map((message) => ({ ...message, id: `c${message.id}` }))
    const replay = populated ? [{ ...parent[0]!, id: "new", preview: "New prompt" }] : []
    const transcripts = new Map([["root", parent], ["child", child], ["replay", replay]])
    const origin = { childSessionId: "child", parentSessionId: "root", sourceMessageId: "a" }
    const replayRelation = { childSessionId: "replay", parentSessionId: "child", sourceMessageId: "cq",
      sharedMessages: [], createdAt: "2026-10-09T00:00:00.000Z" }
    const verified = { ...origin, sharedMessages: parent.map((message, index) => ({ parentMessageId: message.id, childMessageId: child[index]!.id })),
      createdAt: "2026-10-09T00:00:00.000Z" }
    for (const phase of ["provisional", "verified", "contradicted"] as const) {
      const state: ApplicationState = { ...makeInitialApplicationState({ relations: phase === "verified" ? [verified, replayRelation] : [replayRelation] }),
        provider: { sessions: new Map(sessions.map((session) => [session.id, session])),
          transcripts: new Map([...transcripts].map(([id, messages]) => [id, available(messages)])) },
        branchVerifications: phase === "verified" ? new Map() : new Map([["child", {
          origin, status: phase === "provisional" ? "verifying" : "contradicted", reason: phase, retryable: phase === "provisional",
        }]]),
      }
      yield* projection.prepare(state)
      const forest = selectConversationForest(state)
      const expected = buildConversationForest(sessions, transcripts, state.relations, [], phase === "provisional" ? [origin] : [])
      expect(forest).toEqual(expected)
      const graph = forest.graphBySessionId.get("replay")!
      expect(graph).toBe(responses.get(graph.rootSessionId)!)
      const endpoint = graph.nodes.get(graph.endpointBySessionId.get("replay")!)!
      const head = populated ? [...graph.nodes.values()].find((node) => node.kind === "message" && node.aliases.some((alias) => alias.sessionId === "replay"))! : endpoint
      expect(head.parentId).toBe(graph.originNodeId)
      expect(head.provisional).toBeUndefined()
      expect(endpoint.provisional).toBeUndefined()
      expect(graph.rootSessionId).toBe(phase === "contradicted" ? "child" : "root")
    }
    yield* projection.close
  })))
})

test("worker-backed navigation keeps a local unread child reachable during pending discovery, rewind, and source restoration", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const projection = yield* makeProjectionService()
    const root = { id: "root", title: "Root", lastModified: 1 }
    const child = { id: "child", title: "Child", lastModified: 2 }
    const parent = [{ id: "q", role: "user" as const, preview: "Question", ordinal: 0, visible: true },
      { id: "a", role: "agent" as const, preview: "Answer", ordinal: 1, visible: true }]
    for (const phase of ["pending", "rewound", "restored"] as const) {
      const state: ApplicationState = { ...makeInitialApplicationState(),
        provider: { sessions: new Map([[root.id, root]]), transcripts: phase === "pending" ? new Map()
          : new Map([[root.id, available(phase === "restored" ? parent : parent.slice(0, 1))]]) },
        local: { sessions: new Map([[child.id, child]]), transcripts: new Map([[child.id, { _tag: "Unavailable", reason: "Child unread" }]]), temporarySessionIds: new Set() },
        branchVerifications: new Map([[child.id, { origin: { childSessionId: child.id, parentSessionId: root.id, sourceMessageId: "a" },
          status: "unavailable", reason: "Copy evidence unavailable", retryable: true }]]),
        terminals: new Map([[child.id, { ownerId: "owner", phase: "running", activity: "idle" }]]),
      }
      yield* projection.prepare(state)
      const rows = projectRootsViewModel(state)
      if (phase === "restored") {
        expect(rows).toHaveLength(1)
        expect(rows[0]!.sessionId).toBe(root.id)
        expect(rows[0]!.memberSessionIds).toEqual(expect.arrayContaining([root.id, child.id]))
      } else {
        expect(rows.map((row) => row.sessionId).sort()).toEqual([child.id, root.id])
        const childRow = rows.find((row) => row.sessionId === child.id)!
        expect(childRow.memberSessionIds).toEqual([child.id])
        expect(childRow.activation).toBe("open")
        expect(projectGraphViewModel(state, child.id).nodes.some((node) => node._tag === "Endpoint" && node.session.id === child.id)).toBeTrue()
        if (phase === "pending") expect(rows.find((row) => row.sessionId === root.id)?.activation).toBe("loading")
      }
    }
    yield* projection.close
  })))
})
