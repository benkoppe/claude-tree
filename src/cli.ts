#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core"

import { AgentTreeApp } from "./app"
import { createClaudeProvider } from "./providers/claude"
import { theme } from "./theme"

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      "claude-tree\n\nExplore and run this project's Claude Code conversations.\n\nRoot picker:\n  Up/Down or k/j  select a conversation family\n  Mouse wheel     select a conversation family\n  Click           select a row; click the selected row to open it\n  Enter           open its message graph\n  n               start a new conversation\n  q               quit\n\nMessage graph:\n  Up/Down or k/j  move along graph edges\n  Left/Right or h/l move across branches\n  Click           select a card; click the selected card to open it\n  Enter           open or resume the session ending at the selected node\n  f               fork or replay the selected message\n  q or Escape     return to roots\n\nFooter actions can also be clicked.\n\nClaude terminal:\n  Ctrl+Space      return to the message graph\n",
    )
    return
  }
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write("claude-tree 0.1.0\n")
    return
  }
  if (process.argv.length > 2) {
    throw new Error(`Unknown argument: ${process.argv[2]}`)
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("claude-tree requires an interactive terminal")
  }

  const provider = await createClaudeProvider(process.cwd())

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
    app = await AgentTreeApp.create(renderer, process.cwd(), provider)
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
