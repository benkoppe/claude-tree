# claude-tree

`/tree` (from `pi` agent) for Claude Code.

`claude-tree` turns a project's agent conversations into a navigable message tree, making it much easier to manage long & winding sessions without a long, linear history. Sessions that are out of view keep running in the background.

`claude-tree` does not create Git worktrees or restore files to their state at the fork point.

Claude's local slash-command bookkeeping is retained internally for transcript integrity but omitted from message trees. Command-only conversations remain visible while active and disappear after their final process exits.

## Quick Start (Development)

Requires Linux or macOS, Bun 1.3 or newer, Claude Code, and a truecolor terminal using a Nerd Font.

Run:

```sh
bun install --frozen-lockfile
bun run start
```
