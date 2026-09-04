import { describe, expect, test } from "bun:test"

import { Deferred, Effect, Fiber, PubSub } from "effect"
import { TestClock } from "effect/testing"

import { NullTerminalObserver } from "../../src/domain/model"
import {
  PersistenceError,
  ProviderError,
  ProviderProtocolError,
  SessionOwnedError,
  TerminalError,
} from "../../src/domain/errors"
import {
  CodexCleanupError,
  CodexProcessError,
  CodexMutationAmbiguousError,
  CodexRequestTimeout,
  CodexRpcError,
  type CodexAppServerClient,
  type CodexAppServerError,
  type CodexThread,
  type CodexThreadItem,
  type CodexTurn,
} from "../../src/infrastructure/providers/codex/app-server"
import {
  CodexProvider,
  createCodexProvider,
  makeObservedServices,
  normalizeCodexThread,
  type CodexObservedServicesFactory,
} from "../../src/infrastructure/providers/codex/provider"
import {
  CodexSidecarError,
  makeCodexSidecar,
  type CodexSidecarFileHandle,
  type CodexSidecar,
  type CodexSidecarProcess,
} from "../../src/infrastructure/providers/codex/sidecar"
import {
  CodexTerminalObserver,
  observeCodexActivity,
  observeCodexDraft,
} from "../../src/infrastructure/providers/codex/terminal-observer"
import {
  CodexTuiProxyError,
  type CodexTuiProxyTransition,
  type CodexTuiProxyTransitionRequest,
} from "../../src/infrastructure/providers/codex/tui-proxy"
import type {
  TerminalTransitionAcknowledgmentError,
  TerminalTransitionRequest,
} from "../../src/services/provider"

const ROOT = "root-thread"
const CHILD = "child-thread"

