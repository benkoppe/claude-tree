import { describe, expect, test } from "bun:test"

import type {
  SDKSessionInfo,
  SessionMessage,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { ProviderProtocolError } from "../../src/domain/errors"
import {
  ClaudeProvider,
  claudeProviderLayer,
  type ClaudeSdk,
} from "../../src/infrastructure/providers/claude/provider"
import {
  ClaudeTerminalObserver,
  observeClaudeActivity,
  observeClaudeDraft,
} from "../../src/infrastructure/providers/claude/terminal-observer"
import { AgentProvider } from "../../src/services/provider"

const ROOT = "11111111-1111-4111-8111-111111111111"
const CHILD = "22222222-2222-4222-8222-222222222222"
const NEW = "33333333-3333-4333-8333-333333333333"

describe("Effect Claude provider", () => {
  test("provides AgentProviderApi through an Effect layer", async () => {
    const id = await Effect.runPromise(Effect.provide(
      AgentProvider.use((provider) => Effect.succeed(provider.id)),
      claudeProviderLayer("/project", {
        sdk: fakeSdk(),
        resolveExecutable: () => "/usr/bin/claude",
      }),
    ))
    expect(id).toBe("claude")
  })

  test("discovers sessions and isolates transcript outcomes while retaining normalization identity", async () => {
    const user = message(ROOT, "user-1", "user", "question")
    const firstAgent = message(ROOT, "agent-1", "assistant", "checking", undefined, "tool_use")
    const toolResult = message(ROOT, "tool-result", "user", "", undefined, undefined, [
      { type: "tool_result", tool_use_id: "tool", content: "done" },
    ])
    const command = message(
      ROOT,
      "command",
      "user",
      "<command-name>/status</command-name>",
    )
    const secondAgent = message(ROOT, "agent-2", "assistant", "answer", undefined, "end_turn")
    const rootMessages = [user, firstAgent, toolResult, command, secondAgent]
    const provider = providerWith({
      messages: {
        [ROOT]: rootMessages,
        [CHILD]: new Error("permission denied"),
        missing: null,
      },
    })

    const snapshot = await Effect.runPromise(provider.loadSessionSnapshot)
    const explicit = await Effect.runPromise(provider.readTranscripts([ROOT, CHILD, "missing"]))
    const transcript = explicit.get(ROOT)

    expect(snapshot.sessions).toEqual([
      { id: ROOT, title: "Root session", lastModified: 7, gitBranch: "main" },
      { id: CHILD, title: "Child session", lastModified: 6 },
    ])
    expect(snapshot.transcripts.get(CHILD)).toEqual({
      _tag: "Unavailable",
      reason: "Claude readTranscripts failed: permission denied",
    })
    expect(explicit.get("missing")).toEqual({ _tag: "Missing" })
    expect(transcript?._tag).toBe("Available")
    if (transcript?._tag !== "Available") throw new Error("expected transcript")
    expect(transcript.messages.map(({ id, visible }) => ({ id, visible }))).toEqual([
      { id: "user-1", visible: true },
      { id: "agent-1", visible: true },
      { id: "tool-result", visible: false },
      { id: "command", visible: false },
      { id: "agent-2", visible: true },
    ])
    expect(transcript.messages[1]?.displayGroupId).toBe("user-1")
    expect(transcript.messages[4]?.displayGroupId).toBe("user-1")
    expect(transcript.messages[1]?.turnComplete).toBeFalse()
    expect(transcript.messages[4]?.turnComplete).toBeTrue()
    expect(transcript.messages[4]?.copyIdentity).toBe(JSON.stringify(secondAgent.message))
  })

  test("allocates new sessions with TestClock and acquires exact commands lazily in scope", async () => {
    let executableReads = 0
    const provider = providerWith({
      randomUUID: () => NEW,
      resolveExecutable: () => {
        executableReads += 1
        return "/usr/local/bin/claude"
      },
    })

    const prepared = await Effect.runPromise(
      Effect.provide(provider.prepareNewSession, TestClock.layer()),
    )
    expect(prepared.session).toEqual({
      id: NEW,
      title: "New conversation",
      lastModified: 0,
      transient: true,
    })
    expect(executableReads).toBe(0)

    const launch = await Effect.runPromise(Effect.scoped(prepared.acquireLaunch))
    expect(executableReads).toBe(1)
    expect(launch.command).toEqual(["/usr/local/bin/claude", "--session-id", NEW])

    const resumed = await Effect.runPromise(provider.prepareResume({
      id: ROOT,
      title: "Root",
      lastModified: 1,
    }))
    expect(executableReads).toBe(1)
    expect((await Effect.runPromise(Effect.scoped(resumed.acquireLaunch))).command).toEqual([
      "/usr/local/bin/claude",
      "--resume",
      ROOT,
    ])
  })

  test("replays user text from the nearest agent with exact prefill", async () => {
    const parent = [
      message(ROOT, "user-1", "user", "first"),
      message(ROOT, "agent-1", "assistant", "answer"),
      message(ROOT, "user-2", "user", "  replay\nexactly  "),
    ]
    const copied = parent.slice(0, 2).map((entry, index) =>
      copyMessage(entry, CHILD, `child-${index + 1}`),
    )
    let forkCalls = 0
    let forkBoundary: string | undefined
    const provider = providerWith({
      messages: { [ROOT]: parent, [CHILD]: copied },
      physical: {
        [ROOT]: parent,
        [CHILD]: copied.map((entry, index) => copiedRecord(entry, ROOT, parent[index]!.uuid)),
      },
      onFork: (messageId) => {
        forkCalls += 1
        forkBoundary = messageId
      },
    })

    const outcome = await Effect.runPromise(provider.branchFrom({
      sessionId: ROOT,
      messageId: "user-2",
    }))

    expect(outcome._tag).toBe("ValidatedBranch")
    if (outcome._tag !== "ValidatedBranch") throw new Error(outcome.reason)
    expect(forkCalls).toBe(1)
    expect(forkBoundary).toBe("agent-1")
    expect(outcome.derivation).toEqual({
      childSessionId: CHILD,
      parentSessionId: ROOT,
      sourceMessageId: "agent-1",
      sharedMessages: [
        { parentMessageId: "user-1", childMessageId: "child-1" },
        { parentMessageId: "agent-1", childMessageId: "child-2" },
      ],
    })
    const launch = await Effect.runPromise(Effect.scoped(outcome.acquireLaunch))
    expect(launch.command).toEqual([
      "/usr/bin/claude",
      "--resume",
      CHILD,
      "--prefill=  replay\nexactly  ",
    ])
    expect(launch.initialDraft).toEqual({ text: "  replay\nexactly  ", exact: true })
  })

  test("replays an initial user message through a zero-prefix transient session", async () => {
    let forkCalls = 0
    const parent = [message(ROOT, "user-1", "user", "replay me")]
    const provider = providerWith({
      messages: { [ROOT]: parent },
      physical: { [ROOT]: parent },
      randomUUID: () => NEW,
      onFork: () => {
        forkCalls += 1
      },
    })

    const outcome = await Effect.runPromise(provider.branchFrom({
      sessionId: ROOT,
      messageId: "user-1",
    }))

    expect(outcome._tag).toBe("ValidatedBranch")
    if (outcome._tag !== "ValidatedBranch") throw new Error(outcome.reason)
    expect(forkCalls).toBe(0)
    expect(outcome.session.transient).toBeTrue()
    expect(outcome.derivation).toEqual({
      childSessionId: NEW,
      parentSessionId: ROOT,
      sourceMessageId: "user-1",
      sharedMessages: [],
    })
    expect((await Effect.runPromise(Effect.scoped(outcome.acquireLaunch))).command).toEqual([
      "/usr/bin/claude",
      "--session-id",
      NEW,
      "--prefill=replay me",
    ])
  })

  test("rejects an inexact prefill before forkSession", async () => {
    let forkCalls = 0
    const parent = [
      message(ROOT, "agent-1", "assistant", "answer"),
      message(ROOT, "user-1", "user", "bad\0prompt"),
    ]
    const provider = providerWith({
      messages: { [ROOT]: parent },
      physical: { [ROOT]: parent },
      onFork: () => {
        forkCalls += 1
      },
    })

    const error = await Effect.runPromise(
      Effect.flip(provider.branchFrom({ sessionId: ROOT, messageId: "user-1" })),
    )
    expect(error).toBeInstanceOf(ProviderProtocolError)
    expect(error.message).toBe("Claude prompt prefill cannot contain a null byte")
    expect(forkCalls).toBe(0)
  })

  test("rejects user text that cannot round-trip through a UTF-8 command argument", async () => {
    let forkCalls = 0
    const parent = [
      message(ROOT, "agent-1", "assistant", "answer"),
      message(ROOT, "user-1", "user", "bad \ud800 prompt"),
    ]
    const provider = providerWith({
      messages: { [ROOT]: parent },
      physical: { [ROOT]: parent },
      onFork: () => {
        forkCalls += 1
      },
    })

    const error = await Effect.runPromise(
      Effect.flip(provider.branchFrom({ sessionId: ROOT, messageId: "user-1" })),
    )
    expect(error).toBeInstanceOf(ProviderProtocolError)
    expect(error.message).toBe("Claude prompt prefill must be exactly representable as UTF-8 text")
    expect(forkCalls).toBe(0)
  })

  test("accepts an ordered compacted active child while validating every physical record", async () => {
    const parent = [
      message(ROOT, "parent-1", "user", "question"),
      message(ROOT, "parent-2", "assistant", "preserved answer"),
      message(ROOT, "parent-3", "user", "follow-up"),
      message(ROOT, "parent-4", "assistant", "final answer"),
    ]
    const copied = parent.map((entry, index) => copyMessage(entry, CHILD, `child-${index + 1}`))
    const activeChild = [copied[0]!, copied[2]!, copied[3]!]
    const provider = providerWith({
      messages: { [ROOT]: parent, [CHILD]: activeChild },
      physical: {
        [ROOT]: parent,
        [CHILD]: copied.map((entry, index) => copiedRecord(entry, ROOT, parent[index]!.uuid)),
      },
    })

    const outcome = await Effect.runPromise(provider.branchFrom({
      sessionId: ROOT,
      messageId: "parent-4",
    }))

    expect(outcome._tag).toBe("ValidatedBranch")
    if (outcome._tag !== "ValidatedBranch") throw new Error(outcome.reason)
    expect(outcome.derivation.sharedMessages).toEqual(parent.map((entry, index) => ({
      parentMessageId: entry.uuid,
      childMessageId: copied[index]!.uuid,
    })))
  })

  test("forks exactly once across bounded post-create reads", async () => {
    const parent = [
      message(ROOT, "parent-1", "user", "question"),
      message(ROOT, "parent-2", "assistant", "answer"),
    ]
    const copied = parent.map((entry, index) => copyMessage(entry, CHILD, `child-${index + 1}`))
    let forkCalls = 0
    let childReads = 0
    const provider = providerWith({
      messages: {
        [ROOT]: parent,
        [CHILD]: () => {
          childReads += 1
          return childReads === 1 ? copied.slice(0, 1) : copied
        },
      },
      physical: {
        [ROOT]: parent,
        [CHILD]: copied.map((entry, index) => copiedRecord(entry, ROOT, parent[index]!.uuid)),
      },
      onFork: () => {
        forkCalls += 1
      },
      retryDelays: [0],
    })

    const outcome = await Effect.runPromise(provider.branchFrom({
      sessionId: ROOT,
      messageId: "parent-2",
    }))

    expect(outcome._tag).toBe("ValidatedBranch")
    expect(forkCalls).toBe(1)
    expect(childReads).toBe(2)
  })

  test("returns CreatedIndependentSession after post-create payload validation fails", async () => {
    const parent = [
      message(ROOT, "parent-1", "user", "question"),
      message(ROOT, "parent-2", "assistant", "answer"),
    ]
    const copied = parent.map((entry, index) => copyMessage(entry, CHILD, `child-${index + 1}`))
    const tampered = copied.map((entry, index) => copiedRecord(
      index === 1 ? message(CHILD, entry.uuid, "assistant", "different") : entry,
      ROOT,
      parent[index]!.uuid,
    ))
    const provider = providerWith({
      messages: { [ROOT]: parent, [CHILD]: copied },
      physical: { [ROOT]: parent, [CHILD]: tampered },
      retryDelays: [],
    })

    const outcome = await Effect.runPromise(provider.branchFrom({
      sessionId: ROOT,
      messageId: "parent-2",
    }))

    expect(outcome._tag).toBe("CreatedIndependentSession")
    if (outcome._tag !== "CreatedIndependentSession") throw new Error("expected independent")
    expect(outcome.session.id).toBe(CHILD)
    expect(outcome.transcript._tag).toBe("Available")
    expect(outcome.reason).toContain("physical copied prefix does not exactly match")
    expect(outcome.acquireLaunch).toBeDefined()
  })

  test("returns CreatedIndependentSession after bounded post-create reads remain unavailable", async () => {
    const parent = [
      message(ROOT, "parent-1", "user", "question"),
      message(ROOT, "parent-2", "assistant", "answer"),
    ]
    let childReads = 0
    const provider = providerWith({
      messages: {
        [ROOT]: parent,
        [CHILD]: () => {
          childReads += 1
          throw new Error("not persisted")
        },
      },
      physical: { [ROOT]: parent },
      retryDelays: [0, 0],
    })

    const outcome = await Effect.runPromise(provider.branchFrom({
      sessionId: ROOT,
      messageId: "parent-2",
    }))

    expect(outcome._tag).toBe("CreatedIndependentSession")
    if (outcome._tag !== "CreatedIndependentSession") throw new Error("expected independent")
    expect(childReads).toBe(3)
    expect(outcome.transcript).toEqual({
      _tag: "Unavailable",
      reason: "Claude validateFork failed: not persisted",
    })
  })

  test("returns CreatedIndependentSession after post-create launch preparation fails", async () => {
    const parent = [message(ROOT, "parent-1", "assistant", "answer")]
    const provider = providerWith({
      messages: { [ROOT]: parent },
      physical: { [ROOT]: parent },
      childSessionId: "invalid\0child",
    })

    const outcome = await Effect.runPromise(provider.branchFrom({
      sessionId: ROOT,
      messageId: "parent-1",
    }))

    expect(outcome._tag).toBe("CreatedIndependentSession")
    if (outcome._tag !== "CreatedIndependentSession") throw new Error("expected independent")
    expect(outcome.reason).toBe("Claude session IDs must be non-empty and cannot contain null bytes")
    expect(outcome.acquireLaunch).toBeUndefined()
  })

  test("times out a hung session list through the typed provider error channel", async () => {
    const provider = providerWith({
      listSessions: () => new Promise<readonly SDKSessionInfo[]>(() => undefined),
      listSessionsTimeoutMs: 10,
    })

    const error = await Effect.runPromise(Effect.provide(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(provider.loadSessionSnapshot)
        yield* Effect.yieldNow
        yield* TestClock.adjust(10)
        return yield* Fiber.join(fiber).pipe(Effect.flip)
      }),
      TestClock.layer(),
    ))

    expect(error.message).toBe("Claude listSessions timed out after 10ms")
    expect(error.operation).toBe("listSessions")
  })

  test("bounds transcript reads and turns a hung read into an unavailable transcript", async () => {
    let activeReads = 0
    let maxActiveReads = 0
    const completions: Array<() => void> = []
    const sdk = fakeSdk()
    const provider = new ClaudeProvider(
      "/project",
      {
        sdk: {
          ...sdk,
          getSessionMessages: (sessionId) => new Promise((resolve) => {
            activeReads += 1
            maxActiveReads = Math.max(maxActiveReads, activeReads)
            completions.push(() => {
              activeReads -= 1
              resolve([message(sessionId, `message-${sessionId}`, "user", sessionId)])
            })
          }),
        },
        resolveExecutable: () => "/usr/bin/claude",
      },
      { transcriptReadTimeoutMs: 100 },
    )
    const sessionIds = Array.from({ length: 9 }, (_, index) => `session-${index}`)

    const fiber = Effect.runFork(provider.readTranscripts(sessionIds))
    await waitUntil(() => completions.length === 8)
    expect(maxActiveReads).toBe(8)
    completions.shift()?.()
    await waitUntil(() => completions.length === 8)
    for (const complete of completions) complete()
    const transcripts = await Effect.runPromise(Fiber.join(fiber))
    expect(transcripts.size).toBe(9)

    let rejectLate: ((cause: unknown) => void) | undefined
    const hungProvider = providerWith({
      messages: {
        [ROOT]: () => new Promise<never>((_resolve, reject) => {
          rejectLate = reject
        }),
      },
      transcriptReadTimeoutMs: 10,
    })
    const timedOut = await Effect.runPromise(Effect.provide(
      Effect.gen(function*() {
        const readFiber = yield* Effect.forkChild(hungProvider.readTranscripts([ROOT]))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10)
        return yield* Fiber.join(readFiber)
      }),
      TestClock.layer(),
    ))
    expect(timedOut.get(ROOT)).toEqual({
      _tag: "Unavailable",
      reason: "Claude readTranscripts timed out after 10ms",
    })
    rejectLate?.(new Error("late read rejection"))
    await Promise.resolve()
  })

  test("keeps an interrupted SDK read observed when its promise rejects later", async () => {
    let rejectLate: ((cause: unknown) => void) | undefined
    let readCalls = 0
    const provider = providerWith({
      messages: {
        [ROOT]: () => new Promise<never>((_resolve, reject) => {
          readCalls += 1
          rejectLate = reject
        }),
      },
    })
    const unhandled: unknown[] = []
    const onUnhandled = (cause: unknown) => unhandled.push(cause)
    process.on("unhandledRejection", onUnhandled)

    try {
      const fiber = Effect.runFork(provider.readTranscripts([ROOT]))
      await waitUntil(() => rejectLate !== undefined)
      await Effect.runPromise(Fiber.interrupt(fiber))
      rejectLate?.(new Error("late interrupted rejection"))
      await Bun.sleep(5)

      expect(readCalls).toBe(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("returns an independent child when imported fork provenance hangs", async () => {
    const parent = [message(ROOT, "parent-1", "assistant", "answer")]
    const copied = [copyMessage(parent[0]!, CHILD, "child-1")]
    let forkCalls = 0
    let rejectLate: ((cause: unknown) => void) | undefined
    const provider = providerWith({
      messages: { [ROOT]: parent, [CHILD]: copied },
      physical: {
        [ROOT]: parent,
        [CHILD]: () => new Promise<never>((_resolve, reject) => {
          rejectLate = reject
        }),
      },
      onFork: () => {
        forkCalls += 1
      },
      provenanceImportTimeoutMs: 10,
      forkValidationTimeoutMs: 100,
    })

    const outcome = await Effect.runPromise(Effect.provide(
      Effect.gen(function*() {
        const branchFiber = yield* Effect.forkChild(provider.branchFrom({
          sessionId: ROOT,
          messageId: "parent-1",
        }))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10)
        return yield* Fiber.join(branchFiber)
      }),
      TestClock.layer(),
    ))

    expect(forkCalls).toBe(1)
    expect(outcome._tag).toBe("CreatedIndependentSession")
    if (outcome._tag !== "CreatedIndependentSession") throw new Error("expected independent")
    expect(outcome.session.id).toBe(CHILD)
    expect(outcome.transcript._tag).toBe("Available")
    expect(outcome.reason).toContain("Claude validateFork timed out after 10ms")
    rejectLate?.(new Error("late import rejection"))
    await Promise.resolve()
  })

  test("recovers a fork-validation timeout as an independent child without retrying creation", async () => {
    const parent = [message(ROOT, "parent-1", "assistant", "answer")]
    let forkCalls = 0
    const provider = providerWith({
      messages: {
        [ROOT]: parent,
        [CHILD]: () => new Promise<never>(() => undefined),
      },
      physical: { [ROOT]: parent },
      onFork: () => {
        forkCalls += 1
      },
      transcriptReadTimeoutMs: 100,
      forkValidationTimeoutMs: 10,
    })

    const outcome = await Effect.runPromise(Effect.provide(
      Effect.gen(function*() {
        const branchFiber = yield* Effect.forkChild(provider.branchFrom({
          sessionId: ROOT,
          messageId: "parent-1",
        }))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10)
        return yield* Fiber.join(branchFiber)
      }),
      TestClock.layer(),
    ))

    expect(forkCalls).toBe(1)
    expect(outcome._tag).toBe("CreatedIndependentSession")
    if (outcome._tag !== "CreatedIndependentSession") throw new Error("expected independent")
    expect(outcome.session.id).toBe(CHILD)
    expect(outcome.reason).toBe("Claude validateFork timed out after 10ms")
  })

  test("represents a created child independently when executable lookup fails and can retry launch", async () => {
    const parent = [message(ROOT, "parent-1", "assistant", "answer")]
    const copied = [copyMessage(parent[0]!, CHILD, "child-1")]
    let executableReads = 0
    const provider = providerWith({
      messages: { [ROOT]: parent, [CHILD]: copied },
      physical: {
        [ROOT]: parent,
        [CHILD]: [copiedRecord(copied[0]!, ROOT, parent[0]!.uuid)],
      },
      resolveExecutable: () => {
        executableReads += 1
        if (executableReads === 1) throw new Error("temporary lookup failure")
        return "/usr/bin/claude"
      },
    })

    const outcome = await Effect.runPromise(provider.branchFrom({
      sessionId: ROOT,
      messageId: "parent-1",
    }))

    expect(outcome._tag).toBe("CreatedIndependentSession")
    if (outcome._tag !== "CreatedIndependentSession") throw new Error("expected independent")
    expect(outcome.reason).toBe("Could not locate the Claude Code executable")
    expect(outcome.transcript._tag).toBe("Available")
    expect(outcome.acquireLaunch).toBeDefined()
    const launch = await Effect.runPromise(Effect.scoped(outcome.acquireLaunch!))
    expect(launch.command).toEqual(["/usr/bin/claude", "--resume", CHILD])
    expect(executableReads).toBe(2)
  })
})

