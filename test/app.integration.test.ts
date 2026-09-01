import { afterEach, expect, spyOn, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTestRenderer, MouseButtons, TestRecorder } from "@opentui/core/testing"
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk"

import {
  BranchCreatedError,
  NullTerminalObserver,
  type AgentMessage,
  type AgentProvider,
  type AgentSession,
  type BranchDerivation,
  type DraftPreview,
  type PreparedSession,
  type TerminalObserver,
  type TerminalSessionTransition,
  type TerminalSessionTransitionSource,
} from "../src/agent-provider"
import { AgentTreeApp } from "../src/app"
import { displayWidth } from "../src/display-text"
import { BRAILLE_SPINNER_FRAMES } from "../src/graph-renderer"
import { BranchMetadataStore } from "../src/metadata"
import { PROGRAM_VERSION } from "../src/program"
import { ClaudeProvider } from "../src/providers/claude"
import { TerminalManager, type TerminalSessionChangedEvent } from "../src/terminal-manager"
import { theme } from "../src/theme"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test("renders navigator chrome against the terminal edges in both views", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)

  const sessionId = "11111111-1111-4111-8111-111111111111"
  const transcript = [
    sessionMessage(sessionId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "question"),
  ]
  const provider = new ClaudeProvider(project, join(root, "unused-claude"), {
    async list(): Promise<SDKSessionInfo[]> {
      return [{ sessionId, summary: "Layout conversation", firstPrompt: "question", lastModified: Date.now() }]
    },
    async messages(): Promise<SessionMessage[]> {
      return transcript
    },
    async fork(): Promise<{ sessionId: string }> {
      throw new Error("not used")
    },
  })
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    const roots = await waitForFrame(setup, (frame) => frame.includes("Layout conversation"))
    expectNavigatorChrome(roots, "Layout conversation")
    expect(roots).not.toContain("Refreshed")
    const claudeIdentity = setup
      .captureSpans()
      .lines[0]?.spans.find((span) => span.text === "Claude")
    expect(claudeIdentity?.fg.equals(theme.claude)).toBeTrue()

    setup.mockInput.pressEnter()
    const graph = await waitForFrame(
      setup,
      (frame) => frame.includes("Message graph") && frame.includes("question"),
    )
    expectNavigatorChrome(graph, "Selected user · question")
    expect(graph).not.toContain("Graph ready")
    expect(coordinateOf(graph, "question").x).toBe(26)
    expect(coordinateOf(graph, "question").y).toBe(12)
  } finally {
    await app.stop()
    await running
  }
})

test("shows loading instead of an empty state during initial provider discovery", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const session: AgentSession = {
    id: "delayed-session",
    title: "Delayed conversation",
    lastModified: 1,
  }
  let resolveSnapshot!: (snapshot: {
    sessions: AgentSession[]
    transcripts: Map<string, AgentMessage[] | null>
  }) => void
  const snapshot = new Promise<{
    sessions: AgentSession[]
    transcripts: Map<string, AgentMessage[] | null>
  }>((resolve) => { resolveSnapshot = resolve })
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async loadSessionSnapshot() { return snapshot },
    async listSessions() { throw new Error("snapshot should be used") },
    async readTranscripts() { throw new Error("snapshot should be used") },
    async prepareNewSession() { throw new Error("not used") },
    async prepareResume() { throw new Error("not used") },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    const loading = await waitForFrame(setup, (frame) => frame.includes("Loading conversations"))
    expect(loading).not.toContain("No conversations")

    resolveSnapshot({
      sessions: [session],
      transcripts: new Map([
        [session.id, [{ id: "message", role: "user", preview: "Question", ordinal: 0, visible: true }]],
      ]),
    })
    const loaded = await waitForFrame(setup, (frame) => frame.includes("Delayed conversation"))
    expect(loaded).not.toContain("Loading conversations")
    expect(loaded).not.toContain("No conversations")
  } finally {
    await app.stop()
    await running
  }
})

test("omits provider sessions whose persisted transcript became unavailable", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const availableId = "available-session"
  const staleId = "stale-session"
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      return [
        { id: availableId, title: "Available conversation", lastModified: 2 },
        { id: staleId, title: "Stale conversation", lastModified: 1 },
      ]
    },
    async readTranscripts() {
      return new Map<string, AgentMessage[] | null>([
        [availableId, [{ id: "message", role: "user", preview: "Question", ordinal: 0, visible: true }]],
        [staleId, null],
      ])
    },
    async prepareNewSession() {
      throw new Error("not used")
    },
    async prepareResume() {
      throw new Error("not used")
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    const frame = await waitForFrame(setup, (candidate) => candidate.includes("Available conversation"))
    expect(frame).not.toContain("Stale conversation")
  } finally {
    await app.stop()
    await running
  }
})

test("refreshes a created fork with unvalidated ancestry as an independent root", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const parentId = "parent-session"
  const childId = "created-child"
  let childReadAttempts = 0
  let childDiscovered = false
  let childTranscript: AgentMessage[] | null = null
  const sessions: Record<string, AgentSession> = {
    [parentId]: { id: parentId, title: "Original conversation", lastModified: 1 },
    [childId]: { id: childId, title: "Unvalidated fork", lastModified: 2 },
  }
  const transcripts: Record<string, AgentMessage[]> = {
    [parentId]: [
      { id: "parent-message", role: "agent", preview: "source message", ordinal: 0, visible: true },
    ],
    [childId]: [
      { id: "child-message", role: "agent", preview: "orphaned child history", ordinal: 0, visible: true },
    ],
  }
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      return childDiscovered
        ? [sessions[childId]!, sessions[parentId]!]
        : [sessions[parentId]!]
    },
    async readTranscripts(sessionIds) {
      return new Map(sessionIds.map((sessionId) => {
        if (sessionId === childId) {
          childReadAttempts += 1
          return [sessionId, childTranscript] as const
        }
        return [sessionId, transcripts[sessionId] ?? []] as const
      }))
    },
    async prepareNewSession() { throw new Error("not used") },
    async prepareResume() { throw new Error("not used") },
    async branchFrom() {
      throw new BranchCreatedError(
        sessions[childId]!,
        [],
        false,
        `Fork ${childId} was created, but its copied prefix could not be validated`,
      )
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const showTerminal = spyOn(TerminalManager.prototype, "show")
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Original conversation"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("source message"))

    setup.mockInput.pressKey("f")
    const error = await waitForFrame(
      setup,
      (frame) => frame.includes("copied prefix") && frame.includes("could not be validated"),
    )
    expect(error).toContain(childId)
    expect(error).toContain("Unvalidated fork")
    expect(error).toContain("Message graph")
    expect(error).toContain("Selected session · transcript unavailable")
    expect(showTerminal).not.toHaveBeenCalled()

    setup.mockInput.pressEscape()
    await waitForFrame(setup, (frame) => !frame.includes("Error") && frame.includes("Transcript unavailable"))
    childDiscovered = true
    const readsBeforeRefresh = childReadAttempts
    setup.mockInput.pressKey("r")
    const refreshed = await waitForFrame(
      setup,
      (frame) => childReadAttempts > readsBeforeRefresh && !frame.includes("Error"),
    )
    expect(refreshed).toContain("Transcript unavailable")

    childTranscript = []
    setup.mockInput.pressKey("r")
    const readableEmpty = await waitForFrame(
      setup,
      (frame) => frame.includes("Selected session · no visible messages"),
    )
    expect(readableEmpty).toContain("No visible messages")

    childTranscript = null
    const readsBeforeUnavailableRefresh = childReadAttempts
    setup.mockInput.pressKey("r")
    const unavailableAgain = await waitForFrame(
      setup,
      (frame) => childReadAttempts > readsBeforeUnavailableRefresh && !frame.includes("Error"),
    )
    expect(unavailableAgain).toContain("Unvalidated fork")
    expect(unavailableAgain).toContain("Selected session · no visible messages")

    const metadata = await BranchMetadataStore.openForProvider(project, provider.id, state)
    expect(await metadata.loadRelations()).toEqual([])
  } finally {
    showTerminal.mockRestore()
    await app.stop()
    await running
  }
})

test("returns to the navigator when the visible Claude process exits", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const fakeClaude = join(root, "claude")
  await writeFile(
    fakeClaude,
    '#!/bin/sh\nprintf "CHILD_TERMINAL_ACTIVE\\r\\n"\nsleep 0.3\nexit 0\n',
  )
  await chmod(fakeClaude, 0o755)

  const setup = await createTestRenderer({ width: 80, height: 24 })
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      return []
    },
    async readTranscripts() {
      return new Map()
    },
    async prepareNewSession() {
      const id = "new-session"
      return {
        session: { id, title: "New conversation", lastModified: Date.now(), transient: true },
        launch: {
          sessionId: id,
          command: [fakeClaude],
          cwd: project,
          observer: new NullTerminalObserver(),
        },
      }
    },
    async prepareResume(session) {
      return {
        sessionId: session.id,
        command: [fakeClaude],
        cwd: project,
        observer: new NullTerminalObserver(),
      }
    },
  }
  const processTitles: string[] = []
  const app = await AgentTreeApp.create(
    setup.renderer,
    project,
    provider,
    state,
    (title) => processTitles.push(title),
  )
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("No conversations"))
    expect(processTitles.at(-1)).toBe("c/t")
    setup.mockInput.pressKey("n")

    const deadline = performance.now() + 2_000
    let frame = ""
    let showedTerminal = false
    while (performance.now() < deadline) {
      await Bun.sleep(10)
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      if (frame.includes("CHILD_TERMINAL_ACTIVE") && !frame.includes("claude-tree")) {
        showedTerminal = true
      }
      if (showedTerminal && frame.includes("Conversation roots")) break
    }
    expect(showedTerminal).toBeTrue()
    expect(processTitles).toContain("c/t: New conversation")
    expect(processTitles.at(-1)).toBe("c/t")
    expect(frame).toContain("claude-tree")
    expect(frame).not.toContain("session exited")

    setup.mockInput.pressKey("q")
    await running
  } finally {
    await app.stop()
  }
})

test("replaces a temporary new-session id after the provider reports the real session", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const fakeAgent = join(root, "agent")
  await writeFile(fakeAgent, '#!/bin/sh\nprintf "NEW_SESSION_ACTIVE\\r\\n"\nsleep 30\n')
  await chmod(fakeAgent, 0o755)
  let resolveStarted!: (session: AgentSession) => void
  const startedSession = new Promise<AgentSession>((resolve) => { resolveStarted = resolve })
  let resolveSecondStarted!: (session: AgentSession) => void
  const secondStartedSession = new Promise<AgentSession>((resolve) => { resolveSecondStarted = resolve })
  let resolveDiscovery!: (sessions: AgentSession[]) => void
  const discovery = new Promise<AgentSession[]>((resolve) => { resolveDiscovery = resolve })
  let listCalls = 0
  let newSessionCalls = 0
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      listCalls += 1
      return listCalls === 1 ? [] : discovery
    },
    async readTranscripts(sessionIds) {
      return new Map(sessionIds.map((sessionId) => [sessionId, [
        {
          id: "real-history",
          role: "user" as const,
          preview: "persisted history",
          ordinal: 0,
          visible: true,
        },
      ]]))
    },
    async prepareNewSession() {
      newSessionCalls += 1
      if (newSessionCalls === 2) {
        return {
          session: { id: "second-pending", title: "Second pending", lastModified: 3, transient: true },
          launch: {
            sessionId: "second-pending",
            command: [fakeAgent],
            cwd: project,
            observer: new NullTerminalObserver(),
          },
          startedSession: secondStartedSession,
        }
      }
      return {
        session: { id: "pending-session", title: "Pending conversation", lastModified: 1, transient: true },
        launch: {
          sessionId: "pending-session",
          command: [fakeAgent],
          cwd: project,
          observer: new NullTerminalObserver(),
        },
        startedSession,
      }
    },
    async prepareResume() { throw new Error("not used") },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const processTitles: string[] = []
  const app = await AgentTreeApp.create(
    setup.renderer,
    project,
    provider,
    state,
    (title) => processTitles.push(title),
  )
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("No conversations"))
    expect(processTitles.at(-1)).toBe("c/t")
    setup.mockInput.pressKey("n")
    await waitForFrame(setup, (frame) => frame.includes("NEW_SESSION_ACTIVE"))
    const recorder = new TestRecorder(setup.renderer)
    recorder.rec()
    expect(processTitles.at(-1)).toBe("c/t: Pending conversation")
    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitUntil(() => listCalls === 2)
    const pendingGraph = await waitForFrame(
      setup,
      (frame) => frame.includes("Message graph") && frame.includes("Draft"),
    )
    expect(pendingGraph).not.toContain("Conversation roots")
    expect(pendingGraph).not.toContain("No conversations")
    recorder.stop()
    expect(recorder.recordedFrames.some(({ frame }) => frame.includes("Conversation roots"))).toBeFalse()
    expect(processTitles.at(-1)).toBe("c/t: Pending conversation")
    resolveDiscovery([{ id: "real-session", title: "Real conversation", lastModified: 2 }])
    await waitForFrame(setup, (frame) => frame.includes("Message graph"))
    expect(processTitles.at(-1)).toBe("c/t: Pending conversation")
    setup.mockInput.pressKey("q")
    await waitForFrame(
      setup,
      (frame) => frame.includes("Conversation roots") && frame.includes("Pending conversation"),
    )
    expect(processTitles.at(-1)).toBe("c/t")
    resolveStarted({ id: "real-session", title: "Real conversation", lastModified: 2, transient: true })
    const roots = await waitForFrame(
      setup,
      (frame) => frame.includes("Conversation roots") && frame.includes("Real conversation"),
    )
    expect(roots).not.toContain("Pending conversation")
    expect(processTitles.at(-1)).toBe("c/t")
    setup.mockInput.pressEnter()
    await waitForFrame(
      setup,
      (frame) => frame.includes("Message graph") && frame.includes("persisted history"),
    )
    expect(processTitles.at(-1)).toBe("c/t: Real conversation")
    setup.mockInput.pressKey("q")
    const settledRoots = await waitForFrame(setup, (frame) => frame.includes("Real conversation"))
    expect(settledRoots).not.toContain("Pending conversation")
    expect(processTitles.at(-1)).toBe("c/t")

    setup.mockInput.pressKey("n")
    await waitUntil(() => processTitles.at(-1) === "c/t: Second pending")
    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(setup, (frame) => frame.includes("Message graph"))
    expect(processTitles.at(-1)).toBe("c/t: Second pending")
    const titlesBeforeGraphAdoption = processTitles.length
    resolveSecondStarted({
      id: "second-real",
      title: "Second real conversation",
      lastModified: 4,
      transient: true,
    })
    await waitUntil(() => processTitles.at(-1) === "c/t: Second real conversation")
    expect(processTitles.slice(titlesBeforeGraphAdoption)).not.toContain("c/t")
  } finally {
    resolveDiscovery([])
    await app.stop()
    await running
  }
})

