import { realpath, stat } from "node:fs/promises"
import { resolve } from "node:path"

export type CliOptions =
  | { command: "help" }
  | { command: "version" }
  | { command: "state"; action: "check" | "backup" | "export" | "import-json"; provider: "claude" | "codex"; project: string; destination?: string }
  | { command: "diagnose-history"; provider: "claude"; sessionId: string; project: string }
  | { command: "run"; provider: "claude" | "codex"; project: string; resumeWorkspaceId?: string }

export function parseCliArguments(args: readonly string[]): CliOptions {
  if (args.includes("--help") || args.includes("-h")) return { command: "help" }
  if (args.includes("--version") || args.includes("-v")) return { command: "version" }
  if (args[0] === "state") {
    const action = args[1]
    if (action !== "check" && action !== "backup" && action !== "export" && action !== "import-json") throw new Error("Expected state check, backup, export, or import-json")
    const rest = args.slice(2)
    const provider = rest.includes("--codex") ? "codex" : "claude"
    const paths = rest.filter((value) => value !== "--codex")
    if (paths.some((value) => value.startsWith("-"))) throw new Error("Unknown state command option")
    if (action === "backup") {
      if (paths.length !== 1) throw new Error("state backup requires one destination")
      return { command: "state", action, provider, project: ".", destination: paths[0]! }
    }
    if (paths.length > 1 || (action === "check" && paths.length)) throw new Error("Unexpected state command argument")
    return { command: "state", action, provider, project: paths[0] ?? "." }
  }

  let provider: "claude" | "codex" = "claude"
  let project = "."
  let projectSet = false
  let diagnosticSession: string | undefined
  let resumeWorkspaceId: string | undefined

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (argument === "--codex") {
      provider = "codex"
    } else if (argument === "--resume") {
      if (resumeWorkspaceId !== undefined) throw new Error("Specify --resume only once")
      const id = args[++index]
      if (!id || id.startsWith("-")) throw new Error("--resume requires a workspace ID")
      resumeWorkspaceId = id
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
    if (resumeWorkspaceId !== undefined) throw new Error("--resume cannot be combined with --diagnose-history")
    if (provider !== "claude") throw new Error("History diagnostics currently support Claude Code only")
    return { command: "diagnose-history", provider, sessionId: diagnosticSession, project }
  }
  return { command: "run", provider, project, ...(resumeWorkspaceId === undefined ? {} : { resumeWorkspaceId }) }
}

export async function resolveProjectDirectory(project: string, cwd = process.cwd()): Promise<string> {
  const projectPath = await realpath(resolve(cwd, project))
  const projectStat = await stat(projectPath)
  if (!projectStat.isDirectory()) throw new Error(`Project path is not a directory: ${project}`)
  return projectPath
}
