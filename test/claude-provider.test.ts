import { describe, expect, test } from "bun:test"

import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk"

import { BranchCreatedError } from "../src/agent-provider"
import {
  ClaudeProvider,
  claudeCompatibilityWarning,
  createClaudeProvider,
  EXPECTED_CLAUDE_VERSION,
  extractUserPromptText,
  formatMessage,
  type ClaudeSdk,
} from "../src/providers/claude"

const ROOT = "11111111-1111-4111-8111-111111111111"
const CHILD = "22222222-2222-4222-8222-222222222222"

describe("Claude message normalization", () => {
  test("extracts text and tool markers from SDK payloads", () => {
    expect(
      formatMessage({
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "Hello\nworld" },
          { type: "tool_use", name: "Read" },
        ],
      }),
    ).toBe("[thinking] Hello world [tool: Read]")
    expect(formatMessage({ unexpected: true })).toBe("[unavailable message]")
  })

  test("preserves exact text only for prompts Claude can prefill", () => {
    expect(extractUserPromptText({ content: "  first\nsecond  " })).toBe("  first\nsecond  ")
    expect(
      extractUserPromptText({
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      }),
    ).toBe("first\nsecond")
    expect(
      extractUserPromptText({
        content: [
          { type: "text", text: "describe this" },
          { type: "image", source: { type: "base64", data: "..." } },
        ],
      }),
    ).toBeUndefined()
  })

  test("normalizes Claude's assistant role to the core agent role", async () => {
    const provider = new ClaudeProvider("/project", "/usr/bin/claude", sdk({
      parent: [message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "assistant", "answer")],
    }))

    expect((await provider.readTranscripts([ROOT])).get(ROOT)?.[0]?.role).toBe("agent")
  })

  test("isolates an unreadable transcript from other session reads", async () => {
    const provider = new ClaudeProvider("/project", "/usr/bin/claude", sdk({
      parent: [message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "assistant", "answer")],
      childReads: [new Error("unreadable")],
    }))

    const transcripts = await provider.readTranscripts([ROOT, CHILD])

    expect(transcripts.get(ROOT)?.[0]?.preview).toBe("answer")
    expect(transcripts.get(CHILD)).toBeNull()
  })

  test("groups assistant continuations by visible user turn across hidden records", async () => {
    const firstUser = message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "question")
    const firstAssistant = apiAssistantMessage(
      ROOT,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      "api-message-one",
      "Let me inspect that.",
      "tool_use",
    )
    const toolResult = toolResultMessage(
      ROOT,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    )
    const command = stringMessage(
      ROOT,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
      "user",
      "<command-name>/status</command-name>",
    )
    const commandOutput = stringMessage(
      ROOT,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
      "user",
      "<local-command-stdout>Ready</local-command-stdout>",
    )
    const secondAssistant = apiAssistantMessage(
      ROOT,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6",
      "api-message-two",
      "Here is the answer.",
      "end_turn",
    )
    const secondUser = message(
      ROOT,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7",
      "user",
      "follow-up",
    )
    const thirdAssistant = apiAssistantMessage(
      ROOT,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8",
      "api-message-three",
      "Follow-up answer.",
    )
    const records = [
      firstUser,
      firstAssistant,
      toolResult,
      command,
      commandOutput,
      secondAssistant,
      secondUser,
      thirdAssistant,
    ]
    const provider = new ClaudeProvider("/project", "/usr/bin/claude", sdk({ parent: records }))

    const transcript = (await provider.readTranscripts([ROOT])).get(ROOT) ?? []

    expect(transcript.map((entry) => entry.id)).toEqual(records.map((entry) => entry.uuid))
    expect(transcript.map((entry) => entry.visible)).toEqual([
      true,
      true,
      false,
      false,
      false,
      true,
      true,
      true,
    ])
    expect(transcript[1]?.displayGroupId).toBe(firstUser.uuid)
    expect(transcript[5]?.displayGroupId).toBe(firstUser.uuid)
    expect(transcript[7]?.displayGroupId).toBe(secondUser.uuid)
    expect(transcript[1]?.displayGroupId).not.toBe(transcript[7]?.displayGroupId)
    expect(transcript[1]?.turnComplete).toBeFalse()
    expect(transcript[5]?.turnComplete).toBeTrue()
  })

  test("retains local command records internally but hides them from the graph", async () => {
    const command = stringMessage(
      ROOT,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "user",
      "<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>",
    )
    const output = stringMessage(
      ROOT,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      "user",
      "<local-command-stdout>Goodbye!</local-command-stdout>",
    )
    const noResponse = message(
      ROOT,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      "assistant",
      "No response requested.",
      "<synthetic>",
    )
    const realResponse = message(
      ROOT,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
      "assistant",
      "No response requested.",
      "claude-sonnet-5",
    )
    const syntheticError = message(
      ROOT,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
      "assistant",
      "Login expired · Please run /login",
      "<synthetic>",
    )
    const prose = message(
      ROOT,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6",
      "user",
      "Why does <local-command-stdout> appear in transcripts?",
    )
    const provider = new ClaudeProvider("/project", "/usr/bin/claude", sdk({
      parent: [command, output, noResponse, realResponse, syntheticError, prose],
    }))

    const transcript = (await provider.readTranscripts([ROOT])).get(ROOT) ?? []

    expect(transcript.map(({ id, ordinal, visible }) => ({ id, ordinal, visible }))).toEqual([
      { id: command.uuid, ordinal: 0, visible: false },
      { id: output.uuid, ordinal: 1, visible: false },
      { id: noResponse.uuid, ordinal: 2, visible: false },
      { id: realResponse.uuid, ordinal: 3, visible: true },
      { id: syntheticError.uuid, ordinal: 4, visible: true },
      { id: prose.uuid, ordinal: 5, visible: true },
    ])
    await expect(
      provider.branchFrom({ sessionId: ROOT, messageId: command.uuid }),
    ).rejects.toThrow("This user message contains content that Claude Code cannot prefill")
  })
})

