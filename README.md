# claude-tree

`/tree` (from `pi` agent) for Claude Code and other agents.

`claude-tree` frees you from a linear history & turns a project's agent conversations into a navigable message tree. Every leaf corresponds to a distinct session:

<p align="center">
  <img src="docs/images/conversation-tree.png"
       alt="claude-tree showing branching conversations with live sessions and new updates"
       width="600">
</p>

Claude Code is used by default. To use codex, pass `--codex`. Optionally, you can pass the project directory:

```sh
claude-tree /path/to/project
claude-tree --codex /path/to/project
```

## Quick Start

`claude-tree` is project-scoped. Run it inside your project folder.

### Bun

Requires Linux or macOS, Bun, Claude Code or Codex on `$PATH`, and a truecolor terminal using a nerdfont.

```sh
bun add --global github:benkoppe/claude-tree

cd /path/to/project
claude-tree
```

This installs the current `main` branch. Run the install command again to update it.

If the command is not found after installation, add `$BUN_INSTALL/bin` (normally `$HOME/.bun/bin`) to `$PATH`.

On musl Linux, set `OPENTUI_LIBC=musl` when running `claude-tree`.

### Nix

```sh
nix run github:benkoppe/claude-tree
```

If provider CLIs are already installed separately, use `#unwrapped` to keep the existing commands on `$PATH`:

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
