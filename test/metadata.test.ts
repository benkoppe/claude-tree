import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { BranchMetadataStore, validateRelations, type BranchRelation } from "../src/metadata"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("BranchMetadataStore", () => {
  test("round-trips project-scoped branch relationships", async () => {
    const root = await temporaryDirectory()
    const project = join(root, "project")
    const state = join(root, "state")
    await mkdir(project)

    const store = await BranchMetadataStore.openForProvider(project, "claude", state)
    const relation = await store.saveRelation({
      childSessionId: "22222222-2222-4222-8222-222222222222",
      parentSessionId: "11111111-1111-4111-8111-111111111111",
      sourceMessageId: "33333333-3333-4333-8333-333333333333",
      sharedMessages: [
        { parentMessageId: "parent-message", childMessageId: "child-message" },
      ],
      createdAt: "2026-08-30T12:00:00.000Z",
    })

    expect(await store.loadRelations()).toEqual([relation])
    expect(store.projectPath).toBe(project)
  })

  test("rejects malformed metadata rather than silently dropping it", async () => {
    const root = await temporaryDirectory()
    const project = join(root, "project")
    const state = join(root, "state")
    await mkdir(project)
    const store = await BranchMetadataStore.openForProvider(project, "claude", state)

    const manifestFiles = await filesRecursively(join(state, "claude-tree", "projects"))
    const manifestPath = manifestFiles.find((path) => path.endsWith("project.json"))
    expect(manifestPath).toBeDefined()
    const branchPath = join(dirname(manifestPath!), "providers", "claude", "branches", "broken.json")
    await writeFile(branchPath, "{}\n")

    expect(store.loadRelations()).rejects.toThrow()
  })

  test("persists complete JSON documents", async () => {
    const root = await temporaryDirectory()
    const project = join(root, "project")
    const state = join(root, "state")
    await mkdir(project)
    const store = await BranchMetadataStore.openForProvider(project, "claude", state)
    const childSessionId = "22222222-2222-4222-8222-222222222222"
    await store.saveRelation({
      childSessionId,
      parentSessionId: "11111111-1111-4111-8111-111111111111",
      sourceMessageId: "33333333-3333-4333-8333-333333333333",
      sharedMessages: [],
    })

    const files = await filesRecursively(join(state, "claude-tree", "projects"))
    const relationPath = files.find((path) => path.endsWith(".json") && !path.endsWith("project.json"))
    expect(relationPath).toBeDefined()
    const contents = await readFile(relationPath!, "utf8")
    expect(() => JSON.parse(contents)).not.toThrow()
    expect(files.some((path) => path.endsWith(".tmp"))).toBeFalse()
  })
})

describe("validateRelations", () => {
  test("rejects cycles", () => {
    expect(() =>
      validateRelations([
        relation("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"),
        relation("22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"),
      ]),
    ).toThrow("cycle")
  })

  test("does not persist a relation that creates a cycle", async () => {
    const root = await temporaryDirectory()
    const project = join(root, "project")
    const state = join(root, "state")
    await mkdir(project)
    const store = await BranchMetadataStore.openForProvider(project, "test-agent", state)

    await store.saveRelation({
      childSessionId: "child",
      parentSessionId: "parent",
      sourceMessageId: "parent-message",
      sharedMessages: [],
    })
    await expect(
      store.saveRelation({
        childSessionId: "parent",
        parentSessionId: "child",
        sourceMessageId: "child-message",
        sharedMessages: [],
      }),
    ).rejects.toThrow("cycle")
    expect(await store.loadRelations()).toHaveLength(1)
  })

  test("requires unique shared-message mappings", async () => {
    const root = await temporaryDirectory()
    const project = join(root, "project")
    const state = join(root, "state")
    await mkdir(project)
    const store = await BranchMetadataStore.openForProvider(project, "claude", state)

    expect(
      store.saveRelation({
        childSessionId: "22222222-2222-4222-8222-222222222222",
        parentSessionId: "11111111-1111-4111-8111-111111111111",
        sourceMessageId: "33333333-3333-4333-8333-333333333333",
        sharedMessages: [
          { parentMessageId: "same-parent", childMessageId: "child-one" },
          { parentMessageId: "same-parent", childMessageId: "child-two" },
        ],
      }),
    ).rejects.toThrow("shared message mappings must be unique")
  })

  test("accepts a relationship with no shared history", async () => {
    const root = await temporaryDirectory()
    const project = join(root, "project")
    const state = join(root, "state")
    await mkdir(project)
    const store = await BranchMetadataStore.openForProvider(project, "claude", state)

    const saved = await store.saveRelation({
      childSessionId: "22222222-2222-4222-8222-222222222222",
      parentSessionId: "11111111-1111-4111-8111-111111111111",
      sourceMessageId: "33333333-3333-4333-8333-333333333333",
      sharedMessages: [],
    })
    expect(saved.sharedMessages).toEqual([])
  })

  test("accepts opaque provider identifiers", async () => {
    const root = await temporaryDirectory()
    const project = join(root, "project")
    const state = join(root, "state")
    await mkdir(project)
    const store = await BranchMetadataStore.openForProvider(project, "claude", state)

    const saved = await store.saveRelation({
      childSessionId: "session/child:opaque",
      parentSessionId: "session/parent:opaque",
      sourceMessageId: "turn:42",
      sharedMessages: [],
    })
    expect(saved.childSessionId).toBe("session/child:opaque")
  })
})

function relation(childSessionId: string, parentSessionId: string): BranchRelation {
  return {
    schemaVersion: 2,
    childSessionId,
    parentSessionId,
    sourceMessageId: "33333333-3333-4333-8333-333333333333",
    sharedMessages: [],
    createdAt: "2026-08-30T12:00:00.000Z",
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "claude-tree-test-"))
  temporaryDirectories.push(path)
  return path
}

async function filesRecursively(directory: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*")
  const files: string[] = []
  for await (const entry of glob.scan({ cwd: directory, absolute: true, onlyFiles: true })) {
    files.push(entry)
  }
  return files
}