describe("Claude branching", () => {
  test("forks a user message at its nearest agent and seeds the selected prompt", async () => {
    const parent = [
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "root prompt"),
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "assistant", "answer"),
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "user", "first follow-up"),
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", "user", "second\nfollow-up"),
    ]
    const child = parent.slice(0, 2).map((entry, index) =>
      message(CHILD, `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${index + 1}`, entry.type, textOf(entry)),
    )
    let forkedAt: string | undefined
    const provider = new ClaudeProvider("/project", "/usr/bin/claude", sdk({
      parent,
      child,
      onFork(messageId) {
        forkedAt = messageId
      },
    }))

    const prepared = await provider.branchFrom({ sessionId: ROOT, messageId: parent[3]!.uuid })

    expect(forkedAt).toBe(parent[1]!.uuid)
    expect(prepared.providerSessionCreated).toBeTrue()
    expect(prepared.derivation).toEqual({
      childSessionId: CHILD,
      parentSessionId: ROOT,
      sourceMessageId: parent[1]!.uuid,
      sharedMessages: [
        { parentMessageId: parent[0]!.uuid, childMessageId: child[0]!.uuid },
        { parentMessageId: parent[1]!.uuid, childMessageId: child[1]!.uuid },
      ],
    })
    expect(prepared.launch.command).toEqual([
      "/usr/bin/claude",
      "--resume",
      CHILD,
      "--prefill=second\nfollow-up",
    ])
    expect(prepared.launch.initialDraft).toEqual({ text: "second\nfollow-up", exact: true })
  })

  test("replays an initial user message as a related session with no shared history", async () => {
    const parent = [message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "root prompt")]
    const provider = new ClaudeProvider("/project", "/usr/bin/claude", sdk({ parent }))

    const prepared = await provider.branchFrom({ sessionId: ROOT, messageId: parent[0]!.uuid })

    expect(prepared.providerSessionCreated).toBeFalse()
    expect(prepared.session.transient).toBeTrue()
    expect(prepared.derivation).toEqual({
      childSessionId: prepared.session.id,
      parentSessionId: ROOT,
      sourceMessageId: parent[0]!.uuid,
      sharedMessages: [],
    })
    expect(prepared.launch.command).toEqual([
      "/usr/bin/claude",
      "--session-id",
      prepared.session.id,
      "--prefill=root prompt",
    ])
  })

  test("fails closed when a forked prefix differs from its source", async () => {
    const parent = [
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "question"),
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "assistant", "answer"),
    ]
    const child = [
      message(CHILD, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "user", "question "),
      message(CHILD, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", "assistant", "answer"),
    ]
    const provider = new ClaudeProvider(
      "/project",
      "/usr/bin/claude",
      sdk({ parent, child }),
      { forkValidationRetryDelaysMs: [] },
    )

    const error = await provider
      .branchFrom({ sessionId: ROOT, messageId: parent[1]!.uuid })
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(BranchCreatedError)
    expect(error).toHaveProperty("session.id", CHILD)
    expect(error).toHaveProperty(
      "message",
      `Fork ${CHILD} was created, but its copied prefix does not match the source`,
    )
  })

  test("retries a short child transcript without creating a second fork", async () => {
    const parent = [
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "question"),
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "assistant", "answer"),
    ]
    const child = parent.map((entry, index) =>
      message(CHILD, `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${index + 1}`, entry.type, textOf(entry)),
    )
    let forkCalls = 0
    let childReads = 0
    const provider = new ClaudeProvider(
      "/project",
      "/usr/bin/claude",
      sdk({
        parent,
        childReads: [[], child.slice(0, 1), child],
        onChildRead() { childReads += 1 },
        onFork() { forkCalls += 1 },
      }),
      { forkValidationRetryDelaysMs: [0, 0] },
    )

    const prepared = await provider.branchFrom({ sessionId: ROOT, messageId: parent[1]!.uuid })

    expect(forkCalls).toBe(1)
    expect(childReads).toBe(3)
    expect(prepared.derivation.sharedMessages).toEqual([
      { parentMessageId: parent[0]!.uuid, childMessageId: child[0]!.uuid },
      { parentMessageId: parent[1]!.uuid, childMessageId: child[1]!.uuid },
    ])
  })

  test("retries a temporarily unreadable child transcript", async () => {
    const parent = [
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "question"),
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "assistant", "answer"),
    ]
    const child = parent.map((entry, index) =>
      message(CHILD, `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${index + 1}`, entry.type, textOf(entry)),
    )
    const provider = new ClaudeProvider(
      "/project",
      "/usr/bin/claude",
      sdk({ parent, childReads: [new Error("not visible yet"), child] }),
      { forkValidationRetryDelaysMs: [0] },
    )

    const prepared = await provider.branchFrom({ sessionId: ROOT, messageId: parent[1]!.uuid })

    expect(prepared.session.id).toBe(CHILD)
  })

  test("reports a permanently short child as a created branch failure", async () => {
    const parent = [
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "question"),
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "assistant", "answer"),
    ]
    const child = [
      message(CHILD, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "user", "question"),
    ]
    let childReads = 0
    const provider = new ClaudeProvider(
      "/project",
      "/usr/bin/claude",
      sdk({ parent, child, onChildRead() { childReads += 1 } }),
      { forkValidationRetryDelaysMs: [0, 0] },
    )

    const error = await provider
      .branchFrom({ sessionId: ROOT, messageId: parent[1]!.uuid })
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(BranchCreatedError)
    expect(error).toHaveProperty("session.id", CHILD)
    expect(error).toHaveProperty(
      "message",
      `Fork ${CHILD} was created, but its copied prefix could not be validated (expected 2 messages; found 1)`,
    )
    expect(childReads).toBe(3)
  })

  test("reports a permanently unreadable child with its created session", async () => {
    const parent = [
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "question"),
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "assistant", "answer"),
    ]
    let childReads = 0
    const provider = new ClaudeProvider(
      "/project",
      "/usr/bin/claude",
      sdk({
        parent,
        childReads: [new Error("not visible")],
        onChildRead() { childReads += 1 },
      }),
      { forkValidationRetryDelaysMs: [0, 0] },
    )

    const error = await provider
      .branchFrom({ sessionId: ROOT, messageId: parent[1]!.uuid })
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(BranchCreatedError)
    expect(error).toHaveProperty("session.id", CHILD)
    expect(error).toHaveProperty("transcript", [])
    expect(error).toHaveProperty(
      "message",
      `Fork ${CHILD} was created, but its transcript could not be read after 3 attempts: not visible`,
    )
    expect(childReads).toBe(3)
  })

  test("rejects an invalid replay draft before creating its historical fork", async () => {
    const parent = [
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "assistant", "answer"),
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "user", "invalid\0draft"),
    ]
    let forkCalls = 0
    const provider = new ClaudeProvider("/project", "/usr/bin/claude", sdk({
      parent,
      onFork() { forkCalls += 1 },
    }))

    await expect(
      provider.branchFrom({ sessionId: ROOT, messageId: parent[1]!.uuid }),
    ).rejects.toThrow("Claude prompt prefill cannot contain a null byte")
    expect(forkCalls).toBe(0)
  })

  test("preserves hidden local command records in fork correspondence", async () => {
    const parent = [
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "question"),
      message(
        ROOT,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        "user",
        "<command-name>/login</command-name>",
      ),
      message(
        ROOT,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        "user",
        "<local-command-stdout>Login successful</local-command-stdout>",
      ),
      message(
        ROOT,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
        "assistant",
        "No response requested.",
        "<synthetic>",
      ),
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5", "assistant", "answer"),
    ]
    const child = parent.map((entry, index) =>
      message(
        CHILD,
        `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${index + 1}`,
        entry.type,
        textOf(entry),
        modelOf(entry),
      ),
    )
    const provider = new ClaudeProvider("/project", "/usr/bin/claude", sdk({ parent, child }))

    const prepared = await provider.branchFrom({ sessionId: ROOT, messageId: parent[4]!.uuid })

    expect(prepared.derivation.sharedMessages).toEqual(
      parent.map((entry, index) => ({
        parentMessageId: entry.uuid,
        childMessageId: child[index]!.uuid,
      })),
    )
  })
})