describe("Effect Codex provider", () => {
  test("canonicalizes once, pages by canonical cwd, and rejects a repeated cursor", async () => {
    const listCalls: unknown[] = []
    const canonicalized: string[] = []
    const client = fakeClient({
      listThreads(params) {
        listCalls.push(params)
        return Effect.succeed(params.cursor === undefined
          ? { data: [thread(ROOT, [], { name: " Root\nname ", updatedAt: 12 })], nextCursor: "next" }
          : { data: [thread(CHILD, [], { preview: " Child " })], nextCursor: null })
      },
    })
    const provider = await Effect.runPromise(createCodexProvider("/project-link", {
      resolveExecutable: () => "/usr/bin/codex",
      canonicalize(path) {
        canonicalized.push(path)
        return "/canonical/project"
      },
      appServerFactory: () => Effect.succeed(client),
    }))

    const snapshot = await Effect.runPromise(provider.loadSessionSnapshot)
    expect(canonicalized).toEqual(["/project-link", "/project", "/project"])
    expect(snapshot.sessions).toEqual([
      { id: ROOT, title: "Root name", lastModified: 12_000 },
      { id: CHILD, title: "Child", lastModified: 1_000 },
    ])
    expect(listCalls).toEqual([
      {
        cwd: "/canonical/project",
        modelProviders: [],
        sourceKinds: ["cli", "vscode", "appServer"],
        sortKey: "updated_at",
      },
      {
        cwd: "/canonical/project",
        modelProviders: [],
        sourceKinds: ["cli", "vscode", "appServer"],
        sortKey: "updated_at",
        cursor: "next",
      },
    ])

    const repeated = providerWith(fakeClient({
      listThreads: () => Effect.succeed({ data: [], nextCursor: "same" }),
    }))
    const error = await Effect.runPromise(Effect.flip(repeated.loadSessionSnapshot))
    expect(error).toBeInstanceOf(ProviderProtocolError)
    expect(error.message).toContain("repeated thread/list cursor")
  })

  test("scopes thread/list results to canonical project cwd while accepting symlink aliases", async () => {
    const canonicalized: string[] = []
    const client = fakeClient({
      listThreads: () => Effect.succeed({
        data: [
          thread(ROOT, [], { cwd: "/project-link" }),
          thread(CHILD, [], { cwd: "/foreign" }),
          thread("canonical", [], { cwd: "/canonical/project" }),
        ],
        nextCursor: null,
      }),
    })
    const provider = await Effect.runPromise(createCodexProvider("/project-link", {
      resolveExecutable: () => "/usr/bin/codex",
      canonicalize(path) {
        canonicalized.push(path)
        if (path === "/project-link") return "/canonical/project"
        if (path === "/foreign") return "/canonical/foreign"
        return path
      },
      appServerFactory: () => Effect.succeed(client),
    }))

    const snapshot = await Effect.runPromise(provider.loadSessionSnapshot)

    expect(snapshot.sessions.map((session) => session.id)).toEqual([ROOT, "canonical"])
    expect(client.readCalls).toEqual([ROOT, "canonical"])
    expect(canonicalized).toEqual(["/project-link", "/project-link", "/foreign"])
  })

  test("bounds thread-list pages, session count, and the overall metadata deadline", async () => {
    let pageCalls = 0
    const paged = providerWith(fakeClient({
      listThreads: () => Effect.succeed({ data: [], nextCursor: `cursor-${++pageCalls}` }),
    }), { maxThreadListPages: 2 })
    const pageError = await Effect.runPromise(Effect.flip(paged.loadSessionSnapshot))
    expect(pageError).toBeInstanceOf(ProviderProtocolError)
    expect(pageError.message).toContain("exceeded 2 pages")
    expect(pageCalls).toBe(2)

    const sessions = providerWith(fakeClient({
      listThreads: () => Effect.succeed({
        data: [thread("one"), thread("two")],
        nextCursor: null,
      }),
    }), { maxSnapshotSessions: 1 })
    const sessionError = await Effect.runPromise(Effect.flip(sessions.loadSessionSnapshot))
    expect(sessionError).toBeInstanceOf(ProviderProtocolError)
    expect(sessionError.message).toContain("exceeded 1 sessions")

    const deadline = providerWith(fakeClient({ listThreads: () => Effect.never }), {
      metadataDeadlineMs: 10,
    })
    const deadlineError = await Effect.runPromise(Effect.flip(deadline.loadSessionSnapshot))
    expect(deadlineError.message).toContain("overall deadline")

    const branchDeadline = providerWith(fakeClient({
      readThread: () => Effect.succeed(thread(ROOT, [turn("parent-turn", "completed", [
        { id: "parent-agent", type: "agentMessage", text: "Answer" },
      ])])),
      forkThread: () => Effect.never,
    }), { metadataDeadlineMs: 10 })
    const branchOutcome = await Effect.runPromise(
      branchDeadline.branchFrom({ sessionId: ROOT, messageId: "parent-agent" }),
    )
    expect(branchOutcome._tag).toBe("AmbiguousBranchMutation")
    if (branchOutcome._tag !== "AmbiguousBranchMutation") throw new Error("expected ambiguity")
    expect(branchOutcome.reason).toContain("overall deadline after thread/fork dispatch")
  })

  test("uses one scoped app-server for list and all snapshot reads", async () => {
    let acquired = 0
    let released = 0
    const client = fakeClient({
      listThreads: () => Effect.succeed({
        data: [thread(ROOT), thread(CHILD)],
        nextCursor: null,
      }),
    })
    const provider = new CodexProvider("/project", "/usr/bin/codex", {
      appServerFactory: () => Effect.acquireRelease(
        Effect.sync(() => {
          acquired += 1
          return client
        }),
        () => Effect.sync(() => {
          released += 1
        }),
      ),
    })

    const snapshot = await Effect.runPromise(provider.loadSessionSnapshot)
    expect(acquired).toBe(1)
    expect(released).toBe(1)
    expect(client.readCalls).toEqual([ROOT, CHILD])
    expect(snapshot.transcripts.get(ROOT)).toEqual({ _tag: "Available", messages: [] })
  })

  test("loads incremental metadata without reading unrelated transcripts", async () => {
    const client = fakeClient({
      listThreads: () => Effect.succeed({
        data: [thread(ROOT), thread(CHILD), thread("unrelated")],
        nextCursor: null,
      }),
    })
    const provider = providerWith(client)

    const snapshot = await Effect.runPromise(provider.loadSessionSnapshotFor([CHILD]))

    expect(snapshot.sessions.map((session) => session.id)).toEqual([ROOT, CHILD, "unrelated"])
    expect(client.readCalls).toEqual([CHILD])
    expect([...snapshot.transcripts.keys()]).toEqual([CHILD])
  })

  test("bounds reads, retries only typed overloads, and isolates TranscriptRead outcomes", async () => {
    let active = 0
    let maximumActive = 0
    let overloaded = false
    const client = fakeClient({
      readThread(id) {
        if (id === "missing") {
          return Effect.fail(new CodexRpcError({
            method: "thread/read",
            code: -32600,
            message: "not found",
            data: { appErrorCode: "thread_not_found" },
          }))
        }
        if (id === "unavailable") {
          return Effect.fail(new CodexProcessError({ operation: "read", message: "permission denied" }))
        }
        return Effect.acquireUseRelease(
          Effect.sync(() => {
            active += 1
            maximumActive = Math.max(maximumActive, active)
          }),
          () => Effect.gen(function*() {
            yield* Effect.sleep(1)
            if (!overloaded) {
              overloaded = true
              return yield* Effect.fail(new CodexRpcError({
                method: "thread/read",
                code: -32001,
                message: "overloaded",
              }))
            }
            return thread(id)
          }),
          () => Effect.sync(() => {
            active -= 1
          }),
        )
      },
    })
    const provider = providerWith(client, { transcriptReadConcurrency: 4, overloadRetryDelaysMs: [0] })
    const ids = [...Array.from({ length: 30 }, (_, index) => `session-${index}`), "missing", "unavailable"]

    const reads = await Effect.runPromise(provider.readTranscripts(ids))
    expect(maximumActive).toBeLessThanOrEqual(4)
    expect(client.readCalls).toHaveLength(33)
    expect(reads.get("missing")).toEqual({ _tag: "Missing" })
    expect(reads.get("unavailable")).toEqual({
      _tag: "Unavailable",
      reason: "Codex readTranscripts failed: permission denied",
    })
  })

  test("normalizes every raw item with hidden systems and exact copy identity", () => {
    const tool = { id: "tool", type: "commandExecution", command: "pwd" }
    const source = thread(ROOT, [turn("turn-1", "completed", [
      user("user", [
        { type: "text", text: "Hello\nworld" },
        { type: "image", url: "https://example.test/image" },
        { type: "skill", name: "review", path: "/review" },
      ]),
      tool,
      { id: "agent", type: "agentMessage", text: "Final\nanswer", phase: "final_answer" },
      { id: "empty-agent", type: "agentMessage", text: "  " },
    ])])

    const messages = normalizeCodexThread(source)
    expect(messages.map(({ role, preview, visible }) => ({ role, preview, visible }))).toEqual([
      { role: "user", preview: "Hello world [image] [skill: review]", visible: true },
      { role: "system", preview: "[commandExecution]", visible: false },
      { role: "agent", preview: "Final answer", visible: true },
      { role: "system", preview: "[agentMessage]", visible: false },
    ])
    expect(messages[1]?.rawItem).toBe(tool)
    expect(messages[1]?.rawTurn).toBe(source.turns[0])
    expect(messages[2]?.copyIdentity).toBe(JSON.stringify({
      type: "agentMessage",
      text: "Final\nanswer",
      phase: "final_answer",
    }))
    expect(messages.every((message) => message.turnComplete)).toBeTrue()
    expect(normalizeCodexThread(thread(ROOT, [turn("working", "inProgress", [
      { id: "working-agent", type: "agentMessage", text: "Working" },
    ])]))[0]?.turnComplete).toBeFalse()
  })

  test("rejects every non-final completed agent target before mutation", async () => {
    const parent = thread(ROOT, [
      turn("completed", "completed", [
        user("user", [{ type: "text", text: "Question" }]),
        { id: "system", type: "reasoning", summary: [] },
        { id: "agent-mid", type: "agentMessage", text: "First" },
        { id: "agent-final", type: "agentMessage", text: "Final" },
      ]),
      turn("working", "inProgress", [
        { id: "agent-working", type: "agentMessage", text: "Working" },
      ]),
    ])

    for (const target of ["user", "system", "agent-mid", "agent-working", "absent"]) {
      const client = fakeClient({ readThread: () => Effect.succeed(parent) })
      const error = await Effect.runPromise(Effect.flip(
        providerWith(client).branchFrom({ sessionId: ROOT, messageId: target }),
      ))
      expect(error.message).toBeTruthy()
      expect(client.forkCalls).toHaveLength(0)
    }
  })

  test("forks exactly once, rereads the child, and validates the exact copied prefix", async () => {
    const parent = thread(ROOT, [turn("parent-turn", "completed", [
      user("parent-user", [{ type: "text", text: "Question" }]),
      { id: "parent-agent", type: "agentMessage", text: "Answer", phase: "final_answer" },
    ])])
    const child = thread(CHILD, [turn("child-turn", "completed", [
      user("child-user", [{ type: "text", text: "Question" }]),
      { id: "child-agent", type: "agentMessage", text: "Answer", phase: "final_answer" },
    ])])
    const client = fakeClient({
      readThread: (id) => Effect.succeed(id === ROOT ? parent : child),
      forkThread: () => Effect.succeed(child),
    })

    const outcome = await Effect.runPromise(
      providerWith(client).branchFrom({ sessionId: ROOT, messageId: "parent-agent" }),
    )
    expect(outcome._tag).toBe("ValidatedBranch")
    if (outcome._tag !== "ValidatedBranch") throw new Error(outcome.reason)
    expect(client.forkCalls).toEqual([{ threadId: ROOT, turnId: "parent-turn", cwd: "/project" }])
    expect(client.readCalls).toEqual([ROOT, CHILD])
    expect(outcome.derivation.sharedMessages).toEqual([
      { parentMessageId: "parent-user", childMessageId: "child-user" },
      { parentMessageId: "parent-agent", childMessageId: "child-agent" },
    ])
  })

  test("preserves a validated fork when app-server close reports cleanup separately", async () => {
    const parent = thread(ROOT, [turn("parent-turn", "completed", [
      { id: "parent-agent", type: "agentMessage", text: "Answer" },
    ])])
    const child = thread(CHILD, [turn("child-turn", "completed", [
      { id: "child-agent", type: "agentMessage", text: "Answer" },
    ])])
    let closes = 0
    const client = fakeClient({
      readThread: (id) => Effect.succeed(id === ROOT ? parent : child),
      forkThread: () => Effect.succeed(child),
      close: () => {
        closes += 1
        return Effect.fail(new CodexCleanupError({ message: "close failed" }))
      },
    })

    const outcome = await Effect.runPromise(
      providerWith(client).branchFrom({ sessionId: ROOT, messageId: "parent-agent" }),
    )

    expect(outcome._tag).toBe("ValidatedBranch")
    expect(closes).toBe(1)
  })

  test("returns AmbiguousBranchMutation when a sent fork loses its response", async () => {
    const parent = thread(ROOT, [turn("parent-turn", "completed", [
      { id: "parent-agent", type: "agentMessage", text: "Answer" },
    ])])
    const client = fakeClient({
      readThread: () => Effect.succeed(parent),
      forkThread: () => Effect.fail(new CodexMutationAmbiguousError({
        method: "thread/fork",
        message: "fork response was lost",
        cause: new CodexRequestTimeout({ method: "thread/fork", timeoutMs: 10 }),
      })),
    })

    const outcome = await Effect.runPromise(
      providerWith(client).branchFrom({ sessionId: ROOT, messageId: "parent-agent" }),
    )
    expect(outcome).toEqual({
      _tag: "AmbiguousBranchMutation",
      providerId: "codex",
      parentSessionId: ROOT,
      sourceMessageId: "parent-agent",
      reason: "fork response was lost",
      reconciliation: "full-snapshot",
    })
  })

  test("treats a foreign post-dispatch fork child as ambiguous without accepting or launching it", async () => {
    const parent = thread(ROOT, [turn("parent-turn", "completed", [
      { id: "parent-agent", type: "agentMessage", text: "Answer" },
    ])])
    const foreignChild = thread(CHILD, [], { cwd: "/foreign" })
    const client = fakeClient({
      readThread: () => Effect.succeed(parent),
      forkThread: () => Effect.succeed(foreignChild),
    })
    const provider = new CodexProvider("/canonical/project", "/usr/bin/codex", {
      appServerFactory: () => Effect.succeed(client),
      observedServicesFactory: inertObservedServices,
      canonicalize: (path) => path === "/project" ? "/canonical/project" : path,
    })

    const outcome = await Effect.runPromise(
      provider.branchFrom({ sessionId: ROOT, messageId: "parent-agent" }),
    )

    expect(outcome).toMatchObject({
      _tag: "AmbiguousBranchMutation",
      providerId: "codex",
      parentSessionId: ROOT,
      sourceMessageId: "parent-agent",
      reconciliation: "full-snapshot",
      reason: expect.stringContaining("outside the canonical project"),
    })
    expect(client.forkCalls).toHaveLength(1)
    expect(client.readCalls).toEqual([ROOT])
    expect("acquireLaunch" in outcome).toBeFalse()
    expect("session" in outcome).toBeFalse()
  })

  test("preserves ambiguity when reads consume the deadline before a dispatched fork stalls", async () => {
    const parent = thread(ROOT, [turn("parent-turn", "completed", [
      { id: "parent-agent", type: "agentMessage", text: "Answer" },
    ])])

    const outcome = await Effect.runPromise(Effect.provide(Effect.gen(function*() {
      const readStarted = yield* Deferred.make<void>()
      const releaseRead = yield* Deferred.make<void>()
      const forkStarted = yield* Deferred.make<void>()
      const client = fakeClient({
        readThread: () => Effect.gen(function*() {
          yield* Deferred.succeed(readStarted, undefined)
          yield* Deferred.await(releaseRead)
          return parent
        }),
        forkThread: () => Effect.gen(function*() {
          yield* Deferred.succeed(forkStarted, undefined)
          return yield* Effect.never
        }),
      })
      const provider = providerWith(client, { metadataDeadlineMs: 10 })
      const fiber = yield* Effect.forkChild(
        provider.branchFrom({ sessionId: ROOT, messageId: "parent-agent" }),
      )
      yield* Deferred.await(readStarted)
      yield* TestClock.adjust(7)
      yield* Deferred.succeed(releaseRead, undefined)
      yield* Deferred.await(forkStarted)
      yield* TestClock.adjust(3)
      return yield* Fiber.join(fiber)
    }), TestClock.layer()))

    expect(outcome._tag).toBe("AmbiguousBranchMutation")
    if (outcome._tag !== "AmbiguousBranchMutation") throw new Error("expected ambiguity")
    expect(outcome.reason).toContain("overall deadline after thread/fork dispatch")
  })

  test("returns an independent child for every post-create read or prefix failure", async () => {
    const parent = thread(ROOT, [turn("parent-turn", "completed", [
      { id: "parent-agent", type: "agentMessage", text: "Answer" },
    ])])
    const child = thread(CHILD, [turn("child-turn", "completed", [
      { id: "child-agent", type: "agentMessage", text: "Different" },
    ])])

    const cases: ReadonlyArray<{
      readonly childRead: Effect.Effect<CodexThread, CodexAppServerError>
      readonly expectedTranscript: "Available" | "Missing" | "Unavailable"
    }> = [
      {
        childRead: Effect.fail(new CodexProcessError({ operation: "read", message: "not persisted" })),
        expectedTranscript: "Unavailable",
      },
      {
        childRead: Effect.fail(new CodexRpcError({
          method: "thread/read",
          code: -32600,
          message: "missing rollout",
          data: { appErrorCode: "rollout_not_found" },
        })),
        expectedTranscript: "Missing",
      },
      { childRead: Effect.succeed(child), expectedTranscript: "Available" },
    ]
    for (const { childRead, expectedTranscript } of cases) {
      const client = fakeClient({
        readThread: (id) => id === ROOT ? Effect.succeed(parent) : childRead,
        forkThread: () => Effect.succeed(child),
      })
      const outcome = await Effect.runPromise(
        providerWith(client).branchFrom({ sessionId: ROOT, messageId: "parent-agent" }),
      )
      expect(outcome._tag).toBe("CreatedIndependentSession")
      if (outcome._tag !== "CreatedIndependentSession") throw new Error("expected independent")
      expect(outcome.session.id).toBe(CHILD)
      expect(outcome.transcript._tag).toBe(expectedTranscript)
      expect(outcome.acquireLaunch).toBeDefined()
      expect(client.forkCalls).toHaveLength(1)
    }
  })

  test("acquires fresh sidecar services lazily and adopts the pending ID on thread/start", async () => {
    let acquisitions = 0
    let initialThreadIsTemporary: boolean | undefined
    let source!: PubSub.PubSub<CodexTuiProxyTransitionRequest>
    const observedServicesFactory: CodexObservedServicesFactory = (
      _executable,
      _initialThreadId,
      temporary,
    ) => Effect.gen(function*() {
      acquisitions += 1
      initialThreadIsTemporary = temporary
      source = yield* PubSub.unbounded<CodexTuiProxyTransitionRequest>()
      return {
        remoteUrl: "ws://127.0.0.1:12345",
        bearerToken: "secret",
        transitions: source,
        close: () => Effect.void,
      }
    })
    const provider = new CodexProvider("/project", "/usr/bin/codex", {
      appServerFactory: () => Effect.succeed(fakeClient()),
      observedServicesFactory,
      observerFactory: () => new NullTerminalObserver(),
      randomUUID: () => "pending-id",
    })

    const prepared = await Effect.runPromise(provider.prepareNewSession)
    expect(prepared.session.id).toBe("pending-codex-pending-id")
    expect(acquisitions).toBe(0)

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const acquired = yield* prepared.acquireLaunch
      expect(acquired.launch.command).toEqual([
        "/usr/bin/codex",
        "--remote",
        "ws://127.0.0.1:12345",
        "--remote-auth-token-env",
        "CLAUDE_TREE_CODEX_TOKEN",
        "--cd",
        "/project",
      ])
      const subscription = yield* PubSub.subscribe(acquired.launch.transitions!)
      yield* publishObservedTransition(source, {
        _tag: "CodexThreadTransition",
        operation: "start",
        kind: "temporary-adoption",
        previousThreadId: prepared.session.id,
        threadId: CHILD,
        title: "First prompt",
        updatedAt: 21,
        cwd: "/project",
      })
      return yield* takeAndAcknowledgeTransition(subscription)
    })))
    expect(acquisitions).toBe(1)
    expect(initialThreadIsTemporary).toBeTrue()
    expect(result).toEqual({
      _tag: "SessionChanged",
      kind: "temporary-adoption",
      session: {
        id: CHILD,
        title: "First prompt",
        lastModified: 21_000,
        transient: true,
      },
    })
  })

  test("treats a temporary terminal's first thread/resume as adoption without native derivation", async () => {
    let source!: PubSub.PubSub<CodexTuiProxyTransitionRequest>
    const provider = new CodexProvider("/project", "/usr/bin/codex", {
      appServerFactory: () => Effect.succeed(fakeClient()),
      observedServicesFactory: () => Effect.gen(function*() {
        source = yield* PubSub.unbounded<CodexTuiProxyTransitionRequest>()
        return {
          remoteUrl: "ws://127.0.0.1:12346",
          bearerToken: "secret",
          transitions: source,
          close: () => Effect.void,
        }
      }),
      randomUUID: () => "pending-id",
    })
    const prepared = await Effect.runPromise(provider.prepareNewSession)

    const transition = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const acquired = yield* prepared.acquireLaunch
      const subscription = yield* PubSub.subscribe(acquired.launch.transitions!)
      yield* publishObservedTransition(source, {
        _tag: "CodexThreadTransition",
        operation: "resume",
        kind: "temporary-adoption",
        previousThreadId: prepared.session.id,
        threadId: CHILD,
        title: "First identity",
        updatedAt: 22,
        cwd: "/project",
        requestedThreadId: CHILD,
      })
      return yield* takeAndAcknowledgeTransition(subscription)
    })))

    expect(transition).toEqual({
      _tag: "SessionChanged",
      kind: "temporary-adoption",
      session: {
        id: CHILD,
        title: "First identity",
        lastModified: 22_000,
        transient: true,
      },
    })
  })

  test("derives exact requested ancestry for a temporary terminal's first thread/fork", async () => {
    const parent = thread(ROOT, [turn("parent-turn", "completed", [
      user("parent-user", [{ type: "text", text: "Question" }]),
      { id: "parent-agent", type: "agentMessage", text: "Answer" },
    ])])
    const child = thread(CHILD, [turn("child-turn", "completed", [
      user("child-user", [{ type: "text", text: "Question" }]),
      { id: "child-agent", type: "agentMessage", text: "Answer" },
    ])])
    const client = fakeClient({
      readThread: (id) => Effect.succeed(id === ROOT ? parent : child),
    })
    let source!: PubSub.PubSub<CodexTuiProxyTransitionRequest>
    const provider = new CodexProvider("/project", "/usr/bin/codex", {
      appServerFactory: () => Effect.succeed(client),
      observedServicesFactory: () => Effect.gen(function*() {
        source = yield* PubSub.unbounded<CodexTuiProxyTransitionRequest>()
        return {
          remoteUrl: "ws://127.0.0.1:12347",
          bearerToken: "secret",
          transitions: source,
          close: () => Effect.void,
        }
      }),
      randomUUID: () => "pending-id",
    })
    const prepared = await Effect.runPromise(provider.prepareNewSession)
    const transition = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const acquired = yield* prepared.acquireLaunch
      const subscription = yield* PubSub.subscribe(acquired.launch.transitions!)
      yield* publishObservedTransition(source, {
        _tag: "CodexThreadTransition",
        operation: "fork",
        kind: "temporary-adoption",
        previousThreadId: prepared.session.id,
        requestedThreadId: ROOT,
        forkPointTurnId: "parent-turn",
        threadId: CHILD,
        title: "First fork",
        updatedAt: 23,
        cwd: "/project",
      })
      const request = yield* PubSub.take(subscription)
      const event = request.event
      if (event._tag === "SessionChanged" && event.derivation) yield* event.derivation
      yield* Deferred.succeed(request.acknowledgment, undefined)
      return event
    })))

    expect(transition._tag).toBe("SessionChanged")
    if (transition._tag !== "SessionChanged") throw transition.error
    expect(transition.kind).toBe("temporary-adoption")
    expect(transition.session.transient).toBeTrue()
    expect(transition.derivation).toBeDefined()
    expect(await Effect.runPromise(transition.derivation!)).toEqual({
      childSessionId: CHILD,
      parentSessionId: ROOT,
      sourceMessageId: "parent-agent",
      sharedMessages: [
        { parentMessageId: "parent-user", childMessageId: "child-user" },
        { parentMessageId: "parent-agent", childMessageId: "child-agent" },
      ],
    })
  })

  test("derives native fork transitions from an exact independently read prefix", async () => {
    const parent = thread(ROOT, [turn("parent-turn", "completed", [
      user("parent-user", [{ type: "text", text: "Question" }]),
      { id: "parent-agent", type: "agentMessage", text: "Answer" },
    ])])
    const child = thread(CHILD, [turn("child-turn", "completed", [
      user("child-user", [{ type: "text", text: "Question" }]),
      { id: "child-agent", type: "agentMessage", text: "Answer" },
    ])])
    const client = fakeClient({
      readThread: (id) => Effect.succeed(id === ROOT ? parent : child),
    })
    let source!: PubSub.PubSub<CodexTuiProxyTransitionRequest>
    const provider = new CodexProvider("/project", "/usr/bin/codex", {
      appServerFactory: () => Effect.succeed(client),
      observedServicesFactory: () => Effect.gen(function*() {
        source = yield* PubSub.unbounded<CodexTuiProxyTransitionRequest>()
        return {
          remoteUrl: "ws://127.0.0.1:7",
          bearerToken: "token",
          transitions: source,
          close: () => Effect.void,
        }
      }),
    })
    const prepared = await Effect.runPromise(provider.prepareResume({
      id: ROOT,
      title: "Root",
      lastModified: 1,
    }))
    const transition = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const acquired = yield* prepared.acquireLaunch
      const subscription = yield* PubSub.subscribe(acquired.launch.transitions!)
      yield* publishObservedTransition(source, {
        _tag: "CodexThreadTransition",
        operation: "fork",
        kind: "native-fork",
        previousThreadId: ROOT,
        requestedThreadId: ROOT,
        forkPointTurnId: "parent-turn",
        threadId: CHILD,
        title: "Fork",
        updatedAt: 2,
        cwd: "/project",
      })
      const request = yield* PubSub.take(subscription)
      const event = request.event
      if (event._tag === "SessionChanged" && event.derivation) yield* event.derivation
      yield* Deferred.succeed(request.acknowledgment, undefined)
      return event
    })))

    expect(transition._tag).toBe("SessionChanged")
    if (transition._tag !== "SessionChanged") throw transition.error
    expect(transition.kind).toBe("native-fork")
    expect(transition.session.transient).toBeUndefined()
    expect(transition.derivation).toBeDefined()
    expect(await Effect.runPromise(transition.derivation!)).toEqual({
      childSessionId: CHILD,
      parentSessionId: ROOT,
      sourceMessageId: "parent-agent",
      sharedMessages: [
        { parentMessageId: "parent-user", childMessageId: "child-user" },
        { parentMessageId: "parent-agent", childMessageId: "child-agent" },
      ],
    })
  })

  test("rejects a native fork whose copied prefix ends before the requested turn", async () => {
    const parent = nativeForkParent()
    const child = thread(CHILD, [copiedTurn("child-turn-1", "One")])
    const derivation = await nativeForkDerivation(parent, child, "parent-turn-2")

    const error = await Effect.runPromise(Effect.flip(derivation))
    expect(error).toBeInstanceOf(ProviderProtocolError)
    expect(error.message).toContain("through requested source turn parent-turn-2")
  })

  test("rejects a native fork whose copied prefix extends after the requested turn", async () => {
    const parent = nativeForkParent()
    const child = thread(CHILD, [
      copiedTurn("child-turn-1", "One"),
      copiedTurn("child-turn-2", "Two"),
      copiedTurn("child-turn-3", "Three"),
    ])
    const derivation = await nativeForkDerivation(parent, child, "parent-turn-2")

    const error = await Effect.runPromise(Effect.flip(derivation))
    expect(error).toBeInstanceOf(ProviderProtocolError)
    expect(error.message).toContain("through requested source turn parent-turn-2")
  })

  test("prepares resume sidecar services lazily", async () => {
    let acquisitions = 0
    const provider = new CodexProvider("/project", "/usr/bin/codex", {
      appServerFactory: () => Effect.succeed(fakeClient()),
      observedServicesFactory: () => Effect.gen(function*() {
        acquisitions += 1
        return {
          remoteUrl: "ws://127.0.0.1:9",
          bearerToken: "resume-token",
          transitions: yield* PubSub.unbounded<CodexTuiProxyTransitionRequest>(),
          close: () => Effect.void,
        }
      }),
    })
    const prepared = await Effect.runPromise(provider.prepareResume({
      id: ROOT,
      title: "Root",
      lastModified: 1,
    }))
    expect(acquisitions).toBe(0)
    const acquired = await Effect.runPromise(Effect.scoped(prepared.acquireLaunch))
    expect(acquisitions).toBe(1)
    expect(acquired.launch.command).toEqual([
      "/usr/bin/codex",
      "resume",
      "--remote",
      "ws://127.0.0.1:9",
      "--remote-auth-token-env",
      "CLAUDE_TREE_CODEX_TOKEN",
      ROOT,
    ])
  })

  test("bridges proxy acknowledgment to the application transition acknowledgment", async () => {
    let source!: PubSub.PubSub<CodexTuiProxyTransitionRequest>
    const provider = new CodexProvider("/project", "/usr/bin/codex", {
      appServerFactory: () => Effect.succeed(fakeClient()),
      observedServicesFactory: () => Effect.gen(function*() {
        source = yield* PubSub.unbounded<CodexTuiProxyTransitionRequest>()
        return {
          remoteUrl: "ws://127.0.0.1:11",
          bearerToken: "token",
          transitions: source,
          close: () => Effect.void,
        }
      }),
    })
    const prepared = await Effect.runPromise(provider.prepareResume({
      id: ROOT,
      title: "Root",
      lastModified: 1,
    }))

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const acquired = yield* prepared.acquireLaunch
      const subscription = yield* PubSub.subscribe(acquired.launch.transitions!)
      const sourceAcknowledgment = yield* Deferred.make<void, CodexTuiProxyError>()
      yield* PubSub.publish(source, {
        transition: {
          _tag: "CodexThreadTransition",
          operation: "resume",
          kind: "native-fork",
          previousThreadId: ROOT,
          requestedThreadId: ROOT,
          threadId: CHILD,
          title: "Child",
          updatedAt: 2,
          cwd: "/project",
        },
        acknowledgment: sourceAcknowledgment,
      })
      const request = yield* PubSub.take(subscription)
      expect((yield* Deferred.await(sourceAcknowledgment).pipe(Effect.timeoutOption(10)))._tag).toBe("None")
      yield* Deferred.succeed(request.acknowledgment, undefined)
      yield* Deferred.await(sourceAcknowledgment).pipe(Effect.timeout(1_000))
    })))
  })

  test("fails every native transition outside the canonical project before publication", async () => {
    let source!: PubSub.PubSub<CodexTuiProxyTransitionRequest>
    const provider = new CodexProvider("/canonical/project", "/usr/bin/codex", {
      appServerFactory: () => Effect.succeed(fakeClient()),
      canonicalize: async (path) => path,
      observedServicesFactory: () => Effect.gen(function*() {
        source = yield* PubSub.unbounded<CodexTuiProxyTransitionRequest>()
        return {
          remoteUrl: "ws://127.0.0.1:13",
          bearerToken: "token",
          transitions: source,
          close: () => Effect.void,
        }
      }),
    })
    const prepared = await Effect.runPromise(provider.prepareResume({
      id: ROOT,
      title: "Root",
      lastModified: 1,
    }))

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const acquired = yield* prepared.acquireLaunch
      const subscription = yield* PubSub.subscribe(acquired.launch.transitions!)
      for (const operation of ["start", "resume", "fork"] as const) {
        yield* publishObservedTransition(source, {
          _tag: "CodexThreadTransition",
          operation,
          kind: operation === "start" ? "temporary-adoption" : "native-fork",
          previousThreadId: ROOT,
          threadId: `${operation}-foreign-child`,
          title: "Foreign",
          updatedAt: 2,
          cwd: "/foreign/project",
          ...(operation === "fork"
            ? { requestedThreadId: ROOT, forkPointTurnId: "turn" }
            : {}),
        })
        const request = yield* PubSub.take(subscription)
        expect(request.event._tag).toBe("TransitionFailed")
        if (request.event._tag === "TransitionFailed") {
          expect(request.event.error).toBeInstanceOf(ProviderProtocolError)
          expect(request.event.error.message).toContain("belongs to another project")
        }
        yield* Deferred.succeed(request.acknowledgment, undefined)
      }
    })))
  })

  test("immediately forwards every typed terminal transition failure to the proxy", async () => {
    let source!: PubSub.PubSub<CodexTuiProxyTransitionRequest>
    const provider = new CodexProvider("/project", "/usr/bin/codex", {
      appServerFactory: () => Effect.succeed(fakeClient()),
      observedServicesFactory: () => Effect.gen(function*() {
        source = yield* PubSub.unbounded<CodexTuiProxyTransitionRequest>()
        return {
          remoteUrl: "ws://127.0.0.1:12",
          bearerToken: "token",
          transitions: source,
          close: () => Effect.void,
        }
      }),
    })
    const prepared = await Effect.runPromise(provider.prepareResume({
      id: ROOT,
      title: "Root",
      lastModified: 1,
    }))
    const failures: readonly TerminalTransitionAcknowledgmentError[] = [
      new ProviderError({
        providerId: "codex",
        operation: "transition",
        message: "provider failure",
      }),
      new ProviderProtocolError({
        providerId: "codex",
        operation: "transition",
        message: "protocol failure",
      }),
      new TerminalError({
        operation: "native-session-transition",
        sessionId: ROOT,
        message: "terminal failure",
      }),
      new PersistenceError({
        operation: "commit identity",
        path: "/state",
        message: "persistence failure",
      }),
      new SessionOwnedError({
        providerId: "codex",
        sessionId: CHILD,
        ownerPid: 42,
      }),
    ]

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const acquired = yield* prepared.acquireLaunch
      const subscription = yield* PubSub.subscribe(acquired.launch.transitions!)
      for (const failure of failures) {
        const sourceAcknowledgment = yield* Deferred.make<void, CodexTuiProxyError>()
        yield* PubSub.publish(source, {
          transition: {
            _tag: "CodexThreadTransition",
            operation: "resume",
            kind: "native-fork",
            previousThreadId: ROOT,
            requestedThreadId: ROOT,
            threadId: CHILD,
            title: "Child",
            updatedAt: 2,
            cwd: "/project",
          },
          acknowledgment: sourceAcknowledgment,
        })
        const request = yield* PubSub.take(subscription)
        yield* Deferred.fail(request.acknowledgment, failure)
        const proxyError = yield* Effect.flip(
          Deferred.await(sourceAcknowledgment).pipe(Effect.timeout(1_000)),
        )
        expect(proxyError).toBeInstanceOf(CodexTuiProxyError)
        expect(proxyError.cause).toBe(failure)
      }
    })))
  })

  test("rolls back sidecar readiness and aggregates an incomplete rollback", async () => {
    let closes = 0
    const readinessError = new CodexSidecarError({
      operation: "connect",
      message: "not ready",
    })
    const sidecar = fakeSidecar(() => {
      closes += 1
      return Effect.void
    })

    const error = await Effect.runPromise(Effect.flip(Effect.scoped(makeObservedServices(
      "/usr/bin/codex",
      ROOT,
      {
        sidecarFactory: () => Effect.succeed(sidecar),
        waitUntilReady: () => Effect.fail(readinessError),
      },
    ))))
    expect(error).toBe(readinessError)
    expect(closes).toBe(1)

    const rollbackError = await Effect.runPromise(Effect.flip(Effect.scoped(makeObservedServices(
      "/usr/bin/codex",
      ROOT,
      {
        sidecarFactory: () => Effect.succeed(fakeSidecar(() => Effect.fail(new CodexSidecarError({
          operation: "cleanup",
          message: "still running",
        })))),
        waitUntilReady: () => Effect.fail(readinessError),
      },
    ))))
    expect(rollbackError).toBeInstanceOf(CodexSidecarError)
    expect(rollbackError).toMatchObject({ operation: "acquire-rollback" })
    expect(rollbackError.cause).toBeInstanceOf(AggregateError)
    expect((rollbackError.cause as AggregateError).errors).toHaveLength(2)

    const proxyRollback = await Effect.runPromise(Effect.flip(Effect.scoped(makeObservedServices(
      "/usr/bin/codex",
      ROOT,
      {
        sidecarFactory: () => Effect.succeed(fakeSidecar(() => Effect.fail(new CodexSidecarError({
          operation: "cleanup",
          message: "sidecar cleanup failed",
        })))),
        waitUntilReady: () => Effect.void,
        proxyFactory: () => Effect.fail(new CodexTuiProxyError({
          operation: "listen",
          message: "proxy failed",
        })),
      },
    ))))
    expect(proxyRollback).toMatchObject({ operation: "acquire-rollback" })
    expect(proxyRollback.cause).toBeInstanceOf(AggregateError)
  })

  test("interrupts readiness and settles sidecar rollback before acquisition exits", async () => {
    let closes = 0
    const exit = await Effect.runPromise(Effect.gen(function*() {
      const readinessStarted = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(Effect.scoped(makeObservedServices(
        "/usr/bin/codex",
        ROOT,
        {
          sidecarFactory: () => Effect.succeed(fakeSidecar(() => Effect.sync(() => {
            closes += 1
          }))),
          waitUntilReady: () => Effect.gen(function*() {
            yield* Deferred.succeed(readinessStarted, undefined)
            return yield* Effect.never
          }),
        },
      )))
      yield* Deferred.await(readinessStarted)
      yield* Fiber.interrupt(fiber)
      return yield* Fiber.await(fiber)
    }))

    expect(exit._tag).toBe("Failure")
    expect(closes).toBe(1)
  })
})

