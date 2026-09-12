import { realpath, stat } from "node:fs/promises"
import { resolve } from "node:path"

export type CliOptions =
  | { command: "help" }
  | { command: "version" }
  | { command: "diagnose-history"; provider: "claude"; sessionId: string; project: string }
  | { command: "run"; provider: "claude" | "codex"; project: string }

export function parseCliArguments(args: readonly string[]): CliOptions {
  if (args.includes("--help") || args.includes("-h")) return { command: "help" }
  if (args.includes("--version") || args.includes("-v")) return { command: "version" }

  let provider: "claude" | "codex" = "claude"
  let project = "."
  let projectSet = false
  let diagnosticSession: string | undefined

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (argument === "--codex") {
      provider = "codex"
    } else if (argument === "--diagnose-history") {
      if (diagnosticSession !== undefined) throw new Error("Specify --diagnose-history only once")
      const sessionId = args[++index]
      if (!sessionId || sessionId.startsWith("-")) throw new Error("--diagnose-history requires a session ID")
      diagnosticSession = sessionId
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown argument: ${argument}`)
    } else if (projectSet) {
      throw new Error(`Unexpected project path: ${argument}`)
    } else {
      project = argument
      projectSet = true
    }
  }

  if (diagnosticSession !== undefined) {
    if (provider !== "claude") throw new Error("History diagnostics currently support Claude Code only")
    return { command: "diagnose-history", provider, sessionId: diagnosticSession, project }
  }
  return { command: "run", provider, project }
}

export async function resolveProjectDirectory(project: string, cwd = process.cwd()): Promise<string> {
  const projectPath = await realpath(resolve(cwd, project))
  const projectStat = await stat(projectPath)
  if (!projectStat.isDirectory()) throw new Error(`Project path is not a directory: ${project}`)
  return projectPath
}