test("returns directly to a locally staged transient fork while discovery is pending", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const fakeAgent = join(root, "agent")
  await writeFile(fakeAgent, '#!/bin/sh\nprintf "BRANCH_ACTIVE\\r\\n"\nsleep 30\n')
  await chmod(fakeAgent, 0o755)

  const parent: AgentSession = { id: "parent-session", title: "Parent", lastModified: 1 }
  const child: AgentSession = {
    id: "transient-child",
    title: "Transient branch",
    lastModified: 2,
    transient: true,
  }
  let resolveDiscovery!: (sessions: AgentSession[]) => void
  const discovery = new Promise<AgentSession[]>((resolve) => { resolveDiscovery = resolve })
  let listCalls = 0
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      listCalls += 1
      return listCalls === 1 ? [parent] : discovery
    },
    async readTranscripts(sessionIds) {
      return new Map(sessionIds.map((sessionId) => [sessionId, sessionId === parent.id
        ? [{ id: "source-message", role: "agent" as const, preview: "branch source", ordinal: 0, visible: true }]
        : []]))
    },
    async prepareNewSession() { throw new Error("not used") },
    async prepareResume() { throw new Error("not used") },
    async branchFrom() {
      return {
        session: child,
        launch: {
          sessionId: child.id,
          command: [fakeAgent],
          cwd: project,
          observer: new NullTerminalObserver(),
        },
        derivation: {
          childSessionId: child.id,
          parentSessionId: parent.id,
          sourceMessageId: "source-message",
          sharedMessages: [],
        },
        providerSessionCreated: false,
      }
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Parent"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("branch source"))
    setup.mockInput.pressKey("f")
    await waitForFrame(setup, (frame) => frame.includes("BRANCH_ACTIVE"))

    const recorder = new TestRecorder(setup.renderer)
    recorder.rec()
    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitUntil(() => listCalls === 2)
    const pendingGraph = await waitForFrame(
      setup,
      (frame) => frame.includes("Message graph") && frame.includes("Draft"),
    )
    expect(pendingGraph).toContain("branch source")
    expect(pendingGraph).not.toContain("Conversation roots")
    recorder.stop()
    expect(recorder.recordedFrames.some(({ frame }) => frame.includes("Conversation roots"))).toBeFalse()
  } finally {
    resolveDiscovery([parent])
    await app.stop()
    await running
  }
})

test("rolls back a provider-uncreated fork when its terminal cannot launch", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const parent: AgentSession = { id: "parent-session", title: "Parent", lastModified: 1 }
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() { return [parent] },
    async readTranscripts(sessionIds) {
      return new Map(sessionIds.map((sessionId) => [sessionId, [
        { id: "source-message", role: "user" as const, preview: "replayed prompt", ordinal: 0, visible: true },
      ]]))
    },
    async prepareNewSession() { throw new Error("not used") },
    async prepareResume() { throw new Error("not used") },
    async branchFrom() {
      return {
        session: {
          id: "uncreated-child",
          title: "Uncreated branch",
          lastModified: 2,
          transient: true,
        },
        launch: {
          sessionId: "uncreated-child",
          command: [process.execPath],
          cwd: project,
          observer: new NullTerminalObserver(),
        },
        derivation: {
          childSessionId: "uncreated-child",
          parentSessionId: parent.id,
          sourceMessageId: "source-message",
          sharedMessages: [],
        },
        providerSessionCreated: false,
      }
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const showTerminal = spyOn(TerminalManager.prototype, "show").mockRejectedValue(
    new Error("terminal launch failed"),
  )
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Parent"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("replayed prompt"))
    setup.mockInput.pressKey("f")
    await waitForFrame(
      setup,
      (frame) => frame.includes("Error") && frame.includes("terminal launch failed"),
    )
    setup.mockInput.pressEscape()
    const graph = await waitForFrame(
      setup,
      (frame) => frame.includes("Message graph") && frame.includes("replayed prompt"),
    )
    expect(graph).not.toContain("Draft")
    const metadata = await BranchMetadataStore.openForProvider(project, provider.id, state)
    expect(await metadata.loadRelations()).toEqual([])
  } finally {
    showTerminal.mockRestore()
    await app.stop()
    await running
  }
})

test("migrates an in-flight removal when a temporary session gets its real id", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const fakeAgent = join(root, "agent")
  await writeFile(fakeAgent, "#!/bin/sh\ntrap '' HUP TERM\nwhile :; do sleep 1; done\n")
  await chmod(fakeAgent, 0o755)
  let resolveStarted!: (session: AgentSession) => void
  const startedSession = new Promise<AgentSession>((resolve) => { resolveStarted = resolve })
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() { return [] },
    async readTranscripts() { return new Map() },
    async prepareNewSession() {
      return {
        session: {
          id: "pending-session",
          title: "Pending conversation",
          lastModified: 1,
          transient: true,
        },
        launch: {
          sessionId: "pending-session",
          command: [fakeAgent],
          cwd: project,
          observer: new NullTerminalObserver(),
        },
        startedSession,
      }
    },
    async prepareResume() { throw new Error("not used") },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("No conversations"))
    setup.mockInput.pressKey("n")
    await waitForFrame(setup, (frame) => !frame.includes("claude-tree"))
    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(setup, (frame) => frame.includes("Message graph") && frame.includes("Draft"))
    setup.mockInput.pressKey("q")
    await waitForFrame(setup, (frame) => frame.includes("Pending conversation"))
    setup.mockInput.pressKey("d")
    await waitForFrame(setup, (frame) => frame.includes("Delete conversation tree"))

    setup.mockInput.pressArrow("right")
    setup.mockInput.pressEnter()
    resolveStarted({
      id: "real-session",
      title: "Real conversation",
      lastModified: 2,
      transient: true,
    })
    await waitForFrame(setup, (frame) => frame.includes("No conversations") && !frame.includes("Error"))

    const metadata = await BranchMetadataStore.openForProvider(project, provider.id, state)
    const removals = await metadata.loadRemovals()
    expect(removals).toHaveLength(1)
    expect(removals[0]?.kind === "tree" ? removals[0].rootSessionId : undefined).toBe("real-session")
  } finally {
    await app.stop()
    await running
  }
})

test("rolls back a locally staged new session when its terminal cannot launch", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() { return [] },
    async readTranscripts() { return new Map() },
    async prepareNewSession() {
      return {
        session: {
          id: "failed-session",
          title: "Failed conversation",
          lastModified: 1,
          transient: true,
        },
        launch: {
          sessionId: "failed-session",
          command: [process.execPath],
          cwd: project,
          observer: new NullTerminalObserver(),
        },
      }
    },
    async prepareResume() { throw new Error("not used") },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const showTerminal = spyOn(TerminalManager.prototype, "show").mockRejectedValue(
    new Error("terminal launch failed"),
  )
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("No conversations"))
    setup.mockInput.pressKey("n")
    await waitForFrame(setup, (frame) => frame.includes("Error"))
    setup.mockInput.pressEscape()
    const roots = await waitForFrame(
      setup,
      (frame) => frame.includes("Conversation roots") && frame.includes("No conversations"),
    )
    expect(roots).not.toContain("Failed conversation")
  } finally {
    showTerminal.mockRestore()
    await app.stop()
    await running
  }
})

test("cleans a prepared terminal launch when shutdown wins the preparation race", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  let preparationStarted = false
  let cleaned = false
  let resolvePrepared!: (prepared: PreparedSession) => void
  const prepared = new Promise<PreparedSession>((resolve) => { resolvePrepared = resolve })
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    compatibilityWarning: undefined,
    async listSessions() { return [] },
    async readTranscripts() { return new Map() },
    async prepareNewSession() {
      preparationStarted = true
      return prepared
    },
    async prepareResume() { throw new Error("not used") },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("No conversations"))
    setup.mockInput.pressKey("n")
    await waitUntil(() => preparationStarted)
    const stopping = app.stop()
    resolvePrepared({
      session: {
        id: "new-session",
        title: "New conversation",
        lastModified: Date.now(),
        transient: true,
      },
      launch: {
        sessionId: "new-session",
        command: [process.execPath],
        cwd: project,
        observer: new NullTerminalObserver(),
        cleanup: async () => { cleaned = true },
      },
    })
    await stopping
    await running
    await waitUntil(() => cleaned)
  } finally {
    await app.stop()
  }
})

test("shows an empty family while live and removes it after the terminal exits", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  const exitMarker = join(root, "exit")
  await mkdir(project)
  const fakeAgent = join(root, "agent")
  await writeFile(
    fakeAgent,
    `#!/usr/bin/env bun
import { existsSync } from "node:fs"

process.stdout.write("EMPTY_SESSION_ACTIVE\\r\\n")
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(exitMarker)})) return
  clearInterval(timer)
  process.exit(0)
}, 10)
`,
  )
  await chmod(fakeAgent, 0o755)

  const sessionId = "11111111-1111-4111-8111-111111111111"
  let started = false
  const savedSession: AgentSession = {
    id: sessionId,
    title: "Command-only session",
    lastModified: Date.now(),
  }
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      return started ? [savedSession] : []
    },
    async readTranscripts(sessionIds) {
      const transcript: AgentMessage[] = [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
          role: "user",
          preview: "<command-name>/exit</command-name>",
          ordinal: 0,
          visible: false,
        },
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
          role: "user",
          preview: "<local-command-stdout>Goodbye!</local-command-stdout>",
          ordinal: 1,
          visible: false,
        },
      ]
      return new Map(sessionIds.map((id) => [id, transcript]))
    },
    async prepareNewSession() {
      started = true
      return {
        session: { ...savedSession, transient: true },
        launch: {
          sessionId,
          command: [fakeAgent],
          cwd: project,
          observer: new NullTerminalObserver(),
        },
      }
    },
    async prepareResume() {
      throw new Error("not used")
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("No conversations"))
    setup.mockInput.pressKey("n")
    await waitForFrame(setup, (frame) => frame.includes("EMPTY_SESSION_ACTIVE"))

    setup.mockInput.pressKey(" ", { ctrl: true })
    const liveGraph = await waitForFrame(
      setup,
      (frame) => frame.includes("Message graph") && frame.includes("Draft"),
    )
    expect(liveGraph).not.toContain("command-name")
    expect(liveGraph).not.toContain("Goodbye!")

    await writeFile(exitMarker, "exit")
    const roots = await waitForFrame(setup, (frame) => frame.includes("No conversations"))
    expect(roots).not.toContain("Command-only session")
  } finally {
    await app.stop()
    await running
  }
})

test("shows a Draft after a local command follows valid conversation history", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const fakeClaude = join(root, "claude")
  await writeFile(fakeClaude, '#!/bin/sh\nprintf "CLAUDE_ACTIVE\\r\\n"\nsleep 30\n')
  await chmod(fakeClaude, 0o755)

  const sessionId = "11111111-1111-4111-8111-111111111111"
  const transcript = [
    sessionMessage(sessionId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "question"),
    sessionMessage(
      sessionId,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      "assistant",
      "real answer",
      "claude-sonnet-5",
    ),
    sessionMessage(
      sessionId,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      "user",
      "<command-name>/status</command-name>\n<command-message>status</command-message>\n<command-args></command-args>",
    ),
    sessionMessage(
      sessionId,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
      "user",
      "<local-command-stdout>Status shown</local-command-stdout>",
    ),
    sessionMessage(
      sessionId,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
      "assistant",
      "No response requested.",
      "<synthetic>",
    ),
  ]
  const provider = new ClaudeProvider(project, fakeClaude, {
    async list(): Promise<SDKSessionInfo[]> {
      return [{
        sessionId,
        summary: "Conversation with command",
        firstPrompt: "question",
        lastModified: Date.now(),
      }]
    },
    async messages(): Promise<SessionMessage[]> {
      return transcript
    },
    async fork(): Promise<{ sessionId: string }> {
      throw new Error("not used")
    },
  })
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Conversation with command"))
    setup.mockInput.pressEnter()
    const savedGraph = await waitForFrame(
      setup,
      (frame) => frame.includes("Message graph") && frame.includes("real answer"),
    )
    expect(savedGraph).not.toContain("No response requested")
    expect(savedGraph).not.toContain("command-name")

    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("CLAUDE_ACTIVE"))
    setup.mockInput.pressKey(" ", { ctrl: true })
    const liveGraph = await waitForFrame(
      setup,
      (frame) => frame.includes("Message graph") && frame.includes("Draft"),
    )

    expect(liveGraph).toContain("real answer")
    expect(liveGraph).not.toContain("No response requested")
    expect(liveGraph.match(/󰚩 Agent/g)).toHaveLength(1)
  } finally {
    await app.stop()
    await running
  }
})