describe("Codex sidecar", () => {
  test("removes a temporary directory that resolves after acquisition timed out", async () => {
    let resolveDirectory!: (path: string) => void

    const removed = await Effect.runPromise(Effect.provide(Effect.gen(function*() {
      const directoryRemoved = yield* Deferred.make<string>()
      const fiber = yield* Effect.forkChild(Effect.scoped(makeCodexSidecar("codex", {
        makeTemporaryDirectory: () => new Promise((resolve) => {
          resolveDirectory = resolve
        }),
        removeDirectory: async (path) => {
          Deferred.doneUnsafe(directoryRemoved, Effect.succeed(path))
        },
      }, { acquisitionTimeoutMs: 10, cleanupTimeoutMs: 10 })))
      yield* Effect.yieldNow
      yield* TestClock.adjust(10)
      yield* Effect.yieldNow
      yield* TestClock.adjust(10)
      yield* Fiber.join(fiber).pipe(Effect.flip)
      resolveDirectory("/tmp/injected-codex-late")
      return yield* Deferred.await(directoryRemoved)
    }), TestClock.layer()))

    expect(removed).toBe("/tmp/injected-codex-late")
  })

  test("reports a failed cleanup when a late temporary directory resolves", async () => {
    let resolveDirectory!: (path: string) => void
    const reported: CodexSidecarError[] = []

    await Effect.runPromise(Effect.provide(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.scoped(makeCodexSidecar("codex", {
        makeTemporaryDirectory: () => new Promise((resolve) => {
          resolveDirectory = resolve
        }),
        removeDirectory: async () => { throw new Error("late remove failed") },
        reportCleanupFailure: (error) => reported.push(error),
      }, { acquisitionTimeoutMs: 10, cleanupTimeoutMs: 10 })))
      yield* Effect.yieldNow
      yield* TestClock.adjust(10)
      yield* Effect.yieldNow
      yield* TestClock.adjust(10)
      yield* Fiber.join(fiber).pipe(Effect.flip)
      resolveDirectory("/tmp/injected-codex-late-failure")
      yield* Effect.promise(() => waitUntil(() => reported.length === 1))
    }), TestClock.layer()))

    expect(reported[0]).toMatchObject({
      operation: "cleanup",
      message: expect.stringContaining("late Codex token directory"),
    })
  })

  test("requests file-handle closure when token fsync exceeds its acquisition timeout", async () => {
    const opened: string[] = []
    const closed: string[] = []
    let syncStarted = false
    const handle = (path: string): CodexSidecarFileHandle => ({
      sync: () => {
        syncStarted = true
        return new Promise<void>(() => undefined)
      },
      close: async () => { closed.push(path) },
    })

    const error = await Effect.runPromise(Effect.provide(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.scoped(makeCodexSidecar("codex", {
        makeTemporaryDirectory: async () => "/tmp/injected-codex-fsync",
        writeToken: async () => {},
        setTokenMode: async () => {},
        openFile: async (path) => {
          opened.push(path)
          return handle(path)
        },
        removeDirectory: async () => {},
      }, { acquisitionTimeoutMs: 10, cleanupTimeoutMs: 10 })))
      yield* Effect.promise(() => waitUntil(() => syncStarted))
      yield* TestClock.adjust(10)
      return yield* Fiber.join(fiber).pipe(Effect.flip)
    }), TestClock.layer()))

    expect(error).toMatchObject({ operation: "token" })
    expect(opened).toEqual(["/tmp/injected-codex-fsync/token"])
    expect(closed).toEqual(["/tmp/injected-codex-fsync/token"])
  })

  test("times out an interruptible token write and rolls back its directory without sleeps", async () => {
    const removed: string[] = []
    let releaseWrite!: () => void

    const error = await Effect.runPromise(Effect.provide(Effect.gen(function*() {
      const writeStarted = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(Effect.scoped(makeCodexSidecar("codex", {
        makeTemporaryDirectory: async () => "/tmp/injected-codex-timeout",
        writeToken: () => {
          Deferred.doneUnsafe(writeStarted, Effect.void)
          return new Promise<void>((resolve) => {
            releaseWrite = resolve
          })
        },
        removeDirectory: async (path) => { removed.push(path) },
      }, { acquisitionTimeoutMs: 10, cleanupTimeoutMs: 10 })))
      yield* Deferred.await(writeStarted)
      yield* TestClock.adjust(10)
      const failure = yield* Fiber.join(fiber).pipe(Effect.flip)
      releaseWrite()
      return failure
    }), TestClock.layer()))

    expect(error).toBeInstanceOf(CodexSidecarError)
    expect(error).toMatchObject({ operation: "token" })
    expect(removed).toEqual(["/tmp/injected-codex-timeout"])
  })

  test("interrupts sidecar acquisition and completes directory rollback before settling", async () => {
    const removed: string[] = []
    let releaseWrite!: () => void

    const result = await Effect.runPromise(Effect.gen(function*() {
      const writeStarted = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(Effect.scoped(makeCodexSidecar("codex", {
        makeTemporaryDirectory: async () => "/tmp/injected-codex-interrupt",
        writeToken: () => {
          Deferred.doneUnsafe(writeStarted, Effect.void)
          return new Promise<void>((resolve) => {
            releaseWrite = resolve
          })
        },
        removeDirectory: async (path) => { removed.push(path) },
      }, { acquisitionTimeoutMs: 1_000, cleanupTimeoutMs: 10 })))
      yield* Deferred.await(writeStarted)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      releaseWrite()
      return exit
    }))

    expect(result._tag).toBe("Failure")
    expect(removed).toEqual(["/tmp/injected-codex-interrupt"])
  })

  test("aggregates acquisition failure with token-directory rollback failure", async () => {
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(makeCodexSidecar("codex", {
      makeTemporaryDirectory: async () => "/tmp/injected-codex-partial",
      writeToken: async () => { throw new Error("write failed") },
      removeDirectory: async () => { throw new Error("remove failed") },
    }))))

    expect(error).toBeInstanceOf(CodexSidecarError)
    expect(error).toMatchObject({ operation: "acquire-rollback" })
    expect(error.cause).toBeInstanceOf(AggregateError)
    expect((error.cause as AggregateError).errors).toHaveLength(2)
  })

  test("writes a 0600 token and bounds TERM/KILL cleanup", async () => {
    const modes: number[] = []
    const signals: NodeJS.Signals[] = []
    const removed: string[] = []
    let exitCode: number | null = null
    let resolveExit!: (code: number) => void
    const process: CodexSidecarProcess = {
      pid: 42,
      get exitCode() { return exitCode },
      exited: new Promise((resolve) => {
        resolveExit = resolve
      }),
      stderr: new ReadableStream({ start: (controller) => controller.close() }),
      kill() {},
      unref() {},
    }

    await Effect.runPromise(Effect.scoped(makeCodexSidecar("/usr/bin/codex", {
      makeTemporaryDirectory: async () => "/tmp/injected-codex",
      async writeToken(_path, _token, options) {
        modes.push(options.mode)
      },
      async setTokenMode(_path, mode) {
        modes.push(mode)
      },
      syncToken: async () => {},
      async removeDirectory(path) {
        removed.push(path)
      },
      allocatePort: async () => 12345,
      randomUUID: () => "token-value",
      spawn: () => process,
      signalProcessGroup(_process, signal) {
        signals.push(signal)
        if (signal === "SIGKILL") {
          exitCode = 0
          resolveExit(0)
        }
      },
    }, { cleanupTimeoutMs: 1 })))

    expect(modes).toEqual([0o600, 0o600])
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(removed).toEqual(["/tmp/injected-codex"])
  })

  test("captures bounded stderr without EOF and cancels the scoped reader", async () => {
    let stderrCancelled = false
    let exitCode: number | null = null
    let resolveExit!: (code: number) => void
    const process: CodexSidecarProcess = {
      pid: 43,
      get exitCode() { return exitCode },
      exited: new Promise((resolve) => { resolveExit = resolve }),
      stderr: new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("diagnostic")) },
        cancel() { stderrCancelled = true },
      }),
      kill() {},
      unref() {},
    }

    const detail = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const sidecar = yield* makeCodexSidecar("codex", {
        makeTemporaryDirectory: async () => "/tmp/injected-codex-stderr",
        writeToken: async () => {},
        setTokenMode: async () => {},
        syncToken: async () => {},
        removeDirectory: async () => {},
        allocatePort: async () => 12346,
        randomUUID: () => "token",
        spawn: () => process,
        signalProcessGroup() {
          exitCode = 0
          resolveExit(0)
        },
      }, { cleanupTimeoutMs: 10 })
      yield* Effect.sleep(1)
      return yield* sidecar.stderr
    })))

    expect(detail).toBe("diagnostic")
    expect(stderrCancelled).toBeTrue()
  })

  test("retries sidecar cleanup after a process survives the first escalation", async () => {
    const signals: NodeJS.Signals[] = []
    let exitCode: number | null = null
    let resolveExit!: (code: number) => void
    const process: CodexSidecarProcess = {
      pid: 44,
      get exitCode() { return exitCode },
      exited: new Promise((resolve) => { resolveExit = resolve }),
      stderr: new ReadableStream({ start() {} }),
      kill() {},
      unref() {},
    }

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const sidecar = yield* makeCodexSidecar("codex", {
        makeTemporaryDirectory: async () => "/tmp/injected-codex-retry",
        writeToken: async () => {},
        setTokenMode: async () => {},
        syncToken: async () => {},
        removeDirectory: async () => {},
        allocatePort: async () => 12347,
        randomUUID: () => "token",
        spawn: () => process,
        signalProcessGroup(_process, signal) {
          signals.push(signal)
          if (signal === "SIGKILL" && signals.filter((value) => value === "SIGKILL").length === 2) {
            exitCode = 0
            resolveExit(0)
          }
        },
      }, { cleanupTimeoutMs: 2 })
      expect(yield* Effect.flip(sidecar.close())).toBeInstanceOf(Error)
      yield* sidecar.close()
    })))

    expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"])
  })

  test("continues sidecar cleanup after a signal error", async () => {
    const signals: NodeJS.Signals[] = []
    const removed: string[] = []
    let stderrCancelled = false
    let exitCode: number | null = null
    let resolveExit!: (code: number) => void
    const process: CodexSidecarProcess = {
      pid: 45,
      get exitCode() { return exitCode },
      exited: new Promise((resolve) => { resolveExit = resolve }),
      stderr: new ReadableStream({
        start() {},
        cancel() { stderrCancelled = true },
      }),
      kill() {},
      unref() {},
    }

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const sidecar = yield* makeCodexSidecar("codex", {
        makeTemporaryDirectory: async () => "/tmp/injected-codex-signal",
        writeToken: async () => {},
        setTokenMode: async () => {},
        syncToken: async () => {},
        removeDirectory: async (path) => { removed.push(path) },
        allocatePort: async () => 12348,
        randomUUID: () => "token",
        spawn: () => process,
        signalProcessGroup(_process, signal) {
          signals.push(signal)
          if (signal === "SIGTERM") throw new Error("term failed")
          exitCode = 0
          resolveExit(0)
        },
      }, { cleanupTimeoutMs: 2 })
      expect(yield* Effect.flip(sidecar.close())).toBeInstanceOf(Error)
    })))

    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(stderrCancelled).toBeTrue()
    expect(removed).toEqual(["/tmp/injected-codex-signal"])
  })
})