describe("Claude terminal observer", () => {
  test("uses only the minimal TerminalScreen composer fields", () => {
    const screen = {
      lines: ["old output", "❯ first line", "  second line", "────────────────"],
      cursor: { x: 10, y: 2, visible: true },
    }
    expect(observeClaudeDraft(screen)).toBe("first line\n  second line")
    expect(observeClaudeActivity(screen)).toBe("idle")
  })

  test("preserves split and ordered OSC title transitions", () => {
    const observer = new ClaudeTerminalObserver()
    const encoder = new TextEncoder()
    expect(observer.observeOutput(encoder.encode("\u001b]0;⠋ Claude"))).toEqual([])
    expect(observer.observeOutput(encoder.encode(
      " Code\u0007\u001b]2;✳ Claude Code\u001b\\",
    ))).toEqual(["working", "idle"])
  })

  test("prioritizes visible blockers and tracks rewind drafts", () => {
    const observer = new ClaudeTerminalObserver()
    observer.observeInput(new TextEncoder().encode("/undo\r"))
    const restored = {
      lines: ["❯ restored prompt", "────────────────"],
      cursor: { x: 18, y: 0, visible: true },
    }
    expect(observer.observeDraft(restored)).toEqual({
      text: "restored prompt",
      exact: false,
      rewind: true,
      rewindTarget: "restored prompt",
    })
    expect(observeClaudeActivity({
      lines: ["Do you want to proceed?", "❯ 1. Yes", "  2. No", "Esc to cancel"],
      cursor: { x: 2, y: 1, visible: true },
    })).toBe("blocked")
  })
})