test("forwards navigator shortcuts to Claude while the terminal owns input", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  const inputMarker = join(root, "input")
  await mkdir(project)
  const fakeClaude = join(root, "claude")
  await writeFile(
    fakeClaude,
    `#!/bin/sh
IFS= read -r value
printf '%s' "$value" > ${JSON.stringify(inputMarker)}
sleep 30
`,
  )
  await chmod(fakeClaude, 0o755)

  const provider = new ClaudeProvider(project, fakeClaude, {
    async list(): Promise<SDKSessionInfo[]> {
      return []
    },
    async messages(): Promise<SessionMessage[]> {
      return []
    },
    async fork(): Promise<{ sessionId: string }> {
      throw new Error("not used")
    },
  })
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("No conversations"))
    setup.mockInput.pressKey("n")
    await Bun.sleep(30)
    setup.mockInput.pressKey("x")
    setup.mockInput.pressKey("?")
    setup.mockInput.pressKey("d")
    setup.mockInput.pressEnter()
    await waitUntil(() => Bun.file(inputMarker).exists())
    expect(await readFile(inputMarker, "utf8")).toBe("x?d")
  } finally {
    await app.stop()
    await running
  }
})

test("forwards every key except Ctrl+Space while the terminal owns input", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  const inputMarker = join(root, "input")
  const readyMarker = join(root, "ready")
  await mkdir(project)
  const fakeAgent = join(root, "agent")
  await writeFile(
    fakeAgent,
    `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs"

process.stdin.setRawMode?.(true)
writeFileSync(${JSON.stringify(inputMarker)}, "")
writeFileSync(${JSON.stringify(readyMarker)}, "")
process.stdout.write("AGENT_READY\\r\\n")
process.stdin.on("data", (data) => appendFileSync(${JSON.stringify(inputMarker)}, data))
setInterval(() => undefined, 1_000)
`,
  )
  await chmod(fakeAgent, 0o755)

  let newSessionCalls = 0
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      return []
    },
    async readTranscripts(sessionIds) {
      return new Map(sessionIds.map((id) => [id, []]))
    },
    async prepareNewSession() {
      newSessionCalls += 1
      const id = `new-session-${newSessionCalls}`
      return {
        session: { id, title: "New conversation", lastModified: Date.now(), transient: true },
        launch: {
          sessionId: id,
          command: [fakeAgent],
          cwd: project,
          observer: new NullTerminalObserver(),
        },
      }
    },
    async prepareResume(session) {
      return {
        sessionId: session.id,
        command: [fakeAgent],
        cwd: project,
        observer: new NullTerminalObserver(),
      }
    },
  }
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  })
  const focusRenderable = setup.renderer.focusRenderable.bind(setup.renderer)
  let sentActivationKey = false
  setup.renderer.focusRenderable = (renderable) => {
    focusRenderable(renderable)
    if (!sentActivationKey && renderable.id.startsWith("agent-session-")) {
      sentActivationKey = true
      queueMicrotask(() => setup.mockInput.pressKey("n", { ctrl: true }))
    }
  }
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("No conversations"))
    setup.mockInput.pressKey("n")
    await waitUntil(() => Bun.file(readyMarker).exists())
    await waitUntil(async () => (await readFile(inputMarker)).includes(0x0e))

    const pressAgentKey = async (press: () => void) => {
      const previousLength = (await readFile(inputMarker)).length
      press()
      await waitUntil(async () => (await readFile(inputMarker)).length > previousLength)
      expect(setup.renderer.isDestroyed).toBeFalse()
    }
    for (const key of ["n", "r", "q", "f", "x", "g", "h", "j", "k", "l"]) {
      await pressAgentKey(() => setup.mockInput.pressKey(key))
    }
    await pressAgentKey(() => setup.mockInput.pressKey("g", { shift: true }))
    for (const direction of ["up", "down", "left", "right"] as const) {
      await pressAgentKey(() => setup.mockInput.pressArrow(direction))
    }
    await pressAgentKey(() => setup.mockInput.pressEscape())
    await pressAgentKey(() => setup.mockInput.pressEnter())
    await pressAgentKey(() => setup.mockInput.pressCtrlC())
    await pressAgentKey(() => setup.mockInput.pressKey("p", { ctrl: true }))
    await pressAgentKey(() => setup.mockInput.pressKey(" ", { ctrl: true, shift: true }))

    expect(newSessionCalls).toBe(1)

    const inputBeforeHostEscape = await readFile(inputMarker)
    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(setup, (frame) => frame.includes("claude-tree"))
    await Bun.sleep(50)
    expect(await readFile(inputMarker)).toEqual(inputBeforeHostEscape)
  } finally {
    await app.stop()
    await running
  }
})

test("quit closes the UI immediately while live sessions finish shutting down", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  const processMarker = join(root, "processes")
  await mkdir(project)
  const executable = join(root, "agent")
  await writeFile(
    executable,
    `#!/bin/sh
trap '' HUP TERM
sleep 30 &
child=$!
printf '%s %s\n' "$$" "$child" > ${JSON.stringify(processMarker)}
wait "$child"
`,
  )
  await chmod(executable, 0o755)

  let listCalls = 0
  let finishRefresh!: (sessions: AgentSession[]) => void
  const blockedRefresh = new Promise<AgentSession[]>((resolve) => {
    finishRefresh = resolve
  })
  const provider = testProvider(project, executable, () => {
    listCalls += 1
    return listCalls === 1 ? Promise.resolve([]) : blockedRefresh
  })
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("No conversations"))
    setup.mockInput.pressKey("n")
    const processIds = await readProcessIds(processMarker)
    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(
      setup,
      (frame) => listCalls === 2 && frame.includes("Message graph") && frame.includes("q quit"),
    )

    const startedAt = performance.now()
    setup.mockInput.pressCtrlC()
    await waitUntil(() => setup.renderer.isDestroyed)
    expect(setup.renderer.isDestroyed).toBeTrue()

    await running
    expect(performance.now() - startedAt).toBeLessThan(750)
    await waitUntil(() => processIds.every((processId) => !isProcessAlive(processId)))
  } finally {
    finishRefresh([])
    await app.stop()
  }
})

test("shutdown does not wait for an initial session refresh", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)

  let finishRefresh!: (sessions: AgentSession[]) => void
  const blockedRefresh = new Promise<AgentSession[]>((resolve) => {
    finishRefresh = resolve
  })
  const provider = testProvider(project, process.execPath, () => blockedRefresh)
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await Bun.sleep(0)
    const startedAt = performance.now()
    await Promise.all([app.stop(), running])

    expect(setup.renderer.isDestroyed).toBeTrue()
    expect(performance.now() - startedAt).toBeLessThan(250)
  } finally {
    finishRefresh([])
    await app.stop()
  }
})

test("supports mouse selection, scrolling, activation, and footer actions", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const fakeClaude = join(root, "claude")
  await writeFile(fakeClaude, "#!/bin/sh\nsleep 30\n")
  await chmod(fakeClaude, 0o755)

  const sessions = Array.from({ length: 10 }, (_, index): SDKSessionInfo => {
    const ordinal = index + 1
    return {
      sessionId: testUuid(ordinal),
      summary: `Root ${ordinal}`,
      firstPrompt: `question ${ordinal}`,
      lastModified: 100 - ordinal,
    }
  })
  const transcripts = new Map(
    sessions.map((session, index) => {
      const messages = [
        sessionMessage(session.sessionId, testUuid(100 + index * 2), "user", `question ${index + 1}`),
        sessionMessage(
          session.sessionId,
          testUuid(101 + index * 2),
          "assistant",
          `answer ${index + 1}`,
        ),
      ]
      if (index === 7) {
        messages.push(
          sessionMessage(session.sessionId, testUuid(300), "user", "follow-up 8"),
          sessionMessage(session.sessionId, testUuid(301), "assistant", "final 8"),
        )
      }
      return [session.sessionId, messages] as const
    }),
  )
  let listCalls = 0
  const provider = new ClaudeProvider(project, fakeClaude, {
    async list(): Promise<SDKSessionInfo[]> {
      listCalls += 1
      return sessions
    },
    async messages(sessionId): Promise<SessionMessage[]> {
      return transcripts.get(sessionId) ?? []
    },
    async fork(): Promise<{ sessionId: string }> {
      throw new Error("not used")
    },
  })
  const setup = await createTestRenderer({ width: 100, height: 15 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Root 1"))
    const rootList = coordinateOf(setup.captureCharFrame(), "Root 1")
    for (let index = 0; index < 9; index += 1) {
      await setup.mockMouse.scroll(rootList.x, rootList.y, "down")
      await setup.renderOnce()
    }
    let frame = setup.captureCharFrame()
    expect(frame).not.toContain("Root 1 ")
    expect(isSelected(setup, "Root 10")).toBeTrue()

    const rootEight = coordinateOf(frame, "Root 8")
    const rootTen = coordinateOf(frame, "Root 10")
    await setup.mockMouse.drag(rootTen.x, rootTen.y, rootEight.x, rootEight.y)
    await setup.renderOnce()
    expect(isSelected(setup, "Root 10")).toBeTrue()

    await setup.mockMouse.click(rootEight.x, rootEight.y, MouseButtons.RIGHT)
    await setup.renderOnce()
    expect(isSelected(setup, "Root 10")).toBeTrue()

    await setup.mockMouse.click(rootEight.x, rootEight.y)
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(isSelected(setup, "Root 8")).toBeTrue()
    expect(coordinateOf(frame, "Root 8")).toEqual(rootEight)

    await setup.mockMouse.click(rootEight.x, rootEight.y)
    frame = await waitForFrame(
      setup,
      (candidate) => candidate.includes("Message graph") && candidate.includes("answer 8"),
    )
    setup.mockInput.pressArrow("down")
    await waitForFrame(setup, () => isSelected(setup, "answer 8"))
    setup.mockInput.pressArrow("down")
    frame = await waitForFrame(
      setup,
      (candidate) => candidate.includes("follow-up 8") && isSelected(setup, "follow-up 8"),
    )
    const agent = coordinateOf(frame, "Agent")
    expect(agent.x).toBeGreaterThan(30)
    await setup.mockMouse.click(agent.x, agent.y)
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(isSelected(setup, "Agent")).toBeTrue()
    expect(coordinateOf(frame, "Agent")).toEqual(agent)

    await setup.mockMouse.click(agent.x, agent.y)
    await waitForFrame(setup, (candidate) => !candidate.includes("claude-tree"))
    setup.mockInput.pressKey(" ", { ctrl: true })
    frame = await waitForFrame(setup, (candidate) => candidate.includes("Message graph"))

    const rootsAction = coordinateOf(frame, "q quit")
    await setup.mockMouse.click(rootsAction.x, rootsAction.y)
    frame = await waitForFrame(setup, (candidate) => candidate.includes("Conversation roots"))

    const refreshAction = coordinateOf(frame, "r refresh")
    const beforeHover = frame
    await setup.mockMouse.moveTo(refreshAction.x, refreshAction.y)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toBe(beforeHover)

    const callsBeforeRefresh = listCalls
    await setup.mockMouse.click(refreshAction.x, refreshAction.y)
    await waitForFrame(
      setup,
      (candidate) => listCalls > callsBeforeRefresh && candidate.includes("r refresh"),
    )
  } finally {
    await app.stop()
    await running
  }
})

test("kill confirmation freezes a working response and resume creates a fresh draft", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  const launchCountPath = join(root, "launch-count")
  const interruptedMarker = join(root, "interrupted")
  await mkdir(project)
  const fakeClaude = join(root, "claude")
  await writeFile(
    fakeClaude,
    `#!/bin/sh
count=0
if [ -f ${JSON.stringify(launchCountPath)} ]; then count=$(cat ${JSON.stringify(launchCountPath)}); fi
count=$((count + 1))
printf '%s' "$count" > ${JSON.stringify(launchCountPath)}
if [ "$count" -eq 1 ]; then
  trap 'touch ${JSON.stringify(interruptedMarker)}; exit 0' TERM
  ${String.raw`printf '\033]0;\342\240\213 Claude Code\007'`}
  while :; do sleep 30 & wait "$!"; done
fi
${String.raw`printf '\033]0;\342\234\263 Claude Code\007'`}
sleep 30
`,
  )
  await chmod(fakeClaude, 0o755)

  const sessionId = "11111111-1111-4111-8111-111111111111"
  const userMessage = sessionMessage(
    sessionId,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    "user",
    "question",
  )
  const interruptedMessage = sessionMessage(
    sessionId,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    "assistant",
    "frozen partial response",
  )
  const provider = new ClaudeProvider(project, fakeClaude, {
    async list(): Promise<SDKSessionInfo[]> {
      return [
        {
          sessionId,
          summary: "Interruptible conversation",
          firstPrompt: "question",
          lastModified: Date.now(),
        },
      ]
    },
    async messages(): Promise<SessionMessage[]> {
      return (await Bun.file(interruptedMarker).exists())
        ? [userMessage, interruptedMessage]
        : [userMessage]
    },
    async fork(): Promise<{ sessionId: string }> {
      throw new Error("not used")
    },
  })
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Interruptible conversation"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("question") && frame.includes("Message graph"))
    setup.mockInput.pressEnter()
    await Bun.sleep(50)
    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(
      setup,
      (frame) => BRAILLE_SPINNER_FRAMES.some((spinner) => frame.includes(spinner)),
    )

    setup.mockInput.pressKey("x")
    const confirmation = await waitForFrame(
      setup,
      (frame) => frame.includes("Kill live session") && frame.includes("Interrupt this working Agent?"),
    )
    expect(confirmation).toContain("Kill")
    expect(confirmation).toContain("esc")
    expect(confirmation).not.toContain("┌")
    expect(confirmation.indexOf("Cancel")).toBeLessThan(confirmation.lastIndexOf("Kill"))
    expect(setup.captureSpans().lines[0]?.spans[0]?.bg.equals(theme.background)).toBeFalse()
    const defaultKill = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("Kill") && span.bg.equals(theme.selected))
    expect(defaultKill).toBeDefined()

    const modifiedKillKeys = [
      () => setup.mockInput.pressKey("q", { ctrl: true }),
      () => setup.mockInput.pressEscape({ shift: true }),
      () => setup.mockInput.pressTab({ ctrl: true }),
      () => setup.mockInput.pressArrow("right", { shift: true }),
      () => setup.mockInput.pressKey("h", { meta: true }),
      () => setup.mockInput.pressEnter({ ctrl: true }),
      () => setup.mockInput.pressKey("c", { ctrl: true, shift: true }),
    ]
    for (const press of modifiedKillKeys) {
      press()
      await Bun.sleep(10)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("Kill live session")
      expect(setup.renderer.isDestroyed).toBeFalse()
      expect(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .some((span) => span.text.includes("Kill") && span.bg.equals(theme.selected)),
      ).toBeTrue()
    }

    setup.mockInput.pressArrow("right")
    await setup.renderOnce()
    const selectedCancel = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("Cancel") && span.bg.equals(theme.selected))
    expect(selectedCancel).toBeDefined()
    setup.mockInput.pressKey("q")
    const cancelled = await waitForFrame(
      setup,
      (frame) => frame.includes("Message graph") && !frame.includes("Kill live session"),
    )
    expect(cancelled).not.toContain("Conversation roots")

    setup.mockInput.pressKey("x")
    const escapeDialog = await waitForFrame(setup, (frame) => frame.includes("Kill live session"))
    const escapeAction = coordinateOf(escapeDialog, "esc")
    await setup.mockMouse.click(escapeAction.x, escapeAction.y)
    await waitForFrame(setup, (frame) => !frame.includes("Kill live session"))

    setup.mockInput.pressKey("x")
    await waitForFrame(setup, (frame) => frame.includes("Kill live session"))
    await setup.mockMouse.click(0, 0)
    await waitForFrame(setup, (frame) => !frame.includes("Kill live session"))

    setup.mockInput.pressKey("x")
    const clickableDialog = await waitForFrame(setup, (frame) => frame.includes("Cancel  Kill"))
    const actions = coordinateOf(clickableDialog, "Cancel  Kill")
    await setup.mockMouse.click(actions.x + displayWidth("Cancel  "), actions.y)
    const frozen = await waitForFrame(
      setup,
      (frame) => frame.includes("frozen partial response") && !frame.includes("Kill live session"),
    )
    expect(frozen).not.toContain("Draft")
    expect(BRAILLE_SPINNER_FRAMES.every((spinner) => !frozen.includes(spinner))).toBeTrue()

    setup.mockInput.pressEnter()
    await waitUntil(async () => (await readFile(launchCountPath, "utf8")).trim() === "2")
    setup.mockInput.pressKey(" ", { ctrl: true })
    const resumed = await waitForFrame(
      setup,
      (frame) => frame.includes("frozen partial response") && frame.includes("Draft"),
    )
    expect(resumed.indexOf("frozen partial response")).toBeLessThan(resumed.indexOf("Draft"))
  } finally {
    await app.stop()
    await running
  }
})

