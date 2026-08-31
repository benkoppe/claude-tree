import { realpath, stat } from "node:fs/promises"
import { resolve } from "node:path"

export type CliOptions =
  | { command: "help" }
  | { command: "version" }
  | { command: "run"; provider: "claude" | "codex"; project: string }

export function parseCliArguments(args: readonly string[]): CliOptions {
  if (args.includes("--help") || args.includes("-h")) return { command: "help" }
  if (args.includes("--version") || args.includes("-v")) return { command: "version" }

  let provider: "claude" | "codex" = "claude"
  let project = "."
  let projectSet = false

  for (const argument of args) {
    if (argument === "--codex") {
      provider = "codex"
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown argument: ${argument}`)
    } else if (projectSet) {
      throw new Error(`Unexpected project path: ${argument}`)
    } else {
      project = argument
      projectSet = true
    }
  }

  return { command: "run", provider, project }
}

export async function resolveProjectDirectory(project: string, cwd = process.cwd()): Promise<string> {
  const projectPath = await realpath(resolve(cwd, project))
  const projectStat = await stat(projectPath)
  if (!projectStat.isDirectory()) throw new Error(`Project path is not a directory: ${project}`)
  return projectPath
}
