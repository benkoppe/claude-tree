# claude-tree

`/tree` (from `pi` agent) for Claude Code and other agents.

`claude-tree` frees you from a linear history & turns a project's agent conversations into a navigable message tree. Every leaf corresponds to a distinct session:

<p align="center">
  <img src="https://raw.githubusercontent.com/benkoppe/claude-tree/main/docs/images/conversation-tree.png"
       alt="claude-tree showing branching conversations with live sessions and new updates"
       width="600">
</p>

Claude Code is used by default. To use Codex, pass `--codex`. Optionally, you can pass the project directory:

```sh
claude-tree /path/to/project
claude-tree --codex /path/to/project
```

## Quick Start

`claude-tree` is project-scoped. Run it inside your project folder.

### npm (recommended)

Requires Linux or macOS, Node.js 20+, Claude Code or Codex installed on `$PATH`, and a truecolor terminal using a Nerd Font.

```sh
npm install -g @benkoppe/claude-tree

cd /path/to/project
claude-tree
```

Run the install command again to update.

### Bun (from source)

With Bun 1.3.13+ installed, you can install the current `main` branch instead of a release:

```sh
bun add --global github:benkoppe/claude-tree
```

Run that command again to update. If the command is not found, add `$BUN_INSTALL/bin` (normally `$HOME/.bun/bin`) to `$PATH`.

On musl Linux, please set `OPENTUI_LIBC=musl`.

### Nix

```sh
nix run github:benkoppe/claude-tree
```

This command also installs separate Claude/Codex agents. To use your own system-installed agents, use `#unwrapped`:

```sh
nix run github:benkoppe/claude-tree#unwrapped
```

## Development

The development shell includes Bun and the validated provider CLIs available for the platform:

```sh
nix develop
bun install --frozen-lockfile
bun run check # or nix flake check
bun run start
```

Without Nix, install Bun and at least one supported provider CLI before running the last three commands.

After changing `bun.lock`, regenerate the Nix dependency set with `nix develop -c bun2nix -o bun.nix`.