test("killing a draft removes it without fabricating transcript history", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const fakeClaude = join(root, "claude")
  await writeFile(fakeClaude, "#!/bin/sh\nsleep 30\n")
  await chmod(fakeClaude, 0o755)

  const sessionId = "11111111-1111-4111-8111-111111111111"
  const userMessage = sessionMessage(
    sessionId,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    "user",
    "saved question",
  )
  const provider = new ClaudeProvider(project, fakeClaude, {
    async list(): Promise<SDKSessionInfo[]> {
      return [
        {
          sessionId,
          summary: "Saved conversation",
          firstPrompt: "saved question",
          lastModified: Date.now(),
        },
      ]
    },
    async messages(): Promise<SessionMessage[]> {
      return [userMessage]
    },
    async fork(): Promise<{ sessionId: string }> {
      throw new Error("not used")
    },
  })
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Saved conversation"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("saved question"))
    setup.mockInput.pressEnter()
    await Bun.sleep(30)
    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(setup, (frame) => frame.includes("Draft"))

    setup.mockInput.pressKey("x")
    setup.mockInput.pressEnter()
    const killed = await waitForFrame(
      setup,
      (frame) => frame.includes("saved question") && !frame.includes("Kill live session"),
    )
    expect(killed).not.toContain("Draft")
    expect(killed).not.toContain("Agent")
  } finally {
    await app.stop()
    await running
  }
})

test("killing an empty branched draft restores a resumable Fork leaf", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const executable = join(root, "agent")
  await writeFile(executable, "#!/bin/sh\nsleep 30\n")
  await chmod(executable, 0o755)

  const rootSessionId = "root-session"
  const childSessionId = "child-session"
  const sessions: AgentSession[] = [
    { id: rootSessionId, title: "Root conversation", lastModified: 2 },
    { id: childSessionId, title: "Empty branch", lastModified: 1 },
  ]
  const rootTranscript: AgentMessage[] = [
    { id: "root-source", role: "user", preview: "branch source", ordinal: 0, visible: true },
    { id: "root-answer", role: "agent", preview: "main path", ordinal: 1, visible: true },
  ]
  const childTranscript: AgentMessage[] = [
    { id: "child-source", role: "user", preview: "branch source", ordinal: 0, visible: true },
  ]
  const transcripts = new Map([
    [rootSessionId, rootTranscript],
    [childSessionId, childTranscript],
  ])
  const metadata = await BranchMetadataStore.openForProvider(project, "test-agent", state)
  await metadata.saveRelation({
    childSessionId,
    parentSessionId: rootSessionId,
    sourceMessageId: rootTranscript[0]!.id,
    sharedMessages: [{
      parentMessageId: rootTranscript[0]!.id,
      childMessageId: childTranscript[0]!.id,
    }],
  })

  const resumedSessionIds: string[] = []
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      return sessions
    },
    async readTranscripts(sessionIds) {
      return new Map(sessionIds.map((sessionId) => [sessionId, transcripts.get(sessionId) ?? []]))
    },
    async prepareNewSession() {
      throw new Error("not used")
    },
    async prepareResume(session) {
      resumedSessionIds.push(session.id)
      return {
        sessionId: session.id,
        command: [executable],
        cwd: project,
        observer: new NullTerminalObserver(),
      }
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Root conversation"))
    setup.mockInput.pressEnter()
    await waitForFrame(
      setup,
      (frame) => frame.includes("branch source") && frame.includes("main path") && frame.includes("󰘬 Fork"),
    )
    setup.mockInput.pressArrow("down")
    await waitForFrame(setup, () => isSelected(setup, "main path"))
    setup.mockInput.pressArrow("right")
    await waitForFrame(setup, () => isSelected(setup, "Fork"))

    setup.mockInput.pressEnter()
    await waitUntil(() => resumedSessionIds.length === 1)
    expect(resumedSessionIds).toEqual([childSessionId])
    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(setup, (frame) => frame.includes("Draft") && isSelected(setup, "Draft"))

    setup.mockInput.pressKey("x")
    setup.mockInput.pressEnter()
    const stopped = await waitForFrame(
      setup,
      (frame) =>
        frame.includes("󰘬 Fork") &&
        frame.includes("Selected fork") &&
        !frame.includes("Draft") &&
        !frame.includes("Kill live session"),
    )
    expect(stopped).toContain("main path")
    expect(isSelected(setup, "Fork")).toBeTrue()

    setup.mockInput.pressEnter()
    await waitUntil(() => resumedSessionIds.length === 2)
    expect(resumedSessionIds).toEqual([childSessionId, childSessionId])
  } finally {
    await app.stop()
    await running
  }
})

test("moves a live terminal to a provider-created fork and preserves the source endpoint", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const executable = join(root, "agent")
  await writeFile(executable, "#!/bin/sh\nsleep 30\n")
  await chmod(executable, 0o755)

  const parentId = "parent-session"
  const childId = "native-child-session"
  const parent: AgentSession = { id: parentId, title: "Parent", lastModified: 1 }
  const child: AgentSession = { id: childId, title: "Native fork", lastModified: 2 }
  const parentTranscript: AgentMessage[] = [
    { id: "parent-user", role: "user", preview: "question", ordinal: 0, visible: true },
    { id: "parent-agent", role: "agent", preview: "answer", ordinal: 1, visible: true },
    { id: "parent-later", role: "user", preview: "original continuation", ordinal: 2, visible: true },
  ]
  const childTranscript: AgentMessage[] = [
    { id: "child-user", role: "user", preview: "question", ordinal: 0, visible: true },
    { id: "child-agent", role: "agent", preview: "answer", ordinal: 1, visible: true },
  ]
  const transitions = appTransitionSource()
  let switched = false
  const transcriptReads: string[][] = []
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      return switched ? [child, parent] : [parent]
    },
    async readTranscripts(sessionIds) {
      transcriptReads.push([...sessionIds])
      return new Map(sessionIds.map((sessionId) => [
        sessionId,
        sessionId === childId ? childTranscript : parentTranscript,
      ]))
    },
    async prepareNewSession() { throw new Error("not used") },
    async prepareResume(session) {
      return {
        sessionId: session.id,
        command: [executable],
        cwd: project,
        observer: new NullTerminalObserver(),
        sessionTransitions: transitions.source,
      }
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Parent"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("original continuation"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => !frame.includes("claude-tree"))

    switched = true
    let resolveDerivation!: (derivation: {
      childSessionId: string
      parentSessionId: string
      sourceMessageId: string
      sharedMessages: Array<{ parentMessageId: string; childMessageId: string }>
    }) => void
    const derivation = new Promise<Parameters<typeof resolveDerivation>[0]>((resolve) => {
      resolveDerivation = resolve
    })
    const completionState = app as unknown as {
      pendingCompletionRefreshes: Map<string, number>
      completionRefreshAttempts: Map<string, number>
    }
    completionState.pendingCompletionRefreshes.set(parentId, 999)
    completionState.completionRefreshAttempts.set(parentId, 1)
    transitions.emit({
      session: child,
      derivation,
    })
    expect(completionState.pendingCompletionRefreshes.get(parentId)).toBe(999)
    expect(completionState.pendingCompletionRefreshes.has(childId)).toBeFalse()
    completionState.pendingCompletionRefreshes.delete(parentId)
    completionState.completionRefreshAttempts.delete(parentId)
    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(setup, (frame) => frame.includes("Draft") && isSelected(setup, "Draft"))
    setup.mockInput.pressKey("d")
    await Bun.sleep(10)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("Delete conversation")

    resolveDerivation({
      childSessionId: childId,
      parentSessionId: parentId,
      sourceMessageId: "parent-agent",
      sharedMessages: [
        { parentMessageId: "parent-user", childMessageId: "child-user" },
        { parentMessageId: "parent-agent", childMessageId: "child-agent" },
      ],
    })
    const metadata = await BranchMetadataStore.openForProvider(project, "test-agent", state)
    await waitUntil(async () => (await metadata.loadRelations()).length === 1)

    const graph = await waitForFrame(
      setup,
      (frame) =>
        frame.includes("original continuation") &&
        frame.includes("Draft"),
    )
    expect(graph.indexOf("answer")).toBeLessThan(graph.indexOf("original continuation"))
    expect(isSelected(setup, "Draft")).toBeTrue()
    expect(transcriptReads.some((ids) => ids.includes(parentId) && ids.includes(childId))).toBeTrue()
  } finally {
    await app.stop()
    await running
  }
})

test("keeps a live terminal accessible when it switches into a removed session", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const executable = join(root, "agent")
  await writeFile(executable, "#!/bin/sh\nsleep 30\n")
  await chmod(executable, 0o755)

  const visible: AgentSession = { id: "visible-session", title: "Visible", lastModified: 2 }
  const removed: AgentSession = { id: "removed-session", title: "Removed", lastModified: 1 }
  const transitions = appTransitionSource()
  const metadata = await BranchMetadataStore.openForProvider(project, "test-agent", state)
  await metadata.saveRemoval({
    kind: "tree",
    rootSessionId: removed.id,
    memberSessionIds: [removed.id],
  })
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() { return [visible, removed] },
    async readTranscripts(sessionIds) {
      return new Map(sessionIds.map((sessionId) => [sessionId, [{
        id: `${sessionId}-message`,
        role: "user" as const,
        preview: sessionId === removed.id ? "removed secret" : "visible question",
        ordinal: 0,
        visible: true,
      }]]))
    },
    async prepareNewSession() { throw new Error("not used") },
    async prepareResume(session) {
      return {
        sessionId: session.id,
        command: [executable],
        cwd: project,
        observer: new NullTerminalObserver(),
        sessionTransitions: transitions.source,
      }
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    const roots = await waitForFrame(setup, (frame) => frame.includes("Visible"))
    expect(roots).not.toContain("Removed")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("visible question"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => !frame.includes("claude-tree"))

    transitions.emit({ session: removed })
    setup.mockInput.pressKey(" ", { ctrl: true })
    const fallback = await waitForFrame(
      setup,
      (frame) => frame.includes("Draft") && isSelected(setup, "Draft"),
    )
    expect(fallback).not.toContain("removed secret")
  } finally {
    await app.stop()
    await running
  }
})

test("waits for in-flight session ancestry persistence during shutdown", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const parent: AgentSession = { id: "shutdown-parent", title: "Parent", lastModified: 1 }
  const child: AgentSession = { id: "shutdown-child", title: "Child", lastModified: 2 }
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() { return [parent, child] },
    async readTranscripts(sessionIds) {
      return new Map(sessionIds.map((sessionId) => [sessionId, [{
        id: `${sessionId}-message`,
        role: "user" as const,
        preview: "question",
        ordinal: 0,
        visible: true,
      }]]))
    },
    async prepareNewSession() { throw new Error("not used") },
    async prepareResume() { throw new Error("not used") },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()
  let resolveDerivation!: (derivation: BranchDerivation) => void
  const derivation = new Promise<BranchDerivation>((resolve) => { resolveDerivation = resolve })

  await waitForFrame(setup, (frame) => frame.includes("Parent") && frame.includes("Child"))
  ;(app as unknown as {
    onTerminalSessionChanged(event: TerminalSessionChangedEvent): void
  }).onTerminalSessionChanged({
    previousSessionId: parent.id,
    session: child,
    wasActive: false,
    derivation,
  })
  let stopped = false
  const stopping = app.stop().then(() => { stopped = true })
  await Bun.sleep(20)
  expect(stopped).toBeFalse()

  resolveDerivation({
    childSessionId: child.id,
    parentSessionId: parent.id,
    sourceMessageId: `${parent.id}-message`,
    sharedMessages: [{
      parentMessageId: `${parent.id}-message`,
      childMessageId: `${child.id}-message`,
    }],
  })
  await stopping
  await running
  const metadata = await BranchMetadataStore.openForProvider(project, "test-agent", state)
  expect(await metadata.loadRelations()).toHaveLength(1)
})

