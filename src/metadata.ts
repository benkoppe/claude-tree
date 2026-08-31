import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { z } from "zod"

const SCHEMA_VERSION = 1

const manifestSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    projectPath: z.string().min(1),
  })
  .strict()

const relationSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    childSessionId: z.string().min(1),
    parentSessionId: z.string().min(1),
    sourceMessageId: z.string().min(1),
    sharedMessages: z.array(
      z.object({
        parentMessageId: z.string().min(1),
        childMessageId: z.string().min(1),
      }).strict(),
    ),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((relation, context) => {
    const parentIds = new Set<string>()
    const childIds = new Set<string>()
    for (const pair of relation.sharedMessages) {
      if (parentIds.has(pair.parentMessageId) || childIds.has(pair.childMessageId)) {
        context.addIssue({ code: "custom", message: "shared message mappings must be unique" })
        break
      }
      parentIds.add(pair.parentMessageId)
      childIds.add(pair.childMessageId)
    }
  })

const messageRefSchema = z
  .object({
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
  })
  .strict()

const messageRemovalTargetSchema = z
  .object({
    kind: z.literal("message"),
    aliases: z.array(messageRefSchema).min(1),
  })
  .strict()
  .superRefine((target, context) => {
    const messageIdsBySession = new Map<string, Set<string>>()
    for (const alias of target.aliases) {
      const messageIds = messageIdsBySession.get(alias.sessionId) ?? new Set<string>()
      if (messageIds.has(alias.messageId)) {
        context.addIssue({ code: "custom", message: "message aliases must be unique" })
        break
      }
      messageIds.add(alias.messageId)
      messageIdsBySession.set(alias.sessionId, messageIds)
    }
  })

const endpointRemovalTargetSchema = z
  .object({
    kind: z.literal("endpoint"),
    sessionId: z.string().min(1),
    afterMessageId: z.string().min(1).nullable(),
  })
  .strict()

const subtreeRemovalTargetSchema = z.discriminatedUnion("kind", [
  messageRemovalTargetSchema,
  endpointRemovalTargetSchema,
])

const treeRemovalSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    kind: z.literal("tree"),
    rootSessionId: z.string().min(1),
    memberSessionIds: z.array(z.string().min(1)).min(1),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((removal, context) => {
    if (new Set(removal.memberSessionIds).size !== removal.memberSessionIds.length) {
      context.addIssue({ code: "custom", message: "tree member session IDs must be unique" })
    }
    if (!removal.memberSessionIds.includes(removal.rootSessionId)) {
      context.addIssue({ code: "custom", message: "tree members must include the root session" })
    }
  })

const subtreeRemovalSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    kind: z.literal("subtree"),
    target: subtreeRemovalTargetSchema,
    createdAt: z.iso.datetime(),
  })
  .strict()

const removalSchema = z.discriminatedUnion("kind", [treeRemovalSchema, subtreeRemovalSchema])

export type BranchRelation = z.infer<typeof relationSchema>

export type NewBranchRelation = Omit<BranchRelation, "schemaVersion" | "createdAt"> & {
  createdAt?: string
}

export type MessageRemovalTarget = z.infer<typeof messageRemovalTargetSchema>
export type EndpointRemovalTarget = z.infer<typeof endpointRemovalTargetSchema>
export type SubtreeRemovalTarget = z.infer<typeof subtreeRemovalTargetSchema>
export type ConversationRemovalTarget = SubtreeRemovalTarget
export type TreeConversationRemoval = z.infer<typeof treeRemovalSchema>
export type SubtreeConversationRemoval = z.infer<typeof subtreeRemovalSchema>
export type ConversationRemoval = z.infer<typeof removalSchema>

type NewPersistedRecord<T> = T extends unknown
  ? Omit<T, "schemaVersion" | "createdAt"> & { createdAt?: string }
  : never

export type NewConversationRemoval = NewPersistedRecord<ConversationRemoval>

export class BranchMetadataStore {
  readonly projectPath: string

