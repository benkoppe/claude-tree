# Lifecycle review and provider-evidence plan

Status: shutdown audit and regression coverage completed; provider-evidence changes below are a proposed follow-up, **not implemented by this review**. Real stock Claude/Codex shutdown validation on the slow VM remains a merge gate. This document does not certify deadlock freedom or provider durability.

## Shutdown dependency audit

The important distinction is between an internal wait cycle and an external resource that has not settled. Removing an observation deadline is correct only if it does not create a cycle whose participants can no longer progress.

| Wait | Completion producer | How shutdown preserves progress |
| --- | --- | --- |
| Runtime begin/finish acknowledgment | Application actor | Control inbox bypasses ordinary work; actor remains alive through FinishShutdown. Actor abandonment settles replies. |
| Provider identity acknowledgment | Actor transition completion or rejection | BeginShutdown drains admitted identity events; AbortTransitionAcknowledgments rejects pending barriers before command-scope closure. New callbacks are rejected synchronously after admission stops. |
| Owner-local transition serialization | Identity operation holding the owner permit | Supervisor cancels the owner before cleanup waits for serialization. Actor rejects unresolved identity barriers concurrently with supervisor shutdown. |
| Command-scope close | Command fibers and finalizers | Actor cancellation uses interrupt requests, not joins inside its handler. Commands deliver completion into unbounded queues; actor need not join them to process shutdown controls. |
| Read-worker progress acknowledgment | Actor progress consumer | Parent close settles pending read callers/queues; worker cancels progress acknowledgment waits with the owning job. Cleanup does not require acceptance of further graph publications. |
| Navigation flush/close | Navigation writer and metadata worker | Actor stays available; metadata remains open through navigation and command drain. Worker stops admission only after those producers are settled, then drains admitted transactions. |
| Group termination and PTY settlement | OS process group and native stream | Cleanup signals descendants before awaiting the stream. Failed group verification forces PTY closure without claiming absence or releasing the guard. |
| Native acquisition/write/fsync and retained close | Native completion callback or Promise | Owned settlement stays live independently of cancelled observers. Scopes and guards remain retained until verified release. |

Reviewed entry points: `src/application/runtime.ts` (BeginShutdown, AbortTransitionAcknowledgments, performShutdown, actor abandonment), `src/application/command-executor.ts`, `src/application/navigation-writer.ts`, `src/services/terminal-supervisor.ts` (transition, cleanup, shutdown), `src/infrastructure/providers/read-service.ts`, `src/infrastructure/providers/read-worker.ts`, and `src/cli.ts`.

No new internal wait cycle was identified in those paths. This is a bounded source audit, not proof about every native/library implementation. An admitted SQLite transaction, uncancellable native operation, provider close, or PTY stream can still remain externally pending. Pending is not successful release; completed failure is not pending. Retained close results and shutdown failures preserve that distinction.

The second-signal handler invokes forced exit directly from a native event callback. It does not enqueue an actor message, acquire an owner permit, or wait for a cleanup fiber. Its listener scope surrounds application finalization. It therefore remains callable while Effect cleanup waits, provided the JavaScript event loop can run. Synchronous event-loop starvation, a blocked native callback, or a blocked synchronous terminal/warning write can still prevent timely handling; no in-process signal mechanism guarantees recovery from these conditions.

### Added regression coverage

`test/next/application-workflows.test.ts` now checks:

- An identity event queued immediately before shutdown settles its barrier before terminal cleanup waiting on that barrier completes. Either accepted or rejected settlement is safe; an unresolved barrier is not.
- An admitted, uninterruptible navigation write can remain pending beyond two minutes of virtual time without closing persistence early. The actor still answers state queries and the second-signal callback remains callable. Completing the write permits normal shutdown.

Existing coverage also checks direct shutdown against queued ordinary intents, late command finalization, late launch cancellation, read-worker close with stalled progress, unknown group verification retaining ownership, and second-signal dispatch during scope finalization. Signal tests use an injected callback rather than killing the test runner. They do not establish real terminal restoration, resumability, or stock-provider exit behavior.

## Retrieved provider evidence

Reviewed against the repository's pinned baselines, not a promise about arbitrary externally installed versions.

### Claude: SDK 0.3.251 / CLI 2.1.251