describe("Codex terminal observer", () => {
  test("ports OSC, blockers, working rows, and drafts to TerminalScreen", () => {
    const observer = new CodexTerminalObserver()
    const encoder = new TextEncoder()
    expect(observer.observeOutput(encoder.encode("\u001b]0;⠋ Working"))).toEqual([])
    expect(observer.observeOutput(encoder.encode(
      "\u0007\u001b]2;Codex | Ready\u001b\\",
    ))).toEqual(["working", "idle"])

    const composer = {
      lines: ["› first line", "  second line", "? for shortcuts"],
      cursor: { x: 8, y: 1, visible: true },
    }
    expect(observeCodexDraft(composer)).toBe("first line\n  second line")
    expect(observeCodexActivity(composer)).toBe("idle")
    expect(observeCodexActivity({
      lines: ["Allow command?", "❯ Yes", "  No"],
      cursor: { x: 2, y: 1, visible: true },
    })).toBe("blocked")
    expect(observeCodexActivity({
      lines: ["Working (2s · esc to interrupt)"],
      cursor: { x: 0, y: 0, visible: false },
    })).toBe("working")
  })
})

interface FakeClient extends CodexAppServerClient {
  readonly readCalls: string[]
  readonly forkCalls: Array<{ threadId: string; turnId: string; cwd: string }>
}

