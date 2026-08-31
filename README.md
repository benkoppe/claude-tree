# claude-tree

`claude-tree` is a full-screen terminal navigator for Claude Code conversations. It merges related sessions into message graphs while every opened conversation remains the stock Claude Code interface in its own PTY.

All conversations use the same working tree. Running branches can observe and edit the same files.

## Requirements

- Linux or macOS on x86_64 or arm64
- Bun 1.3 or newer
- Claude Code 2.1.239 for the validated compatibility baseline
- A truecolor terminal using a Nerd Font

User-message replay relies on Claude Code 2.1.239's hidden `--prefill` option. Upgrading Claude Code requires revalidating that option as well as SDK session compatibility.

The included Nix flake provides Bun and the validated Claude Code version:

```sh
direnv allow
bun install --frozen-lockfile
```

Without direnv:

```sh
nix develop
bun install --frozen-lockfile
```

## Run

Start from the project whose Claude sessions you want to explore:

```sh
bun run start
```

To expose the `claude-tree` executable from a development checkout, run `bun link` once and then invoke `claude-tree` from a project directory.

## Controls

Conversation roots:

| Key | Action |
| --- | --- |
| `Up` / `k` | Select the previous conversation family |
| `Down` / `j` | Select the next conversation family |
| `Enter` | Open the selected message graph |
| `n` | Start a new root conversation |
| `r` | Refresh sessions and messages |
| `q` or `Ctrl+C` | Exit |

Message graph:

| Key | Action |
| --- | --- |
| `Up` / `k` | Move to the visible parent |
| `Down` / `j` | Move to a visible child, preserving the cursor column |
| `Left` / `h` | Move to the nearest node on the left, preserving depth |
| `Right` / `l` | Move to the nearest node on the right, preserving depth |
| `Enter` | Open or resume the session ending at the selected node |
| `f` | Fork an assistant message, or replay a selected user message |
| `n` | Start a new root conversation |
| `r` | Refresh the graph |
| `q` or `Escape` | Return to conversation roots |
| `Ctrl+C` | Exit |

Claude terminal:

| Key | Action |
| --- | --- |
| `Ctrl+Space` | Return to the navigator |

Every other terminal key belongs to Claude Code. Slash commands, permissions, hooks, MCP servers, plugins, mouse input, paste handling, and Claude's own keybindings are not reimplemented by `claude-tree`.

Message nodes are filled cards labeled with Nerd Font icons and readable roles such as User, Assistant, and Branch point. The selected card uses a contrasting background instead of a cursor symbol. Adjacent messages may have the same role; graph structure follows transcript order rather than assuming that user and assistant messages alternate. Copied history from a fork is shown once as shared graph nodes rather than duplicated for every session.

Graph edges use connected Unicode box-drawing lines with proper corners, branches, and intersections. Vertical movement follows graph edges, so reaching the bottom of a branch never jumps into a taller neighboring branch. Horizontal movement crosses branches and root chains by visual position, including when the target is outside the viewport. Navigation preserves the desired column or depth like a text-editor cursor, so reversing an ambiguous move returns to the exact node it came from.

Saved sessions end at their latest message; selecting that message and pressing `Enter` resumes the session. A Claude session card appears after the latest message only while that session has a running Claude process. Live cards show their observed unsent draft: `Draft` is an exact prompt initially prefilled by `claude-tree`, while `Observed draft` is a best-effort preview read from Claude's visible composer when returning to the graph. Claude exposes no composer-state API, so long, scrolled, or unrecognized drafts may appear as `No draft observed`. The conversation-root list uses `● Live` and `○ Saved` to summarize each family.

## Fork Behavior

Forking an assistant message copies history through that exact message and opens the child with a blank composer. Forking a user message instead copies history through the nearest earlier assistant and opens the child with the selected user prompt already in the composer but not submitted. Intervening user messages are not copied. If the selected user message has no earlier assistant, its replay remains in the same conversation family as another top-level root. These roots share an invisible empty-history origin, so no false message edge is drawn between them. Prompts containing non-text content cannot be replayed because Claude's prefill option accepts text only.

Dragging across text in an embedded Claude terminal copies the selection through OSC52. OSC52 clipboard writes emitted by Claude itself, such as the login URL copy shortcut, are also forwarded to the outer terminal. The outer terminal must allow OSC52 clipboard writes.

## State

Claude transcripts remain Claude's source of truth. `claude-tree` stores only branch relationships under:

```text
$XDG_STATE_HOME/claude-tree/projects/<project-hash>/
```

When `XDG_STATE_HOME` is unset, the base directory is `~/.local/state`.

The canonical project path is recorded and checked before state is used. Relationship files are validated strictly and replaced atomically. Sessions without recorded ancestry appear as independent roots.

Observed unsent drafts are process-local UI state. They are kept only in memory while `claude-tree` is running and are never written to application state.

## Development

```sh
bun run typecheck
bun test
bun run check
nix flake check --no-update-lock-file
```

Tests use temporary state, Anthropic's in-memory session store, fixture PTYs, and OpenTUI's in-memory renderer. They do not call a model or modify real Claude transcripts.

## MVP Limits

- Live PTYs exist only while the foreground `claude-tree` process is running. Exiting terminates child processes; persisted Claude sessions remain resumable.
- The application prevents two child processes for the same session inside one instance. It cannot prevent an external Claude process or another `claude-tree` instance from resuming that session concurrently.
- Forking copies conversation history through the selected message, not historical files or Claude file-history snapshots.
- Branches intentionally share the current working tree; no Git worktrees are created.
- A fork can be created before relationship metadata fails to save. In that case the Claude session is preserved and appears as an independent root.
- OpenTUI's embedded terminal renders character cells, not Kitty graphics or Sixel images.
- Clipboard forwarding depends on OSC52 support in the outer terminal and any intervening SSH or multiplexer configuration.
- Draft observation is a conservative parse of Claude's visible input box, not a semantic composer API. It may be unavailable when the prompt is scrolled, visually abbreviated, or displayed by an incompatible Claude Code version.
