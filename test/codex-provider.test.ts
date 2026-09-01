import { describe, expect, test } from "bun:test"

import { BranchCreatedError, NullTerminalObserver } from "../src/agent-provider"
import type {
  CodexAppServer,
  CodexThread,
  CodexThreadItem,
  CodexThreadListPage,
  CodexTurn,
} from "../src/providers/codex-app-server"
import { CodexRpcError } from "../src/providers/codex-app-server"
import {
  CodexProvider,
  type CodexResumeSessionFactory,
  createCodexProvider,
  formatCodexUserInput,
  normalizeCodexThread,
} from "../src/providers/codex"

const ROOT = "01911111-1111-7111-8111-111111111111"
const CHILD = "01922222-2222-7222-8222-222222222222"

describe("Codex message normalization", () => {
  test("shows nonempty user and agent messages and preserves every raw item", () => {
    const rawTool = { type: "commandExecution", id: "tool-1", command: "pwd", status: "completed" }
    const thread = codexThread(ROOT, [
      turn("turn-1", "completed", [
        user("user-1", [
          { type: "text", text: "Hello\nworld" },
          { type: "image", url: "https://example.test/a.png" },
          { type: "localImage", path: "/tmp/a.png" },
          { type: "audio", url: "https://example.test/a.wav" },
          { type: "localAudio", path: "/tmp/a.wav" },
          { type: "skill", name: "review", path: "/skills/review" },
          { type: "mention", name: "README", path: "/project/README.md" },
        ]),
        rawTool,
        { type: "agentMessage", id: "agent-1", text: "Finished\nnow", phase: "final_answer" },
        { type: "agentMessage", id: "agent-empty", text: "  " },
      ]),
    ])

    const messages = normalizeCodexThread(thread)

    expect(messages.map(({ role, preview, visible }) => ({ role, preview, visible }))).toEqual([
      {
        role: "user",
        preview:
          "Hello world [image] [localImage] [audio] [localAudio] [skill: review] [mention: README]",
        visible: true,
      },
      { role: "system", preview: "[commandExecution]", visible: false },
      { role: "agent", preview: "Finished now", visible: true },
      { role: "system", preview: "[agentMessage]", visible: false },
    ])
    expect(messages[1]?.rawItem).toBe(rawTool)
    expect(messages[1]?.turnId).toBe("turn-1")
    expect(messages.map((message) => message.ordinal)).toEqual([0, 1, 2, 3])
    expect(messages[2]?.turnComplete).toBeTrue()
    expect(normalizeCodexThread(codexThread(ROOT, [
      turn("turn-2", "inProgress", [
        { type: "agentMessage", id: "agent-working", text: "Working" },
      ]),
    ]))[0]?.turnComplete).toBeFalse()
    for (const status of ["interrupted", "failed"] as const) {
      expect(normalizeCodexThread(codexThread(ROOT, [
        turn(`turn-${status}`, status, [
          { type: "agentMessage", id: `agent-${status}`, text: status },
        ]),
      ]))[0]?.turnComplete).toBeTrue()
    }
    expect(normalizeCodexThread(codexThread(ROOT, [
      turn("turn-interrupted-user-only", "interrupted", [
        user("user-interrupted", [{ type: "text", text: "Interrupted" }]),
      ]),
    ]))[0]?.turnComplete).toBeTrue()
  })

  test("formats unknown and empty user inputs conservatively", () => {
    expect(formatCodexUserInput([])).toBe("[empty message]")
    expect(formatCodexUserInput([{ type: "futureInput", value: 1 }])).toBe("[futureInput]")
  })
})

