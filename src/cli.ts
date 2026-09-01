#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core"

import { AgentTreeApp } from "./app"
import { PROGRAM_NAME, PROGRAM_VERSION } from "./program"
import { setProcessTitle } from "./process-title"
import { parseCliArguments, resolveProjectDirectory } from "./cli-options"
import { createHerdrReporter } from "./herdr-reporter"
import { createClaudeProvider } from "./providers/claude"
import { createCodexProvider } from "./providers/codex"
import { theme } from "./theme"

async function main(): Promise<void> {
  const options = parseCliArguments(process.argv.slice(2))
  if (options.command === "help") {
    process.stdout.write(
      `${PROGRAM_NAME} [--codex] [PROJECT]\n\nExplore and run coding-agent conversations for PROJECT (default: current directory).\nClaude Code is used by default; pass --codex to use Codex.\n\nRoot picker:\n  Up/Down or k/j  select a conversation family\n  Mouse wheel     select a conversation family\n  Click           select a row; click the selected row to open it\n  Enter           open its message graph\n  d               delete the selected whole tree from roots\n  n               start a new conversation\n  r               refresh conversations\n  ?               open About\n  q               quit\n\nMessage graph:\n  Up/Down or k/j  move along graph edges\n  Left/Right or h/l move across branches\n  Click           select a card; click the selected card to open it\n  Enter           open or resume the session ending at the selected node\n  f               fork the selected provider-supported message\n  d               delete the selected node and visual descendants from the graph\n  x               kill the selected live endpoint after confirmation\n  n               start a new conversation\n  r               refresh the graph\n  ?               open About\n  q or Escape     return to roots\n\nDelete confirmation:\n  Cancel is selected by default; arrows, h/j/k/l, or Tab change the choice\n  Enter           confirm the selected choice\n  q or Escape     cancel\n  Deletion cannot be undone in claude-tree; provider transcripts and project files remain\n  Affected live sessions stop first; ancestors remain forkable\n  A deleted original leaf cannot be opened from that path\n\nKill confirmation:\n  Arrows, h/j/k/l, or Tab choose Kill or Cancel\n  Enter           confirm the selected choice\n  q or Escape     cancel\n\nFooter actions can also be clicked.\n\nAgent terminal:\n  Ctrl+Space      return to the message graph\n  d               ordinary provider input\n`,
    )
    return
  }
  if (options.command === "version") {
    process.stdout.write(`${PROGRAM_NAME} ${PROGRAM_VERSION}\n`)
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("claude-tree requires an interactive terminal")
  }

  const projectPath = await resolveProjectDirectory(options.project)
  const provider = await (options.provider === "codex"
    ? createCodexProvider(projectPath)
    : createClaudeProvider(projectPath))

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    useMouse: true,
    useKittyKeyboard: { events: true },
    backgroundColor: theme.background,
  })
  let app: AgentTreeApp | undefined
  let stopRequested = false
  const stop = () => {
    stopRequested = true
    if (app) void app.stop()
  }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
  process.on("SIGHUP", stop)
  process.on("SIGQUIT", stop)

  try {
    app = await AgentTreeApp.create(
      renderer,
      projectPath,
      provider,
      undefined,
      setProcessTitle,
      { herdrReporter: createHerdrReporter() },
    )
    if (stopRequested) {
      await app.stop()
      return
    }
    await app.run()
  } finally {
    process.off("SIGTERM", stop)
    process.off("SIGINT", stop)
    process.off("SIGHUP", stop)
    process.off("SIGQUIT", stop)
    if (app) await app.stop()
    else renderer.destroy()
  }
}

void main().catch((error) => {
  process.stderr.write(`claude-tree: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
