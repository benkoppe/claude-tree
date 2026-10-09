# Project Goals

## Purpose

`claude-tree` is a terminal application for exploring coding-agent conversations as a tree. Claude Code and Codex are the supported providers. It should make it easy to move among related conversations, branch from an earlier provider-supported boundary, and let several branches continue running without turning the user's terminal into a collection of panes.

The project exists to add navigation and orchestration around stock coding-agent interfaces, not to replace them.

## Core Experience

- Present a focused, full-screen navigator for sessions, messages, and branches.
- Open one selected conversation in its provider's stock TUI as the only visible terminal surface.
- Keep other opened conversations alive in the background while the application is running.
- Return quickly between the navigator and any live conversation without losing its terminal state.
- Allow a conversation to fork from a selected historical message while leaving the source conversation unchanged.
- Use one shared working tree for all branches.
- Keep each application invocation's navigation independent when multiple invocations use the same project and provider.

The navigator and a selected agent terminal are mutually exclusive views. A multipane dashboard is not the intended interface.

## Preserve The Agent TUI

Users should interact with the stock, interactive TUI supplied by the selected provider. Permissions, slash commands, hooks, MCP servers, plugins, keybindings, rewind behavior, and future provider features should continue to work without being reimplemented by this project.

The application may use supported provider APIs to discover and organize sessions, but it should not become a custom Agent SDK chat frontend unless the product goals fundamentally change.

Provider-specific session formats, branching rules, launch arguments, and terminal telemetry belong behind an explicit provider boundary. One application invocation uses one provider; aggregating unrelated providers into one navigator is not a current goal.

## Reliability And Scope

- The provider's own transcripts remain the source of truth for conversation content.
- Application-owned data should be limited to relationships and UI state that the provider does not persist.
- Serialize application-state changes through one actor per invocation, even when provider reads and terminal processes run concurrently.
- Never launch two terminals for the same provider session within one invocation. Across invocations, warn about a live session and allow an explicit user override; duplicate ownership is a user-accepted risk, not a hard persistence constraint.
- Acquire and release terminal and provider resources explicitly. A partially acquired terminal must not become visible. Keep incomplete cleanup process-local rather than persisting crash reservations.
- Exiting `claude-tree` may stop active child processes, but their persisted provider sessions must remain resumable later.
- Concurrent branches are intentionally allowed to operate on the same files. Avoid hiding this fact or implying worktree isolation.
- Prefer a small, understandable local application over daemon or distributed infrastructure unless a later requirement justifies that complexity.
- Support explicit workspace resume of semantic navigation and the visible provider session. Do not restore PTYs or automatically restart hidden agents.

## Non-Goals

- Reimplementing a provider's conversation UI or permission system.
- Displaying every conversation in a separate pane or terminal window.
- Using tmux as the process or presentation layer.
- Automatically isolating branches into Git worktrees.
- Reconstructing or editing provider transcript files by hand.
- Automatically recovering orphaned processes, reservations, launch artifacts, or identity journals after a crash.
- Silently deleting, resetting, or guessing incompatible application state. Recognized SQLite schemas use tested forward migrations; legacy JSON import is explicit, and unknown or corrupt state is preserved and rejected.

Implementation details may evolve when better tools or APIs become available. Preserve the experience and boundaries above rather than treating an early implementation as permanent.
