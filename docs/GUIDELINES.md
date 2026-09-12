# Code Guidelines

## General

Follow general code best practices, such as:

- IMPORTANT: Always aim for the most correct design rather than preserving accidental behavior. Snowcloud is in alpha, so internal compatibility is not a requirement unless explicitly documented. Do not add legacy behavior, migrations, or version increments merely because an internal representation changes. Strict recovery and ownership safety still apply: incompatible persisted state must fail closed rather than being silently ignored or recreated.
- Avoid redundant duplication: if a string or a magic number is being duplicated multiple times, extract it to a single shared place.
- Use descriptive and well-chosen names for variables, functions, and classes.
- Each function should do one 'job' and do it well.
- If you're writing a long comment to explain behavior, that behavior is usually wrong. Code should be largely self-explanatory, though some commenting can be good.
- Avoid reinventing the wheel when a well-known library or tool can accomplish the task effectively.

## TypeScript And Effect

- Model long-lived processes, scopes, subscriptions, temporary files, and terminal surfaces as acquired resources with explicit, idempotent cleanup. Finalizers are mandatory backstops, not substitutes for a lifecycle API that can report incomplete cleanup.
- Keep application-state mutation behind the application actor. Asynchronous commands and callbacks should return typed events carrying stable owner and sequence identities rather than retaining mutable state references.
- Make shutdown and rollback uninterruptible only around the ownership transition that must be atomic. Keep external waits individually bounded, verify the resulting state, and preserve ownership when absence cannot be proven.
- Test timeouts, retries, heartbeats, and escalation with Effect's `TestClock` or controlled deferred values. Do not add real sleeps to deterministic unit tests.

## Persistence

- Provider state schema v3 is strict and reset-only. Do not add implicit migration, deletion, quarantine, fallback parsing, or automatic recreation for incompatible persisted state.
- Write related metadata, per-instance navigation, terminal ownership, and identity-adoption changes through the unified provider-state transaction when they must remain atomic.
- Treat provider mutations as ambiguous after they may have been sent and their response is unavailable. Do not retry or infer success; reconcile from a full provider snapshot.

## Agents

- If subagents are needed, tell those subagents not to create their own subagents, unless explicitly told otherwise.

## Git

- Use concise commit messages in the existing `scope: imperative summary` style, such as `server: add router integration tests` or `core: add app config env parsing`.
- Prefer scopes that match the touched area or crate, such as `rust`, `server`, `db`, `web`, or `core`.

## Rust

- Prefer proven crates over custom implementations when they fit the problem.
- Check current crate versions with Cargo before recommending or adding dependencies.
- Do not over-pin versions in `Cargo.toml`; rely on `Cargo.lock` for exact resolution.
- Group imports by origin with blank lines between standard library, external crates, and local crates:

```rust
use std::fs;
use std::path::PathBuf;

use anyhow::Context;
use serde::Deserialize;

use repo_crate::config::AppConfig;
use repo_crate::server::Server;
```