function fakeClient(overrides: Partial<CodexAppServerClient> = {}): FakeClient {
  const readCalls: string[] = []
  const forkCalls: Array<{ threadId: string; turnId: string; cwd: string }> = []
  return {
    readCalls,
    forkCalls,
    listThreads: overrides.listThreads ?? (() => Effect.succeed({ data: [], nextCursor: null })),
    listLoadedThreadIds: overrides.listLoadedThreadIds ?? (() => Effect.succeed([])),
    readThread(id, includeTurns) {
      readCalls.push(id)
      return overrides.readThread?.(id, includeTurns) ?? Effect.succeed(thread(id))
    },
    forkThread(threadId, turnId, cwd) {
      forkCalls.push({ threadId, turnId, cwd })
      return overrides.forkThread?.(threadId, turnId, cwd) ?? Effect.succeed(thread(CHILD))
    },
    close: overrides.close ?? (() => Effect.void),
  }
}

function fakeSidecar(
  close: () => Effect.Effect<void, CodexSidecarError>,
): CodexSidecar {
  return {
    remoteUrl: "ws://127.0.0.1:12345",
    bearerToken: "token",
    process: {
      pid: 42,
      exitCode: null,
      exited: new Promise(() => {}),
      stderr: new ReadableStream({ start() {} }),
      kill() {},
      unref() {},
    },
    stderr: Effect.succeed(""),
    close,
  }
}

