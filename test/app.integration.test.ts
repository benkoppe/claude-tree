import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTestRenderer, MouseButtons } from "@opentui/core/testing"
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk"

import { NullTerminalObserver, type AgentProvider, type AgentSession } from "../src/agent-provider"
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
    async listSessions() {
      return []
    },
    async readTranscript() {
      return []
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
    setup.mockInput.pressEnter()
    await waitUntil(() => Bun.file(inputMarker).exists())
    expect(await readFile(inputMarker, "utf8")).toBe("x?")
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
  const setup = await createTestRenderer({ width: 80, height: 24 })
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
    await waitForFrame(setup, (frame) => frame.includes("Message graph") && frame.includes("first"))
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
    setup.mockInput.pressEnter()
    let frame = await waitForFrame(
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
    async listSessions() {
      return sessions
    },
    async readTranscript(sessionId) {
      return [
        {
          id: `${sessionId}-message`,
          role: "user",
          preview: `${sessionId} question`,
          ordinal: 0,
          visible: true,
        },
      ]
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
    const roots = await waitForFrame(setup, (frame) => frame.includes("Primary conversation"))
    expect(roots).not.toContain("All branches share this working tree.")
    expect(roots).not.toContain("Refreshed")

    setup.mockInput.pressKey("?")
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
    async listSessions() {
      listCalls += 1
      return listCalls === 2 ? interruptedRefresh : [session]
    },
    async readTranscript() {
      return [
        {
          id: "focus-message",
          role: "user",
          preview: "focus question",
          ordinal: 0,
          visible: true,
        },
      ]
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
): SessionMessage {
  return {
    type,
    uuid,
    session_id: sessionId,
    message: { content: [{ type: "text", text }] },
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
    listSessions,
    async readTranscript() {
      return []
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
