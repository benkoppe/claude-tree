# claude-tree

`/tree` (from `pi` agent) for Claude Code and other agents.

`claude-tree` turns a project's agent conversations into a navigable message tree, making it much easier to manage large & winding sessions without a long, linear history. Sessions that are out of view keep running in the background in their provider's native interface.

Claude Code is selected by default. Pass `--codex` to use Codex, and optionally pass the project directory:

```sh
claude-tree /path/to/project
claude-tree --codex /path/to/project
```

`claude-tree` does not create Git worktrees or restore files to their state at the fork point.

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

## Resume a workspace

Press `?` to find the current workspace's resume command in About:

```sh
claude-tree --resume WORKSPACE_ID /path/to/project
claude-tree --codex --resume WORKSPACE_ID /path/to/project
```

Resume restores the saved roots selection or tree cursor, and reopens the visible provider session if you left a terminal open. It starts a fresh runtime: hidden agents, terminal scrollback, and unsent drafts are not restored. Each invocation has independent navigation, even when resuming the same saved workspace.

Quitting stops child agents and restores the host terminal. A live session open in another invocation produces a **Cancel / Open anyway** warning; Cancel is selected by default. Opening anyway does not stop the other invocation and may cause conflicting conversation writes.

There is no automatic crash recovery. Session guards are OS locks released when the application dies, so stale reservations cannot block future opens. Detached agents or Codex sidecars may survive an abrupt crash; stop any leftovers yourself before resuming.

Workspace navigation and tree relationships are stored under `$XDG_STATE_HOME` (default `~/.local/state`). Incompatible metadata—including the older ownership/recovery format—is rejected without migration or deletion. Reset it explicitly by moving or removing the affected project state directory; this does not delete provider conversations, but does remove saved tree relationships and workspace destinations.

## Herdr

Inside a Herdr pane, claude-tree reports the displayed tree or terminal's activity and its workspace resume command. Herdr 0.9.2+ can run that command after a server restart, in the pane's original directory. The `claude-tree` command must be on `PATH`. Reporting is optional and failures do not interrupt normal use.

Herdr does not accept resume arguments containing apostrophes or control characters, or commands exceeding its size limits. Such commands are omitted while activity reporting continues. Outside Herdr, the integration does nothing.

## Development

The keyed executor is adapted from T3 Code; its MIT notice is
retained in [`THIRD_PARTY_LICENSES`](THIRD_PARTY_LICENSES).

The development shell includes Bun and the validated provider CLIs available for the platform:

```sh
nix develop
bun install --frozen-lockfile
bun run check # or nix flake check
bun run start
```

Without Nix, install Bun and at least one supported provider CLI before running the last three commands.

After changing `bun.lock`, regenerate the Nix dependency set with `nix develop -c bun2nix -o bun.nix`.