function providerWith(
  client: FakeClient,
  options: ConstructorParameters<typeof CodexProvider>[3] = { overloadRetryDelaysMs: [] },
): CodexProvider {
  return new CodexProvider("/project", "/usr/bin/codex", {
    appServerFactory: () => Effect.succeed(client),
    observedServicesFactory: inertObservedServices,
    canonicalize: (path) => path,
  }, options)
}

const inertObservedServices: CodexObservedServicesFactory = () => Effect.gen(function*() {
  return {
    remoteUrl: "ws://127.0.0.1:1",
    bearerToken: "token",
    transitions: yield* PubSub.unbounded<CodexTuiProxyTransitionRequest>(),
    close: () => Effect.void,
  }
})

function thread(
  id: string,
  turns: readonly CodexTurn[] = [],
  overrides: Partial<CodexThread> = {},
): CodexThread {
  return {
    id,
    name: null,
    preview: "Preview",
    updatedAt: 1,
    cwd: "/project",
    gitInfo: null,
    turns,
    ...overrides,
  }
}

function turn(
  id: string,
  status: CodexTurn["status"],
  items: readonly CodexThreadItem[],
): CodexTurn {
  return { id, status, items }
}

function user(id: string, content: readonly Record<string, unknown>[]): CodexThreadItem {
  return { id, type: "userMessage", content } as CodexThreadItem
}