describe("Claude compatibility", () => {
  test("warns unless the installed CLI exactly matches the validated baseline", () => {
    expect(claudeCompatibilityWarning(`${EXPECTED_CLAUDE_VERSION} (Claude Code)`)).toBeUndefined()
    expect(claudeCompatibilityWarning("2.1.250 (Claude Code)")).toBe(
      `Warning: validated with Claude Code ${EXPECTED_CLAUDE_VERSION}; found 2.1.250 (Claude Code)`,
    )
    expect(claudeCompatibilityWarning("12.1.2510 (Claude Code)")).toContain("Warning")
  })

  test("checks the CLI version and blocks historical forks before creation on mismatch", async () => {
    const parent = [
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "question"),
      message(ROOT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "assistant", "answer"),
    ]
    let forked = false
    const fakeSdk = sdk({
      parent,
      onFork() { forked = true },
    })
    const calls: string[] = []
    const provider = await createClaudeProvider("/project", {
      sdk: fakeSdk,
      which(name) {
        calls.push(`which:${name}`)
        return "/usr/local/bin/claude"
      },
      async readVersion(executable) {
        calls.push(`version:${executable}`)
        return "2.1.250 (Claude Code)"
      },
    })

    expect(calls).toEqual(["which:claude", "version:/usr/local/bin/claude"])
    expect(provider.compatibilityWarning).toContain("2.1.250")
    await expect(
      provider.branchFrom({ sessionId: ROOT, messageId: parent[1]!.uuid }),
    ).rejects.toThrow("Historical branching is disabled for this version pair")
    expect(forked).toBeFalse()
  })

  test("fails when Claude Code is not on PATH", async () => {
    await expect(createClaudeProvider("/project", { which: () => null })).rejects.toThrow(
      "Claude Code was not found on PATH",
    )
  })
})

