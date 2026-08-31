# claude-tree

`/tree` (from `pi` agent) for Claude Code and other agents.

`claude-tree` turns a project's agent conversations into a navigable message tree, making it much easier to manage long & winding sessions without a long, linear history. Sessions that are out of view keep running in the background in their provider's stock TUI.

Claude Code is selected by default. Pass `--codex` to use Codex, and optionally pass the project directory:

```sh
claude-tree /path/to/project
claude-tree --codex /path/to/project
```

`claude-tree` does not create Git worktrees or restore files to their state at the fork point.

## Quick Start (Development)

Requires Linux or macOS, Bun 1.3 or newer, Claude Code 2.1.239 or Codex 0.150.1, and a truecolor terminal using a Nerd Font.

Run:

```sh
bun install --frozen-lockfile
bun run start
```

The Nix development shell provides Bun and the validated agent versions.
