import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { ClaudeProvider } from "../src/infrastructure/providers/claude/provider"
import { buildConversationForest } from "../src/domain/conversation-graph"

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
  const agentId = crypto.randomUUID()
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
      uuid: agentId,
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
    upToMessageId: agentId,
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
  expect(sourceMessages.map((message) => message.uuid)).toEqual([userId, agentId])
  expect(childMessages).toHaveLength(2)
  expect(childMessages.map((message) => message.uuid)).not.toEqual([userId, agentId])
  expect(childMessages.map((message) => message.type)).toEqual(["user", "assistant"])
})

test("the pinned SDK preserves consecutive message roles at an exact fork boundary", async () => {
  const store = new InMemorySessionStore()
  const sourceSessionId = crypto.randomUUID()
  const userOneId = crypto.randomUUID()
  const userTwoId = crypto.randomUUID()
  const agentOneId = crypto.randomUUID()
  const agentTwoId = crypto.randomUUID()
  const timestamp = "2026-08-30T12:00:00.000Z"
  const projectKey = process.cwd().replaceAll("/", "-")
  const entries: SessionStoreEntry[] = [
    userEntry(sourceSessionId, userOneId, null, "first", timestamp),
    userEntry(sourceSessionId, userTwoId, userOneId, "second", timestamp),
    agentEntry(sourceSessionId, agentOneId, userTwoId, "first answer", timestamp),
    agentEntry(sourceSessionId, agentTwoId, agentOneId, "second answer", timestamp),
  ]
  await store.append({ projectKey, sessionId: sourceSessionId }, entries)

  const result = await forkSession(sourceSessionId, {
    dir: process.cwd(),
    sessionStore: store,
    upToMessageId: agentOneId,
  })
  const childMessages = await getSessionMessages(result.sessionId, {
    dir: process.cwd(),
    sessionStore: store,
  })

  expect(childMessages.map((message) => message.type)).toEqual(["user", "user", "assistant"])
  expect(childMessages.map((message) => message.uuid)).not.toContain(userOneId)
  expect(childMessages.map((message) => message.uuid)).not.toContain(userTwoId)
  expect(childMessages.map((message) => message.uuid)).not.toContain(agentOneId)
})

test("the pinned SDK returns streamed assistant blocks as separate transcript records", async () => {
  const store = new InMemorySessionStore()
  const sessionId = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const firstBlockId = crypto.randomUUID()
  const secondBlockId = crypto.randomUUID()
  const apiMessageId = "msg_streamed"
  const timestamp = "2026-08-30T12:00:00.000Z"
  const projectKey = process.cwd().replaceAll("/", "-")
  await store.append({ projectKey, sessionId }, [
    userEntry(sessionId, userId, null, "question", timestamp),
    agentEntry(sessionId, firstBlockId, userId, "first block", timestamp, apiMessageId, null),
    agentEntry(
      sessionId,
      secondBlockId,
      firstBlockId,
      "second block",
      timestamp,
      apiMessageId,
      "end_turn",
    ),
  ])

  const messages = await getSessionMessages(sessionId, {
    dir: process.cwd(),
    sessionStore: store,
  })

  expect(messages.map((message) => message.uuid)).toEqual([userId, firstBlockId, secondBlockId])
  expect(messages.slice(1).map((message) => (message.message as { id: string }).id)).toEqual([
    apiMessageId,
    apiMessageId,
  ])
})

test("the pinned SDK preserves provenance when compaction shortens a fork's active transcript", async () => {
  const store = new InMemorySessionStore()
  const sessionId = crypto.randomUUID()
  const timestamp = "2026-08-30T12:00:00.000Z"
  const projectKey = process.cwd().replaceAll("/", "-")
  const anchorId = crypto.randomUUID()
  const anchor = userEntry(sessionId, anchorId, null, "anchor", timestamp)
  const preserved = Array.from({ length: 13 }, (_, index) =>
    agentEntry(
      sessionId,
      crypto.randomUUID(),
      anchorId,
      `preserved ${index + 1}`,
      timestamp,
    )
  )
  const compactBoundary: SessionStoreEntry = {
    type: "system",
    subtype: "compact_boundary",
    uuid: crypto.randomUUID(),
    parentUuid: anchorId,
    sessionId,
    timestamp,
    compactMetadata: {
      preservedMessages: {
        anchorUuid: anchorId,
        uuids: preserved.map((entry) => entry.uuid!),
      },
    },
  }
  const active = [anchor]
  let parentId = anchorId
  for (let index = 1; index < 340; index += 1) {
    const uuid = crypto.randomUUID()
    const entry = index % 2 === 0
      ? userEntry(sessionId, uuid, parentId, `user ${index}`, timestamp)
      : agentEntry(sessionId, uuid, parentId, `agent ${index}`, timestamp)
    active.push(entry)
    parentId = uuid
  }
  await store.append(
    { projectKey, sessionId },
    [anchor, ...preserved, compactBoundary, ...active.slice(1)],
  )

  const sourceMessages = await getSessionMessages(sessionId, {
    dir: process.cwd(),
    sessionStore: store,
  })
  const result = await forkSession(sessionId, {
    dir: process.cwd(),
    sessionStore: store,
    upToMessageId: active.at(-1)!.uuid!,
  })
  const childMessages = await getSessionMessages(result.sessionId, {
    dir: process.cwd(),
    sessionStore: store,
  })
  const copiedConversationRecords = store
    .getEntries({ projectKey, sessionId: result.sessionId })
    .filter((entry) => entry.type === "user" || entry.type === "assistant")

  expect(sourceMessages).toHaveLength(353)
  expect(childMessages).toHaveLength(340)
  expect(copiedConversationRecords).toHaveLength(353)
  expect(copiedConversationRecords.every((entry) => {
    const forkedFrom = entry.forkedFrom as Record<string, unknown> | undefined
    return forkedFrom?.sessionId === sessionId && typeof forkedFrom.messageUuid === "string"
  })).toBeTrue()
})

