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

## Shutdown and recovery

Quitting stops the owned agent processes and restores the host terminal. Provider conversations remain available to resume later.

If shutdown fails, the error lists the affected sessions, cleanup stages, and underlying causes. Simultaneous terminal and navigation-persistence failures are reported together.

After an interrupted shutdown, `claude-tree` checks previous terminal ownership at startup and when opening a session. It releases an orphaned reservation once the old application, its terminal process group, and any recorded Codex sidecar group are definitely gone and its launch artifacts are removed. A saved `stopping` or `cleanup-incomplete` status alone does not block reopening.

If cleanup cannot be verified, the error identifies the remaining condition: a surviving process group, unknown liveness, failed artifact cleanup, or an acquisition interrupted before all process identities were recorded. Resolve that condition and retry. Recovery does not signal unidentified processes or guess that an incompletely recorded launch was harmless.

Opening a terminal allows up to ten seconds for each launch persistence operation, including normal contention with navigation saves. Persistence timeout errors include the time budget and last operation phase. Such a timeout means the application stopped waiting; it is not evidence that another terminal is running. Late reservations are released without starting a provider process.

Application metadata uses a strict, reset-only format under `$XDG_STATE_HOME` (default `~/.local/state`). Older terminal-owner records without a resource inventory are rejected in place, rather than automatically upgraded or deleted. Any reset is explicit and affects application-owned relationships and UI metadata, not provider transcripts.

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
