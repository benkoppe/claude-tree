import { describe, expect, test } from "bun:test"

import type { BranchRelation } from "../src/metadata"
import {
  buildSessionTree,
  childCountByMessage,
  extractUserPromptText,
  formatMessage,
  type SessionSummary,
} from "../src/sessions"

describe("buildSessionTree", () => {
  test("attaches known children and leaves unknown ancestry as roots", () => {
    const sessions: SessionSummary[] = [
      session("11111111-1111-4111-8111-111111111111", "Parent", 10),
      session("22222222-2222-4222-8222-222222222222", "Child", 30),
      session("44444444-4444-4444-8444-444444444444", "Independent", 20),
    ]
    const relations: BranchRelation[] = [
      relation(
        "22222222-2222-4222-8222-222222222222",
        "11111111-1111-4111-8111-111111111111",
      ),
      relation(
        "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555",
      ),
    ]

    expect(buildSessionTree(sessions, relations).map(({ session, depth }) => [session.title, depth])).toEqual([
      ["Independent", 0],
      ["Parent", 0],
      ["Child", 1],
    ])
  })
})

describe("message presentation", () => {
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

  test("counts branches at their source message", () => {
    const counts = childCountByMessage(
      [
        relation("22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"),
        relation("44444444-4444-4444-8444-444444444444", "11111111-1111-4111-8111-111111111111"),
      ],
      "11111111-1111-4111-8111-111111111111",
    )
    expect(counts.get("33333333-3333-4333-8333-333333333333")).toBe(2)
  })
})

function session(sessionId: string, title: string, lastModified: number): SessionSummary {
  return { sessionId, title, lastModified }
}

function relation(childSessionId: string, parentSessionId: string): BranchRelation {
  return {
    schemaVersion: 1,
    childSessionId,
    parentSessionId,
    sourceMessageId: "33333333-3333-4333-8333-333333333333",
    createdAt: "2026-08-30T12:00:00.000Z",
  }
}
