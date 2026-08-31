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

export type BranchRelation = z.infer<typeof relationSchema>

export type NewBranchRelation = Omit<BranchRelation, "schemaVersion" | "createdAt"> & {
  createdAt?: string
}

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
}

function relationFileName(childSessionId: string): string {
  return `${createHash("sha256").update(childSessionId).digest("hex")}.json`
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