test("reports a late session-transition failure during shutdown", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() { return [] },
    async readTranscripts() { return new Map() },
    async prepareNewSession() { throw new Error("not used") },
    async prepareResume() { throw new Error("not used") },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()
  await waitForFrame(setup, (frame) => frame.includes("No conversations"))

  let rejectTransition!: (error: Error) => void
  const transition = new Promise<void>((_resolve, reject) => { rejectTransition = reject })
  const stopping = app.stop()
  ;(app as unknown as {
    trackSessionTransition(reconciliation: Promise<void>, reportErrors: boolean): void
  }).trackSessionTransition(transition, false)
  rejectTransition(new Error("ancestry write failed"))

  await expect(stopping).rejects.toThrow("Unable to finish claude-tree shutdown cleanly")
  await running
})

test("removes a live root only after confirmation and keeps it removed after refresh and restart", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  const processMarker = join(root, "root-process")
  await mkdir(project)
  const executable = join(root, "agent")
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s' "$$" > ${JSON.stringify(processMarker)}
sleep 30
`,
  )
  await chmod(executable, 0o755)

  const sessions: AgentSession[] = [
    { id: "root-a", title: "Root A", lastModified: 2 },
    { id: "root-b", title: "Root B", lastModified: 1 },
  ]
  let listCalls = 0
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      listCalls += 1
      return sessions
    },
    async readTranscripts(sessionIds) {
      return new Map(sessionIds.map((sessionId) => [sessionId, [
        {
          id: `${sessionId}-message`,
          role: "user" as const,
          preview: `${sessionId} question`,
          ordinal: 0,
          visible: true,
        },
      ]]))
    },
    async prepareNewSession() {
      throw new Error("not used")
    },
    async prepareResume(session) {
      return {
        sessionId: session.id,
        command: [executable],
        cwd: project,
        observer: new NullTerminalObserver(),
      }
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Root A") && frame.includes("Root B"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("root-a question"))
    setup.mockInput.pressEnter()
    const [processId] = await readProcessIds(processMarker)
    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(setup, (frame) => frame.includes("Message graph"))
    setup.mockInput.pressKey("q")
    await waitForFrame(setup, (frame) => frame.includes("Conversation roots"))

    setup.mockInput.pressKey("d")
    const confirmation = await waitForFrame(
      setup,
      (frame) =>
        frame.includes("Delete conversation tree") &&
        frame.includes("Delete this conversation tree?") &&
        frame.includes("• Deletion cannot be undone.") &&
        frame.includes("• Transcripts and project files are not deleted.") &&
        frame.includes("• 1 live session will be stopped first."),
    )
    expect(confirmation).toContain("Cancel  Delete")
    const confirmationLines = confirmation.split("\n")
    const questionLine = confirmationLines.findIndex((line) =>
      line.includes("Delete this conversation tree?"),
    )
    const warningLine = confirmationLines.findIndex((line) =>
      line.includes("• Deletion cannot be undone."),
    )
    expect(warningLine).toBe(questionLine + 2)
    expect(
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .some(
          (span) => span.text.includes("Deletion cannot be undone.") && span.fg.equals(theme.danger),
        ),
    ).toBeTrue()
    expect(
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .some((span) => span.text.includes("Cancel") && span.bg.equals(theme.selected)),
    ).toBeTrue()

    setup.mockInput.pressEnter()
    await waitForFrame(
      setup,
      (frame) => frame.includes("Root A") && !frame.includes("Delete conversation tree"),
    )
    expect(isProcessAlive(processId!)).toBeTrue()

    setup.mockInput.pressKey("d")
    await waitForFrame(setup, (frame) => frame.includes("Delete conversation tree"))
    setup.mockInput.pressArrow("right")
    setup.mockInput.pressEnter()
    const removed = await waitForFrame(
      setup,
      (frame) => frame.includes("Root B") && !frame.includes("Root A"),
    )
    expect(removed).toContain("Conversation roots")
    expect(isProcessAlive(processId!)).toBeFalse()

    const callsBeforeRefresh = listCalls
    setup.mockInput.pressKey("r")
    await waitForFrame(
      setup,
      (frame) => listCalls > callsBeforeRefresh && frame.includes("Root B") && !frame.includes("Root A"),
    )
  } finally {
    await app.stop()
    await running
  }

  const restartedSetup = await createTestRenderer({ width: 80, height: 24 })
  const restartedApp = await AgentTreeApp.create(
    restartedSetup.renderer,
    project,
    provider,
    state,
  )
  const restarted = restartedApp.run()
  try {
    const frame = await waitForFrame(
      restartedSetup,
      (candidate) => candidate.includes("Root B"),
    )
    expect(frame).not.toContain("Root A")
  } finally {
    await restartedApp.stop()
    await restarted
  }
})

test("removes a branched conversation path and leaves its nearest parent usable", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  const launchMarker = join(root, "path-launch")
  await mkdir(project)
  const executable = join(root, "agent")
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s' "$1" > ${JSON.stringify(launchMarker)}
sleep 30
`,
  )
  await chmod(executable, 0o755)

  const sessions: AgentSession[] = [
    { id: "session-a", title: "Conversation A", lastModified: 1 },
    { id: "session-b", title: "Conversation B", lastModified: 2 },
    { id: "session-c", title: "Conversation C", lastModified: 3 },
  ]
  const transcripts = new Map([
    [
      "session-a",
      [{ id: "a-1", role: "user" as const, preview: "path A", ordinal: 0, visible: true }],
    ],
    [
      "session-b",
      [
        { id: "b-1", role: "user" as const, preview: "path A", ordinal: 0, visible: true },
        { id: "b-2", role: "agent" as const, preview: "path B", ordinal: 1, visible: true },
      ],
    ],
    [
      "session-c",
      [
        { id: "c-1", role: "user" as const, preview: "path A", ordinal: 0, visible: true },
        { id: "c-2", role: "agent" as const, preview: "path B", ordinal: 1, visible: true },
        { id: "c-3", role: "user" as const, preview: "path C", ordinal: 2, visible: true },
      ],
    ],
  ])
  const metadata = await BranchMetadataStore.openForProvider(project, "test-agent", state)
  await metadata.saveRelation({
    childSessionId: "session-b",
    parentSessionId: "session-a",
    sourceMessageId: "a-1",
    sharedMessages: [{ parentMessageId: "a-1", childMessageId: "b-1" }],
  })
  await metadata.saveRelation({
    childSessionId: "session-c",
    parentSessionId: "session-b",
    sourceMessageId: "b-2",
    sharedMessages: [
      { parentMessageId: "b-1", childMessageId: "c-1" },
      { parentMessageId: "b-2", childMessageId: "c-2" },
    ],
  })
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      return sessions
    },
    async readTranscripts(sessionIds) {
      return new Map(sessionIds.map((sessionId) => [sessionId, transcripts.get(sessionId) ?? []]))
    },
    async prepareNewSession() {
      throw new Error("not used")
    },
    async prepareResume(session) {
      return {
        sessionId: session.id,
        command: [executable, session.id],
        cwd: project,
        observer: new NullTerminalObserver(),
      }
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Conversation A"))
    setup.mockInput.pressEnter()
    await waitForFrame(
      setup,
      (frame) => frame.includes("path A") && frame.includes("path B") && frame.includes("path C"),
    )
    setup.mockInput.pressArrow("down")
    await waitForFrame(setup, () => isSelected(setup, "path B"))
    setup.mockInput.pressKey("d")
    const confirmation = await waitForFrame(
      setup,
      (frame) =>
        frame.includes("Delete conversation path") &&
        frame.includes("Delete this node and all descendents?") &&
        frame.includes("• Deletion cannot be undone.") &&
        frame.includes("• Transcripts and project files are not deleted."),
    )
    expect(confirmation).toContain("Cancel  Delete")
    setup.mockInput.pressArrow("right")
    setup.mockInput.pressEnter()

    const pruned = await waitForFrame(
      setup,
      (frame) => frame.includes("path A") && !frame.includes("path B") && !frame.includes("path C"),
    )
    expect(pruned).toContain("Message graph")
    expect(isSelected(setup, "path A")).toBeTrue()

    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => !frame.includes("claude-tree"))
    await waitUntil(() => Bun.file(launchMarker).exists())
    expect(await readFile(launchMarker, "utf8")).toBe("session-a")
  } finally {
    await app.stop()
    await running
  }
})

test("stops a live endpoint before removing its path and prevents resuming it", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  const processMarker = join(root, "path-process")
  const persistedMarker = join(root, "path-persisted")
  await mkdir(project)
  const executable = join(root, "agent")
  await writeFile(
    executable,
    `#!/bin/sh
trap 'touch ${JSON.stringify(persistedMarker)}; exit 0' TERM
printf '%s' "$$" > ${JSON.stringify(processMarker)}
sleep 30
`,
  )
  await chmod(executable, 0o755)

  const session: AgentSession = { id: "live-path", title: "Live path", lastModified: 1 }
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      return [session]
    },
    async readTranscripts(sessionIds) {
      const messages: AgentMessage[] = [
        {
          id: "kept-message",
          role: "user",
          preview: "kept ancestor",
          ordinal: 0,
          visible: true,
        },
      ]
      if (await Bun.file(persistedMarker).exists()) {
        messages.push({
          id: "persisted-while-stopping",
          role: "agent",
          preview: "persisted while stopping",
          ordinal: 1,
          visible: true,
        })
      }
      return new Map(sessionIds.map((sessionId) => [sessionId, messages]))
    },
    async prepareNewSession() {
      throw new Error("not used")
    },
    async prepareResume(resumed) {
      return {
        sessionId: resumed.id,
        command: [executable],
        cwd: project,
        observer: new NullTerminalObserver(),
      }
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Live path"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("kept ancestor"))
    setup.mockInput.pressEnter()
    const [processId] = await readProcessIds(processMarker)
    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(setup, (frame) => frame.includes("Draft"))

    setup.mockInput.pressKey("d")
    await waitForFrame(
      setup,
      (frame) =>
        frame.includes("Delete conversation path") &&
        frame.includes("1 live session will be stopped first"),
    )
    setup.mockInput.pressArrow("right")
    setup.mockInput.pressEnter()
    const removed = await waitForFrame(
      setup,
      (frame) => {
        if (frame.includes("persisted while stopping")) {
          throw new Error(`Rendered content below the removed endpoint:\n${frame}`)
        }
        return frame.includes("kept ancestor") && !frame.includes("Draft") && isSelected(setup, "kept ancestor")
      },
    )
    expect(removed).toContain("Message graph")
    expect(isProcessAlive(processId!)).toBeFalse()

    setup.mockInput.pressKey("r")
    await waitForFrame(
      setup,
      (frame) => frame.includes("kept ancestor") && !frame.includes("persisted while stopping"),
    )

    await Bun.sleep(20)
    setup.mockInput.pressEnter()
    await waitForFrame(
      setup,
      (frame) => frame.includes("No Test Agent session is reachable from this node"),
    )
  } finally {
    await app.stop()
    await running
  }
})

test("uses Ctrl+N and Ctrl+P to move through conversation roots", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)

  const sessions = Array.from({ length: 3 }, (_, index): SDKSessionInfo => ({
    sessionId: testUuid(index + 1),
    summary: `Root ${index + 1}`,
    firstPrompt: `question ${index + 1}`,
    lastModified: 100 - index,
  }))
  const provider = new ClaudeProvider(project, join(root, "unused-claude"), {
    async list(): Promise<SDKSessionInfo[]> {
      return sessions
    },
    async messages(sessionId): Promise<SessionMessage[]> {
      const index = sessions.findIndex((session) => session.sessionId === sessionId)
      return [sessionMessage(sessionId, testUuid(100 + index), "user", `question ${index + 1}`)]
    },
    async fork(): Promise<{ sessionId: string }> {
      throw new Error("not used")
    },
  })
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const processTitles: string[] = []
  const app = await AgentTreeApp.create(
    setup.renderer,
    project,
    provider,
    state,
    (title) => processTitles.push(title),
  )
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Root 1"))
    expect(isSelected(setup, "Root 1")).toBeTrue()
    expect(processTitles.at(-1)).toBe("c/t")

    setup.mockInput.pressKey("n", { ctrl: true })
    await waitForFrame(setup, () => isSelected(setup, "Root 2"))
    expect(processTitles.at(-1)).toBe("c/t")

    setup.mockInput.pressKey("p", { ctrl: true })
    let frame = await waitForFrame(setup, () => isSelected(setup, "Root 1"))
    expect(frame).toContain("Conversation roots")
    expect(processTitles.at(-1)).toBe("c/t")

    setup.mockInput.pressEnter()
    await waitForFrame(
      setup,
      (candidate) => candidate.includes("Message graph") && candidate.includes("question 1"),
    )
    expect(processTitles.at(-1)).toBe("c/t: Root 1")

    setup.mockInput.pressKey("q")
    frame = await waitForFrame(setup, (candidate) => candidate.includes("Conversation roots"))
    expect(processTitles.at(-1)).toBe("c/t")
  } finally {
    await app.stop()
    await running
  }
})

