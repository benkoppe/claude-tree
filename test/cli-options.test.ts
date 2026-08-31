import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseCliArguments, resolveProjectDirectory } from "../src/cli-options"

describe("CLI options", () => {
  test("uses Claude and the current directory by default", () => {
    expect(parseCliArguments([])).toEqual({ command: "run", provider: "claude", project: "." })
  })

  test("selects Codex without treating the project as a prompt", () => {
    expect(parseCliArguments(["--codex", "."])).toEqual({
      command: "run",
      provider: "codex",
      project: ".",
    })
    expect(parseCliArguments(["project", "--codex"])).toEqual({
      command: "run",
      provider: "codex",
      project: "project",
    })
  })

  test("rejects unknown options and multiple project paths", () => {
    expect(() => parseCliArguments(["--claude"])).toThrow("Unknown argument: --claude")
    expect(() => parseCliArguments(["one", "two"])).toThrow("Unexpected project path: two")
  })

  test("canonicalizes a project directory and rejects files", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-tree-cli-test-"))
    try {
      await mkdir(join(root, "project"))
      await symlink(join(root, "project"), join(root, "linked-project"))
      await writeFile(join(root, "file"), "not a project")

      expect(await resolveProjectDirectory("linked-project", root)).toBe(join(root, "project"))
      await expect(resolveProjectDirectory("file", root)).rejects.toThrow(
        "Project path is not a directory: file",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