interface FakeOptions {
  readonly listSessions?: () => readonly SDKSessionInfo[] | PromiseLike<readonly SDKSessionInfo[]>
  readonly messages?: Readonly<Record<
    string,
    readonly SessionMessage[] |
      Error |
      null |
      (() => readonly SessionMessage[] | null | PromiseLike<readonly SessionMessage[] | null>)
  >>
  readonly physical?: Readonly<Record<
    string,
    readonly SessionStoreEntry[] |
      Error |
      (() => readonly SessionStoreEntry[] | PromiseLike<readonly SessionStoreEntry[]>)
  >>
  readonly childSessionId?: string
  readonly onFork?: (messageId: string) => void
  readonly resolveExecutable?: () => string | null | PromiseLike<string | null>
  readonly randomUUID?: () => string
  readonly retryDelays?: readonly number[]
  readonly forkValidationTimeoutMs?: number
  readonly listSessionsTimeoutMs?: number
  readonly transcriptReadTimeoutMs?: number
  readonly provenanceImportTimeoutMs?: number
}

function providerWith(options: FakeOptions = {}): ClaudeProvider {
  const sessions: SDKSessionInfo[] = [
    {
      sessionId: ROOT,
      summary: "Root session",
      lastModified: 7,
      gitBranch: "main",
    },
    { sessionId: CHILD, summary: "Child session", lastModified: 6 },
  ]
  const sdk = fakeSdk(options, sessions)
  return new ClaudeProvider(
    "/project",
    {
      sdk,
      resolveExecutable: options.resolveExecutable ?? (() => "/usr/bin/claude"),
      ...(options.randomUUID === undefined ? {} : { randomUUID: options.randomUUID }),
    },
    {
      forkValidationRetryDelaysMs: options.retryDelays ?? [],
      ...(options.forkValidationTimeoutMs === undefined
        ? {}
        : { forkValidationTimeoutMs: options.forkValidationTimeoutMs }),
      ...(options.listSessionsTimeoutMs === undefined
        ? {}
        : { listSessionsTimeoutMs: options.listSessionsTimeoutMs }),
      ...(options.transcriptReadTimeoutMs === undefined
        ? {}
        : { transcriptReadTimeoutMs: options.transcriptReadTimeoutMs }),
      ...(options.provenanceImportTimeoutMs === undefined
        ? {}
        : { provenanceImportTimeoutMs: options.provenanceImportTimeoutMs }),
    },
  )
}

