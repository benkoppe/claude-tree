import { describe, expect, test } from "bun:test"

import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk"

import {
  ClaudeProvider,
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
    const provider = new ClaudeProvider("/project", "/usr/bin/claude", sdk({ parent, child }))

    await expect(
      provider.branchFrom({ sessionId: ROOT, messageId: parent[1]!.uuid }),
    ).rejects.toThrow(`Fork ${CHILD} was created, but its copied prefix does not match the source`)
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

function sdk(options: {
  parent: SessionMessage[]
  child?: SessionMessage[]
  onFork?: (messageId: string) => void
}): ClaudeSdk {
  return {
    async list(): Promise<SDKSessionInfo[]> {
      return [{ sessionId: ROOT, summary: "Root", firstPrompt: "root prompt", lastModified: 1 }]
    },
    async messages(sessionId): Promise<SessionMessage[]> {
      return sessionId === ROOT ? options.parent : options.child ?? []
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

function textOf(message: SessionMessage): string {
  const payload = message.message as { content: Array<{ text?: string }> }
  return payload.content[0]?.text ?? ""
}

function modelOf(message: SessionMessage): string | undefined {
  const payload = message.message as { model?: unknown }
  return typeof payload.model === "string" ? payload.model : undefined
}
