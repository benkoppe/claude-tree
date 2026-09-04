import { describe, expect, test } from "bun:test"

import type {
  SDKSessionInfo,
  SessionMessage,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { ProviderError, ProviderProtocolError } from "../../src/domain/errors"
import {
  ClaudeProvider,
  claudeProviderLayer,
  type ClaudeProviderDependencies,
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

  test("loads incremental snapshots with all metadata and deduplicated requested reads", async () => {
    const reads: string[] = []
    const provider = providerWith({
      messages: {
        [ROOT]: () => {
          reads.push(ROOT)
          return [message(ROOT, "root-message", "user", "root")]
        },
        [CHILD]: () => {
          reads.push(CHILD)
          return [message(CHILD, "child-message", "user", "child")]
        },
      },
    })

    const snapshot = await Effect.runPromise(provider.loadSessionSnapshotFor([CHILD, CHILD]))
    expect(snapshot.sessions.map((session) => session.id)).toEqual([ROOT, CHILD])
    expect([...snapshot.transcripts.keys()]).toEqual([CHILD])
    expect(reads).toEqual([CHILD])

    await Effect.runPromise(provider.readTranscripts([ROOT, ROOT, CHILD, ROOT]))
    expect(reads).toEqual([CHILD, ROOT, CHILD])
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

    const acquired = await Effect.runPromise(Effect.scoped(prepared.acquireLaunch))
    expect(executableReads).toBe(1)
    expect(acquired.launch.command).toEqual(["/usr/local/bin/claude", "--session-id", NEW])
    await Effect.runPromise(acquired.close)

    const resumed = await Effect.runPromise(provider.prepareResume({
      id: ROOT,
      title: "Root",
      lastModified: 1,
    }))
    expect(executableReads).toBe(1)
    expect((await Effect.runPromise(Effect.scoped(resumed.acquireLaunch))).launch.command).toEqual([
      "/usr/local/bin/claude",
      "--resume",
      ROOT,
    ])
  })

  test("returns an explicit close effect and creates a fresh observer for every acquisition", async () => {
    const observers: ClaudeTerminalObserver[] = []
    const provider = providerWith({
      observerFactory: () => {
        const observer = new ClaudeTerminalObserver()
        observers.push(observer)
        return observer
      },
    })
    const prepared = await Effect.runPromise(provider.prepareResume({
      id: ROOT,
      title: "Root",
      lastModified: 1,
    }))

    const first = await Effect.runPromise(Effect.scoped(prepared.acquireLaunch))
    const second = await Effect.runPromise(Effect.scoped(prepared.acquireLaunch))

    expect(observers).toHaveLength(2)
    expect(first.launch.observer).toBe(observers[0]!)
    expect(second.launch.observer).toBe(observers[1]!)
    expect(first.launch.observer).not.toBe(second.launch.observer)
    await Effect.runPromise(first.close)
    await Effect.runPromise(second.close)
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
    const launch = (await Effect.runPromise(Effect.scoped(outcome.acquireLaunch))).launch
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
    expect((await Effect.runPromise(Effect.scoped(outcome.acquireLaunch))).launch.command).toEqual([
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

  test("forks an older boundary when compaction reconstructs a later preserved source record before it", async () => {
    const physicalParent = [
      message(ROOT, "parent-1", "user", "question"),
      message(ROOT, "parent-2", "assistant", "older answer"),
      message(ROOT, "parent-3", "assistant", "later preserved context"),
    ]
    const activeParent = [physicalParent[0]!, physicalParent[2]!, physicalParent[1]!]
    const copied = physicalParent.slice(0, 2).map((entry, index) =>
      copyMessage(entry, CHILD, `child-${index + 1}`),
    )
    const provider = providerWith({
      messages: { [ROOT]: activeParent, [CHILD]: copied },
      physical: {
        [ROOT]: physicalParent,
        [CHILD]: copied.map((entry, index) =>
          copiedRecord(entry, ROOT, physicalParent[index]!.uuid),
        ),
      },
    })

    const outcome = await Effect.runPromise(provider.branchFrom({
      sessionId: ROOT,
      messageId: "parent-2",
    }))

    expect(outcome._tag).toBe("ValidatedBranch")
    if (outcome._tag !== "ValidatedBranch") throw new Error(outcome.reason)
    expect(outcome.derivation.sharedMessages).toEqual([
      { parentMessageId: "parent-1", childMessageId: "child-1" },
      { parentMessageId: "parent-2", childMessageId: "child-2" },
    ])
  })

  test("uses cached parent metadata for the initial PreparedTerminal fork title", async () => {
    const parent = [message(ROOT, "parent-1", "assistant", "answer")]
    const copied = [copyMessage(parent[0]!, CHILD, "child-1")]
    let listCalls = 0
    const provider = providerWith({
      listSessions: () => {
        listCalls += 1
        return [{
          sessionId: ROOT,
          customTitle: "Contextual parent",
          summary: "Parent summary",
          lastModified: 1,
        }]
      },
      messages: { [ROOT]: parent, [CHILD]: copied },
      physical: {
        [ROOT]: parent,
        [CHILD]: [copiedRecord(copied[0]!, ROOT, parent[0]!.uuid)],
      },
    })

    await Effect.runPromise(provider.loadSessionSnapshotFor([]))
    const outcome = await Effect.runPromise(provider.branchFrom({
      sessionId: ROOT,
      messageId: "parent-1",
    }))

    expect(outcome._tag).toBe("ValidatedBranch")
    if (outcome._tag !== "ValidatedBranch") throw new Error("expected validated branch")
    expect(outcome.session.title).toBe("Contextual parent (fork)")
    expect(listCalls).toBe(1)
  })

  test("uses a deterministic fork title when parent metadata is unavailable", async () => {
    const parent = [message(ROOT, "parent-1", "assistant", "answer")]
    const copied = [copyMessage(parent[0]!, CHILD, "child-1")]
    const provider = providerWith({
      messages: { [ROOT]: parent, [CHILD]: copied },
      physical: {
        [ROOT]: parent,
        [CHILD]: [copiedRecord(copied[0]!, ROOT, parent[0]!.uuid)],
      },
    })

    const outcome = await Effect.runPromise(provider.branchFrom({
      sessionId: ROOT,
      messageId: "parent-1",
    }))

    expect(outcome._tag).toBe("ValidatedBranch")
    if (outcome._tag !== "ValidatedBranch") throw new Error("expected validated branch")
    expect(outcome.session.title).toBe("Conversation (fork)")
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

  test("returns ambiguity when forkSession rejects immediately after invocation", async () => {
    const parent = [message(ROOT, "parent-1", "assistant", "answer")]
    let forkCalls = 0
    const provider = providerWith({
      messages: { [ROOT]: parent },
      physical: { [ROOT]: parent },
      forkSession: () => {
        forkCalls += 1
        return Promise.reject(new Error("write result unavailable"))
      },
    })

    const outcome = await Effect.runPromise(provider.branchFrom({
      sessionId: ROOT,
      messageId: "parent-1",
    }))

    expect(outcome).toEqual({
      _tag: "AmbiguousBranchMutation",
      providerId: "claude",
      parentSessionId: ROOT,
      sourceMessageId: "parent-1",
      reason:
        "Claude forkSession failed after invocation: write result unavailable; Claude may have created a child session",
      reconciliation: "full-snapshot",
    })
    expect(forkCalls).toBe(1)
  })

  test("returns ambiguity when fork creation times out and never retries after late settlement", async () => {
    const parent = [message(ROOT, "parent-1", "assistant", "answer")]
    let forkCalls = 0
    let rejectFork: ((cause: unknown) => void) | undefined
    const unhandled: unknown[] = []
    const onUnhandled = (cause: unknown) => unhandled.push(cause)
    process.on("unhandledRejection", onUnhandled)
    const provider = providerWith({
      messages: { [ROOT]: parent },
      physical: { [ROOT]: parent },
      forkSession: () => new Promise((_resolve, reject) => {
        forkCalls += 1
        rejectFork = reject
      }),
      forkSessionTimeoutMs: 10,
      forkValidationTimeoutMs: 100,
      operationTimeoutMs: 100,
    })

    try {
      const outcome = await Effect.runPromise(Effect.provide(
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(provider.branchFrom({
            sessionId: ROOT,
            messageId: "parent-1",
          }))
          yield* Effect.yieldNow
          yield* TestClock.adjust(10)
          return yield* Fiber.join(fiber)
        }),
        TestClock.layer(),
      ))

      expect(outcome).toEqual({
        _tag: "AmbiguousBranchMutation",
        providerId: "claude",
        parentSessionId: ROOT,
        sourceMessageId: "parent-1",
        reason: "Claude forkSession timed out after 10ms; Claude may have created a child session",
        reconciliation: "full-snapshot",
      })
      expect(forkCalls).toBe(1)
      rejectFork?.(new Error("late fork rejection"))
      await Bun.sleep(5)
      expect(forkCalls).toBe(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("ignores a late fork success after timeout without retrying or validating it", async () => {
    const parent = [message(ROOT, "parent-1", "assistant", "answer")]
    let forkCalls = 0
    let childReads = 0
    let resolveFork: ((result: { readonly sessionId: string }) => void) | undefined
    const provider = providerWith({
      messages: {
        [ROOT]: parent,
        [CHILD]: () => {
          childReads += 1
          return []
        },
      },
      physical: { [ROOT]: parent },
      forkSession: () => new Promise((resolve) => {
        forkCalls += 1
        resolveFork = resolve
      }),
      forkSessionTimeoutMs: 10,
      forkValidationTimeoutMs: 100,
      operationTimeoutMs: 100,
    })

    const outcome = await Effect.runPromise(Effect.provide(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(provider.branchFrom({
          sessionId: ROOT,
          messageId: "parent-1",
        }))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10)
        return yield* Fiber.join(fiber)
      }),
      TestClock.layer(),
    ))

    expect(outcome._tag).toBe("AmbiguousBranchMutation")
    resolveFork?.({ sessionId: CHILD })
    await Promise.resolve()
    expect(forkCalls).toBe(1)
    expect(childReads).toBe(0)
  })

  test("queues reconciliation and preserves interruption after forkSession invocation", async () => {
    const parent = [message(ROOT, "parent-1", "assistant", "answer")]
    let forkCalls = 0
    let rejectFork: ((cause: unknown) => void) | undefined
    const unhandled: unknown[] = []
    const onUnhandled = (cause: unknown) => unhandled.push(cause)
    process.on("unhandledRejection", onUnhandled)
    const provider = providerWith({
      messages: { [ROOT]: parent },
      physical: { [ROOT]: parent },
      forkSession: () => new Promise((_resolve, reject) => {
        forkCalls += 1
        rejectFork = reject
      }),
    })

    try {
      const fiber = Effect.runFork(provider.branchFrom({
        sessionId: ROOT,
        messageId: "parent-1",
      }))
      await waitUntil(() => rejectFork !== undefined)
      await Effect.runPromise(Fiber.interrupt(fiber))
      const exit = await Effect.runPromise(Fiber.await(fiber))

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(await Effect.runPromise(provider.takeBranchMutationReconciliation)).toEqual({
        _tag: "AmbiguousBranchMutation",
        providerId: "claude",
        parentSessionId: ROOT,
        sourceMessageId: "parent-1",
        reason:
          "Claude forkSession was interrupted after invocation; Claude may have created a child session",
        reconciliation: "full-snapshot",
      })
      expect(forkCalls).toBe(1)

      rejectFork?.(new Error("late interrupted rejection"))
      await Bun.sleep(5)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("queues reconciliation when interrupted after the fork child ID is known", async () => {
    const parent = [message(ROOT, "parent-1", "assistant", "answer")]

    const signal = await Effect.runPromise(Effect.gen(function*() {
      const childReadStarted = yield* Deferred.make<void>()
      const provider = providerWith({
        messages: {
          [ROOT]: parent,
          [CHILD]: () => {
            Deferred.doneUnsafe(childReadStarted, Effect.void)
            return new Promise<never>(() => undefined)
          },
        },
        physical: { [ROOT]: parent },
      })
      const fiber = yield* Effect.forkChild(provider.branchFrom({
        sessionId: ROOT,
        messageId: "parent-1",
      }))
      yield* Deferred.await(childReadStarted)
      yield* Fiber.interrupt(fiber)
      return yield* provider.takeBranchMutationReconciliation
    }))

    expect(signal).toMatchObject({
      _tag: "AmbiguousBranchMutation",
      providerId: "claude",
      parentSessionId: ROOT,
      sourceMessageId: "parent-1",
      reconciliation: "full-snapshot",
    })
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

  test("retains reconciliation for every unusable returned child ID", async () => {
    const parent = [message(ROOT, "parent-1", "assistant", "answer")]

    for (const childSessionId of ["", "invalid\0child", ROOT]) {
      const provider = providerWith({
        messages: { [ROOT]: parent },
        physical: { [ROOT]: parent },
        childSessionId,
      })
      const outcome = await Effect.runPromise(provider.branchFrom({
        sessionId: ROOT,
        messageId: "parent-1",
      }))

      expect(outcome._tag).toBe("AmbiguousBranchMutation")
      if (outcome._tag !== "AmbiguousBranchMutation") throw new Error("expected ambiguity")
      expect(outcome).toMatchObject({
        parentSessionId: ROOT,
        sourceMessageId: "parent-1",
        reconciliation: "full-snapshot",
        reason: "Claude returned an invalid or non-distinct child session ID after creating a fork",
      })
      expect(await Effect.runPromise(provider.takeBranchMutationReconciliation)).toEqual(outcome)
      expect("acquireLaunch" in outcome).toBeFalse()
      expect("session" in outcome).toBeFalse()
    }
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

  test("uses one absolute deadline across session listing and transcript reads", async () => {
    let resolveList: ((sessions: readonly SDKSessionInfo[]) => void) | undefined
    let rootReads = 0
    const provider = providerWith({
      listSessions: () => new Promise((resolve) => {
        resolveList = resolve
      }),
      messages: {
        [ROOT]: () => {
          rootReads += 1
          return new Promise<never>(() => undefined)
        },
      },
      operationTimeoutMs: 10,
      listSessionsTimeoutMs: 100,
      transcriptReadTimeoutMs: 100,
    })

    const snapshot = await Effect.runPromise(Effect.provide(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(provider.loadSessionSnapshot)
        yield* Effect.yieldNow
        yield* TestClock.adjust(6)
        resolveList?.([
          { sessionId: ROOT, summary: "Root", lastModified: 1 },
          { sessionId: CHILD, summary: "Child", lastModified: 1 },
        ])
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        expect(rootReads).toBe(1)
        yield* TestClock.adjust(4)
        return yield* Fiber.join(fiber)
      }),
      TestClock.layer(),
    ))

    expect(snapshot.transcripts.get(ROOT)).toEqual({
      _tag: "Unavailable",
      reason: "Claude loadSessionSnapshot timed out after 10ms",
    })
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
    expect(outcome.reason).toContain("Claude branchFrom timed out after 10ms")
  })

  test("retains validated ancestry when bounded executable lookup later times out", async () => {
    const parent = [message(ROOT, "parent-1", "assistant", "answer")]
    const copied = [copyMessage(parent[0]!, CHILD, "child-1")]
    let executableReads = 0
    let rejectLate: ((cause: unknown) => void) | undefined
    const provider = providerWith({
      messages: { [ROOT]: parent, [CHILD]: copied },
      physical: {
        [ROOT]: parent,
        [CHILD]: [copiedRecord(copied[0]!, ROOT, parent[0]!.uuid)],
      },
      resolveExecutable: () => new Promise<never>((_resolve, reject) => {
        executableReads += 1
        rejectLate = reject
      }),
      executableLookupTimeoutMs: 10,
    })

    const outcome = await Effect.runPromise(provider.branchFrom({
      sessionId: ROOT,
      messageId: "parent-1",
    }))

    expect(outcome._tag).toBe("ValidatedBranch")
    if (outcome._tag !== "ValidatedBranch") throw new Error("expected validated branch")
    expect(outcome.derivation.sharedMessages).toEqual([
      { parentMessageId: "parent-1", childMessageId: "child-1" },
    ])
    expect(executableReads).toBe(0)

    const error = await Effect.runPromise(Effect.provide(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.scoped(outcome.acquireLaunch))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10)
        return yield* Fiber.join(fiber).pipe(Effect.flip)
      }),
      TestClock.layer(),
    ))
    expect(error).toBeInstanceOf(ProviderError)
    expect(error.operation).toBe("acquireLaunch")
    expect(error.message).toBe("Claude acquireLaunch timed out after 10ms")
    expect(executableReads).toBe(1)
    rejectLate?.(new Error("late lookup rejection"))
    await Promise.resolve()
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
  readonly forkSession?: (
    sessionId: string,
    options: { readonly dir: string; readonly upToMessageId: string },
  ) => { readonly sessionId: string } | PromiseLike<{ readonly sessionId: string }>
  readonly onFork?: (messageId: string) => void
  readonly resolveExecutable?: () => string | null | PromiseLike<string | null>
  readonly observerFactory?: () => ClaudeTerminalObserver
  readonly randomUUID?: () => string
  readonly retryDelays?: readonly number[]
  readonly operationTimeoutMs?: number
  readonly executableLookupTimeoutMs?: number
  readonly forkSessionTimeoutMs?: number
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
      ...(options.observerFactory === undefined
        ? {}
        : { observerFactory: options.observerFactory }),
      ...(options.randomUUID === undefined ? {} : { randomUUID: options.randomUUID }),
    },
    {
      forkValidationRetryDelaysMs: options.retryDelays ?? [],
      ...(options.operationTimeoutMs === undefined
        ? {}
        : { operationTimeoutMs: options.operationTimeoutMs }),
      ...(options.executableLookupTimeoutMs === undefined
        ? {}
        : { executableLookupTimeoutMs: options.executableLookupTimeoutMs }),
      ...(options.forkSessionTimeoutMs === undefined
        ? {}
        : { forkSessionTimeoutMs: options.forkSessionTimeoutMs }),
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
    async forkSession(sessionId, forkOptions) {
      options.onFork?.(forkOptions.upToMessageId)
      if (options.forkSession) return options.forkSession(sessionId, forkOptions)
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