for (const preservation of ["preservedSegment", "preservedMessages"] as const) {
  test(`the provider forks and attaches SDK history reordered by ${preservation}`, async () => {
    const store = new InMemorySessionStore()
    const sessionId = crypto.randomUUID()
    const projectKey = process.cwd().replaceAll("/", "-")
    const ids: string[] = Array.from({ length: 8 }, () => crypto.randomUUID())
    const timestamp = "2026-08-30T12:00:00.000Z"
    await store.append({ projectKey, sessionId }, [
      userEntry(sessionId, ids[0]!, null, "old question", timestamp),
      agentEntry(sessionId, ids[1]!, ids[0]!, "old answer", timestamp),
      userEntry(sessionId, ids[2]!, ids[1]!, "preserved question", timestamp),
      agentEntry(sessionId, ids[3]!, ids[2]!, "preserved answer", timestamp),
      {
        type: "system", subtype: "compact_boundary", uuid: ids[4]!,
        sessionId, parentUuid: null, timestamp,
        compactMetadata: preservation === "preservedSegment"
          ? { preservedSegment: { headUuid: ids[2], tailUuid: ids[3], anchorUuid: ids[5] } }
          : { preservedMessages: { uuids: [ids[2], ids[3]], anchorUuid: ids[5] } },
      },
      userEntry(sessionId, ids[5]!, ids[4]!, "compaction summary", timestamp),
      userEntry(sessionId, ids[6]!, ids[5]!, "continue", timestamp),
      agentEntry(sessionId, ids[7]!, ids[6]!, "latest answer", timestamp),
    ])
    let forkCalls = 0
    const provider = new ClaudeProvider(process.cwd(), { sdk: {
      async listSessions() { return [] },
      getSessionMessages: (id, options) => getSessionMessages(id, { ...options, sessionStore: store }),
      forkSession: (id, options) => {
        forkCalls += 1
        return forkSession(id, { ...options, sessionStore: store })
      },
      async importSessionToStore(id, target) {
        await target.append({ projectKey, sessionId: id }, store.getEntries({ projectKey, sessionId: id }))
      },
    } }, { forkValidationRetryDelaysMs: [] })
    const outcome = await Effect.runPromise(provider.branchFrom({ sessionId, messageId: ids[7]! }))
    expect(outcome._tag).toBe("ValidatedBranch")
    expect(forkCalls).toBe(1)
    if (outcome._tag !== "ValidatedBranch") throw new Error(outcome.reason)
    expect(outcome.derivation.sharedMessages.map((pair) => ids.indexOf(pair.parentMessageId))).toEqual([5, 2, 3, 6, 7])
    const reads = await Effect.runPromise(provider.readTranscripts([sessionId, outcome.session.id]))
    const parent = reads.get(sessionId)!
    const child = reads.get(outcome.session.id)!
    if (parent._tag !== "Available" || child._tag !== "Available") throw new Error("Missing transcript")
    const forest = buildConversationForest(
      [{ id: sessionId, title: "Parent", lastModified: 0 }, outcome.session],
      new Map([[sessionId, parent.messages], [outcome.session.id, child.messages]]),
      [{ ...outcome.derivation, createdAt: timestamp }],
    )
    expect(forest.graphs).toHaveLength(1)
    expect(forest.graphs[0]!.warnings).toEqual([])
  })
}

test("the Claude provider validates SDK-imported source and child records", async () => {
  const configDir = await realpath(await mkdtemp(join(tmpdir(), "claude-tree-sdk-provenance-")))
  const projectDir = join(configDir, "project")
  const projectKey = "sdk-provenance-fixture"
  const sourceSessionId = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const agentId = crypto.randomUUID()
  const timestamp = "2026-08-30T12:00:00.000Z"
  const entries = [
    userEntry(sourceSessionId, userId, null, "hello", timestamp),
    agentEntry(sourceSessionId, agentId, userId, "hello back", timestamp),
  ]

  try {
    await mkdir(projectDir, { recursive: true })
    const transcriptDir = join(configDir, "projects", projectKey)
    await mkdir(transcriptDir, { recursive: true })
    await writeFile(
      join(transcriptDir, `${sourceSessionId}.jsonl`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    )

    const script = `
      import { Effect } from "effect"
      import { makeClaudeProvider } from "./src/infrastructure/providers/claude/provider.ts"
      const provider = makeClaudeProvider(${JSON.stringify(projectDir)}, {
        resolveExecutable: () => "/usr/bin/claude",
      })
      const prepared = await Effect.runPromise(provider.branchFrom({
        sessionId: ${JSON.stringify(sourceSessionId)},
        messageId: ${JSON.stringify(agentId)},
      }))
      if (prepared._tag !== "ValidatedBranch") throw new Error("Unexpected branch outcome")
      console.log(prepared.derivation.sharedMessages.length)
    `
    const subprocess = Bun.spawn([globalThis.process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...globalThis.process.env,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_PROJECT_DIR_NAME: projectKey,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      Bun.readableStreamToText(subprocess.stdout),
      Bun.readableStreamToText(subprocess.stderr),
    ])

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe("2")
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
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

function agentEntry(
  sessionId: string,
  uuid: string,
  parentUuid: string,
  text: string,
  timestamp: string,
  apiMessageId = `msg_${uuid}`,
  stopReason: string | null = "end_turn",
): SessionStoreEntry {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    sessionId,
    timestamp,
    cwd: process.cwd(),
    message: {
      id: apiMessageId,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}