function fakeSdk(
  options: FakeOptions = {},
  sessions: readonly SDKSessionInfo[] = [],
): ClaudeSdk {
  return {
    async listSessions() {
      return options.listSessions?.() ?? sessions
    },
    async getSessionMessages(sessionId) {
      const configured = options.messages !== undefined && sessionId in options.messages
        ? options.messages[sessionId]
        : []
      if (configured instanceof Error) throw configured
      return typeof configured === "function" ? configured() : configured
    },
    async forkSession(_sessionId, forkOptions) {
      options.onFork?.(forkOptions.upToMessageId)
      return { sessionId: options.childSessionId ?? CHILD }
    },
    async importSessionToStore(sessionId, store) {
      const configured = options.physical?.[sessionId] ?? []
      if (configured instanceof Error) throw configured
      const entries = typeof configured === "function" ? await configured() : configured
      await append(store, sessionId, entries)
    },
  }
}

async function append(
  store: SessionStore,
  sessionId: string,
  entries: readonly SessionStoreEntry[],
): Promise<void> {
  await store.append(
    { projectKey: "project", sessionId },
    [...entries],
  )
}

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!condition() && performance.now() < deadline) await Bun.sleep(1)
  if (!condition()) throw new Error("Condition was not met before timeout")
}

function message(
  sessionId: string,
  uuid: string,
  type: SessionMessage["type"],
  text: string,
  model?: string,
  stopReason?: string | null,
  content?: readonly Record<string, unknown>[],
): SessionMessage {
  return {
    type,
    uuid,
    session_id: sessionId,
    message: {
      ...(model === undefined ? {} : { model }),
      ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
      content: content ?? [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    parent_agent_id: null,
  }
}

function copyMessage(source: SessionMessage, sessionId: string, uuid: string): SessionMessage {
  return { ...source, uuid, session_id: sessionId }
}

function copiedRecord(
  child: SessionMessage,
  parentSessionId: string,
  parentMessageId: string,
): SessionStoreEntry {
  return {
    type: child.type,
    uuid: child.uuid,
    message: child.message,
    forkedFrom: { sessionId: parentSessionId, messageUuid: parentMessageId },
  }
}
