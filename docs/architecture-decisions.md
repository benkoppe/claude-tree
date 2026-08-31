# Architecture Decisions

This document records decisions that shape the project and the reasons behind them. Specific libraries and versions are an initial baseline and can be upgraded or replaced when a better implementation preserves these constraints.

## Providers Are Explicit Application Dependencies

One provider is selected when the application starts and is injected into the application controller. The provider owns session discovery, transcript normalization, new and resumed session launch preparation, historical branch semantics, compatibility checks, and interpretation of provider-specific terminal output. The application core owns graph construction, navigation, rendering, process lifecycle, and relationship persistence.

Session and message identifiers are opaque provider strings. The core must not assume UUIDs, provider CLI flags, transcript payload formats, or a particular branching implementation. Historical branch results expose validated parent-to-child message correspondence so the graph can merge shared history without understanding how the provider created it.

Branching is an explicit capability. A provider that cannot branch through a supported interface must report that limitation rather than editing transcripts or simulating fragile terminal input. The initial provider is Claude Code, and only one provider's sessions appear in a given application invocation.

## Stock Agent TUIs Run In Owned PTYs

Each live branch is a normal interactive provider process attached to its own pseudo-terminal and terminal emulator state. The application forwards input to the selected process and continues consuming output from every hidden process.

Only the selected emulator is rendered. Switching views must not suspend or recreate unrelated Claude processes.

This preserves the complete stock-agent experience and avoids maintaining a partial clone of its UI. It also rules out tmux and Herdr-style visible panes as the primary architecture.

The generic terminal manager executes provider-prepared commands and delegates activity and draft observation to a provider-created terminal observer. The initial implementation uses Bun's native PTY API with OpenTUI's `EmbeddedTerminalRenderable`, which uses Ghostty's VT parser. This combination has been validated in the development environment, but the ownership model is more important than those particular dependencies.

## Provider APIs Are Session Tools, Not The Chat Runtime

Use supported provider APIs for session discovery, message reads, and historical forks. For the Claude adapter, historical branching is based on `forkSession(sessionId, { upToMessageId })` rather than direct transcript manipulation.

The initial SDK and CLI compatibility baseline is `@anthropic-ai/claude-agent-sdk` 0.3.239 with Claude Code 2.1.239. Upgrade them deliberately and verify session compatibility together.

Forked sessions do not include the source session's file-history snapshots. A historical conversation fork therefore does not provide historical file rewind. Because all branches share the current working tree, it also does not restore files to their state at the selected message.

## Branch Relationships Need Application Metadata

Claude sessions are persisted independently. Historical forking remaps message UUIDs and does not retain enough source-branch information for this application to reconstruct a reliable cross-session tree later.

Store only the missing relationship data: the child session, parent session, source message, and validated correspondence between shared parent and child messages. Keep it outside the repository under the user's XDG state directory, scoped by project and provider. Write it defensively so a failed or partial update cannot damage provider transcripts.

Sessions and forks not created or recorded by `claude-tree` should still be usable. When their ancestry cannot be established reliably, show them as independent roots rather than guessing from message content.

## User Messages Replay From The Previous Agent

Forking an agent message copies the transcript through that exact SDK message. Forking a user message has different semantics: copy through its nearest earlier agent, then open the child with the selected user text in Claude's composer without submitting it. Transcript order is authoritative, and adjacent messages may have the same role.

A user replay with no agent ancestor copies a zero-message prefix but remains in the same conversation family. The graph represents all top-level roots as children of one synthetic empty-history origin. That origin is application state rather than a Claude message or session: it is never rendered, selected, counted, or used as a fork target, and no connectors are drawn from it.

The validated Claude Code 2.1.239 baseline provides a hidden `--prefill` option that initializes the stock interactive composer. It is preferable to timing simulated PTY keystrokes, but it is not a public compatibility surface. Claude Code upgrades must explicitly revalidate it. Prompts that cannot be represented as text fail closed rather than silently losing content.

Claude Code does not expose semantic composer state. The application may show a conservative, in-memory preview parsed from the visible input box when leaving a live terminal, but it must mark that preview as approximate and never persist it as transcript or relationship state.

Claude Code also does not expose semantic generation state to its terminal host. Observe its OSC terminal-title activity indicator directly from PTY output so hidden processes remain observable, with conservative matching against the last visible Claude screen as a fallback. An idle transition triggers a fresh SDK transcript read; keep the live endpoint visually pending until the rebuilt graph is ready so a completed agent message and its following draft leaf appear atomically. Keep activity state ephemeral and informational: process exit remains authoritative, and detection must not control permissions or inject input.

## Graph Navigation Preserves Cursor Intent

Vertical navigation follows visible graph edges: up selects the parent and down selects a child. It never falls diagonally into a neighboring branch. Horizontal navigation uses the same world-space node layout as rendering and may cross branches, root chains, and viewport boundaries.

Navigation retains a preferred world-space column for vertical movement and depth for horizontal movement, plus the exact source of the latest transition. This mirrors a text-editor cursor: moving through an ambiguous parent or a shorter neighboring branch and then reversing returns to the node that was left. Blocked movement does not discard that intent. Rebuilding or resizing the graph resets it. The synthetic family origin does not participate in navigation.

## One Process For The Initial Product

Live PTYs belong to the foreground `claude-tree` process. Closing the application gracefully terminates its child Claude processes and restores the host terminal. Persisted sessions can be resumed on the next launch.

Shutdown releases the navigator and terminal emulators immediately, then remains in the foreground for a short, bounded cleanup of each owned agent process group. Keep PTYs open during the graceful termination window so the agent can finish its signal handling; escalate surviving process groups and close their PTYs before the application exits.

A daemon/client split is intentionally deferred. Add one only if surviving application exit becomes a real requirement; do not pay the lifecycle and IPC complexity merely to imitate a terminal multiplexer.

Do not run two live processes against the same Claude session ID, because concurrent transcript ownership is unsafe. Different branches may run concurrently.

## Input And View Ownership

The application has two modes: navigator and embedded terminal. In terminal mode, input belongs to the selected agent except for one configurable host escape chord. The initial default is `Ctrl+Space`, selected explicitly for returning to the navigator.

Avoid intercepting ordinary agent keys. Host shortcuts should be mode-specific, visible to the user, and configurable when practical.

## Shared Working Tree Is Deliberate

Every agent process starts in the same project directory. This allows branches to observe and build on the same filesystem state, but it also permits simultaneous edits and conflicts. The application should communicate status accurately and must not claim branch-level file isolation or silently create worktrees.

Future agents have latitude in UI composition, state modeling, testing strategy, and dependency choices. Changes should be judged against the goals in `project-goals.md` and the behavioral constraints above.
