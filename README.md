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

## Tree Shortcuts

Press **`c`** in the tree to copy the highlighted node's full text, preserving line breaks, indentation, and Markdown. Grouped Agent nodes copy their represented messages in order. Draft nodes copy the available draft preview, which may be approximate. Nodes without text leave the clipboard untouched.

Copy uses the host terminal's OSC 52 clipboard support, the same mechanism used for clipboard writes from embedded agent terminals.

## Activity Recovery

Working indicators combine terminal activity observations with a short wait for the provider's completed transcript. Hidden sessions are checked automatically, and `r` in the navigator resamples live terminals as well as refreshing conversation history.

Claude launches include temporary, additive `Stop` and `StopFailure` hooks that request an activity check. They do not change permissions, replace your hooks, or write settings files. If hooks are disabled, restricted, or unavailable, terminal observation remains active. A hook firing is not treated as proof of completion.

If refresh cannot recognize a working terminal's screen or read its transcript, it reports the uncertainty rather than forcing the session idle. Provider UI changes can still require an observer update; include the provider version and refresh error when reporting an activity issue. Conversation text and hook payloads are not logged by this recovery mechanism.

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
