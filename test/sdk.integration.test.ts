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

for (const [preservation, linkedHistory] of ["preservedSegment", "preservedMessages"].flatMap((preservation) =>
  [false, true].map((linkedHistory) => [preservation, linkedHistory] as const)
)) {
  test(`the provider forks and attaches SDK history reordered by ${preservation} (logical history: ${linkedHistory})`, async () => {
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
        ...(linkedHistory ? { logicalParentUuid: ids[3] } : {}),
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
      async getSessionInfo() { return undefined },
      getSessionMessages: (id, options) => getSessionMessages(id, { ...options, sessionStore: options.sessionStore ?? store }),
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
    expect(outcome.derivation.sharedMessages.map((pair) => ids.indexOf(pair.parentMessageId))).toEqual(linkedHistory ? [0, 1, 2, 3, 5, 6, 7] : [5, 2, 3, 6, 7])
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

test("compaction preserves a long logical history across reload, forks, repeated compaction, and rewind", async () => {
  const store = new InMemorySessionStore()
  const sessionId = crypto.randomUUID()
  const projectKey = process.cwd().replaceAll("/", "-")
  const timestamp = "2026-09-05T12:00:00.000Z"
  const provider = () => new ClaudeProvider(process.cwd(), { sdk: {
    async listSessions() { return [] },
    async getSessionInfo() { return undefined },
    getSessionMessages: (id, options) => getSessionMessages(id, { ...options, sessionStore: options.sessionStore ?? store }),
    forkSession: (id, options) => forkSession(id, { ...options, sessionStore: store }),
    async importSessionToStore(id, target) {
      await target.append({ projectKey, sessionId: id }, store.getEntries({ projectKey, sessionId: id }))
    },
  } })
  const history: string[] = []
  for (let turn = 0; turn < 80; turn++) {
    const question = crypto.randomUUID(), answer = crypto.randomUUID()
    await store.append({ projectKey, sessionId }, [
      userEntry(sessionId, question, history.at(-1) ?? null, `question ${turn}`, timestamp),
      agentEntry(sessionId, answer, question, `answer ${turn}`, timestamp),
    ])
    history.push(question, answer)
  }
  const compact = async (id: string, parent: string) => {
    const boundary = crypto.randomUUID(), summary = crypto.randomUUID()
    await store.append({ projectKey, sessionId: id }, [
      { type: "system", subtype: "compact_boundary", uuid: boundary, parentUuid: null,
        logicalParentUuid: parent, sessionId: id, timestamp, compactMetadata: {} },
      { ...userEntry(id, summary, boundary, "compressed context", timestamp), isCompactSummary: true },
    ])
    return summary
  }
  const read = async (ids: string[]) => new Map([...await Effect.runPromise(provider().readTranscripts(ids))].map(([id, result]) => {
    if (result._tag !== "Available") throw new Error(JSON.stringify(result))
    return [id, result.messages] as const
  }))
  const summary = await compact(sessionId, history.at(-1)!)
  expect((await read([sessionId])).get(sessionId)!.filter((message) => message.visible).map((message) => message.id)).toEqual(history)
  const historicalFork = await Effect.runPromise(provider().branchFrom({ sessionId, messageId: history[79]! }))
  if (historicalFork._tag !== "ValidatedBranch") throw new Error(historicalFork.reason)
  expect(historicalFork.derivation.sharedMessages.map((pair) => pair.parentMessageId)).toEqual(history.slice(0, 80))
  const question = crypto.randomUUID(), answer = crypto.randomUUID()
  await store.append({ projectKey, sessionId }, [
    userEntry(sessionId, question, summary, "after compaction", timestamp),
    agentEntry(sessionId, answer, question, "continued", timestamp),
  ])
  const fork = await Effect.runPromise(provider().branchFrom({ sessionId, messageId: answer }))
  if (fork._tag !== "ValidatedBranch") throw new Error(fork.reason)
  const childSource = fork.derivation.sharedMessages.at(-1)!.childMessageId
  const childQuestion = crypto.randomUUID(), childAnswer = crypto.randomUUID()
  await store.append({ projectKey, sessionId: fork.session.id }, [
    userEntry(fork.session.id, childQuestion, childSource, "child question", timestamp),
    agentEntry(fork.session.id, childAnswer, childQuestion, "child answer", timestamp),
  ])
  const secondSummary = await compact(fork.session.id, childAnswer)
  const finalQuestion = crypto.randomUUID()
  await store.append({ projectKey, sessionId: fork.session.id }, [userEntry(fork.session.id, finalQuestion, secondSummary, "after second compaction", timestamp)])
  const sessions = [{ id: sessionId, title: "Parent", lastModified: 0 }, fork.session]
  const relations = [{ ...fork.derivation, createdAt: timestamp }]
  const forest = buildConversationForest(sessions, await read(sessions.map((session) => session.id)), relations)
  expect(forest.warnings).toEqual([])
  expect(forest.graphs).toHaveLength(1)
  const graph = forest.graphs[0]!
  const nodeFor = (id: string) => [...graph.nodes.values()].find((node) => node.kind === "message" && node.aliases.some((alias) => alias.messageId === id))!
  expect(nodeFor(finalQuestion).parentId).toBe(nodeFor(childAnswer).id)
  expect(nodeFor(childQuestion).parentId).toBe(nodeFor(answer).id)
  for (let index = 1; index < history.length; index++) expect(nodeFor(history[index]!).parentId).toBe(nodeFor(history[index - 1]!).id)
  // Relations saved before history-aware reads only mapped the active context.
  const legacy = buildConversationForest(sessions, await read(sessions.map((session) => session.id)), [{
    ...relations[0]!, sharedMessages: relations[0]!.sharedMessages.filter((pair) => new Set<string>([summary, question, answer]).has(pair.parentMessageId)),
  }])
  expect(legacy.warnings).toEqual([])
  expect(legacy.graphs).toHaveLength(1)
  // An explicit new branch from an earlier parent is a rewind, not compaction.
  const replacement = crypto.randomUUID()
  await store.append({ projectKey, sessionId: fork.session.id }, [userEntry(fork.session.id, replacement, childSource, "rewound", timestamp)])
  const rewound = (await read([fork.session.id])).get(fork.session.id)!
  expect(rewound.some((message) => message.id === childQuestion || message.id === childAnswer || message.id === finalQuestion)).toBe(false)
  expect(rewound.at(-1)!.id).toBe(replacement)
  await compact(fork.session.id, replacement)
  const compactedRewind = (await read([fork.session.id])).get(fork.session.id)!
  expect(compactedRewind.filter((message) => message.visible).map((message) => message.id)).toEqual(rewound.filter((message) => message.visible).map((message) => message.id))
  await compact(fork.session.id, crypto.randomUUID())
  expect((await Effect.runPromise(provider().readTranscripts([fork.session.id]))).get(fork.session.id)?._tag).toBe("Unavailable")
})

for (const preserveShared of [false, true]) {
  test(`compacting an existing fork preserves its attachment (preserved shared history: ${preserveShared})`, async () => {
    const store = new InMemorySessionStore()
    const sessionId = crypto.randomUUID()
    const projectKey = process.cwd().replaceAll("/", "-")
    const timestamp = "2026-09-05T12:00:00.000Z"
    const question = crypto.randomUUID(), source = crypto.randomUUID()
    await store.append({ projectKey, sessionId }, [
      userEntry(sessionId, question, null, "original question", timestamp),
      agentEntry(sessionId, source, question, "fork source", timestamp),
    ])
    const makeProvider = () => new ClaudeProvider(process.cwd(), { sdk: {
      async listSessions() { return [] },
      async getSessionInfo() { return undefined },
      getSessionMessages: (id, options) => getSessionMessages(id, { ...options, sessionStore: options.sessionStore ?? store }),
      forkSession: (id, options) => forkSession(id, { ...options, sessionStore: store }),
      async importSessionToStore(id, target) {
        await target.append({ projectKey, sessionId: id }, store.getEntries({ projectKey, sessionId: id }))
      },
    } })
    const fork = await Effect.runPromise(makeProvider().branchFrom({ sessionId, messageId: source }))
    if (fork._tag !== "ValidatedBranch") throw new Error(fork.reason)
    const childId = fork.session.id
    const boundary = crypto.randomUUID(), summary = crypto.randomUUID(), continuation = crypto.randomUUID()
    await store.append({ projectKey, sessionId: childId }, [
      {
        type: "system", subtype: "compact_boundary", uuid: boundary, parentUuid: null, sessionId: childId, timestamp,
        compactMetadata: preserveShared ? { preservedMessages: {
          anchorUuid: summary, uuids: fork.derivation.sharedMessages.map((pair) => pair.childMessageId),
        } } : {},
      },
      { ...userEntry(childId, summary, boundary, "compressed context", timestamp), isCompactSummary: true },
      agentEntry(childId, continuation, summary, "continue after compaction", timestamp),
    ])
    // A fresh provider must reconstruct the same attachment without cached pre-compaction text.
    const reads = await Effect.runPromise(makeProvider().readTranscripts([sessionId, childId]))
    const transcripts = new Map([...reads].map(([id, read]) => {
      if (read._tag !== "Available") throw new Error(`Unavailable ${id}`)
      return [id, read.messages] as const
    }))
    expect(transcripts.get(childId)?.find((item) => item.id === summary)).toMatchObject({ visible: false, historyBoundary: "compaction" })
    const forest = buildConversationForest(
      [{ id: sessionId, title: "Parent", lastModified: 0 }, fork.session], transcripts,
      [{ ...fork.derivation, createdAt: timestamp }],
    )
    expect(forest.graphs).toHaveLength(1)
    expect(forest.warnings).toEqual([])
    const graph = forest.graphs[0]!
    const sourceNode = [...graph.nodes.values()].find((node) => node.kind === "message" && node.aliases.some((alias) => alias.sessionId === sessionId && alias.messageId === source))!
    const continued = [...graph.nodes.values()].find((node) => node.kind === "message" && node.aliases.some((alias) => alias.messageId === continuation))!
    expect(continued.parentId).toBe(sourceNode.id)
    const nextFork = await Effect.runPromise(makeProvider().branchFrom({ sessionId: childId, messageId: continuation }))
    if (nextFork._tag !== "ValidatedBranch") throw new Error(nextFork.reason)
    const nextReads = await Effect.runPromise(makeProvider().readTranscripts([sessionId, childId, nextFork.session.id]))
    const nextTranscripts = new Map([...nextReads].map(([id, read]) => {
      if (read._tag !== "Available") throw new Error(`Unavailable ${id}`)
      return [id, read.messages] as const
    }))
    const nextForest = buildConversationForest(
      [{ id: sessionId, title: "Parent", lastModified: 0 }, fork.session, nextFork.session], nextTranscripts,
      [fork.derivation, nextFork.derivation].map((derivation) => ({ ...derivation, createdAt: timestamp })),
    )
    expect(nextForest.graphs).toHaveLength(1)
    expect(nextForest.warnings).toEqual([])
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

test("filesystem import preserves compacted roots and real SDK forks without replacing the SDK active context", async () => {
  const configDir = await realpath(await mkdtemp(join(tmpdir(), "claude-tree-startup-import-")))
  const projectDir = join(configDir, "project")
  const projectKey = "startup-import-fixture"
  const sessionId = crypto.randomUUID()
  const ids = Array.from({ length: 6 }, () => crypto.randomUUID())
  const firstBoundary = crypto.randomUUID(), firstSummary = crypto.randomUUID()
  const restoredUser = crypto.randomUUID(), restoredAgent = crypto.randomUUID()
  const timestamp = "2026-09-11T12:00:00.000Z"
  const entries: SessionStoreEntry[] = [
    userEntry(sessionId, ids[0]!, null, "before compaction", timestamp),
    agentEntry(sessionId, ids[1]!, ids[0]!, "earlier answer", timestamp),
    // A later root replaces this path, while the physical old records remain.
    userEntry(sessionId, restoredUser, null, "replacement question", timestamp),
    agentEntry(sessionId, restoredAgent, restoredUser, "replacement answer", timestamp),
    // Cross the pinned SDK's filesystem precompaction-read threshold.
    { type: "file-history-snapshot", snapshot: "x".repeat(6 * 1024 * 1024) },
    { type: "system", subtype: "compact_boundary", uuid: firstBoundary, parentUuid: null,
      logicalParentUuid: restoredAgent, sessionId, timestamp, compactMetadata: {} },
    { ...userEntry(sessionId, firstSummary, firstBoundary, "first compact summary", timestamp), isCompactSummary: true },
    { type: "system", subtype: "compact_boundary", uuid: ids[2]!, parentUuid: null,
      logicalParentUuid: firstSummary, sessionId, timestamp,
      compactMetadata: { preservedMessages: { uuids: ids.slice(0, 2), anchorUuid: ids[3] } } },
    { ...userEntry(sessionId, ids[3]!, ids[2]!, "compact summary", timestamp), isCompactSummary: true },
    userEntry(sessionId, ids[4]!, ids[3]!, "after compaction", timestamp),
    agentEntry(sessionId, ids[5]!, ids[4]!, "latest answer", timestamp),
  ]
  try {
    await mkdir(projectDir, { recursive: true })
    const transcriptDir = join(configDir, "projects", projectKey)
    await mkdir(transcriptDir, { recursive: true })
    await writeFile(join(transcriptDir, `${sessionId}.jsonl`), entries.map((entry) => JSON.stringify({ ...entry, cwd: projectDir })).join("\n") + "\n")
    const script = `
      import { Effect } from "effect"
      import { getSessionMessages, getSessionInfo, forkSession, listSessions, importSessionToStore, InMemorySessionStore } from "@anthropic-ai/claude-agent-sdk"
      import { makeClaudeProvider } from "./src/infrastructure/providers/claude/provider.ts"
      const dir = ${JSON.stringify(projectDir)}, id = ${JSON.stringify(sessionId)}
      const active = await getSessionMessages(id, { dir })
      const store = new InMemorySessionStore()
      await importSessionToStore(id, store, { dir, includeSubagents: false })
      const imported = await getSessionMessages(id, { dir, sessionStore: store })
      const storeActiveProvider = makeClaudeProvider(dir, { sdk: {
        getSessionInfo, forkSession, listSessions, importSessionToStore,
        getSessionMessages: (id, options) => getSessionMessages(id, { ...options, sessionStore: store }),
      } })
      const storeActiveRead = (await Effect.runPromise(storeActiveProvider.readTranscripts([id]))).get(id)
      const provider = makeClaudeProvider(dir, { resolveExecutable: () => "/usr/bin/claude" })
      const read = (await Effect.runPromise(provider.readTranscripts([id]))).get(id)
      if (read?._tag !== "Available") throw new Error(JSON.stringify(read))
      const branch = await Effect.runPromise(provider.branchFrom({ sessionId: id, messageId: ${JSON.stringify(restoredAgent)} }))
      if (branch._tag !== "ValidatedBranch") throw new Error(JSON.stringify(branch))
      const snapshot = await Effect.runPromise(provider.loadSessionSnapshot)
      console.log(JSON.stringify({
        active: active.map(m => m.uuid), imported: imported.map(m => m.uuid),
        storeActiveOutcome: storeActiveRead._tag,
        history: read.messages.map(m => ({ id: m.id, historical: Boolean(m.historical) })),
        sessions: snapshot.sessions.length,
        outcomes: [...snapshot.transcripts.values()].map(read => read._tag),
        shared: branch.derivation.sharedMessages.length,
      }))
    `
    const subprocess = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_PROJECT_DIR_NAME: projectKey },
      stdout: "pipe", stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited, Bun.readableStreamToText(subprocess.stdout), Bun.readableStreamToText(subprocess.stderr),
    ])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.imported.length).toBeGreaterThan(result.active.length)
    expect(result.storeActiveOutcome).toBe("Unavailable")
    const historyIds = result.history.map((message: { id: string }) => message.id)
    expect(historyIds).toContain(restoredUser)
    expect(historyIds).not.toContain(ids[0])
    expect(result.imported).toContain(ids[0])
    for (const message of result.history) expect(message.historical).toBe(!result.active.includes(message.id))
    expect(result.sessions).toBe(2)
    expect(result.outcomes).toEqual(["Available", "Available"])
    expect(result.shared).toBe(2)
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test("filesystem preservation cycles recover across SDK forks without depending on the original parent file", async () => {
  const configDir = await realpath(await mkdtemp(join(tmpdir(), "claude-tree-preserved-versions-")))
  const projectDir = join(configDir, "project")
  const projectKey = "preserved-versions-fixture"
  const sessionId = crypto.randomUUID()
  const ids = Array.from({ length: 6 }, () => crypto.randomUUID())
  const timestamp = "2026-09-11T12:00:00.000Z"
  const answer = agentEntry(sessionId, ids[1]!, ids[0]!, "old answer", timestamp)
  const entries: SessionStoreEntry[] = [
    userEntry(sessionId, ids[0]!, null, "old question", timestamp), answer,
    { type: "file-history-snapshot", snapshot: "x".repeat(6 * 1024 * 1024) },
    { type: "system", subtype: "compact_boundary", uuid: ids[2]!, sessionId, parentUuid: null,
      logicalParentUuid: ids[1], compactMetadata: { preservedMessages: { uuids: [ids[1]], anchorUuid: ids[3] } } },
    { ...userEntry(sessionId, ids[3]!, ids[2]!, "summary", timestamp), isCompactSummary: true },
    { ...answer, parentUuid: ids[3] },
    userEntry(sessionId, ids[4]!, ids[1]!, "current question", timestamp),
    agentEntry(sessionId, ids[5]!, ids[4]!, "current answer", timestamp),
  ]
  try {
    await mkdir(projectDir, { recursive: true })
    const transcriptDir = join(configDir, "projects", projectKey)
    await mkdir(transcriptDir, { recursive: true })
    const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`)
    await writeFile(transcriptPath, entries.map((entry) => JSON.stringify({ ...entry, cwd: projectDir })).join("\n") + "\n")
    const script = `
      import { Effect } from "effect"
      import { unlink } from "node:fs/promises"
      import { makeClaudeProvider } from "./src/infrastructure/providers/claude/provider.ts"
      const makeProvider = () => makeClaudeProvider(${JSON.stringify(projectDir)}, { resolveExecutable: () => "/usr/bin/claude" })
      const read = async id => {
        const result = (await Effect.runPromise(makeProvider().readTranscripts([id]))).get(id)
        if (result?._tag !== "Available") throw new Error(JSON.stringify(result))
        return result.messages.filter(message => message.visible).map(message => message.preview)
      }
      const fork = async (id, messageId) => {
        const result = await Effect.runPromise(makeProvider().branchFrom({ sessionId: id, messageId }))
        if (result._tag !== "ValidatedBranch") throw new Error(JSON.stringify(result))
        return result
      }
      const original = await read(${JSON.stringify(sessionId)})
      const child = await fork(${JSON.stringify(sessionId)}, ${JSON.stringify(ids[5])})
      const grandchild = await fork(child.session.id, child.derivation.sharedMessages.at(-1).childMessageId)
      await unlink(${JSON.stringify(transcriptPath)})
      const descendant = await read(grandchild.session.id)
      const historical = await fork(child.session.id, child.derivation.sharedMessages.find(pair => pair.parentMessageId === ${JSON.stringify(ids[1])}).childMessageId)
      console.log(JSON.stringify({ original, descendant, historical: await read(historical.session.id), copied: historical.derivation.sharedMessages.length }))
    `
    const subprocess = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_PROJECT_DIR_NAME: projectKey },
      stdout: "pipe", stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited, Bun.readableStreamToText(subprocess.stdout), Bun.readableStreamToText(subprocess.stderr),
    ])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.original).toEqual(["old question", "old answer", "current question", "current answer"])
    expect(result.descendant).toEqual(result.original)
    expect(result.historical).toEqual(["old question", "old answer"])
    expect(result.copied).toBe(2)
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test("single-version SDK forks recover five preserved records through attachment ancestry on fresh filesystem reads", async () => {
  const configDir = await realpath(await mkdtemp(join(tmpdir(), "claude-tree-single-version-")))
  const projectDir = join(configDir, "project")
  const projectKey = "single-version-fork-fixture"
  const sessionId = crypto.randomUUID()
  const ids = Array.from({ length: 10 }, () => crypto.randomUUID())
  const timestamp = "2026-09-11T12:00:00.000Z"
  const question = userEntry(sessionId, ids[0]!, null, "original question", timestamp)
  const preserved: SessionStoreEntry[] = [
    agentEntry(sessionId, ids[1]!, ids[0]!, "preserved answer", timestamp),
    userEntry(sessionId, ids[2]!, ids[1]!, "preserved question", timestamp),
    agentEntry(sessionId, ids[3]!, ids[2]!, "another preserved answer", timestamp),
    userEntry(sessionId, ids[4]!, ids[3]!, "another preserved question", timestamp),
    { type: "attachment", uuid: ids[5]!, sessionId, parentUuid: ids[4], attachment: { type: "fixture", data: "attachment evidence" } },
  ]
  const compact: SessionStoreEntry = { type: "system", subtype: "compact_boundary", uuid: ids[6]!, sessionId, parentUuid: null,
    logicalParentUuid: ids[5], compactMetadata: { preservedMessages: { uuids: ids.slice(1, 6), anchorUuid: ids[7] } } }
  const summary = { ...userEntry(sessionId, ids[7]!, ids[6]!, "summary", timestamp), isCompactSummary: true }
  const continuation = userEntry(sessionId, ids[8]!, ids[5]!, "current question", timestamp)
  const response = agentEntry(sessionId, ids[9]!, ids[8]!, "current answer", timestamp)
  const originals = [question, ...preserved, compact, summary, continuation, response]
  // The SDK can fork a compacted store snapshot containing only the context
  // version; original parent evidence remains in the source's physical file.
  const snapshot = [question, compact, summary,
    ...preserved.map((record, index) => ({ ...record, parentUuid: index === 0 ? ids[7] : ids[index] })), continuation, response]
  try {
    await mkdir(projectDir, { recursive: true })
    const transcriptDir = join(configDir, "projects", projectKey)
    await mkdir(transcriptDir, { recursive: true })
    const ancestorDir = join(configDir, "projects", "ancestor-project-fixture")
    await mkdir(ancestorDir, { recursive: true })
    const originalPath = join(ancestorDir, `${sessionId}.jsonl`)
    await writeFile(originalPath, originals.map((record) => JSON.stringify({ ...record, cwd: projectDir })).join("\n") + "\n")
    const script = `
      import { writeFile, unlink } from "node:fs/promises"
      import { Effect } from "effect"
      import { forkSession, InMemorySessionStore } from "@anthropic-ai/claude-agent-sdk"
      import { makeClaudeProvider } from "./src/infrastructure/providers/claude/provider.ts"
      const dir = ${JSON.stringify(projectDir)}, projectKey = ${JSON.stringify(projectKey)}
      const store = new InMemorySessionStore()
      await store.append({ projectKey, sessionId: ${JSON.stringify(sessionId)} }, ${JSON.stringify(snapshot)})
      const child = await forkSession(${JSON.stringify(sessionId)}, { dir, sessionStore: store, upToMessageId: ${JSON.stringify(ids[9])} })
      const childEntries = store.getEntries({ projectKey, sessionId: child.sessionId })
      const childAnswer = childEntries.find(record => record.forkedFrom?.messageUuid === ${JSON.stringify(ids[1])})
      const childTail = childEntries.find(record => record.forkedFrom?.messageUuid === ${JSON.stringify(ids[9])})
      await writeFile(${JSON.stringify(transcriptDir)} + "/" + child.sessionId + ".jsonl", childEntries.map(record => JSON.stringify(record)).join("\\n") + "\\n")
      const grandchild = await forkSession(child.sessionId, { dir, sessionStore: store, upToMessageId: childTail.uuid })
      const grandEntries = store.getEntries({ projectKey, sessionId: grandchild.sessionId })
      await writeFile(${JSON.stringify(transcriptDir)} + "/" + grandchild.sessionId + ".jsonl", grandEntries.map(record => JSON.stringify(record)).join("\\n") + "\\n")
      const makeProvider = () => makeClaudeProvider(dir, { resolveExecutable: () => "/usr/bin/claude" })
      const first = (await Effect.runPromise(makeProvider().readTranscripts([child.sessionId]))).get(child.sessionId)
      const second = (await Effect.runPromise(makeProvider().readTranscripts([grandchild.sessionId]))).get(grandchild.sessionId)
      if (first?._tag !== "Available" || second?._tag !== "Available") throw new Error(JSON.stringify({ first, second }))
      const fork = await Effect.runPromise(makeProvider().branchFrom({ sessionId: grandchild.sessionId,
        messageId: grandEntries.find(record => record.forkedFrom?.messageUuid === childTail.uuid).uuid }))
      if (fork._tag !== "ValidatedBranch") throw new Error(JSON.stringify(fork))
      await unlink(${JSON.stringify(originalPath)})
      const missing = (await Effect.runPromise(makeProvider().readTranscripts([child.sessionId]))).get(child.sessionId)
      console.log(JSON.stringify({
        localVersions: childEntries.filter(record => record.uuid === childAnswer.uuid).length,
        first: first.messages.filter(message => message.visible).map(message => message.preview),
        second: second.messages.filter(message => message.visible).map(message => message.preview),
        copied: fork.derivation.sharedMessages.length,
        missing: missing?._tag,
        missingReason: missing?._tag === "Unavailable" && missing.reason.includes("requires source session"),
      }))
    `
    const subprocess = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_PROJECT_DIR_NAME: projectKey },
      stdout: "pipe", stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited, Bun.readableStreamToText(subprocess.stdout), Bun.readableStreamToText(subprocess.stderr),
    ])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.localVersions).toBe(1)
    expect(result.first).toEqual(["original question", "preserved answer", "preserved question", "another preserved answer", "another preserved question", "current question", "current answer"])
    expect(result.second).toEqual(result.first)
    expect(result.copied).toBe(8)
    expect(result.missing).toBe("Unavailable")
    expect(result.missingReason).toBeTrue()
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
