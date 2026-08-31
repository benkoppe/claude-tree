import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTestRenderer } from "@opentui/core/testing"

import type { TerminalLaunch } from "../src/agent-provider"
import { ClaudeTerminalObserver } from "../src/providers/claude-terminal-observer"
import {
  TerminalManager,
} from "../src/terminal-manager"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test("terminal ownership closes permanently when shutdown starts", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const manager = new TerminalManager(setup.renderer, () => undefined)

  try {
    const startedAt = performance.now()
    await manager.shutdown()
    expect(performance.now() - startedAt).toBeLessThan(250)
    await expect(
      manager.show(launch(process.execPath, "11111111-1111-4111-8111-111111111111")),
    ).rejects.toThrow("shutting down")
  } finally {
    setup.renderer.destroy()
  }
})

test("shutdown releases emulators immediately and terminates the owned process group", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const directory = await mkdtemp(join(tmpdir(), "claude-tree-shutdown-test-"))
  temporaryDirectories.push(directory)
  const processMarker = join(directory, "processes")
  const executable = await createFakeClaude(
    `trap 'exit 0' HUP TERM
    (trap '' HUP TERM; sleep 30) &
    child=$!
    printf '%s %s\n' "$$" "$child" > ${JSON.stringify(processMarker)}
    wait "$child"`,
  )
  const manager = new TerminalManager(setup.renderer, () => undefined)

  try {
    await manager.show(launch(executable, "11111111-1111-4111-8111-111111111111"))
    const processIds = await readProcessIds(processMarker)

    const startedAt = performance.now()
    const shutdown = manager.shutdown(75)
    expect(manager.shutdown()).toBe(shutdown)
    expect(setup.renderer.root.getChildrenCount()).toBe(0)

    await shutdown
    expect(performance.now() - startedAt).toBeLessThan(750)
    await waitUntil(() => processIds.every((processId) => !isProcessAlive(processId)))
  } finally {
    await manager.shutdown(0)
    setup.renderer.destroy()
  }
})

test("shutdown keeps the PTY open for graceful process cleanup", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const directory = await mkdtemp(join(tmpdir(), "claude-tree-graceful-shutdown-test-"))
  temporaryDirectories.push(directory)
  const readyMarker = join(directory, "ready")
  const resultMarker = join(directory, "result")
  const executable = await createFakeClaude(
    `trap 'sleep 0.05; printf term > ${JSON.stringify(resultMarker)}; exit 0' TERM
    trap 'printf hup > ${JSON.stringify(resultMarker)}; exit 1' HUP
    printf '%s\n' "$$" > ${JSON.stringify(readyMarker)}
    while :; do sleep 30 & wait "$!"; done`,
  )
  const manager = new TerminalManager(setup.renderer, () => undefined)

  try {
    await manager.show(launch(executable, "11111111-1111-4111-8111-111111111111"))
    await readProcessIds(readyMarker)

    await manager.shutdown(200)
    expect((await readFile(resultMarker, "utf8")).trim()).toBe("term")
  } finally {
    await manager.shutdown(0)
    setup.renderer.destroy()
  }
})

test("uses launch arguments and initial draft only when spawning a process", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const directory = await mkdtemp(join(tmpdir(), "claude-tree-prefill-test-"))
  temporaryDirectories.push(directory)
  const executable = join(directory, "claude")
  const argumentsPath = join(directory, "arguments")
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argumentsPath}"\nsleep 30\n`,
  )
  await chmod(executable, 0o755)
  const manager = new TerminalManager(setup.renderer, () => undefined)
  const sessionId = "11111111-1111-4111-8111-111111111111"

  try {
    await manager.show(launch(executable, sessionId, ["--resume", sessionId, "--prefill=draft prompt"], "draft prompt"))
    await Bun.sleep(30)
    expect((await readFile(argumentsPath, "utf8")).trim().split("\n")).toEqual([
      "--resume",
      sessionId,
      "--prefill=draft prompt",
    ])
    expect(manager.draftPreviews().get(sessionId)).toEqual({
      text: "draft prompt",
      exact: true,
    })

    manager.hideActive()
    expect(manager.draftPreviews().get(sessionId)?.exact).toBeTrue()
    await manager.show(launch(executable, sessionId, ["--resume", sessionId, "--prefill=replacement"], "replacement"))
    expect((await readFile(argumentsPath, "utf8")).trim()).not.toContain("replacement")
  } finally {
    await manager.shutdown(50)
    setup.renderer.destroy()
  }
})

test("tracks OSC activity transitions from a hidden process", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const fakeClaude = await createFakeClaude(
    String.raw`sleep 0.05
    printf '\033]0;\342\240\213 Claude Code\007'
    sleep 0.15
    printf '\033]0;\342\234\263 Claude Code\007'
    sleep 30`,
  )
  const activityChanges: Array<{ sessionId: string; activity: "working" | "idle" }> = []
  const manager = new TerminalManager(
    setup.renderer,
    () => undefined,
    (event) => activityChanges.push(event),
  )
  const sessionId = "11111111-1111-4111-8111-111111111111"

  try {
    await manager.show(launch(fakeClaude, sessionId))
    manager.hideActive()
    await waitUntil(() => manager.workingSessionIds().has(sessionId))
    await waitUntil(() => !manager.workingSessionIds().has(sessionId))
    expect(activityChanges).toEqual([
      { sessionId, activity: "working" },
      { sessionId, activity: "idle" },
    ])
  } finally {
    await manager.shutdown(50)
    setup.renderer.destroy()
  }
})