describe("Codex sessions", () => {
  test("pages by canonical cwd and maps names, previews, timestamps, and branches", async () => {
    const calls: Parameters<CodexAppServer["listThreads"]>[0][] = []
    const first = codexThread(ROOT, [], {
      name: "  Named\nthread ",
      preview: "ignored",
      updatedAt: 12,
      gitInfo: { branch: "feature" },
    })
    const second = codexThread(CHILD, [], { name: null, preview: " preview title ", updatedAt: 7 })
    const server = fakeServer({
      async listThreads(params) {
        calls.push(params)
        return params.cursor
          ? { data: [second], nextCursor: null }
          : { data: [first], nextCursor: "next" }
      },
    })
    const provider = providerFrom(server)

    expect(await provider.listSessions()).toEqual([
      { id: ROOT, title: "Named thread", lastModified: 12_000, gitBranch: "feature" },
      { id: CHILD, title: "preview title", lastModified: 7_000 },
    ])
    const filters = {
      cwd: "/canonical/project",
      modelProviders: [],
      sourceKinds: ["cli", "vscode", "appServer"],
      sortKey: "updated_at",
    } as const
    expect(calls).toEqual([filters, { ...filters, cursor: "next" }])
    expect(server.closeCalls).toBe(1)
  })

  test("reads a transcript batch through one app-server process", async () => {
    const factories: FakeServer[] = []
    const server = fakeServer({
      async readThread(id) {
        return codexThread(id, [turn(`turn-${id}`, "completed", [user(`user-${id}`, [{ type: "text", text: id }])])])
      },
    })
    const provider = new CodexProvider("/canonical/project", "/usr/bin/codex", async () => {
      factories.push(server)
      return server
    })

    const transcripts = await provider.readTranscripts([ROOT, CHILD])

    expect(factories).toHaveLength(1)
    expect(server.readCalls).toEqual([ROOT, CHILD])
    expect(transcripts.get(ROOT)?.[0]?.preview).toBe(ROOT)
    expect(transcripts.get(CHILD)?.[0]?.preview).toBe(CHILD)
    expect(server.closeCalls).toBe(1)
  })

  test("loads session metadata and transcripts through one app-server process", async () => {
    const factories: FakeServer[] = []
    const thread = codexThread(ROOT, [
      turn("turn-1", "completed", [user("user-1", [{ type: "text", text: "Question" }])]),
    ])
    const server = fakeServer({
      async listThreads() { return { data: [thread], nextCursor: null } },
      async readThread() { return thread },
    })
    const provider = new CodexProvider("/canonical/project", "/usr/bin/codex", async () => {
      factories.push(server)
      return server
    })

    const snapshot = await provider.loadSessionSnapshot()

    expect(factories).toHaveLength(1)
    expect(snapshot.sessions).toEqual([
      { id: ROOT, title: "Preview", lastModified: 1_000 },
    ])
    expect(snapshot.transcripts.get(ROOT)?.[0]?.preview).toBe("Question")
    expect(server.readCalls).toEqual([ROOT])
    expect(server.closeCalls).toBe(1)
  })

  test("omits stale thread-index entries whose rollout is missing", async () => {
    const server = fakeServer({
      async readThread(id) {
        if (id === CHILD) {
          throw new CodexRpcError("thread/read", -32600, `no rollout found for thread id ${id}`)
        }
        return codexThread(id, [])
      },
    })

    const transcripts = await providerFrom(server).readTranscripts([ROOT, CHILD])

    expect(transcripts.get(ROOT)).toEqual([])
    expect(transcripts.get(CHILD)).toBeNull()
    expect(server.closeCalls).toBe(1)
  })

  test("does not hide unrelated invalid-request failures", async () => {
    const server = fakeServer({
      async readThread() {
        throw new CodexRpcError("thread/read", -32600, "failed to load configuration")
      },
    })

    await expect(providerFrom(server).readTranscripts([ROOT])).rejects.toThrow(
      "failed to load configuration",
    )
    expect(server.closeCalls).toBe(1)
  })

  test("bounds transcript concurrency and retries app-server overloads", async () => {
    let active = 0
    let maximumActive = 0
    let overloaded = false
    const server = fakeServer({
      async readThread(id) {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        try {
          await Bun.sleep(1)
          if (!overloaded) {
            overloaded = true
            throw new CodexRpcError("thread/read", -32001, "server overloaded")
          }
          return codexThread(id, [])
        } finally {
          active -= 1
        }
      },
    })
    const sessionIds = Array.from({ length: 200 }, (_, index) => `session-${index}`)

    const transcripts = await providerFrom(server).readTranscripts(sessionIds)

    expect(transcripts.size).toBe(200)
    expect(maximumActive).toBeLessThanOrEqual(16)
    expect(server.readCalls).toHaveLength(201)
  })

  test("lets the stock remote TUI start a blank thread and reports its real session", async () => {
    const events: string[] = []
    const observer = new NullTerminalObserver()
    const cleanup = async () => { events.push("cleanup") }
    const transitions = {
      subscribe() {
        return () => undefined
      },
    }
    const provider = new CodexProvider(
      "/canonical/project",
      "/usr/bin/codex",
      async () => fakeServer(),
      () => observer,
      async (executable, cwd) => {
        events.push(`start:${executable}:${cwd}`)
        return {
          sessionId: "pending-codex-test",
          threadStarted: Promise.resolve(
            { id: CHILD, title: "Untitled conversation", lastModified: 21_000 },
          ),
          remoteUrl: "unix:///tmp/codex.sock",
          bearerToken: "secret-token",
          transitions,
          cleanup,
        }
      },
    )

    const prepared = await provider.prepareNewSession()
    events.push("returned")

    expect(events).toEqual(["start:/usr/bin/codex:/canonical/project", "returned"])
    expect(prepared.session.id).toBe("pending-codex-test")
    expect(prepared.session.title).toBe("Untitled conversation")
    expect(prepared.session.transient).toBeTrue()
    expect(await prepared.startedSession).toEqual({
      id: CHILD, title: "Untitled conversation", lastModified: 21_000, transient: true,
    })
    expect(prepared.launch).toEqual({
      sessionId: "pending-codex-test",
      command: [
        "/usr/bin/codex",
        "--remote",
        "unix:///tmp/codex.sock",
        "--remote-auth-token-env",
        "CLAUDE_TREE_CODEX_TOKEN",
        "--cd",
        "/canonical/project",
      ],
      cwd: "/canonical/project",
      env: { CLAUDE_TREE_CODEX_TOKEN: "secret-token" },
      observer,
      sessionTransitions: transitions,
      cleanup,
    })
    await prepared.launch.cleanup?.()
    expect(events).toEqual(["start:/usr/bin/codex:/canonical/project", "returned", "cleanup"])
  })

  test("does not invent ancestry when the stock TUI forks before the first turn", async () => {
    const parent = codexThread(ROOT, [
      turn("turn-1", "completed", [user("parent-user", [{ type: "text", text: "Question" }])]),
    ])
    const child = codexThread(CHILD, [])
    const server = fakeServer({
      async readThread(id) { return id === ROOT ? parent : child },
    })
    let derivation: Promise<unknown> | undefined
    const provider = new CodexProvider(
      "/canonical/project",
      "/usr/bin/codex",
      async () => server,
      undefined,
      undefined,
      async (_executable, _cwd, _sessionId, transitionFor) => {
        derivation = transitionFor({
          previousThreadId: ROOT,
          thread: child,
          method: "thread/fork",
          params: { beforeTurnId: "turn-1" },
        }).derivation
        return fakeResumeSessionFactory(_executable, _cwd, _sessionId, transitionFor)
      },
    )

    await provider.prepareResume({ id: ROOT, title: "Root", lastModified: 1 })
    expect(await derivation).toBeUndefined()
  })

  test("resume uses the stock TUI through its observed app-server", async () => {
    const provider = providerFrom(fakeServer())
    const launch = await provider.prepareResume({ id: ROOT, title: "Root", lastModified: 0 })
    expect(launch.command).toEqual([
      "/usr/bin/codex",
      "resume",
      "--remote",
      "ws://127.0.0.1:12345",
      "--remote-auth-token-env",
      "CLAUDE_TREE_CODEX_TOKEN",
      ROOT,
    ])
    expect(launch.sessionTransitions).toBeDefined()
  })
})