test("opens the only descendant leaf from an interior message", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  const launchMarker = join(root, "launch")
  await mkdir(project)
  const fakeClaude = join(root, "claude")
  await writeFile(
    fakeClaude,
    `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(launchMarker)}
sleep 30
`,
  )
  await chmod(fakeClaude, 0o755)

  const sessionId = "11111111-1111-4111-8111-111111111111"
  const transcript = [
    sessionMessage(sessionId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "user", "first"),
    sessionMessage(sessionId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "assistant", "second"),
    sessionMessage(sessionId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "user", "third"),
  ]
  const provider = new ClaudeProvider(project, fakeClaude, {
    async list(): Promise<SDKSessionInfo[]> {
      return [
        {
          sessionId,
          summary: "Linear conversation",
          firstPrompt: "first",
          lastModified: 10,
        },
      ]
    },
    async messages(): Promise<SessionMessage[]> {
      return transcript
    },
    async fork(): Promise<{ sessionId: string }> {
      throw new Error("not used")
    },
  })
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Linear conversation"))
    setup.mockInput.pressEnter()
    let frame = await waitForFrame(
      setup,
      (candidate) => candidate.includes("Message graph") && candidate.includes("first"),
    )
    expect(frame).not.toContain("g top")
    expect(frame).not.toContain("G bottom")

    setup.mockInput.pressKey("g", { shift: true })
    await waitForFrame(setup, () => isSelected(setup, "third"))
    setup.mockInput.pressKey("g", { ctrl: true })
    await Bun.sleep(20)
    await setup.renderOnce()
    expect(isSelected(setup, "third")).toBeTrue()
    setup.mockInput.pressKey("g")
    await waitForFrame(setup, () => isSelected(setup, "first"))

    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => !frame.includes("claude-tree"))

    expect(await readMarker(launchMarker)).toEqual(["--resume", sessionId])
  } finally {
    await app.stop()
    await running
  }
})

test("opens a picker for multiple descendant leaves and resumes the chosen session", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  const launchMarker = join(root, "launch")
  const finishMarker = join(root, "finish")
  await mkdir(project)
  const fakeClaude = join(root, "claude")
  await writeFile(
    fakeClaude,
    `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(launchMarker)}
${String.raw`printf '\033]0;\342\240\213 Claude Code\007'`}
while [ ! -f ${JSON.stringify(finishMarker)} ]; do sleep 0.01; done
${String.raw`printf '\033]0;\342\234\263 Claude Code\007'`}
sleep 30
`,
  )
  await chmod(fakeClaude, 0o755)

  const rootSessionId = "11111111-1111-4111-8111-111111111111"
  const childSessionId = "22222222-2222-4222-8222-222222222222"
  const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
  const copiedSourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"
  const rootTranscript = [sessionMessage(rootSessionId, sourceId, "user", "branch source")]
  let childTranscript = [
    sessionMessage(childSessionId, copiedSourceId, "user", "branch source"),
    sessionMessage(
      childSessionId,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      "assistant",
      "branch answer",
    ),
  ]
  const metadata = await BranchMetadataStore.openForProvider(project, "claude", state)
  await metadata.saveRelation({
    childSessionId,
    parentSessionId: rootSessionId,
    sourceMessageId: sourceId,
    sharedMessages: [{ parentMessageId: sourceId, childMessageId: copiedSourceId }],
  })
  const provider = new ClaudeProvider(project, fakeClaude, {
    async list(): Promise<SDKSessionInfo[]> {
      return [
        {
          sessionId: rootSessionId,
          summary: "Root leaf",
          firstPrompt: "branch source",
          lastModified: 10,
        },
        {
          sessionId: childSessionId,
          summary: "Child leaf",
          firstPrompt: "branch source",
          lastModified: 20,
        },
      ]
    },
    async messages(sessionId): Promise<SessionMessage[]> {
      return sessionId === rootSessionId ? rootTranscript : childTranscript
    },
    async fork(): Promise<{ sessionId: string }> {
      throw new Error("not used")
    },
  })
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const processTitles: string[] = []
  const terminalTitles: string[] = []
  let rendererStarted = false
  let terminalTitleSetBeforeStart = false
  const startRenderer = setup.renderer.start.bind(setup.renderer)
  setup.renderer.start = () => {
    rendererStarted = true
    startRenderer()
  }
  setup.renderer.setTerminalTitle = (title) => {
    if (!rendererStarted) terminalTitleSetBeforeStart = true
    terminalTitles.push(title)
  }
  const app = await AgentTreeApp.create(
    setup.renderer,
    project,
    provider,
    state,
    (title) => processTitles.push(title),
  )
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Root leaf"))
    expect(processTitles.at(-1)).toBe("c/t")
    expect(terminalTitles.at(-1)).toBe("c/t")
    expect(terminalTitleSetBeforeStart).toBeFalse()
    setup.mockInput.pressEnter()
    await waitForFrame(
      setup,
      (frame) => frame.includes("Message graph") && frame.includes("branch source"),
    )
    expect(processTitles.at(-1)).toBe("c/t: Root leaf")
    expect(terminalTitles.at(-1)).toBe("c/t: Root leaf")
    setup.mockInput.pressKey("g", { shift: true })
    let frame = await waitForFrame(
      setup,
      (candidate) => candidate.includes("Jump to Leaf") && candidate.includes("Child leaf"),
    )
    expect(frame).toContain("1 node down")
    setup.mockInput.pressKey("n", { ctrl: true })
    await waitForFrame(setup, () => isSelected(setup, "Child leaf"))
    setup.mockInput.pressEnter()
    await waitForFrame(
      setup,
      (candidate) => !candidate.includes("Jump to Leaf") && isSelected(setup, "branch answer"),
    )
    expect(await Bun.file(launchMarker).exists()).toBeFalse()
    setup.mockInput.pressKey("g")
    await waitForFrame(setup, () => isSelected(setup, "branch source"))

    setup.mockInput.pressEnter()
    frame = await waitForFrame(
      setup,
      (candidate) => candidate.includes("Open leaf") && candidate.includes("Child leaf"),
    )
    expect(frame).toContain("esc")
    expect(frame).not.toContain("┌")
    expect(setup.captureSpans().lines[0]?.spans[0]?.bg.equals(theme.background)).toBeFalse()
    expect(isSelected(setup, "Root leaf")).toBeTrue()

    setup.resize(40, 8)
    await waitForFrame(
      setup,
      (candidate) => candidate.includes("Resize to at least") && !candidate.includes("Open leaf"),
    )
    setup.resize(80, 24)
    await waitForFrame(setup, (candidate) => candidate.includes("Message graph"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (candidate) => candidate.includes("Open leaf"))

    setup.mockInput.pressKey("n", { ctrl: true })
    frame = await waitForFrame(setup, () => isSelected(setup, "Child leaf"))
    expect(frame).toContain("2 nodes down")

    setup.mockInput.pressEnter()
    await waitForFrame(setup, (candidate) => !candidate.includes("claude-tree"))
    expect(await readMarker(launchMarker)).toEqual(["--resume", childSessionId])
    expect(processTitles.at(-1)).toBe("c/t: Child leaf")
    expect(terminalTitles.at(-1)).toBe("c/t: Child leaf")

    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(
      setup,
      (candidate) =>
        candidate.includes("Message graph") &&
        candidate.includes("Agent") &&
        BRAILLE_SPINNER_FRAMES.some((spinner) => candidate.includes(spinner)),
    )
    expect(processTitles.at(-1)).toBe("c/t: Root leaf")
    expect(terminalTitles.at(-1)).toBe("c/t: Root leaf")
    childTranscript = [
      ...childTranscript,
      sessionMessage(
        childSessionId,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
        "user",
        "follow-up question",
      ),
      sessionMessage(
        childSessionId,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
        "assistant",
        "new branch answer",
        undefined,
        "end_turn",
      ),
    ]
    await writeFile(finishMarker, "")
    await waitForFrame(
      setup,
      (candidate) =>
        candidate.includes("new branch answer") &&
        candidate.includes("Draft") &&
        candidate.includes("New updates"),
    )
    setup.mockInput.pressKey("g")
    await waitForFrame(setup, () => isSelected(setup, "branch source"))

    setup.mockInput.pressKey("g", { shift: true })
    frame = await waitForFrame(
      setup,
      (candidate) => candidate.includes("Jump to Leaf") && candidate.includes("● Child leaf"),
    )
    expect(frame).not.toContain("• Child leaf")
    setup.mockInput.pressEscape()
    await waitForFrame(setup, (candidate) => !candidate.includes("Jump to Leaf"))

    setup.mockInput.pressEnter()
    frame = await waitForFrame(
      setup,
      (candidate) => candidate.includes("Open leaf") && candidate.includes("● Child leaf"),
    )
    expect(frame).not.toContain("• Child leaf")
    const optionLines = frame.split("\n").filter((line) => line.includes("node") && line.includes("down"))
    const rootOption = optionLines.find((line) => line.includes("Root leaf"))!
    const childOption = optionLines.find((line) => line.includes("Child leaf"))!
    expect(displayWidth(rootOption.slice(0, rootOption.indexOf("Root leaf")))).toBe(
      displayWidth(childOption.slice(0, childOption.indexOf("Child leaf"))),
    )
  } finally {
    await app.stop()
    await running
  }
})

test("replaces a completed agent spinner with a message and new draft leaf", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  const finishMarker = join(root, "finish")
  await mkdir(project)
  const fakeClaude = join(root, "claude")
  await writeFile(
    fakeClaude,
    `#!/bin/sh
${String.raw`printf '\033]0;\342\240\213 Claude Code\007'`}
while [ ! -f ${JSON.stringify(finishMarker)} ]; do sleep 0.01; done
${String.raw`printf '\033]0;\342\234\263 Claude Code\007'`}
sleep 30
`,
  )
  await chmod(fakeClaude, 0o755)

  const sessionId = "11111111-1111-4111-8111-111111111111"
  const userMessage = sessionMessage(
    sessionId,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    "user",
    "question",
  )
  const partialAgentMessage = sessionMessage(
    sessionId,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    "assistant",
    "first blurb",
    undefined,
    null,
  )
  const agentMessage = sessionMessage(
    sessionId,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    "assistant",
    "completed answer",
    undefined,
    "end_turn",
  )
  const unrelatedSessionId = "22222222-2222-4222-8222-222222222222"
  const unrelatedTranscript = [sessionMessage(
    unrelatedSessionId,
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    "user",
    "unrelated question",
  )]
  let transcript: SessionMessage[] = [userMessage]
  const transcriptReadSessionIds: string[] = []
  const provider = new ClaudeProvider(project, fakeClaude, {
    async list(): Promise<SDKSessionInfo[]> {
      return [
        {
          sessionId,
          summary: "Live conversation",
          firstPrompt: "question",
          lastModified: 2,
        },
        {
          sessionId: unrelatedSessionId,
          summary: "Unrelated conversation",
          firstPrompt: "unrelated question",
          lastModified: 1,
        },
      ]
    },
    async messages(readSessionId): Promise<SessionMessage[]> {
      transcriptReadSessionIds.push(readSessionId)
      return readSessionId === sessionId ? transcript : unrelatedTranscript
    },
    async fork(): Promise<{ sessionId: string }> {
      throw new Error("not used")
    },
  })
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(
    setup.renderer,
    project,
    provider,
    state,
  )
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Live conversation"))
    transcriptReadSessionIds.length = 0
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("question") && frame.includes("Message graph"))
    setup.mockInput.pressEnter()
    await Bun.sleep(50)
    transcript = [userMessage, partialAgentMessage]
    setup.mockInput.pressKey(" ", { ctrl: true })

    const generating = await waitForFrame(
      setup,
      (frame) =>
        frame.includes("Agent") && BRAILLE_SPINNER_FRAMES.some((spinner) => frame.includes(spinner)),
    )
    expect(generating).not.toContain("first blurb")
    expect(generating).not.toContain("completed answer")
    expect(generating).not.toContain("Draft")

    await writeFile(finishMarker, "")
    await waitUntil(() => transcriptReadSessionIds.length >= 2)
    transcript = [userMessage, partialAgentMessage, agentMessage]
    const completed = await waitForFrame(
      setup,
      (frame) => {
        if (frame.includes("Draft") && !frame.includes("completed answer")) {
          throw new Error(`Rendered Draft before committing the agent message:\n${frame}`)
        }
        return (
          frame.includes("completed answer") &&
          frame.includes("Draft") &&
          frame.includes("New updates") &&
          BRAILLE_SPINNER_FRAMES.every((spinner) => !frame.includes(spinner))
        )
      },
    )
    expect(completed.match(/󰚩 Agent/g)).toHaveLength(1)
    expect(completed).toContain("first blurb completed answer")
    expect(completed.indexOf("completed answer")).toBeLessThan(completed.indexOf("Draft"))
    expect(transcriptReadSessionIds.every((readSessionId) => readSessionId === sessionId)).toBeTrue()
    const selectedDraft = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("Draft") && span.bg.equals(theme.selected))
    expect(selectedDraft).toBeDefined()

    setup.mockInput.pressKey("q")
    const roots = await waitForFrame(
      setup,
      (frame) =>
        frame.includes("Conversation roots") &&
        frame.includes("New updates") &&
        frame.includes("● New updates · Live conversation"),
    )
    expect(roots).not.toContain("Saved")
    expect(roots).not.toContain("● Live · Live conversation")

    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("Message graph"))
    setup.mockInput.pressKey("g", { shift: true })
    await waitForFrame(setup, () => isSelected(setup, "Draft"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => !frame.includes("claude-tree"))
    setup.mockInput.pressKey(" ", { ctrl: true })
    const viewed = await waitForFrame(
      setup,
      (frame) =>
        frame.includes("completed answer") &&
        frame.includes("Draft") &&
        !frame.includes("New updates"),
    )
    expect(viewed).toContain("Live conversation")
  } finally {
    await app.stop()
    await running
  }
})

