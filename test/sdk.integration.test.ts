import { expect, test } from "bun:test"

import {
  forkSession,
  getSessionMessages,
  InMemorySessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk"

test("the pinned SDK forks through a selected historical UUID", async () => {
  const store = new InMemorySessionStore()
  const sourceSessionId = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const assistantId = crypto.randomUUID()
  const timestamp = "2026-08-30T12:00:00.000Z"
  const projectKey = process.cwd().replaceAll("/", "-")
  const entries: SessionStoreEntry[] = [
    {
      type: "user",
      uuid: userId,
      parentUuid: null,
      sessionId: sourceSessionId,
      timestamp,
      cwd: process.cwd(),
      message: { role: "user", content: "hello" },
    },
    {
      type: "assistant",
      uuid: assistantId,
      parentUuid: userId,
      sessionId: sourceSessionId,
      timestamp,
      cwd: process.cwd(),
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "test",
        content: [{ type: "text", text: "hello back" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ]
  await store.append({ projectKey, sessionId: sourceSessionId }, entries)

  const result = await forkSession(sourceSessionId, {
    dir: process.cwd(),
    sessionStore: store,
    upToMessageId: assistantId,
  })
  const sourceMessages = await getSessionMessages(sourceSessionId, {
    dir: process.cwd(),
    sessionStore: store,
  })
  const childMessages = await getSessionMessages(result.sessionId, {
    dir: process.cwd(),
    sessionStore: store,
  })

  expect(result.sessionId).not.toBe(sourceSessionId)
  expect(sourceMessages.map((message) => message.uuid)).toEqual([userId, assistantId])
  expect(childMessages).toHaveLength(2)
  expect(childMessages.map((message) => message.uuid)).not.toEqual([userId, assistantId])
  expect(childMessages.map((message) => message.type)).toEqual(["user", "assistant"])
})

test("the pinned SDK preserves consecutive message roles at an exact fork boundary", async () => {
  const store = new InMemorySessionStore()
  const sourceSessionId = crypto.randomUUID()
  const userOneId = crypto.randomUUID()
  const userTwoId = crypto.randomUUID()
  const assistantOneId = crypto.randomUUID()
  const assistantTwoId = crypto.randomUUID()
  const timestamp = "2026-08-30T12:00:00.000Z"
  const projectKey = process.cwd().replaceAll("/", "-")
  const entries: SessionStoreEntry[] = [
    userEntry(sourceSessionId, userOneId, null, "first", timestamp),
    userEntry(sourceSessionId, userTwoId, userOneId, "second", timestamp),
    assistantEntry(sourceSessionId, assistantOneId, userTwoId, "first answer", timestamp),
    assistantEntry(sourceSessionId, assistantTwoId, assistantOneId, "second answer", timestamp),
  ]
  await store.append({ projectKey, sessionId: sourceSessionId }, entries)

  const result = await forkSession(sourceSessionId, {
    dir: process.cwd(),
    sessionStore: store,
    upToMessageId: assistantOneId,
  })
  const childMessages = await getSessionMessages(result.sessionId, {
    dir: process.cwd(),
    sessionStore: store,
  })

  expect(childMessages.map((message) => message.type)).toEqual(["user", "user", "assistant"])
  expect(childMessages.map((message) => message.uuid)).not.toContain(userOneId)
  expect(childMessages.map((message) => message.uuid)).not.toContain(userTwoId)
  expect(childMessages.map((message) => message.uuid)).not.toContain(assistantOneId)
})

function userEntry(
  sessionId: string,
  uuid: string,
  parentUuid: string | null,
  content: string,
  timestamp: string,
): SessionStoreEntry {
  return {
    type: "user",
    uuid,
    parentUuid,
    sessionId,
    timestamp,
    cwd: process.cwd(),
    message: { role: "user", content },
  }
}

function assistantEntry(
  sessionId: string,
  uuid: string,
  parentUuid: string,
  text: string,
  timestamp: string,
): SessionStoreEntry {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    sessionId,
    timestamp,
    cwd: process.cwd(),
    message: {
      id: `msg_${uuid}`,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}