describe("Codex branching", () => {
  test("forks through the selected completed turn and maps the exact copied prefix", async () => {
    const parent = codexThread(ROOT, [
      turn("turn-1", "completed", [
        user("parent-user-1", [{ type: "text", text: "Question" }]),
        { type: "reasoning", id: "parent-reasoning-1", summary: ["thinking"], content: [] },
        { type: "agentMessage", id: "parent-agent-1", text: "Answer", phase: "final_answer" },
      ]),
      turn("turn-2", "completed", [
        user("parent-user-2", [{ type: "text", text: "Later" }]),
        { type: "agentMessage", id: "parent-agent-2", text: "Later answer" },
      ]),
    ], { name: "Parent", preview: "Question" })
    const child = codexThread(CHILD, [
      turn("child-turn-1", "completed", [
        user("child-user-1", [{ type: "text", text: "Question" }]),
        { type: "reasoning", id: "child-reasoning-1", summary: ["thinking"], content: [] },
        { type: "agentMessage", id: "child-agent-1", text: "Answer", phase: "final_answer" },
      ]),
    ], { name: "Parent", preview: "Question", updatedAt: 30 })
    const server = fakeServer({
      async readThread(id) {
        return id === ROOT ? parent : child
      },
      async forkThread() {
        return child
      },
    })
    const provider = providerFrom(server)

    const prepared = await provider.branchFrom({ sessionId: ROOT, messageId: "parent-agent-1" })

    expect(server.forkCalls).toEqual([
      { threadId: ROOT, lastTurnId: "turn-1", cwd: "/canonical/project" },
    ])
    expect(prepared.providerSessionCreated).toBeTrue()
    expect(prepared.derivation).toEqual({
      childSessionId: CHILD,
      parentSessionId: ROOT,
      sourceMessageId: "parent-agent-1",
      sharedMessages: [
        { parentMessageId: "parent-user-1", childMessageId: "child-user-1" },
        { parentMessageId: "parent-reasoning-1", childMessageId: "child-reasoning-1" },
        { parentMessageId: "parent-agent-1", childMessageId: "child-agent-1" },
      ],
    })
    expect(prepared.launch.command).toEqual([
      "/usr/bin/codex",
      "resume",
      "--remote",
      "ws://127.0.0.1:12345",
      "--remote-auth-token-env",
      "CLAUDE_TREE_CODEX_TOKEN",
      CHILD,
    ])
    expect(server.closeCalls).toBe(1)
  })

  test("reports the created child when terminal preparation fails after a fork", async () => {
    const parent = codexThread(ROOT, [
      turn("turn-1", "completed", [
        user("parent-user", [{ type: "text", text: "Question" }]),
        { type: "agentMessage", id: "parent-agent", text: "Answer" },
      ]),
    ])
    const child = codexThread(CHILD, [
      turn("child-turn-1", "completed", [
        user("child-user", [{ type: "text", text: "Question" }]),
        { type: "agentMessage", id: "child-agent", text: "Answer" },
      ]),
    ])
    const server = fakeServer({
      async readThread(id) { return id === ROOT ? parent : child },
      async forkThread() { return child },
    })
    const provider = new CodexProvider(
      "/canonical/project",
      "/usr/bin/codex",
      async () => server,
      undefined,
      undefined,
      async () => { throw new Error("proxy startup failed") },
    )

    let failure: unknown
    try {
      await provider.branchFrom({ sessionId: ROOT, messageId: "parent-agent" })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(BranchCreatedError)
    const created = failure as BranchCreatedError
    expect(created.session.id).toBe(CHILD)
    expect(created.transcript.map((message) => message.id)).toEqual(["child-user", "child-agent"])
    expect(created.transcriptAvailable).toBeTrue()
  })

  test("does not start an observed sidecar until the metadata server closes", async () => {
    const parent = codexThread(ROOT, [
      turn("turn-1", "completed", [
        { type: "agentMessage", id: "parent-agent", text: "Answer" },
      ]),
    ])
    const child = codexThread(CHILD, [
      turn("child-turn-1", "completed", [
        { type: "agentMessage", id: "child-agent", text: "Answer" },
      ]),
    ])
    const server = fakeServer({
      async readThread(id) { return id === ROOT ? parent : child },
      async forkThread() { return child },
      async close() { throw new Error("close failed") },
    })
    let resumeCalls = 0
    const provider = new CodexProvider(
      "/canonical/project",
      "/usr/bin/codex",
      async () => server,
      undefined,
      undefined,
      async (...args) => {
        resumeCalls += 1
        return fakeResumeSessionFactory(...args)
      },
    )

    await expect(
      provider.branchFrom({ sessionId: ROOT, messageId: "parent-agent" }),
    ).rejects.toThrow("close failed")
    expect(resumeCalls).toBe(0)
  })

  test.each([
    ["user message", turn("turn-1", "completed", [user("target", [{ type: "text", text: "Q" }])]), "user message"],
    ["system item", turn("turn-1", "completed", [{ type: "reasoning", id: "target", summary: [], content: [] }]), "system item"],
    [
      "intra-turn agent",
      turn("turn-1", "completed", [
        { type: "agentMessage", id: "target", text: "First" },
        { type: "agentMessage", id: "final", text: "Final" },
      ]),
      "final item",
    ],
    ["in-progress turn", turn("turn-1", "inProgress", [{ type: "agentMessage", id: "target", text: "Working" }]), "completed turn"],
  ])("rejects a %s clearly", async (_label, selectedTurn, expected) => {
    const server = fakeServer({ async readThread() { return codexThread(ROOT, [selectedTurn]) } })
    const provider = providerFrom(server)
    await expect(provider.branchFrom({ sessionId: ROOT, messageId: "target" })).rejects.toThrow(expected)
    expect(server.forkCalls).toHaveLength(0)
    expect(server.closeCalls).toBe(1)
  })

  test("fails closed when any copied raw payload differs", async () => {
    const parent = codexThread(ROOT, [
      turn("parent-turn", "completed", [
        user("parent-user", [{ type: "text", text: "Question" }]),
        { type: "agentMessage", id: "parent-agent", text: "Answer", phase: "final_answer" },
      ]),
    ])
    const child = codexThread(CHILD, [
      turn("child-turn", "completed", [
        user("child-user", [{ type: "text", text: "Question " }]),
        { type: "agentMessage", id: "child-agent", text: "Answer", phase: "final_answer" },
      ]),
    ])
    const server = fakeServer({
      async readThread(id) { return id === ROOT ? parent : child },
      async forkThread() { return child },
    })

    await expect(
      providerFrom(server).branchFrom({ sessionId: ROOT, messageId: "parent-agent" }),
    ).rejects.toThrow(`Fork ${CHILD} was created, but its copied prefix does not match the source`)
  })

  test("fails closed when the child has extra copied items", async () => {
    const parent = codexThread(ROOT, [
      turn("parent-turn", "completed", [{ type: "agentMessage", id: "parent-agent", text: "Answer" }]),
    ])
    const child = codexThread(CHILD, [
      turn("child-turn", "completed", [
        { type: "agentMessage", id: "child-agent", text: "Answer" },
        { type: "reasoning", id: "extra", summary: [], content: [] },
      ]),
    ])
    const server = fakeServer({
      async readThread(id) { return id === ROOT ? parent : child },
      async forkThread() { return child },
    })

    await expect(
      providerFrom(server).branchFrom({ sessionId: ROOT, messageId: "parent-agent" }),
    ).rejects.toThrow(`Fork ${CHILD} was created, but its copied prefix could not be validated`)
  })
})

describe("Codex provider creation", () => {
  test("locates Codex and canonicalizes the project without checking its version", async () => {
    const calls: string[] = []
    const server = fakeServer()
    const provider = await createCodexProvider("/project-link", {
      which(name) {
        calls.push(`which:${name}`)
        return "/usr/local/bin/codex"
      },
      async canonicalize(path) {
        calls.push(`canonicalize:${path}`)
        return "/canonical/project"
      },
      appServerFactory: async () => server,
      resumeSessionFactory: fakeResumeSessionFactory,
    })

    expect(calls).toEqual([
      "which:codex",
      "canonicalize:/project-link",
    ])
    expect(provider.navigatorIdentity.label).toBe("Codex")
    expect((await provider.prepareResume({ id: ROOT, title: "Root", lastModified: 0 })).cwd).toBe(
      "/canonical/project",
    )
  })

  test("fails when Codex is not on PATH", async () => {
    await expect(createCodexProvider("/project", { which: () => null })).rejects.toThrow(
      "Codex was not found on PATH",
    )
  })
})

interface FakeServer extends CodexAppServer {
  closeCalls: number
  readCalls: string[]
  forkCalls: Array<{ threadId: string; lastTurnId: string; cwd: string }>
}

function fakeServer(overrides: Partial<CodexAppServer> = {}): FakeServer {
  const server: FakeServer = {
    closeCalls: 0,
    readCalls: [],
    forkCalls: [],
    async listThreads(params): Promise<CodexThreadListPage> {
      if (overrides.listThreads) return overrides.listThreads.call(server, params)
      return { data: [], nextCursor: null }
    },
    async listLoadedThreadIds() {
      if (overrides.listLoadedThreadIds) return overrides.listLoadedThreadIds.call(server)
      return []
    },
    async readThread(id) {
      server.readCalls.push(id)
      if (overrides.readThread) return overrides.readThread.call(server, id)
      return codexThread(id, [])
    },
    async forkThread(threadId, lastTurnId, cwd) {
      server.forkCalls.push({ threadId, lastTurnId, cwd })
      if (overrides.forkThread) {
        return overrides.forkThread.call(server, threadId, lastTurnId, cwd)
      }
      return codexThread(CHILD, [])
    },
    async close() {
      server.closeCalls += 1
      await overrides.close?.call(server)
    },
  }
  return server
}

function providerFrom(server: FakeServer, observerFactory?: () => NullTerminalObserver): CodexProvider {
  return new CodexProvider(
    "/canonical/project",
    "/usr/bin/codex",
    async () => server,
    observerFactory,
    undefined,
    fakeResumeSessionFactory,
  )
}

const fakeResumeSessionFactory: CodexResumeSessionFactory = async () => ({
  remoteUrl: "ws://127.0.0.1:12345",
  bearerToken: "resume-token",
  transitions: {
    subscribe() {
      return () => undefined
    },
  },
  async cleanup() {},
})

function codexThread(
  id: string,
  turns: CodexTurn[],
  overrides: Partial<CodexThread> = {},
): CodexThread {
  return {
    id,
    name: null,
    preview: "Preview",
    updatedAt: 1,
    cwd: "/canonical/project",
    gitInfo: null,
    turns,
    ...overrides,
  }
}

function turn(id: string, status: CodexTurn["status"], items: CodexThreadItem[]): CodexTurn {
  return { id, status, items }
}

function user(id: string, content: Array<Record<string, unknown>>): CodexThreadItem {
  return { type: "userMessage", id, content } as CodexThreadItem
}