test("keeps completion pending when persistence has only reached the user message", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  const finishMarker = join(root, "finish")
  await mkdir(project)
  const fakeClaude = join(root, "claude")
  await writeFile(
    fakeClaude,
    `#!/bin/sh
${String.raw`printf '\033]0;\342\240\213 Claude Code\007'`}
while [ ! -f ${JSON.stringify(finishMarker)} ]; do sleep 0.01; done
${String.raw`printf '\033]0;\342\234\263 Claude Code\007'`}
sleep 30
`,
  )
  await chmod(fakeClaude, 0o755)

  const sessionId = "33333333-3333-4333-8333-333333333333"
  const oldUser = sessionMessage(sessionId, "cccccccc-cccc-4ccc-8ccc-ccccccccccc1", "user", "old question")
  const oldAgent = sessionMessage(
    sessionId,
    "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
    "assistant",
    "old answer",
    undefined,
    "end_turn",
  )
  const rewoundUser = sessionMessage(
    sessionId,
    "cccccccc-cccc-4ccc-8ccc-ccccccccccc5",
    "user",
    "rewound question",
  )
  const removedAgent = sessionMessage(
    sessionId,
    "cccccccc-cccc-4ccc-8ccc-ccccccccccc6",
    "assistant",
    "removed answer",
    undefined,
    "end_turn",
  )
  const newUser = sessionMessage(sessionId, "cccccccc-cccc-4ccc-8ccc-ccccccccccc3", "user", "new question")
  const newAgent = sessionMessage(
    sessionId,
    "cccccccc-cccc-4ccc-8ccc-ccccccccccc4",
    "assistant",
    "new answer",
    undefined,
    "end_turn",
  )
  let transcript: SessionMessage[] = [oldUser, oldAgent, rewoundUser, removedAgent]
  let transcriptReads = 0
  const provider = new ClaudeProvider(project, fakeClaude, {
    async list(): Promise<SDKSessionInfo[]> {
      return [{ sessionId, summary: "Persistence lag", firstPrompt: "old question", lastModified: 1 }]
    },
    async messages(): Promise<SessionMessage[]> {
      transcriptReads += 1
      return transcript
    },
    async fork(): Promise<{ sessionId: string }> {
      throw new Error("not used")
    },
  })
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Persistence lag"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("old answer"))
    setup.mockInput.pressEnter()
    await Bun.sleep(50)
    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(
      setup,
      (frame) => frame.includes("Agent") && BRAILLE_SPINNER_FRAMES.some((spinner) => frame.includes(spinner)),
    )
    ;(app as unknown as {
      liveRewindAnchors: Map<string, { targetMessageId: string; submitted: boolean }>
    }).liveRewindAnchors.set(sessionId, {
      targetMessageId: rewoundUser.uuid,
      submitted: true,
    })

    const readsBeforeIdle = transcriptReads
    transcript = [oldUser, oldAgent]
    await writeFile(finishMarker, "")
    await waitUntil(() => transcriptReads > readsBeforeIdle)
    const pending = await waitForFrame(
      setup,
      (frame) => frame.includes("Agent") && BRAILLE_SPINNER_FRAMES.some((spinner) => frame.includes(spinner)),
    )
    expect(pending).not.toContain("new question")
    expect(pending).not.toContain("Draft")
    const pendingState = app as unknown as {
      liveRewindAnchors: Map<string, unknown>
      pendingCompletionRefreshes: Map<string, number>
    }
    expect(pendingState.liveRewindAnchors.has(sessionId)).toBeTrue()
    expect(pendingState.pendingCompletionRefreshes.has(sessionId)).toBeTrue()
    expect(pending).not.toContain("New updates")

    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => !frame.includes("claude-tree"))
    transcript = [oldUser, oldAgent, newUser, newAgent]
    await waitUntil(() => transcriptReads > readsBeforeIdle + 1)
    setup.mockInput.pressKey(" ", { ctrl: true })
    const completed = await waitForFrame(
      setup,
      (frame) =>
        frame.includes("new question") &&
        frame.includes("new answer") &&
        frame.includes("Draft") &&
        !frame.includes("New updates"),
    )
    expect(completed.indexOf("new question")).toBeLessThan(completed.indexOf("new answer"))
  } finally {
    await app.stop()
    await running
  }
})

test("does not accept a stale shorter transcript without a rewind boundary", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  const finishMarker = join(root, "finish")
  await mkdir(project)
  const fakeClaude = join(root, "claude")
  await writeFile(
    fakeClaude,
    `#!/bin/sh
${String.raw`printf '\033]0;\342\240\213 Claude Code\007'`}
while [ ! -f ${JSON.stringify(finishMarker)} ]; do sleep 0.01; done
${String.raw`printf '\033]0;\342\234\263 Claude Code\007'`}
sleep 30
`,
  )
  await chmod(fakeClaude, 0o755)

  const sessionId = "44444444-4444-4444-8444-444444444444"
  const firstUser = sessionMessage(sessionId, "dddddddd-dddd-4ddd-8ddd-ddddddddddd1", "user", "keep question")
  const firstAgent = sessionMessage(
    sessionId,
    "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
    "assistant",
    "keep answer",
    undefined,
    "end_turn",
  )
  const removedUser = sessionMessage(sessionId, "dddddddd-dddd-4ddd-8ddd-ddddddddddd3", "user", "remove question")
  const removedAgent = sessionMessage(
    sessionId,
    "dddddddd-dddd-4ddd-8ddd-ddddddddddd4",
    "assistant",
    "remove answer",
    undefined,
    "end_turn",
  )
  let transcript: SessionMessage[] = [firstUser, firstAgent, removedUser, removedAgent]
  let transcriptReads = 0
  const provider = new ClaudeProvider(project, fakeClaude, {
    async list(): Promise<SDKSessionInfo[]> {
      return [{ sessionId, summary: "Rewound conversation", firstPrompt: "keep question", lastModified: 1 }]
    },
    async messages(): Promise<SessionMessage[]> {
      transcriptReads += 1
      return transcript
    },
    async fork(): Promise<{ sessionId: string }> {
      throw new Error("not used")
    },
  })
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Rewound conversation"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("remove answer"))
    setup.mockInput.pressEnter()
    await Bun.sleep(50)
    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(
      setup,
      (frame) => frame.includes("remove answer") && BRAILLE_SPINNER_FRAMES.some((spinner) => frame.includes(spinner)),
    )

    const readsBeforeIdle = transcriptReads
    transcript = [firstUser, firstAgent]
    await writeFile(finishMarker, "")
    await waitUntil(() => transcriptReads > readsBeforeIdle)
    await setup.renderOnce()
    const retained = setup.captureCharFrame()
    expect(retained).toContain("remove question")
    expect(retained).toContain("remove answer")
    expect(retained).not.toContain("Draft")
  } finally {
    await app.stop()
    await running
  }
})

test("projects a live Claude undo draft before the rewritten transcript is persisted", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const executable = join(root, "agent")
  await writeFile(executable, "#!/bin/sh\nsleep 30\n")
  await chmod(executable, 0o755)

  const session: AgentSession = { id: "rewind-draft-session", title: "Live rewind", lastModified: 1 }
  const transcript: AgentMessage[] = [
    { id: "kept-user", role: "user", preview: "kept question", ordinal: 0, visible: true },
    { id: "kept-agent", role: "agent", preview: "kept answer", ordinal: 1, visible: true },
    { id: "rewound-user", role: "user", preview: "restore this prompt", ordinal: 2, visible: true },
    { id: "removed-agent", role: "agent", preview: "remove this answer", ordinal: 3, visible: true },
  ]
  let draftObservations = 0
  const rewindObserver: TerminalObserver = {
    observeOutput() { return [] },
    observeScreen() { return undefined },
    observeDraft() {
      draftObservations += 1
      return draftObservations === 1
        ? { text: "restore this prompt", exact: false, rewind: true }
        : { text: "restore this prompt", exact: false }
    },
  }
  let listCalls = 0
  let transcriptReads = 0
  let resolveDelayedList!: (sessions: AgentSession[]) => void
  const delayedList = new Promise<AgentSession[]>((resolve) => {
    resolveDelayedList = resolve
  })
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      listCalls += 1
      if (listCalls > 1) return delayedList
      return [session]
    },
    async readTranscripts(sessionIds) {
      transcriptReads += 1
      return new Map(sessionIds.map((sessionId) => [sessionId, transcript]))
    },
    async prepareNewSession() { throw new Error("not used") },
    async prepareResume() {
      return {
        sessionId: session.id,
        command: [executable],
        cwd: project,
        observer: rewindObserver,
      }
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Live rewind"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("remove this answer"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => !frame.includes("claude-tree"))
    setup.mockInput.pressKey(" ", { ctrl: true })

    const rewound = await waitForFrame(
      setup,
      (frame) =>
        frame.includes("kept answer") &&
        frame.includes("Draft") &&
        frame.includes("restore this prompt") &&
        !frame.includes("remove this answer"),
    )
    expect(isSelected(setup, "Draft")).toBeTrue()
    expect(rewound.indexOf("kept answer")).toBeLessThan(rewound.indexOf("Draft"))

    await waitUntil(() => listCalls > 1)
    resolveDelayedList([session])
    await waitUntil(() => transcriptReads > 1)
    await Bun.sleep(10)
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => !frame.includes("claude-tree"))
    setup.mockInput.pressKey(" ", { ctrl: true })
    const rewoundAgain = await waitForFrame(
      setup,
      (frame) =>
        frame.includes("kept answer") &&
        frame.includes("Draft") &&
        !frame.includes("remove this answer"),
    )
    expect(draftObservations).toBe(2)
    expect(isSelected(setup, "Draft")).toBeTrue()
    expect(rewoundAgain.indexOf("kept answer")).toBeLessThan(rewoundAgain.indexOf("Draft"))
  } finally {
    await app.stop()
    await running
  }
})

test("moves a live rewind projection again when the same session is rewound twice", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const session: AgentSession = { id: "double-rewind", title: "Double rewind", lastModified: 1 }
  const transcript: AgentMessage[] = [
    { id: "first-user", role: "user", preview: "first question", ordinal: 0, visible: true },
    { id: "first-agent", role: "agent", preview: "first answer", ordinal: 1, visible: true },
    { id: "second-user", role: "user", preview: "second question", ordinal: 2, visible: true },
    { id: "second-agent", role: "agent", preview: "second answer", ordinal: 3, visible: true },
    { id: "third-user", role: "user", preview: "third question", ordinal: 4, visible: true },
    { id: "third-agent", role: "agent", preview: "third answer", ordinal: 5, visible: true },
  ]
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() { return [session] },
    async readTranscripts() { return new Map([[session.id, transcript]]) },
    async prepareNewSession() { throw new Error("not used") },
    async prepareResume() { throw new Error("not used") },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Double rewind"))
    const rewindState = app as unknown as {
      captureLiveRewindAnchor(sessionId: string, draft: DraftPreview): void
      projectedTranscriptsForLiveRewinds(): Map<string, AgentMessage[]>
    }
    rewindState.captureLiveRewindAnchor(session.id, {
      text: "third question",
      exact: false,
      rewind: true,
      rewindTarget: "third question",
    })
    expect(
      rewindState.projectedTranscriptsForLiveRewinds().get(session.id)?.map((message) => message.id),
    ).toEqual(["first-user", "first-agent", "second-user", "second-agent"])

    rewindState.captureLiveRewindAnchor(session.id, {
      text: "second question",
      exact: false,
      rewind: true,
      rewindTarget: "second question",
    })
    expect(
      rewindState.projectedTranscriptsForLiveRewinds().get(session.id)?.map((message) => message.id),
    ).toEqual(["first-user", "first-agent"])
  } finally {
    await app.stop()
    await running
  }
})

test("does not project a live rewind when its prompt matches multiple messages", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const executable = join(root, "agent")
  await writeFile(executable, "#!/bin/sh\nsleep 30\n")
  await chmod(executable, 0o755)

  const session: AgentSession = { id: "ambiguous-rewind", title: "Ambiguous rewind", lastModified: 1 }
  const transcript: AgentMessage[] = [
    { id: "first-user", role: "user", preview: "repeated prompt", ordinal: 0, visible: true },
    { id: "first-agent", role: "agent", preview: "first answer", ordinal: 1, visible: true },
    { id: "second-user", role: "user", preview: "repeated prompt", ordinal: 2, visible: true },
    { id: "second-agent", role: "agent", preview: "answer must remain", ordinal: 3, visible: true },
  ]
  const observer: TerminalObserver = {
    observeOutput() { return [] },
    observeScreen() { return undefined },
    observeDraft() {
      return {
        text: "repeated prompt",
        exact: false,
        rewind: true,
        rewindTarget: "repeated prompt",
      }
    },
  }
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() { return [session] },
    async readTranscripts() { return new Map([[session.id, transcript]]) },
    async prepareNewSession() { throw new Error("not used") },
    async prepareResume() {
      return {
        sessionId: session.id,
        command: [executable],
        cwd: project,
        observer,
      }
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Ambiguous rewind"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("answer must remain"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => !frame.includes("claude-tree"))
    setup.mockInput.pressKey(" ", { ctrl: true })

    const graph = await waitForFrame(
      setup,
      (frame) => frame.includes("answer must remain") && frame.includes("Draft"),
    )
    expect(graph.indexOf("answer must remain")).toBeLessThan(graph.indexOf("Draft"))
  } finally {
    await app.stop()
    await running
  }
})