  private constructor(
    projectPath: string,
    private readonly projectStateDirectory: string,
  ) {
    this.projectPath = projectPath
  }

  static async openForProvider(
    projectDirectory: string,
    providerId: string,
    stateHome?: string,
  ): Promise<BranchMetadataStore> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(providerId)) {
      throw new Error(`Invalid provider ID: ${providerId}`)
    }
    const projectPath = await realpath(projectDirectory)
    const baseStateDirectory = stateHome ?? resolveStateHome()
    const projectKey = createHash("sha256").update(projectPath).digest("hex")
    const projectRootDirectory = join(baseStateDirectory, "claude-tree", "projects", projectKey)
    const projectStateDirectory = join(projectRootDirectory, "providers", providerId)
    const relationDirectory = join(projectStateDirectory, "branches")
    const removalDirectory = join(projectStateDirectory, "removals")

    await mkdir(projectRootDirectory, { recursive: true, mode: 0o700 })

    const manifestPath = join(projectRootDirectory, "project.json")
    const manifestFile = Bun.file(manifestPath)
    if (!(await manifestFile.exists())) {
      await writeJsonAtomically(manifestPath, {
        schemaVersion: SCHEMA_VERSION,
        projectPath,
      })
    }

    const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")))
    if (manifest.projectPath !== projectPath) {
      throw new Error(
        `State directory belongs to ${manifest.projectPath}, not ${projectPath}. Refusing to use it.`,
      )
    }

    await mkdir(relationDirectory, { recursive: true, mode: 0o700 })
    await mkdir(removalDirectory, { recursive: true, mode: 0o700 })
    return new BranchMetadataStore(projectPath, projectStateDirectory)
  }

  async loadRelations(): Promise<BranchRelation[]> {
    const relationDirectory = join(this.projectStateDirectory, "branches")
    const entries = await readdir(relationDirectory, { withFileTypes: true })
    const relations: BranchRelation[] = []

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue

      const relation = relationSchema.parse(
        JSON.parse(await readFile(join(relationDirectory, entry.name), "utf8")),
      )
      const expectedName = relationFileName(relation.childSessionId)
      if (entry.name !== expectedName) {
        throw new Error(`Branch metadata ${entry.name} belongs in ${expectedName}`)
      }
      relations.push(relation)
    }

    validateRelations(relations)
    return relations
  }

  async saveRelation(input: NewBranchRelation): Promise<BranchRelation> {
    const relation = relationSchema.parse({
      ...input,
      schemaVersion: SCHEMA_VERSION,
      createdAt: input.createdAt ?? new Date().toISOString(),
    })
    if (relation.childSessionId === relation.parentSessionId) {
      throw new Error("A session cannot be its own parent")
    }

    const targetPath = join(
      this.projectStateDirectory,
      "branches",
      relationFileName(relation.childSessionId),
    )
    if (await Bun.file(targetPath).exists()) {
      const existing = relationSchema.parse(JSON.parse(await readFile(targetPath, "utf8")))
      if (JSON.stringify(existing) !== JSON.stringify(relation)) {
        throw new Error(`Session ${relation.childSessionId} already has different branch metadata`)
      }
      return existing
    }

    validateRelations([...(await this.loadRelations()), relation])
    await writeJsonAtomically(targetPath, relation)
    return relation
  }

  async loadRemovals(): Promise<ConversationRemoval[]> {
    const removalDirectory = join(this.projectStateDirectory, "removals")
    const entries = await readdir(removalDirectory, { withFileTypes: true })
    const removals: ConversationRemoval[] = []

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
        throw new Error(`Invalid removal metadata filename: ${entry.name}`)
      }

      const removal = removalSchema.parse(
        JSON.parse(await readFile(join(removalDirectory, entry.name), "utf8")),
      )
      if (!isCanonicalRemoval(removal)) {
        throw new Error(`Removal metadata ${entry.name} is not canonically ordered`)
      }
      const expectedName = removalFileName(removal)
      if (entry.name !== expectedName) {
        throw new Error(`Removal metadata ${entry.name} belongs in ${expectedName}`)
      }
      removals.push(removal)
    }

    return removals
  }

  async saveRemoval(input: NewConversationRemoval): Promise<ConversationRemoval> {
    const removal = canonicalizeRemoval(
      removalSchema.parse({
        ...input,
        schemaVersion: SCHEMA_VERSION,
        createdAt: input.createdAt ?? new Date().toISOString(),
      }),
    )
    const fileName = removalFileName(removal)
    const existing = (await this.loadRemovals()).find(
      (candidate) => removalFileName(candidate) === fileName,
    )
    if (existing) return existing

    await writeJsonAtomically(join(this.projectStateDirectory, "removals", fileName), removal)
    return removal
  }
}

