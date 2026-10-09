# Code Guidelines

## General

Follow general code best practices, such as:

- IMPORTANT: Always aim for the most correct design rather than preserving accidental behavior. claude-tree is in alpha, so internal compatibility is not a requirement unless explicitly documented. Do not add legacy behavior, migrations, or version increments merely because an internal representation changes. Incompatible persisted state must be rejected rather than silently ignored or recreated.
- Avoid redundant duplication: if a string or a magic number is being duplicated multiple times, extract it to a single shared place.
- Use descriptive and well-chosen names for variables, functions, and classes.
- Each function should do one 'job' and do it well.
- If you're writing a long comment to explain behavior, that behavior is usually wrong. Code should be largely self-explanatory, though some commenting can be good.
- Avoid reinventing the wheel when a well-known library or tool can accomplish the task effectively.

## TypeScript And Effect

- Keep `effect`, `@effect/platform-bun`, and `@effect/platform-node-shared` pinned to the same tested release. The shared adapter needs an explicit runtime dependency because the Bun adapter's prerelease range can resolve an incompatible newer adapter when installing the packed application without the repository lockfile.
- Model long-lived processes, scopes, subscriptions, temporary files, and terminal surfaces as acquired resources with explicit, idempotent cleanup. Finalizers are mandatory backstops, not substitutes for a lifecycle API that can report incomplete cleanup.
- Keep application-state mutation behind the application actor. Asynchronous commands and callbacks should return typed events carrying stable owner and sequence identities rather than retaining mutable state references.
- Keep normal resource cleanup completion-driven and idempotent, without default observation deadlines. Explicit caller deadlines may report incomplete cleanup but never prove release; retain time windows for signal escalation. Cleanup state is process-local; do not introduce persisted orphan recovery. OS-held session guards are advisory across invocations, with a user-confirmed override, and release automatically when the application exits.
- Test timeouts, retries, heartbeats, and escalation with Effect's `TestClock` or controlled deferred values. Do not add real sleeps to deterministic unit tests.
- Create filesystem test fixtures with `mkdtemp(join(tmpdir(), prefix))`, not hardcoded host or coding-harness directories. Tests must run independently and respect the platform's temporary directory; retain `realpath` where canonical project identity matters and clean up each owned fixture.

## Responsiveness Benchmark

Run `bun run benchmark:responsiveness` to measure startup and refresh using real SDK fixture reads, keyboard input, and OpenTUI rendering. It uses disposable data and does not launch agent terminals or modify real transcripts.

For a larger workload, use `BENCHMARK_SESSIONS=1000 BENCHMARK_RECORDS=100 bun run benchmark:responsiveness`. Add `--inline` to compare without read/projection workers; this retains the other optimizations, so it is not the original implementation. Run comparisons sequentially on the same machine without other heavy work.

`inputToVisibleSelection` waits for the matching actor acknowledgment, presentation delivery, and highlighted destination. It includes polling and test-renderer overhead. `sampledAcknowledgedFrameIntervals` includes 16 ms input pacing and is not native FPS. The p95 latency goal is 16.7 ms, not an automated pass/fail threshold; timings depend on machine load and Nix builds may reuse cached results. Keep this benchmark separate from flake checks and deterministic regression tests. It measures loading/refresh, not provider mutations or terminal acquisition.

## Persistence

- Application metadata lives in one private XDG SQLite database. Projects and session references have stable application identities; provider identities remain opaque. Do not persist transcripts, provider catalogue caches, or terminal ownership.
- Commit schema declarations and reviewed SQL migrations together. Use STRICT tables, scoped foreign keys, WAL, FULL synchronization, and short transactions. Upgrade only with exclusive OS schema access; never migrate underneath live persistence clients. Reject unknown schemas and corrupt state without deletion, fallback parsing, or recreation.
- Legacy v3 JSON is accepted only by the explicit importer, with its original strict structural, semantic, and canonical validation. Leave source files untouched and require legacy invocations to be closed before cutover.
- Write related metadata and per-instance navigation in one SQLite transaction when they must remain atomic. Workspace resume copies the requested navigation into a fresh invocation; it never shares a navigation writer with the original workspace. Navigation saves update only their workspace, not all shared metadata.
- Treat provider mutations as ambiguous after they may have been sent and their response is unavailable. Do not retry or infer success; reconcile from a full provider snapshot.
- Preserve a confirmed fork child separately from ancestry verification. Pending visibility is not contradictory evidence. Verification retries are read-only and use captured source evidence; never repeat the mutation, auto-launch an unverified child, or persist a verification receipt. Retain uncancellable mutation settlement through finalization, including late confirmed child identities.
- Never persist terminal owners, launch-resource inventories, or identity-adoption journals. Provider sidecars and temporary capability artifacts have ordinary scoped cleanup, not startup recovery.

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