test("shows About from both navigator views and uses the same modal language as kill", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)

  const sessions: AgentSession[] = [
    { id: "about-session", title: "Primary conversation", lastModified: 2 },
    { id: "other-session", title: "Other conversation", lastModified: 1 },
  ]
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      return sessions
    },
    async readTranscripts(sessionIds) {
      return new Map(sessionIds.map((sessionId) => [sessionId, [
        {
          id: `${sessionId}-message`,
          role: "user" as const,
          preview: `${sessionId} question`,
          ordinal: 0,
          visible: true,
        },
      ]]))
    },
    async prepareNewSession() {
      throw new Error("not used")
    },
    async prepareResume() {
      throw new Error("not used")
    },
  }
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    const roots = await waitForFrame(setup, (frame) => frame.includes("Primary conversation"))
    expect(roots).not.toContain("All branches share this working tree.")
    expect(roots).not.toContain("Refreshed")

    setup.mockInput.pressKey("?", { ctrl: true })
    await Bun.sleep(10)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("Settings")

    setup.mockInput.pressKey("?", { shift: true })
    const about = await waitForFrame(
      setup,
      (frame) =>
        frame.includes("Settings") &&
        frame.includes("About") &&
        frame.includes("claude-tree") &&
        frame.includes(`Version ${PROGRAM_VERSION}`) &&
        frame.includes("Note: Branches are not isolated.") &&
        frame.includes("can modify the same files."),
    )
    expect(about).not.toContain("┌")
    expect(setup.captureSpans().lines[0]?.spans[0]?.bg.equals(theme.background)).toBeFalse()
    expect(
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .some((span) => span.text.includes("About") && span.bg.equals(theme.selected)),
    ).toBeTrue()

    const modifiedInfoKeys = [
      () => setup.mockInput.pressKey("q", { ctrl: true }),
      () => setup.mockInput.pressEscape({ shift: true }),
      () => setup.mockInput.pressEnter({ meta: true }),
      () => setup.mockInput.pressKey("?", { ctrl: true }),
      () => setup.mockInput.pressKey("c", { ctrl: true, shift: true }),
    ]
    for (const press of modifiedInfoKeys) {
      press()
      await Bun.sleep(10)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("Settings")
      expect(setup.renderer.isDestroyed).toBeFalse()
    }

    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEscape()
    const closed = await waitForFrame(setup, (frame) => !frame.includes("Settings"))
    expect(closed.split("\n")[23]?.trim()).toBe("Primary conversation")

    const aboutAction = coordinateOf(closed, "? about")
    await setup.mockMouse.click(aboutAction.x, aboutAction.y)
    await waitForFrame(setup, (frame) => frame.includes("Settings") && frame.includes("About"))
    setup.mockInput.pressKey("?")
    await waitForFrame(setup, (frame) => !frame.includes("Settings"))

    setup.mockInput.pressEnter()
    const graph = await waitForFrame(setup, (frame) => frame.includes("Message graph"))
    expect(graph).toContain("? about")
    setup.mockInput.pressKey("?")
    await waitForFrame(setup, (frame) => frame.includes("Settings") && frame.includes("About"))
    await setup.mockMouse.click(0, 0)
    await waitForFrame(setup, (frame) => frame.includes("Message graph") && !frame.includes("Settings"))

    setup.mockInput.pressKey("x")
    const error = await waitForFrame(
      setup,
      (frame) => frame.includes("Error") && frame.includes("Select a live Draft or Agent to kill"),
    )
    expect(error).toContain("esc close")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => !frame.includes("Select a live Draft or Agent to kill"))
  } finally {
    await app.stop()
    await running
  }
})

test("restarts an active refresh and ignores its late result", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)

  let resolveStale!: (sessions: AgentSession[]) => void
  const staleRefresh = new Promise<AgentSession[]>((resolve) => {
    resolveStale = resolve
  })
  let listCalls = 0
  const provider = testProvider(project, process.execPath, () => {
    listCalls += 1
    if (listCalls === 1) {
      return Promise.resolve([{ id: "initial", title: "Initial", lastModified: 1 }])
    }
    if (listCalls === 2) return staleRefresh
    return Promise.resolve([{ id: "newest", title: "Newest", lastModified: 3 }])
  })
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Initial"))
    setup.mockInput.pressKey("r")
    const firstSpinner = await waitForFrame(setup, refreshSpinnerVisible)
    const firstFrame = ["|", "/", "-", "\\"].find((spinner) =>
      firstSpinner.includes(`${spinner} refresh`),
    )!
    await waitForFrame(
      setup,
      (frame) =>
        refreshSpinnerVisible(frame) && !frame.includes(`${firstFrame} refresh`),
    )

    setup.mockInput.pressKey("r")
    const newest = await waitForFrame(
      setup,
      (frame) => listCalls === 3 && frame.includes("Newest") && frame.includes("r refresh"),
    )
    expect(newest).not.toContain("Initial")

    resolveStale([{ id: "stale", title: "Stale", lastModified: 2 }])
    await Bun.sleep(20)
    await setup.renderOnce()
    const settled = setup.captureCharFrame()
    expect(settled).toContain("Newest")
    expect(settled).not.toContain("Stale")
  } finally {
    resolveStale([])
    await app.stop()
    await running
  }
})

test("coalesces transcript intents when an incremental refresh is restarted", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const firstSession: AgentSession = { id: "refresh-first", title: "First", lastModified: 2 }
  const secondSession: AgentSession = { id: "refresh-second", title: "Second", lastModified: 1 }
  const sessions = [firstSession, secondSession]
  let resolveInterrupted!: (sessions: AgentSession[]) => void
  const interrupted = new Promise<AgentSession[]>((resolve) => {
    resolveInterrupted = resolve
  })
  let listCalls = 0
  const transcriptReads: string[][] = []
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      listCalls += 1
      return listCalls === 2 ? interrupted : sessions
    },
    async readTranscripts(sessionIds) {
      transcriptReads.push([...sessionIds])
      return new Map(sessionIds.map((sessionId) => [sessionId, [{
        id: `${sessionId}-message`,
        role: "user" as const,
        preview: `${sessionId} prompt`,
        ordinal: 0,
        visible: true,
      }]]))
    },
    async prepareNewSession() { throw new Error("not used") },
    async prepareResume() { throw new Error("not used") },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("First") && frame.includes("Second"))
    transcriptReads.length = 0
    const requestRefresh = (
      app as unknown as {
        requestRefresh(
          focusSessionId: string | undefined,
          showWarnings: boolean,
          transcriptSessionIds: ReadonlySet<string>,
        ): Promise<void>
      }
    ).requestRefresh.bind(app)
    const firstRefresh = requestRefresh(undefined, false, new Set([firstSession.id]))
    await waitUntil(() => listCalls === 2)
    await requestRefresh(undefined, false, new Set([secondSession.id]))

    expect(transcriptReads.at(-1)?.sort()).toEqual([firstSession.id, secondSession.id].sort())
    resolveInterrupted(sessions)
    await firstRefresh
  } finally {
    resolveInterrupted(sessions)
    await app.stop()
    await running
  }
})

test("preserves return-to-graph focus when that refresh is restarted", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const executable = join(root, "agent")
  await writeFile(executable, "#!/bin/sh\nsleep 30\n")
  await chmod(executable, 0o755)

  const session: AgentSession = { id: "focus-session", title: "Focused", lastModified: 1 }
  let resolveInterrupted!: (sessions: AgentSession[]) => void
  const interruptedRefresh = new Promise<AgentSession[]>((resolve) => {
    resolveInterrupted = resolve
  })
  let listCalls = 0
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      listCalls += 1
      return listCalls === 2 ? interruptedRefresh : [session]
    },
    async readTranscripts(sessionIds) {
      const transcript: AgentMessage[] = [
        {
          id: "focus-message",
          role: "user",
          preview: "focus question",
          ordinal: 0,
          visible: true,
        },
      ]
      return new Map(sessionIds.map((sessionId) => [sessionId, transcript]))
    },
    async prepareNewSession() {
      throw new Error("not used")
    },
    async prepareResume(resumed) {
      return {
        sessionId: resumed.id,
        command: [executable],
        cwd: project,
        observer: new NullTerminalObserver(),
      }
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Focused"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("focus question"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => !frame.includes("claude-tree"))
    setup.mockInput.pressKey(" ", { ctrl: true })
    const returning = await waitForFrame(
      setup,
      (frame) =>
        listCalls === 2 && frame.includes("Message graph") && frame.includes("focus question"),
    )
    expect(returning).not.toContain("Conversation roots")

    setup.mockInput.pressKey("r")
    const graph = await waitForFrame(
      setup,
      (frame) => listCalls === 3 && frame.includes("Message graph") && frame.includes("focus question"),
    )
    expect(graph).not.toContain("Conversation roots")
  } finally {
    resolveInterrupted([])
    await app.stop()
    await running
  }
})

test("restores a semantic graph selection across app instances", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const sessionId = "restored-graph-session"
  const messages: AgentMessage[] = [
    { id: "first-message", role: "user", preview: "restored first", ordinal: 0, visible: true },
    { id: "last-message", role: "agent", preview: "restored last", ordinal: 1, visible: true },
  ]
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      return [{ id: sessionId, title: "Restored graph", lastModified: 1 }]
    },
    async readTranscripts() {
      return new Map([[sessionId, messages]])
    },
    async prepareNewSession() { throw new Error("not used") },
    async prepareResume() { throw new Error("not used") },
  }

  const firstSetup = await createTestRenderer({ width: 80, height: 24 })
  const firstApp = await AgentTreeApp.create(firstSetup.renderer, project, provider, state)
  const firstRun = firstApp.run()
  try {
    await waitForFrame(firstSetup, (frame) => frame.includes("Restored graph"))
    firstSetup.mockInput.pressEnter()
    await waitForFrame(firstSetup, (frame) => frame.includes("restored first"))
    firstSetup.mockInput.pressKey("g", { shift: true })
    await waitForFrame(firstSetup, () => isSelected(firstSetup, "restored last"))
  } finally {
    await firstApp.stop()
    await firstRun
  }

  const secondSetup = await createTestRenderer({ width: 80, height: 24 })
  const secondApp = await AgentTreeApp.create(secondSetup.renderer, project, provider, state)
  const secondRun = secondApp.run()
  try {
    const restored = await waitForFrame(
      secondSetup,
      (frame) => frame.includes("Message graph") && isSelected(secondSetup, "restored last"),
    )
    expect(restored).not.toContain("Conversation roots")
  } finally {
    await secondApp.stop()
    await secondRun
  }
})

test("resumes a persisted terminal view on startup", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  await mkdir(project)
  const executable = join(root, "agent")
  await writeFile(executable, '#!/bin/sh\nprintf "RESTORED_TERMINAL\\r\\n"\nsleep 30\n')
  await chmod(executable, 0o755)
  const sessionId = "restored-terminal-session"
  const metadata = await BranchMetadataStore.openForProvider(project, "test-agent", state)
  await metadata.saveNavigationState({ view: "terminal", sessionId })
  const resumed: string[] = []
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() {
      return [{ id: sessionId, title: "Restored terminal", lastModified: 1 }]
    },
    async readTranscripts() {
      return new Map([
        [sessionId, [{ id: "message", role: "user", preview: "prompt", ordinal: 0, visible: true }]],
      ])
    },
    async prepareNewSession() { throw new Error("not used") },
    async prepareResume(session) {
      resumed.push(session.id)
      return {
        sessionId: session.id,
        command: [executable],
        cwd: project,
        observer: new NullTerminalObserver(),
      }
    },
  }
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("RESTORED_TERMINAL"))
    expect(resumed).toEqual([sessionId])
  } finally {
    await app.stop()
    await running
  }
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "claude-tree-app-test-"))
  temporaryDirectories.push(path)
  return path
}

function appTransitionSource(): {
  source: TerminalSessionTransitionSource
  emit(transition: TerminalSessionTransition): void
} {
  let listener: ((transition: TerminalSessionTransition) => void) | undefined
  return {
    source: {
      subscribe(onTransition) {
        listener = onTransition
        return () => { listener = undefined }
      },
    },
    emit(transition) {
      listener?.(transition)
    },
  }
}

function sessionMessage(
  sessionId: string,
  uuid: string,
  type: SessionMessage["type"],
  text: string,
  model?: string,
  stopReason?: string | null,
): SessionMessage {
  return {
    type,
    uuid,
    session_id: sessionId,
    message: {
      ...(model === undefined ? {} : { model }),
      ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    parent_agent_id: null,
  }
}

function testUuid(value: number): string {
  const suffix = value.toString().padStart(12, "0")
  return `00000000-0000-4000-8000-${suffix}`
}

function coordinateOf(frame: string, text: string): { x: number; y: number } {
  const lines = frame.split("\n")
  for (const [y, line] of lines.entries()) {
    const index = line.indexOf(text)
    if (index >= 0) return { x: displayWidth(line.slice(0, index)), y }
  }
  throw new Error(`Missing text in frame: ${text}\n${frame}`)
}

function isSelected(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  text: string,
): boolean {
  return setup
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .some((span) => span.text.includes(text) && span.bg.equals(theme.selected))
}

async function waitForFrame(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  predicate: (frame: string) => boolean,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = performance.now() + timeoutMs
  let frame = ""
  while (performance.now() < deadline) {
    await Bun.sleep(10)
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    if (predicate(frame)) return frame
  }
  throw new Error(`Timed out waiting for frame:\n${frame}`)
}

function testProvider(
  project: string,
  executable: string,
  listSessions: () => Promise<AgentSession[]>,
): AgentProvider {
  return {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    listSessions,
    async readTranscripts(sessionIds) {
      return new Map(sessionIds.map((sessionId) => [sessionId, [
        {
          id: `message-${sessionId}`,
          role: "user",
          preview: "test message",
          ordinal: 0,
          visible: true,
        },
      ]]))
    },
    async prepareNewSession() {
      const id = "new-session"
      return {
        session: { id, title: "New conversation", lastModified: Date.now(), transient: true },
        launch: {
          sessionId: id,
          command: [executable],
          cwd: project,
          observer: new NullTerminalObserver(),
        },
      }
    },
    async prepareResume(session) {
      return {
        sessionId: session.id,
        command: [executable],
        cwd: project,
        observer: new NullTerminalObserver(),
      }
    },
  }
}

async function readProcessIds(path: string): Promise<number[]> {
  let contents = ""
  const deadline = performance.now() + 2_000
  while (performance.now() < deadline) {
    try {
      contents = await readFile(path, "utf8")
      break
    } catch {
      await Bun.sleep(10)
    }
  }
  expect(contents).not.toBe("")
  return contents.trim().split(/\s+/).map(Number)
}

async function readMarker(path: string): Promise<string[]> {
  let contents = ""
  const deadline = performance.now() + 2_000
  while (performance.now() < deadline) {
    try {
      contents = await readFile(path, "utf8")
      break
    } catch {
      await Bun.sleep(10)
    }
  }
  expect(contents).not.toBe("")
  return contents.trim().split("\n")
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await condition()) return
    await Bun.sleep(10)
  }
  expect(await condition()).toBeTrue()
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

function expectNavigatorChrome(frame: string, detail: string): void {
  const lines = frame.trimEnd().split("\n")
  const separator = "─".repeat(80)
  expect(lines).toHaveLength(24)
  expect(lines[0]).toContain("claude-tree")
  expect(lines[2]).toBe(separator)
  expect(lines[21]).toBe(separator)
  expect(lines[23]?.trim()).toBe(detail)
}

function refreshSpinnerVisible(frame: string): boolean {
  return ["|", "/", "-", "\\"].some((spinner) => frame.includes(`${spinner} refresh`))
}