function nativeForkParent(): CodexThread {
  return thread(ROOT, [
    copiedTurn("parent-turn-1", "One", "parent"),
    copiedTurn("parent-turn-2", "Two", "parent"),
    copiedTurn("parent-turn-3", "Three", "parent"),
  ])
}

function copiedTurn(id: string, text: string, itemPrefix = "child"): CodexTurn {
  return turn(id, "completed", [
    user(`${itemPrefix}-user-${text}`, [{ type: "text", text: `Question ${text}` }]),
    { id: `${itemPrefix}-agent-${text}`, type: "agentMessage", text: `Answer ${text}` },
  ])
}

async function nativeForkDerivation(
  parent: CodexThread,
  child: CodexThread,
  forkPointTurnId: string,
) {
  const client = fakeClient({
    readThread: (id) => Effect.succeed(id === ROOT ? parent : child),
  })
  let source!: PubSub.PubSub<CodexTuiProxyTransitionRequest>
  const provider = new CodexProvider("/project", "/usr/bin/codex", {
    appServerFactory: () => Effect.succeed(client),
    observedServicesFactory: () => Effect.gen(function*() {
      source = yield* PubSub.unbounded<CodexTuiProxyTransitionRequest>()
      return {
        remoteUrl: "ws://127.0.0.1:7",
        bearerToken: "token",
        transitions: source,
        close: () => Effect.void,
      }
    }),
  })
  const prepared = await Effect.runPromise(provider.prepareResume({
    id: ROOT,
    title: "Root",
    lastModified: 1,
  }))
  const transition = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const acquired = yield* prepared.acquireLaunch
    const subscription = yield* PubSub.subscribe(acquired.launch.transitions!)
    yield* publishObservedTransition(source, {
      _tag: "CodexThreadTransition",
      operation: "fork",
      kind: "native-fork",
      previousThreadId: ROOT,
      requestedThreadId: ROOT,
      forkPointTurnId,
      threadId: CHILD,
      title: "Fork",
      updatedAt: 2,
      cwd: "/project",
    })
    const request = yield* PubSub.take(subscription)
    yield* Deferred.succeed(request.acknowledgment, undefined)
    return request.event
  })))
  if (transition._tag !== "SessionChanged" || !transition.derivation) {
    throw new Error("expected a fork derivation")
  }
  return transition.derivation
}

function publishObservedTransition(
  source: PubSub.PubSub<CodexTuiProxyTransitionRequest>,
  transition: CodexTuiProxyTransition,
): Effect.Effect<boolean> {
  return Effect.gen(function*() {
    const acknowledgment = yield* Deferred.make<void, CodexTuiProxyError>()
    return yield* PubSub.publish(source, { transition, acknowledgment })
  })
}

function takeAndAcknowledgeTransition(
  subscription: PubSub.Subscription<TerminalTransitionRequest>,
): Effect.Effect<TerminalTransitionRequest["event"]> {
  return Effect.gen(function*() {
    const request = yield* PubSub.take(subscription)
    yield* Deferred.succeed(request.acknowledgment, undefined)
    return request.event
  })
}

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!condition() && performance.now() < deadline) await Bun.sleep(1)
  if (!condition()) throw new Error("Condition was not met before timeout")
}
