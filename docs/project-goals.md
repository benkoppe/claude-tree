# Project Goals

## Purpose

`claude-tree` is a terminal application for exploring Claude Code conversations as a tree. It should make it easy to move among related conversations, branch from an earlier message, and let several branches continue running without turning the user's terminal into a collection of panes.

The project exists to add navigation and orchestration around Claude Code, not to replace Claude Code itself.

## Core Experience

- Present a focused, full-screen navigator for sessions, messages, and branches.
- Open one selected conversation as the only visible terminal surface.
- Keep other opened conversations alive in the background while the application is running.
- Return quickly between the navigator and any live conversation without losing its terminal state.
- Allow a conversation to fork from a selected historical message while leaving the source conversation unchanged.
- Use one shared working tree for all branches.

The navigator and a selected Claude terminal are mutually exclusive views. A multipane dashboard is not the intended interface.

## Preserve Claude Code

Users should interact with the stock, interactive Claude Code TUI. Permissions, slash commands, hooks, MCP servers, plugins, keybindings, rewind behavior, and future Claude Code features should continue to work without being reimplemented by this project.

The application may use supported Claude SDK APIs to discover and organize sessions, but it should not become a custom Agent SDK chat frontend unless the product goals fundamentally change.

## Reliability And Scope

- Claude's own transcripts remain the source of truth for conversation content.
- Application-owned data should be limited to relationships and UI state that Claude does not persist.
- Exiting `claude-tree` may stop active child processes, but their persisted Claude sessions must remain resumable later.
- Concurrent branches are intentionally allowed to operate on the same files. Avoid hiding this fact or implying worktree isolation.
- Prefer a small, understandable local application over daemon or distributed infrastructure unless a later requirement justifies that complexity.

## Non-Goals

- Reimplementing Claude Code's conversation UI or permission system.
- Displaying every conversation in a separate pane or terminal window.
- Using tmux as the process or presentation layer.
- Automatically isolating branches into Git worktrees.
- Reconstructing or editing Claude transcript files by hand.

Implementation details may evolve when better tools or APIs become available. Preserve the experience and boundaries above rather than treating an early implementation as permanent.
