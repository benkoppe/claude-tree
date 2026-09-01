import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTestRenderer, MouseButtons } from "@opentui/core/testing"
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk"

import {
  NullTerminalObserver,
  type AgentMessage,
  type AgentProvider,
  type AgentSession,
  type PreparedSession,
} from "../src/agent-provider"
import { AgentTreeApp } from "../src/app"
import { displayWidth } from "../src/display-text"
import { BRAILLE_SPINNER_FRAMES } from "../src/graph-renderer"
import { BranchMetadataStore } from "../src/metadata"
import { PROGRAM_VERSION } from "../src/program"
import { ClaudeProvider } from "../src/providers/claude"
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
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("No conversations"))
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
  const provider: AgentProvider = {
    id: "test-agent",
    displayName: "Test Agent",
    navigatorIdentity: { label: "Agent", color: theme.secondary },
    async listSessions() { return [] },
    async readTranscripts() { return new Map() },
    async prepareNewSession() {
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
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("No conversations"))
    setup.mockInput.pressKey("n")
    await waitForFrame(setup, (frame) => frame.includes("NEW_SESSION_ACTIVE"))
    resolveStarted({ id: "real-session", title: "Real conversation", lastModified: 2, transient: true })
    await Bun.sleep(10)

    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(setup, (frame) => frame.includes("Message graph"))
    setup.mockInput.pressKey("q")
    const roots = await waitForFrame(setup, (frame) => frame.includes("Real conversation"))
    expect(roots).not.toContain("Pending conversation")
  } finally {
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
    const busyFrame = await waitForFrame(
      setup,
      (frame) => refreshSpinnerVisible(frame) && frame.includes("q quit"),
    )

    const startedAt = performance.now()
    const quitAction = coordinateOf(busyFrame, "q quit")
    await setup.mockMouse.click(quitAction.x, quitAction.y)
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
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Root 1"))
    expect(isSelected(setup, "Root 1")).toBeTrue()

    setup.mockInput.pressKey("n", { ctrl: true })
    await waitForFrame(setup, () => isSelected(setup, "Root 2"))

    setup.mockInput.pressKey("p", { ctrl: true })
    const frame = await waitForFrame(setup, () => isSelected(setup, "Root 1"))
    expect(frame).toContain("Conversation roots")
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

  const rootSessionId = "11111111-1111-4111-8111-111111111111"
  const childSessionId = "22222222-2222-4222-8222-222222222222"
  const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
  const copiedSourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"
  const rootTranscript = [sessionMessage(rootSessionId, sourceId, "user", "branch source")]
  const childTranscript = [
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
  const app = await AgentTreeApp.create(setup.renderer, project, provider, state)
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Root leaf"))
    setup.mockInput.pressEnter()
    await waitForFrame(
      setup,
      (frame) => frame.includes("Message graph") && frame.includes("branch source"),
    )
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

    setup.mockInput.pressKey(" ", { ctrl: true })
    await waitForFrame(
      setup,
      (candidate) => candidate.includes("Message graph") && candidate.includes("branch answer"),
    )
    setup.mockInput.pressArrow("up")
    await waitForFrame(setup, () => isSelected(setup, "branch answer"))
    setup.mockInput.pressArrow("up")
    await waitForFrame(setup, () => isSelected(setup, "branch source"))
    setup.mockInput.pressEnter()
    frame = await waitForFrame(
      setup,
      (candidate) => candidate.includes("Open leaf") && candidate.includes("• Child leaf"),
    )
    expect(frame).not.toContain("●")
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
  const agentMessage = sessionMessage(
    sessionId,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    "assistant",
    "completed answer",
  )
  let transcript = [userMessage]
  const provider = new ClaudeProvider(project, fakeClaude, {
    async list(): Promise<SDKSessionInfo[]> {
      return [
        {
          sessionId,
          summary: "Live conversation",
          firstPrompt: "question",
          lastModified: Date.now(),
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
  const app = await AgentTreeApp.create(
    setup.renderer,
    project,
    provider,
    state,
  )
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Live conversation"))
    setup.mockInput.pressEnter()
    await waitForFrame(setup, (frame) => frame.includes("question") && frame.includes("Message graph"))
    setup.mockInput.pressEnter()
    await Bun.sleep(50)
    setup.mockInput.pressKey(" ", { ctrl: true })

    const generating = await waitForFrame(
      setup,
      (frame) =>
        frame.includes("Agent") && BRAILLE_SPINNER_FRAMES.some((spinner) => frame.includes(spinner)),
    )
    expect(generating).not.toContain("completed answer")
    expect(generating).not.toContain("Draft")

    transcript = [userMessage, agentMessage]
    await writeFile(finishMarker, "")
    const completed = await waitForFrame(
      setup,
      (frame) => {
        if (frame.includes("Draft") && !frame.includes("completed answer")) {
          throw new Error(`Rendered Draft before committing the agent message:\n${frame}`)
        }
        return (
          frame.includes("completed answer") &&
          frame.includes("Draft") &&
          BRAILLE_SPINNER_FRAMES.every((spinner) => !frame.includes(spinner))
        )
      },
    )
    expect(completed.indexOf("completed answer")).toBeLessThan(completed.indexOf("Draft"))
    const selectedDraft = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("Draft") && span.bg.equals(theme.selected))
    expect(selectedDraft).toBeDefined()

    setup.mockInput.pressKey("q")
    const roots = await waitForFrame(
      setup,
      (frame) => frame.includes("Conversation roots") && frame.includes("● Live · Live conversation"),
    )
    expect(roots).not.toContain("Saved")
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
    await waitForFrame(setup, refreshSpinnerVisible)

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

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "claude-tree-app-test-"))
  temporaryDirectories.push(path)
  return path
}

function sessionMessage(
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