- [Session API documentation](https://platform.claude.com/docs/en/agent-sdk/sessions) and local `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` describe `forkSession` as copying records, remapping UUIDs, and returning a child session ID. `getSessionMessages` returns reconstructed messages; neither reviewed return type carries a snapshot revision token.
- The pinned filesystem implementation in `sdk.mjs` delegates `forkSession` to a routine that awaits its record writer. That writer ends the write stream and awaits `finish` before returning the ID. This is stronger than merely dispatching a mutation, but is **not** an fsync guarantee, an atomic multi-read snapshot, or a guarantee that discovery and reconstruction agree immediately. Minified private symbols are inspection evidence, not an integration interface.
- Current `readAndValidateCreatedFork` distinguishes `Short` from contradictory `Invalid` inside its validator, but collapses exhausted short/missing/read-failure observations into an `Invalid` result. The public fallback correctly saves no ancestry; its classification loses whether verification is unresolved or contradicted.

### Codex: 0.150.1

- [App-server documentation](https://developers.openai.com/codex/app-server/) describes `thread/fork`, `thread/read`, and typed turn notifications.
- Pinned [Thread](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/schema/typescript/v2/Thread.ts), [ThreadForkResponse](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/schema/typescript/v2/ThreadForkResponse.ts), and [ThreadReadResponse](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/schema/typescript/v2/ThreadReadResponse.ts) expose identity, `forkedFromId`, turns, and metadata timestamps, but no snapshot revision token for these operations. `updatedAt` is not such a token.
- The pinned [thread processor](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/thread_processor.rs), `thread_fork_inner`, materializes a persistent fork and reads its stored history before sending its response. The application already validates that returned prefix rather than waiting for catalogue visibility. Do not add a redundant polling lifecycle to this path.
- `turn/completed` is stronger than screen-idle observation, but a notification is not an atomic revision binding a separate read. Parent identity alone cannot establish exact copied-message correspondence.

Conclusion: neither reviewed provider interface justifies replacing history confirmation with an invented revision guarantee. Matching reads remain a heuristic, especially when an external invocation can write or rewind the same session.

## Follow-up design

### 1. Separate mutation and verification facts

Use explicit operation states, owned by the branch command and returned as typed events:

1. Not dispatched: cancellation can safely report no mutation.
2. Dispatched without a usable response: ambiguous; reconcile a full snapshot, never repeat the mutation or guess its child.
3. Created with a validated distinct child ID: preserve that identity even if subsequent reads fail, time out, or are cancelled.
4. Verification pending: missing, short, or unavailable evidence; no ancestry assertion.
5. Verification contradicted: concrete incompatible identity, provenance, ordering, or payload; preserve the child independently and report the contradiction.
6. Verified: persist exact correspondence and publish the branch through the actor.

Catalogue discovery is a separate observation, not a prerequisite for state 3 and not proof of state 6. Cancellation cannot revert state 3 to “nothing created.” A malformed response after dispatch remains ambiguous, not confirmed creation.

### 2. Make visibility verification cancellable, not time-authoritative

First introduce distinct `Verified`, `Unverified`, and `Contradicted` validation results. Add a fixed reason code for unavailable/short evidence rather than converting every exhausted retry to invalid ancestry. Extend the public known-child outcome with typed verification status; the actor displays an independent child until correspondence is verified.

Then replace Claude's total-attempt cap for genuinely transient visibility with a capped-backoff, cancellable verification loop with no default wall-clock work deadline. Do not reuse this loop for permanently malformed/unsupported input or contradictory evidence. An explicit caller observation budget or user cancellation ends observation as **unverified**, retaining the known child; it does not repeat `forkSession`. Existing bounded completion polling and history confirmation are separate policies and remain bounded.

This needs a user-visible verification-in-progress/cancel action before enabling indefinite verification by default. Navigation, other terminal actions, and quit must remain responsive. Keep the operation-local source snapshot and child identity in memory while verification is active. On cancellation, preserve the child independently and provide a read-only verification retry for the known child while that evidence remains available. A repeated Fork action must not masquerade as such a retry.

Retry must validate against the original captured source evidence, not a parent that may have since rewound. Retrying after restart without sufficient source evidence remains independent; do not add transcript persistence, durable validation journals, provider-file edits, or crash recovery. A known but unreadable child is not automatically launchable: resume admission must still succeed through the provider's normal checks. Releasing retained evidence ends the opportunity to infer ancestry, not the child's existence.

### 3. Keep history consistency claims honest

Keep owner/observation-revision invalidation, complete-versus-limited coverage, exact payload checks, and retained accepted history. Do not use catalogue timestamps, mtime, idle titles, elapsed delay, or two matching reads as revision tokens. Expose unresolved/unstable history through the existing details status without inventing a rewind or completing a turn.

Codex typed turn evidence can drive fresh reads and reject stale turns, but cannot guarantee those reads are atomic. Claude hooks and screen observations remain hints. If a future supported provider API supplies a revision-bound snapshot, add it behind the provider boundary, with tests rejecting stale revisions; do not synthesize one in the application core.

### Implementation and test gates

Land in separate reviewable changes: (1) result classification and UI status, (2) known-child read-only verification and cancellation, (3) cancellable visibility policy and progress UI. Only then enable unlimited transient observation. Keep Codex's response-based validation unchanged unless a concrete supported-version failure is demonstrated.

Required deterministic tests:

- Child visibility arriving after all former retry windows validates once, with exactly one mutation dispatch.
- Cancellation before dispatch is non-ambiguous; cancellation after dispatch without a response is ambiguous; cancellation after a valid child ID preserves an unverified child.
- Missing/short/read-failure evidence cannot become contradictory solely through elapsed time or attempts; actual provenance/payload contradictions fail closed immediately.
- Verification retry cannot dispatch a mutation, follows the captured source evidence despite parent rewind, and writes ancestry only after exact validation.
- A known but unreadable child cannot be launched as if resume were confirmed; unsupported permanent read failures do not loop forever.
- A slow verification does not block navigation, quit, or unrelated endpoints; late verification cannot steal newer focus or acknowledge an obsolete command.
- Changing reads terminate bounded history confirmation as unstable; matching reads remain explicitly heuristic; limited coverage and stale owner/observation results cannot prove completion.

Manual merge gate remains unchanged: exercise generation, launch, identity adoption, terminal restoration, second-signal forced exit, session resumability, and absence of owned children after **normal** shutdown with both stock providers on the slow VM. Failures block merge. Forced exit deliberately cannot guarantee writes or child termination.
