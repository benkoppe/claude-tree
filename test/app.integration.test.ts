import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTestRenderer } from "@opentui/core/testing"
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk"

import { ClaudeTreeApp } from "../src/app"
import { BRAILLE_SPINNER_FRAMES } from "../src/graph-renderer"
import { SessionService } from "../src/sessions"
import { theme } from "../src/theme"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
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
