# Architecture Decisions

This document records decisions that shape the project and the reasons behind them. Specific libraries and versions are an initial baseline and can be upgraded or replaced when a better implementation preserves these constraints.

## Stock Claude Code Runs In Owned PTYs

Each live branch is a normal interactive `claude` process attached to its own pseudo-terminal and terminal emulator state. The application forwards input to the selected process and continues consuming output from every hidden process.

Only the selected emulator is rendered. Switching views must not suspend or recreate unrelated Claude processes.

This preserves the complete Claude Code experience and avoids maintaining a partial clone of its UI. It also rules out tmux and Herdr-style visible panes as the primary architecture.

The initial implementation direction is Bun's native PTY API with OpenTUI's `EmbeddedTerminalRenderable`, which uses Ghostty's VT parser. This combination has been validated in the development environment, but the ownership model is more important than those particular dependencies.

## The Agent SDK Is A Session Tool, Not The Chat Runtime

Use supported SDK functions for session discovery, message reads, and historical forks. In particular, historical branching is based on `forkSession(sessionId, { upToMessageId })` rather than direct transcript manipulation.

The initial SDK and CLI compatibility baseline is `@anthropic-ai/claude-agent-sdk` 0.3.239 with Claude Code 2.1.239. Upgrade them deliberately and verify session compatibility together.

Forked sessions do not include the source session's file-history snapshots. A historical conversation fork therefore does not provide historical file rewind. Because all branches share the current working tree, it also does not restore files to their state at the selected message.

## Branch Relationships Need Application Metadata

Claude sessions are persisted independently. Historical forking remaps message UUIDs and does not retain enough source-branch information for this application to reconstruct a reliable cross-session tree later.

Store only the missing relationship data, such as the child session, parent session, source message, and copied-prefix boundary. Keep it outside the repository under the user's XDG state directory, scoped by project. Write it defensively so a failed or partial update cannot damage Claude's transcripts.

Sessions and forks not created or recorded by `claude-tree` should still be usable. When their ancestry cannot be established reliably, show them as independent roots rather than guessing from message content.

## User Messages Replay From The Previous Assistant

Forking an assistant message copies the transcript through that exact SDK message. Forking a user message has different semantics: copy through its nearest earlier assistant, then open the child with the selected user text in Claude's composer without submitting it. Transcript order is authoritative, and adjacent messages may have the same role.

A user replay with no assistant ancestor copies a zero-message prefix but remains in the same conversation family. The graph represents all top-level roots as children of one synthetic empty-history origin. That origin is application state rather than a Claude message or session: it is never rendered, selected, counted, or used as a fork target, and no connectors are drawn from it.

The validated Claude Code 2.1.239 baseline provides a hidden `--prefill` option that initializes the stock interactive composer. It is preferable to timing simulated PTY keystrokes, but it is not a public compatibility surface. Claude Code upgrades must explicitly revalidate it. Prompts that cannot be represented as text fail closed rather than silently losing content.

Claude Code does not expose semantic composer state. The application may show a conservative, in-memory preview parsed from the visible input box when leaving a live terminal, but it must mark that preview as approximate and never persist it as transcript or relationship state.

Claude Code also does not expose semantic generation state to its terminal host. Observe its OSC terminal-title activity indicator directly from PTY output so hidden processes remain observable, with conservative matching against the last visible Claude screen as a fallback. An idle transition triggers a fresh SDK transcript read; keep the live endpoint visually pending until the rebuilt graph is ready so a completed assistant message and its following draft leaf appear atomically. Keep activity state ephemeral and informational: process exit remains authoritative, and detection must not control permissions or inject input.

## Graph Navigation Preserves Cursor Intent

Vertical navigation follows visible graph edges: up selects the parent and down selects a child. It never falls diagonally into a neighboring branch. Horizontal navigation uses the same world-space node layout as rendering and may cross branches, root chains, and viewport boundaries.

Navigation retains a preferred world-space column for vertical movement and depth for horizontal movement, plus the exact source of the latest transition. This mirrors a text-editor cursor: moving through an ambiguous parent or a shorter neighboring branch and then reversing returns to the node that was left. Blocked movement does not discard that intent. Rebuilding or resizing the graph resets it. The synthetic family origin does not participate in navigation.

## One Process For The Initial Product

Live PTYs belong to the foreground `claude-tree` process. Closing the application gracefully terminates its child Claude processes and restores the host terminal. Persisted sessions can be resumed on the next launch.

A daemon/client split is intentionally deferred. Add one only if surviving application exit becomes a real requirement; do not pay the lifecycle and IPC complexity merely to imitate a terminal multiplexer.

Do not run two live processes against the same Claude session ID, because concurrent transcript ownership is unsafe. Different branches may run concurrently.

## Input And View Ownership

The application has two modes: navigator and embedded terminal. In terminal mode, input belongs to Claude except for one configurable host escape chord. The initial default is `Ctrl+Space`, selected explicitly for returning to the navigator.

Avoid intercepting ordinary Claude keys. Host shortcuts should be mode-specific, visible to the user, and configurable when practical.

## Shared Working Tree Is Deliberate

Every Claude process starts in the same project directory. This allows branches to observe and build on the same filesystem state, but it also permits simultaneous edits and conflicts. The application should communicate status accurately and must not claim branch-level file isolation or silently create worktrees.

Future agents have latitude in UI composition, state modeling, testing strategy, and dependency choices. Changes should be judged against the goals in `project-goals.md` and the behavioral constraints above.