function relationFileName(childSessionId: string): string {
  return `${createHash("sha256").update(childSessionId).digest("hex")}.json`
}

function removalFileName(removal: ConversationRemoval): string {
  const identity =
    removal.kind === "tree"
      ? {
          schemaVersion: removal.schemaVersion,
          kind: removal.kind,
          rootSessionId: removal.rootSessionId,
          memberSessionIds: removal.memberSessionIds,
        }
      : {
          schemaVersion: removal.schemaVersion,
          kind: removal.kind,
          target: removal.target,
        }
  return `${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}.json`
}

function canonicalizeRemoval(removal: ConversationRemoval): ConversationRemoval {
  if (removal.kind === "tree") {
    return {
      ...removal,
      memberSessionIds: [...removal.memberSessionIds].sort(compareOpaqueIds),
    }
  }
  if (removal.target.kind === "endpoint") return removal
  return {
    ...removal,
    target: {
      ...removal.target,
      aliases: [...removal.target.aliases].sort(
        (left, right) =>
          compareOpaqueIds(left.sessionId, right.sessionId) ||
          compareOpaqueIds(left.messageId, right.messageId),
      ),
    },
  }
}

function isCanonicalRemoval(removal: ConversationRemoval): boolean {
  const canonical = canonicalizeRemoval(removal)
  if (removal.kind === "tree" && canonical.kind === "tree") {
    return removal.memberSessionIds.every(
      (sessionId, index) => sessionId === canonical.memberSessionIds[index],
    )
  }
  if (
    removal.kind === "subtree" &&
    removal.target.kind === "message" &&
    canonical.kind === "subtree" &&
    canonical.target.kind === "message"
  ) {
    const canonicalAliases = canonical.target.aliases
    return removal.target.aliases.every((alias, index) => {
      const canonicalAlias = canonicalAliases[index]
      if (!canonicalAlias) return false
      return alias.sessionId === canonicalAlias.sessionId && alias.messageId === canonicalAlias.messageId
    })
  }
  return true
}

function compareOpaqueIds(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function validateRelations(relations: BranchRelation[]): void {
  const parents = new Map<string, string>()
  for (const relation of relations) {
    if (relation.childSessionId === relation.parentSessionId) {
      throw new Error(`Session ${relation.childSessionId} cannot be its own parent`)
    }
    if (parents.has(relation.childSessionId)) {
      throw new Error(`Session ${relation.childSessionId} has more than one parent`)
    }
    parents.set(relation.childSessionId, relation.parentSessionId)
  }

  for (const child of parents.keys()) {
    const seen = new Set<string>()
    let current: string | undefined = child
    while (current !== undefined) {
      if (seen.has(current)) {
        throw new Error(`Branch metadata contains a cycle involving ${current}`)
      }
      seen.add(current)
      current = parents.get(current)
    }
  }
}

function resolveStateHome(): string {
  const configured = process.env.XDG_STATE_HOME
  if (configured) {
    if (!configured.startsWith("/")) {
      throw new Error("XDG_STATE_HOME must be an absolute path")
    }
    return configured
  }
  return join(homedir(), ".local", "state")
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporaryPath, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    await rename(temporaryPath, path)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}
