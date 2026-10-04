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

### Responsiveness benchmark

Run `bun run benchmark:responsiveness` to measure startup and refresh using real SDK fixture reads, keyboard input, and OpenTUI rendering. It uses disposable data and does not launch agent terminals or modify real transcripts.

For a larger workload, use `BENCHMARK_SESSIONS=1000 BENCHMARK_RECORDS=100 bun run benchmark:responsiveness`. Add `--inline` to compare without read/projection workers; this retains the other optimizations, so it is not the original implementation. Run comparisons sequentially on the same machine without other heavy work.

`inputToVisibleSelection` waits for the matching actor acknowledgment, presentation delivery, and highlighted destination. It includes polling and test-renderer overhead. `sampledAcknowledgedFrameIntervals` includes 16 ms input pacing and is not native FPS. The p95 latency goal is 16.7 ms, not an automated pass/fail threshold; timings depend on machine load and Nix builds may reuse cached results. Keep this benchmark separate from flake checks and deterministic regression tests. It measures loading/refresh, not provider mutations or terminal acquisition.