function sdk(options: {
  parent: SessionMessage[]
  child?: SessionMessage[]
  childReads?: Array<SessionMessage[] | Error>
  onChildRead?: () => void
  onFork?: (messageId: string) => void
}): ClaudeSdk {
  let childReadIndex = 0
  return {
    async list(): Promise<SDKSessionInfo[]> {
      return [{ sessionId: ROOT, summary: "Root", firstPrompt: "root prompt", lastModified: 1 }]
    },
    async messages(sessionId): Promise<SessionMessage[]> {
      if (sessionId === ROOT) return options.parent
      options.onChildRead?.()
      const result = options.childReads?.[
        Math.min(childReadIndex, Math.max(0, options.childReads.length - 1))
      ]
      childReadIndex += 1
      if (result instanceof Error) throw result
      return result ?? options.child ?? []
    },
    async fork(_sessionId, forkOptions): Promise<{ sessionId: string }> {
      options.onFork?.(forkOptions.upToMessageId)
      return { sessionId: CHILD }
    },
  }
}

function message(
  sessionId: string,
  uuid: string,
  type: SessionMessage["type"],
  text: string,
  model?: string,
): SessionMessage {
  return {
    type,
    uuid,
    session_id: sessionId,
    message: {
      ...(model === undefined ? {} : { model }),
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    parent_agent_id: null,
  }
}

function stringMessage(
  sessionId: string,
  uuid: string,
  type: SessionMessage["type"],
  text: string,
): SessionMessage {
  return {
    type,
    uuid,
    session_id: sessionId,
    message: { role: type, content: text },
    parent_tool_use_id: null,
    parent_agent_id: null,
  }
}

function apiAssistantMessage(
  sessionId: string,
  uuid: string,
  apiMessageId: string,
  text: string,
  stopReason?: string | null,
): SessionMessage {
  return {
    type: "assistant",
    uuid,
    session_id: sessionId,
    message: {
      id: apiMessageId,
      role: "assistant",
      content: [{ type: "text", text }],
      ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    },
    parent_tool_use_id: null,
    parent_agent_id: null,
  }
}

function toolResultMessage(sessionId: string, uuid: string): SessionMessage {
  return {
    type: "user",
    uuid,
    session_id: sessionId,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-call", content: "result" }],
    },
    parent_tool_use_id: null,
    parent_agent_id: null,
  }
}

function textOf(message: SessionMessage): string {
  const payload = message.message as { content: Array<{ text?: string }> }
  return payload.content[0]?.text ?? ""
}

function modelOf(message: SessionMessage): string | undefined {
  const payload = message.message as { model?: unknown }
  return typeof payload.model === "string" ? payload.model : undefined
}