test("an exited hidden process releases its emulator", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const manager = new TerminalManager(setup.renderer, () => undefined)

  try {
    await manager.show(launch(process.execPath, "11111111-1111-4111-8111-111111111111"))
    manager.hideActive()

    const deadline = performance.now() + 2_000
    while (setup.renderer.root.getChildrenCount() !== 0 && performance.now() < deadline) {
      await Bun.sleep(10)
    }
    expect(setup.renderer.root.getChildrenCount()).toBe(0)
  } finally {
    await manager.shutdown()
    setup.renderer.destroy()
  }
})

test("reports that the visible process exited", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  let resolveExit!: (event: { sessionId: string; exitCode: number; wasActive: boolean }) => void
  const exited = new Promise<{ sessionId: string; exitCode: number; wasActive: boolean }>((resolve) => {
    resolveExit = resolve
  })
  const manager = new TerminalManager(setup.renderer, resolveExit)

  try {
    const sessionId = "11111111-1111-4111-8111-111111111111"
    await manager.show(launch(process.execPath, sessionId))
    expect(await exited).toEqual({ sessionId, exitCode: 1, wasActive: true })
    expect(setup.renderer.root.getChildrenCount()).toBe(0)
  } finally {
    await manager.shutdown()
    setup.renderer.destroy()
  }
})

test("copies embedded-terminal selections through renderer OSC52", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const fakeClaude = await createFakeClaude('printf "copy-this-text\\r\\n"; sleep 30')
  let copiedText: string | undefined
  setup.renderer.copyToClipboardOSC52 = (text) => {
    copiedText = text
    return true
  }
  const manager = new TerminalManager(setup.renderer, () => undefined)

  try {
    await manager.show(launch(fakeClaude, "11111111-1111-4111-8111-111111111111"))
    await Bun.sleep(30)
    await setup.renderOnce()
    await setup.mockMouse.drag(0, 0, 13, 0)
    expect(copiedText).toContain("copy-this-text")
  } finally {
    await manager.shutdown(50)
    setup.renderer.destroy()
  }
})

test("forwards OSC52 writes emitted by the child process", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const fakeClaude = await createFakeClaude(
    `printf '\\033]52;c;aHR0cHM6Ly9leGFtcGxlLmNvbS9sb2dpbg==\\007'`,
  )
  let copiedText: string | undefined
  setup.renderer.copyToClipboardOSC52 = (text) => {
    copiedText = text
    return true
  }
  const manager = new TerminalManager(setup.renderer, () => undefined)

  try {
    await manager.show(launch(fakeClaude, "11111111-1111-4111-8111-111111111111"))
    const deadline = performance.now() + 2_000
    while (copiedText === undefined && performance.now() < deadline) await Bun.sleep(10)
    expect(copiedText).toBe("https://example.com/login")
  } finally {
    await manager.shutdown(50)
    setup.renderer.destroy()
  }
})

test("does not forward OSC52 writes from hidden child processes", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const fakeClaude = await createFakeClaude(
    `case "$2" in
      11111111-*) payload="aGlkZGVu" ;;
      *) payload="YWN0aXZl" ;;
    esac
    sleep 0.05
    printf '\\033]52;c;%s\\007' "$payload"
    sleep 30`,
  )
  const copiedTexts: string[] = []
  setup.renderer.copyToClipboardOSC52 = (text) => {
    copiedTexts.push(text)
    return true
  }
  const manager = new TerminalManager(setup.renderer, () => undefined)

  try {
    await manager.show(launch(fakeClaude, "11111111-1111-4111-8111-111111111111"))
    await manager.show(launch(fakeClaude, "22222222-2222-4222-8222-222222222222"))
    await Bun.sleep(150)
    expect(copiedTexts).toEqual(["active"])
  } finally {
    await manager.shutdown(50)
    setup.renderer.destroy()
  }
})

test("a hidden process exit preserves the active terminal selection", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const fakeClaude = await createFakeClaude(
    `case "$2" in
      11111111-*) sleep 0.1 ;;
      *) printf 'keep-this-selected\\r\\n'; sleep 30 ;;
    esac`,
  )
  setup.renderer.copyToClipboardOSC52 = () => true
  const manager = new TerminalManager(setup.renderer, () => undefined)

  try {
    await manager.show(launch(fakeClaude, "11111111-1111-4111-8111-111111111111"))
    await manager.show(launch(fakeClaude, "22222222-2222-4222-8222-222222222222"))
    await Bun.sleep(30)
    await setup.renderOnce()
    await setup.mockMouse.drag(0, 0, 17, 0)
    expect(setup.renderer.hasSelection).toBeTrue()

    await Bun.sleep(150)
    expect(setup.renderer.hasSelection).toBeTrue()
  } finally {
    await manager.shutdown(50)
    setup.renderer.destroy()
  }
})

async function createFakeClaude(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "claude-tree-fake-claude-"))
  temporaryDirectories.push(directory)
  const executable = join(directory, "claude")
  await writeFile(executable, `#!/bin/sh\n${body}\n`)
  await chmod(executable, 0o755)
  return executable
}

function launch(
  executable: string,
  sessionId: string,
  args: string[] = ["--session-id", sessionId],
  initialDraft?: string,
): TerminalLaunch {
  return {
    sessionId,
    command: [executable, ...args],
    cwd: process.cwd(),
    observer: new ClaudeTerminalObserver(),
    ...(initialDraft === undefined
      ? {}
      : { initialDraft: { text: initialDraft, exact: true } }),
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!condition() && performance.now() < deadline) await Bun.sleep(10)
  expect(condition()).toBeTrue()
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

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}
