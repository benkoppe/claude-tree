import { describe, expect, test } from "bun:test"

import { Effect, PubSub } from "effect"

import { NullTerminalObserver } from "../../src/domain/model"
import { ProviderProtocolError } from "../../src/domain/errors"
import {
  CodexProcessError,
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
  normalizeCodexThread,
  type CodexObservedServicesFactory,
} from "../../src/infrastructure/providers/codex/provider"
import {
  makeCodexSidecar,
  type CodexSidecarProcess,
} from "../../src/infrastructure/providers/codex/sidecar"
import {
  CodexTerminalObserver,
  observeCodexActivity,
  observeCodexDraft,
} from "../../src/infrastructure/providers/codex/terminal-observer"
import type { CodexTuiProxyTransition } from "../../src/infrastructure/providers/codex/tui-proxy"

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
    expect(canonicalized).toEqual(["/project-link"])
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
    let source!: PubSub.PubSub<CodexTuiProxyTransition>
    const observedServicesFactory: CodexObservedServicesFactory = () => Effect.gen(function*() {
      acquisitions += 1
      source = yield* PubSub.unbounded<CodexTuiProxyTransition>()
      return {
        remoteUrl: "ws://127.0.0.1:12345",
        bearerToken: "secret",
        transitions: source,
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
      const launch = yield* prepared.acquireLaunch
      expect(launch.command).toEqual([
        "/usr/bin/codex",
        "--remote",
        "ws://127.0.0.1:12345",
        "--remote-auth-token-env",
        "CLAUDE_TREE_CODEX_TOKEN",
        "--cd",
        "/project",
      ])
      const subscription = yield* PubSub.subscribe(launch.transitions!)
      yield* PubSub.publish(source, {
        _tag: "CodexThreadTransition",
        operation: "start",
        previousThreadId: prepared.session.id,
        threadId: CHILD,
        title: "First prompt",
        updatedAt: 21,
      })
      return yield* PubSub.take(subscription)
    })))
    expect(acquisitions).toBe(1)
    expect(result).toEqual({
      _tag: "SessionChanged",
      session: {
        id: CHILD,
        title: "First prompt",
        lastModified: 21_000,
        transient: true,
      },
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
    let source!: PubSub.PubSub<CodexTuiProxyTransition>
    const provider = new CodexProvider("/project", "/usr/bin/codex", {
      appServerFactory: () => Effect.succeed(client),
      observedServicesFactory: () => Effect.gen(function*() {
        source = yield* PubSub.unbounded<CodexTuiProxyTransition>()
        return {
          remoteUrl: "ws://127.0.0.1:7",
          bearerToken: "token",
          transitions: source,
        }
      }),
    })
    const prepared = await Effect.runPromise(provider.prepareResume({
      id: ROOT,
      title: "Root",
      lastModified: 1,
    }))
    const transition = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const launch = yield* prepared.acquireLaunch
      const subscription = yield* PubSub.subscribe(launch.transitions!)
      yield* PubSub.publish(source, {
        _tag: "CodexThreadTransition",
        operation: "fork",
        previousThreadId: ROOT,
        requestedThreadId: ROOT,
        forkPointTurnId: "parent-turn",
        threadId: CHILD,
        title: "Fork",
        updatedAt: 2,
      })
      return yield* PubSub.take(subscription)
    })))

    expect(transition._tag).toBe("SessionChanged")
    if (transition._tag !== "SessionChanged") throw transition.error
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
          transitions: yield* PubSub.unbounded<CodexTuiProxyTransition>(),
        }
      }),
    })
    const prepared = await Effect.runPromise(provider.prepareResume({
      id: ROOT,
      title: "Root",
      lastModified: 1,
    }))
    expect(acquisitions).toBe(0)
    const launch = await Effect.runPromise(Effect.scoped(prepared.acquireLaunch))
    expect(acquisitions).toBe(1)
    expect(launch.command).toEqual([
      "/usr/bin/codex",
      "resume",
      "--remote",
      "ws://127.0.0.1:9",
      "--remote-auth-token-env",
      "CLAUDE_TREE_CODEX_TOKEN",
      ROOT,
    ])
  })
})

describe("Codex sidecar", () => {
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

function providerWith(
  client: FakeClient,
  options: ConstructorParameters<typeof CodexProvider>[3] = { overloadRetryDelaysMs: [] },
): CodexProvider {
  return new CodexProvider("/project", "/usr/bin/codex", {
    appServerFactory: () => Effect.succeed(client),
    observedServicesFactory: inertObservedServices,
  }, options)
}

const inertObservedServices: CodexObservedServicesFactory = () => Effect.gen(function*() {
  return {
    remoteUrl: "ws://127.0.0.1:1",
    bearerToken: "token",
    transitions: yield* PubSub.unbounded<CodexTuiProxyTransition>(),
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
  let source!: PubSub.PubSub<CodexTuiProxyTransition>
  const provider = new CodexProvider("/project", "/usr/bin/codex", {
    appServerFactory: () => Effect.succeed(client),
    observedServicesFactory: () => Effect.gen(function*() {
      source = yield* PubSub.unbounded<CodexTuiProxyTransition>()
      return {
        remoteUrl: "ws://127.0.0.1:7",
        bearerToken: "token",
        transitions: source,
      }
    }),
  })
  const prepared = await Effect.runPromise(provider.prepareResume({
    id: ROOT,
    title: "Root",
    lastModified: 1,
  }))
  const transition = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const launch = yield* prepared.acquireLaunch
    const subscription = yield* PubSub.subscribe(launch.transitions!)
    yield* PubSub.publish(source, {
      _tag: "CodexThreadTransition",
      operation: "fork",
      previousThreadId: ROOT,
      requestedThreadId: ROOT,
      forkPointTurnId,
      threadId: CHILD,
      title: "Fork",
      updatedAt: 2,
    })
    return yield* PubSub.take(subscription)
  })))
  if (transition._tag !== "SessionChanged" || !transition.derivation) {
    throw new Error("expected a fork derivation")
  }
  return transition.derivation
}
