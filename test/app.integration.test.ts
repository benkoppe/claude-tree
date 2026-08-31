import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTestRenderer, MouseButtons } from "@opentui/core/testing"
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk"

import { ClaudeTreeApp } from "../src/app"
import { displayWidth } from "../src/display-text"
import { BRAILLE_SPINNER_FRAMES } from "../src/graph-renderer"
import { SessionService } from "../src/sessions"
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
    sessionMessage(
      sessionId,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "user",
      "question",
    ),
  ]
  const sessionService = new SessionService(project, {
    async list(): Promise<SDKSessionInfo[]> {
      return [
        {
          sessionId,
          summary: "Layout conversation",
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
  const app = await ClaudeTreeApp.create(
    setup.renderer,
    project,
    join(root, "unused-claude"),
    undefined,
    state,
    sessionService,
  )
  const running = app.run()

  try {
    const roots = await waitForFrame(setup, (frame) => frame.includes("Layout conversation"))
    expectNavigatorChrome(roots, "Refreshed")

    setup.mockInput.pressEnter()
    const graph = await waitForFrame(
      setup,
      (frame) => frame.includes("Message graph") && frame.includes("question"),
    )
    expectNavigatorChrome(graph, "Graph ready")
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
  const app = await ClaudeTreeApp.create(setup.renderer, project, fakeClaude, undefined, state)
  const running = app.run()

  try {
    await setup.renderOnce()
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
      if (frame.includes("Claude session exited")) break
    }
    expect(showedTerminal).toBeTrue()
    expect(frame).toContain("claude-tree")
    expect(frame).toContain("Claude session exited")

    setup.mockInput.pressKey("q")
    await running
  } finally {
    await app.stop()
  }
})

test("quit closes the UI immediately while live sessions finish shutting down", async () => {
  const root = await temporaryDirectory()
  const project = join(root, "project")
  const state = join(root, "state")
  const processMarker = join(root, "processes")
  await mkdir(project)
  const fakeClaude = join(root, "claude")
  await writeFile(
    fakeClaude,
    `#!/bin/sh
trap '' HUP TERM
sleep 30 &
child=$!
printf '%s %s\n' "$$" "$child" > ${JSON.stringify(processMarker)}
wait "$child"
`,
  )
  await chmod(fakeClaude, 0o755)

  let listCalls = 0
  let finishRefresh!: (sessions: SDKSessionInfo[]) => void
  const blockedRefresh = new Promise<SDKSessionInfo[]>((resolve) => {
    finishRefresh = resolve
  })
  const sessionService = new SessionService(project, {
    async list(): Promise<SDKSessionInfo[]> {
      listCalls += 1
      return listCalls === 1 ? [] : blockedRefresh
    },
    async messages(): Promise<SessionMessage[]> {
      return []
    },
    async fork(): Promise<{ sessionId: string }> {
      throw new Error("not used")
    },
  })
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await ClaudeTreeApp.create(
    setup.renderer,
    project,
    fakeClaude,
    undefined,
    state,
    sessionService,
  )
  const running = app.run()

  try {
    await setup.renderOnce()
    setup.mockInput.pressKey("n")
    const processIds = await readProcessIds(processMarker)
    setup.mockInput.pressKey(" ", { ctrl: true })
    const busyFrame = await waitForFrame(
      setup,
      (frame) => frame.includes("Working") && frame.includes("q quit"),
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

  let finishRefresh!: (sessions: SDKSessionInfo[]) => void
  const blockedRefresh = new Promise<SDKSessionInfo[]>((resolve) => {
    finishRefresh = resolve
  })
  const sessionService = new SessionService(project, {
    async list(): Promise<SDKSessionInfo[]> {
      return blockedRefresh
    },
    async messages(): Promise<SessionMessage[]> {
      return []
    },
    async fork(): Promise<{ sessionId: string }> {
      throw new Error("not used")
    },
  })
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const app = await ClaudeTreeApp.create(
    setup.renderer,
    project,
    process.execPath,
    undefined,
    state,
    sessionService,
  )
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
  const sessionService = new SessionService(project, {
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
  const setup = await createTestRenderer({ width: 100, height: 16 })
  const app = await ClaudeTreeApp.create(
    setup.renderer,
    project,
    fakeClaude,
    undefined,
    state,
    sessionService,
  )
  const running = app.run()

  try {
    await waitForFrame(setup, (frame) => frame.includes("Root 1"))
    const rootList = coordinateOf(setup.captureCharFrame(), "Root 1")
    for (let index = 0; index < 8; index += 1) {
      await setup.mockMouse.scroll(rootList.x, rootList.y, "down")
      await setup.renderOnce()
    }
    let frame = setup.captureCharFrame()
    expect(frame).not.toContain("Root 1")
    expect(isSelected(setup, "Root 9")).toBeTrue()

    const rootEight = coordinateOf(frame, "Root 8")
    const rootNine = coordinateOf(frame, "Root 9")
    await setup.mockMouse.drag(rootNine.x, rootNine.y, rootEight.x, rootEight.y)
    await setup.renderOnce()
    expect(isSelected(setup, "Root 9")).toBeTrue()

    await setup.mockMouse.click(rootEight.x, rootEight.y, MouseButtons.RIGHT)
    await setup.renderOnce()
    expect(isSelected(setup, "Root 9")).toBeTrue()

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
    const assistant = coordinateOf(frame, "Assistant")
    await setup.mockMouse.click(assistant.x, assistant.y)
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(isSelected(setup, "Assistant")).toBeTrue()
    expect(coordinateOf(frame, "Assistant")).toEqual(assistant)

    await setup.mockMouse.click(assistant.x, assistant.y)
    await waitForFrame(setup, (candidate) => !candidate.includes("claude-tree"))
    setup.mockInput.pressKey(" ", { ctrl: true })
    frame = await waitForFrame(setup, (candidate) => candidate.includes("Message graph"))

    const rootsAction = coordinateOf(frame, "q roots")
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
      (candidate) => listCalls > callsBeforeRefresh && candidate.includes("Refreshed"),
    )
  } finally {
    await app.stop()
    await running
  }
})

test("replaces a completed assistant spinner with a message and new draft leaf", async () => {
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
  const assistantMessage = sessionMessage(
    sessionId,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    "assistant",
    "completed answer",
  )
  let transcript = [userMessage]
  const sessionService = new SessionService(project, {
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
  const app = await ClaudeTreeApp.create(
    setup.renderer,
    project,
    fakeClaude,
    undefined,
    state,
    sessionService,
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
        frame.includes("Assistant") && BRAILLE_SPINNER_FRAMES.some((spinner) => frame.includes(spinner)),
    )
    expect(generating).not.toContain("completed answer")
    expect(generating).not.toContain("Draft")

    transcript = [userMessage, assistantMessage]
    await writeFile(finishMarker, "")
    const completed = await waitForFrame(
      setup,
      (frame) => {
        if (frame.includes("Draft") && !frame.includes("completed answer")) {
          throw new Error(`Rendered Draft before committing the assistant message:\n${frame}`)
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

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!condition() && performance.now() < deadline) await Bun.sleep(10)
  expect(condition()).toBeTrue()
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

function expectNavigatorChrome(frame: string, status: string): void {
  const lines = frame.trimEnd().split("\n")
  const separator = "─".repeat(80)
  expect(lines).toHaveLength(24)
  expect(lines[0]).toContain("claude-tree")
  expect(lines[2]).toBe(separator)
  expect(lines[20]).toBe(separator)
  expect(lines[23]?.trim()).toBe(status)
}
