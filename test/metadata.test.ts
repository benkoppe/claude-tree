import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
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

  test("round-trips tree and subtree removals", async () => {
    const root = await temporaryDirectory()
    const project = join(root, "project")
    const state = join(root, "state")
    await mkdir(project)
    const store = await BranchMetadataStore.openForProvider(project, "claude", state)

    const tree = await store.saveRemoval({
      kind: "tree",
      rootSessionId: "root",
      memberSessionIds: ["root", "child"],
      createdAt: "2026-08-30T12:00:00.000Z",
    })
    const messages = await store.saveRemoval({
      kind: "subtree",
      target: {
        kind: "message",
        aliases: [
          { sessionId: "root", messageId: "message-one" },
          { sessionId: "child", messageId: "message-copy" },
        ],
      },
      createdAt: "2026-08-30T12:01:00.000Z",
    })
    const endpoint = await store.saveRemoval({
      kind: "subtree",
      target: { kind: "endpoint", sessionId: "child", afterMessageId: "last-message" },
      createdAt: "2026-08-30T12:02:00.000Z",
    })

    const loaded = await store.loadRemovals()
    expect(loaded).toHaveLength(3)
    expect(loaded).toEqual(expect.arrayContaining([tree, messages, endpoint]))
  })

  test("canonically persists and idempotently saves removal identities", async () => {
    const root = await temporaryDirectory()
    const project = join(root, "project")
    const state = join(root, "state")
    await mkdir(project)
    const store = await BranchMetadataStore.openForProvider(project, "claude", state)

    const firstTree = await store.saveRemoval({
      kind: "tree",
      rootSessionId: "root",
      memberSessionIds: ["root", "alpha"],
      createdAt: "2026-08-30T12:00:00.000Z",
    })
    const repeatedTree = await store.saveRemoval({
      kind: "tree",
      rootSessionId: "root",
      memberSessionIds: ["alpha", "root"],
      createdAt: "2026-08-30T13:00:00.000Z",
    })
    const firstMessages = await store.saveRemoval({
      kind: "subtree",
      target: {
        kind: "message",
        aliases: [
          { sessionId: "session-b", messageId: "message-b" },
          { sessionId: "session-a", messageId: "message-a" },
        ],
      },
      createdAt: "2026-08-30T14:00:00.000Z",
    })
    const repeatedMessages = await store.saveRemoval({
      kind: "subtree",
      target: {
        kind: "message",
        aliases: [
          { sessionId: "session-a", messageId: "message-a" },
          { sessionId: "session-b", messageId: "message-b" },
        ],
      },
      createdAt: "2026-08-30T15:00:00.000Z",
    })

    if (firstTree.kind !== "tree") throw new Error("Expected a tree removal")
    expect(firstTree.memberSessionIds).toEqual(["alpha", "root"])
    expect(repeatedTree).toEqual(firstTree)
    expect(firstMessages.kind).toBe("subtree")
    if (firstMessages.kind !== "subtree" || firstMessages.target.kind !== "message") {
      throw new Error("Expected a message removal")
    }
    expect(firstMessages.target.aliases).toEqual([
      { sessionId: "session-a", messageId: "message-a" },
      { sessionId: "session-b", messageId: "message-b" },
    ])
    expect(repeatedMessages).toEqual(firstMessages)
    expect(await removalMetadataFiles(state)).toHaveLength(2)
  })

  test("treats session and message IDs as opaque structured values", async () => {
    const root = await temporaryDirectory()
    const project = join(root, "project")
    const state = join(root, "state")
    await mkdir(project)
    const store = await BranchMetadataStore.openForProvider(project, "claude", state)

    const combined = await store.saveRemoval({
      kind: "subtree",
      target: {
        kind: "message",
        aliases: [
          { sessionId: "a:b", messageId: "c" },
          { sessionId: "a", messageId: "b:c" },
        ],
      },
    })
    await store.saveRemoval({
      kind: "subtree",
      target: { kind: "message", aliases: [{ sessionId: "session/one", messageId: "turn|1" }] },
    })
    await store.saveRemoval({
      kind: "subtree",
      target: { kind: "message", aliases: [{ sessionId: "session", messageId: "one/turn|1" }] },
    })

    expect(combined.kind === "subtree" && combined.target.kind === "message").toBeTrue()
    expect(await removalMetadataFiles(state)).toHaveLength(3)
    for (const path of await removalMetadataFiles(state)) {
      expect(path.split("/").at(-1)).toMatch(/^[a-f0-9]{64}\.json$/)
    }
  })

  test("rejects invalid removal filenames and strict schemas", async () => {
    const root = await temporaryDirectory()
    const project = join(root, "project")
    const state = join(root, "state")
    await mkdir(project)
    const store = await BranchMetadataStore.openForProvider(project, "claude", state)
    const removalDirectory = await removalMetadataDirectory(state)

    await writeFile(join(removalDirectory, "broken.json"), "{}\n")
    await expect(store.loadRemovals()).rejects.toThrow("Invalid removal metadata filename")
    await rm(join(removalDirectory, "broken.json"))

    await writeFile(
      join(removalDirectory, `${"0".repeat(64)}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "subtree",
        target: { kind: "endpoint", sessionId: "session", afterMessageId: null, unexpected: true },
        createdAt: "2026-08-30T12:00:00.000Z",
      })}\n`,
    )
    await expect(store.loadRemovals()).rejects.toThrow()
    await rm(join(removalDirectory, `${"0".repeat(64)}.json`))

    await writeFile(
      join(removalDirectory, `${"1".repeat(64)}.json`),
      `${JSON.stringify({
        schemaVersion: 2,
        kind: "subtree",
        target: { kind: "endpoint", sessionId: "session", afterMessageId: null },
        createdAt: "2026-08-30T12:00:00.000Z",
      })}\n`,
    )
    await expect(store.loadRemovals()).rejects.toThrow()
  })

  test("validates removal filenames against canonical identity", async () => {
    const root = await temporaryDirectory()
    const project = join(root, "project")
    const state = join(root, "state")
    await mkdir(project)
    const store = await BranchMetadataStore.openForProvider(project, "claude", state)
    const removal = await store.saveRemoval({
      kind: "subtree",
      target: { kind: "endpoint", sessionId: "session", afterMessageId: null },
      createdAt: "2026-08-30T12:00:00.000Z",
    })
    const [savedPath] = await removalMetadataFiles(state)
    expect(savedPath).toBeDefined()
    const removalDirectory = dirname(savedPath!)
    await rm(savedPath!)
    await writeFile(join(removalDirectory, `${"f".repeat(64)}.json`), `${JSON.stringify(removal)}\n`)

    await expect(store.loadRemovals()).rejects.toThrow("belongs in")
  })

  test("enforces tree and subtree removal invariants", async () => {
    const root = await temporaryDirectory()
    const project = join(root, "project")
    const state = join(root, "state")
    await mkdir(project)
    const store = await BranchMetadataStore.openForProvider(project, "claude", state)

    await expect(
      store.saveRemoval({ kind: "tree", rootSessionId: "root", memberSessionIds: [] }),
    ).rejects.toThrow()
    await expect(
      store.saveRemoval({
        kind: "tree",
        rootSessionId: "root",
        memberSessionIds: ["root", "root"],
      }),
    ).rejects.toThrow("unique")
    await expect(
      store.saveRemoval({ kind: "tree", rootSessionId: "root", memberSessionIds: ["child"] }),
    ).rejects.toThrow("include the root")
    await expect(
      store.saveRemoval({ kind: "subtree", target: { kind: "message", aliases: [] } }),
    ).rejects.toThrow()
    await expect(
      store.saveRemoval({
        kind: "subtree",
        target: {
          kind: "message",
          aliases: [
            { sessionId: "session", messageId: "message" },
            { sessionId: "session", messageId: "message" },
          ],
        },
      }),
    ).rejects.toThrow("unique")
  })

  test("atomically persists complete private removal JSON", async () => {
    const root = await temporaryDirectory()
    const project = join(root, "project")
    const state = join(root, "state")
    await mkdir(project)
    const store = await BranchMetadataStore.openForProvider(project, "claude", state)
    const removal = await store.saveRemoval({
      kind: "tree",
      rootSessionId: "root",
      memberSessionIds: ["root"],
    })

    const files = await filesRecursively(join(state, "claude-tree", "projects"))
    const removalFiles = files.filter((path) => path.includes("/removals/"))
    expect(removalFiles).toHaveLength(1)
    expect(JSON.parse(await readFile(removalFiles[0]!, "utf8"))).toEqual(removal)
    expect((await stat(removalFiles[0]!)).mode & 0o777).toBe(0o600)
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
    schemaVersion: 1,
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

async function removalMetadataDirectory(state: string): Promise<string> {
  const files = await filesRecursively(join(state, "claude-tree", "projects"))
  const manifestPath = files.find((path) => path.endsWith("project.json"))
  if (!manifestPath) throw new Error("Project manifest was not created")
  return join(dirname(manifestPath), "providers", "claude", "removals")
}

async function removalMetadataFiles(state: string): Promise<string[]> {
  return filesRecursively(await removalMetadataDirectory(state))
}
