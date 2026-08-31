import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTestRenderer } from "@opentui/core/testing"

import { observeClaudeDraft, TerminalManager } from "../src/terminal-manager"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test("terminal ownership closes permanently when shutdown starts", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const manager = new TerminalManager(
    setup.renderer,
    process.cwd(),
    process.execPath,
    () => undefined,
  )

  try {
    const startedAt = performance.now()
    await manager.shutdown()
    expect(performance.now() - startedAt).toBeLessThan(250)
    await expect(
      manager.show({
        kind: "new",
        sessionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toThrow("shutting down")
  } finally {
    setup.renderer.destroy()
  }
})

test("passes a prefill only when spawning a Claude process", async () => {
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
  const manager = new TerminalManager(setup.renderer, process.cwd(), executable, () => undefined)
  const sessionId = "11111111-1111-4111-8111-111111111111"

  try {
    await manager.show({ kind: "resume", sessionId, prefillText: "draft prompt" })
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
    await manager.show({ kind: "resume", sessionId, prefillText: "replacement" })
    expect((await readFile(argumentsPath, "utf8")).trim()).not.toContain("replacement")
  } finally {
    await manager.shutdown(50)
    setup.renderer.destroy()
  }
})

test("observes only a cursor-local Claude composer bounded by its rule", () => {
  expect(
    observeClaudeDraft({
      text: "",
      lines: ["old output", "────────────────", "❯ first line", "  second line", "────────────────", "status"],
      columns: 40,
      rows: 6,
      cursor: { x: 8, y: 3, visible: true },
    }),
  ).toBe("first line\n  second line")
  expect(
    observeClaudeDraft({
      text: "",
      lines: ["❯ transcript text", "not a composer"],
      columns: 40,
      rows: 2,
      cursor: { x: 5, y: 0, visible: true },
    }),
  ).toBeUndefined()
  expect(
    observeClaudeDraft({
      text: "",
      lines: ["❯ hidden cursor", "────────────────"],
      columns: 40,
      rows: 2,
      cursor: { x: 5, y: 0, visible: false },
    }),
  ).toBeUndefined()
})

test("an exited hidden process releases its emulator", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const manager = new TerminalManager(
    setup.renderer,
    process.cwd(),
    process.execPath,
    () => undefined,
  )

  try {
    await manager.show({
      kind: "new",
      sessionId: "11111111-1111-4111-8111-111111111111",
    })
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
  const manager = new TerminalManager(
    setup.renderer,
    process.cwd(),
    process.execPath,
    resolveExit,
  )

  try {
    const sessionId = "11111111-1111-4111-8111-111111111111"
    await manager.show({ kind: "new", sessionId })
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
  const manager = new TerminalManager(
    setup.renderer,
    process.cwd(),
    fakeClaude,
    () => undefined,
  )

  try {
    await manager.show({
      kind: "new",
      sessionId: "11111111-1111-4111-8111-111111111111",
    })
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
  const manager = new TerminalManager(
    setup.renderer,
    process.cwd(),
    fakeClaude,
    () => undefined,
  )

  try {
    await manager.show({
      kind: "new",
      sessionId: "11111111-1111-4111-8111-111111111111",
    })
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
  const manager = new TerminalManager(
    setup.renderer,
    process.cwd(),
    fakeClaude,
    () => undefined,
  )

  try {
    await manager.show({
      kind: "new",
      sessionId: "11111111-1111-4111-8111-111111111111",
    })
    await manager.show({
      kind: "new",
      sessionId: "22222222-2222-4222-8222-222222222222",
    })
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
  const manager = new TerminalManager(
    setup.renderer,
    process.cwd(),
    fakeClaude,
    () => undefined,
  )

  try {
    await manager.show({
      kind: "new",
      sessionId: "11111111-1111-4111-8111-111111111111",
    })
    await manager.show({
      kind: "new",
      sessionId: "22222222-2222-4222-8222-222222222222",
    })
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
