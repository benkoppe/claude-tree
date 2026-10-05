# Lifecycle review and provider evidence

Status: shutdown audit, provider visibility changes, and deterministic regression coverage implemented. Real stock Claude/Codex shutdown validation on the slow VM remains a merge gate. This document does not certify deadlock freedom, atomic provider snapshots, or provider durability.

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
- `readAndValidateCreatedFork` now preserves pending, unavailable, and contradicted classifications. Short records are checked for contradictory evidence before being classified as incomplete.

### Codex: 0.150.1

- [App-server documentation](https://developers.openai.com/codex/app-server/) describes `thread/fork`, `thread/read`, and typed turn notifications.
- Pinned [Thread](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/schema/typescript/v2/Thread.ts), [ThreadForkResponse](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/schema/typescript/v2/ThreadForkResponse.ts), and [ThreadReadResponse](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/schema/typescript/v2/ThreadReadResponse.ts) expose identity, `forkedFromId`, turns, and metadata timestamps, but no snapshot revision token for these operations. `updatedAt` is not such a token.
- The pinned [thread processor](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/thread_processor.rs), `thread_fork_inner`, materializes a persistent fork and reads its stored history before sending its response. **Correction to the original review:** the application performs a separate `thread/read` after that response, not direct prefix validation of the response alone. That additional read can fail or lag; it now retains the confirmed child and supports read-only verification retry. No catalogue visibility prerequisite is added.
- `turn/completed` is stronger than screen-idle observation, but a notification is not an atomic revision binding a separate read. Parent identity alone cannot establish exact copied-message correspondence.

Conclusion: neither reviewed provider interface justifies replacing history confirmation with an invented revision guarantee. Matching reads remain a heuristic, especially when an external invocation can write or rewind the same session.

## Implemented design

### 1. Separate mutation and verification facts

Creation and verification facts are owned by the branch command and returned as typed events:

1. Not dispatched: cancellation can safely report no mutation.
2. Dispatched without a usable response: ambiguous; reconcile a full snapshot, never repeat the mutation or guess its child.
3. Created with a validated distinct child ID: preserve that identity even if subsequent reads fail, time out, or are cancelled.
4. Verification pending: missing or compatible short evidence; no ancestry assertion. General read failures and unsupported evidence stop automatic polling as unavailable, with an explicit retry action.
5. Verification contradicted: concrete incompatible identity, provenance, ordering, or payload; preserve the child independently and report the contradiction.
6. Verified: persist exact correspondence and publish the branch through the actor.
7. Verified but metadata persistence failed: retain verified evidence for metadata-only retry; never repeat provider creation.

Catalogue discovery is a separate observation, not a prerequisite for state 3 and not proof of state 6. Cancellation cannot revert state 3 to “nothing created.” A malformed response after dispatch remains ambiguous, not confirmed creation.

### 2. Make visibility verification cancellable, not time-authoritative

`CreatedIndependentSession.verification` carries a typed status and fixed reason code, separately from mutation ambiguity. `BranchVerificationReceipt` exposes read-only verification while its provider closure retains the original source evidence. `BranchCreated` publishes the receipt before subsequent reads. The actor projects that child independently and stores only presentation status in `ApplicationState.branchVerifications`; receipts remain in its process-local command registry.

`src/services/branch-verification.ts` polls compatible pending evidence with capped backoff and no default total-attempt or work deadline. Ordinary read errors and unsupported input stop automatic polling; contradictory evidence stops immediately. Claude retains small bounded read batches, but those batches no longer impose a total visibility limit. Explicit validation budgets span pending reads and end observation as **unverified**, retaining the known child. Existing bounded completion polling and history confirmation remain separate and bounded.

The footer shows verification progress and `v` cancellation or retry. It manages the selected child's receipt when available, otherwise an active verification, otherwise a retryable receipt. Selecting a different child selects its own action; cancellation and retry use distinct presentation action keys so a running retry cannot block its cancel action. Navigation, other terminal actions, and quit remain independent. A repeated Fork action is not a verification retry. Status and failure explanations appear in the child's existing details view.

Retry validates against the captured source evidence, not a parent that may have since rewound. Unverified children are not automatically launched. Explicit independent opening retires their receipts before normal resume and ownership admission. Successful read-only retry saves ancestry without changing focus or launching a terminal. Receipts are released on success, contradiction, independent opening, navigator removal, or shutdown; cancellation retains them for retry. Zero-prefix Claude replay is a preparation, not an already persisted child: after successful metadata-only retry, retain its lazy prepared launch for explicit Open, rather than attempting provider resume. After restart there is no receipt and no inferred missing ancestry. No schema changes, transcript persistence, provider-file edits, or crash recovery were added.

Native Claude mutation settlement is uninterruptible because its Promise cannot be cancelled. The actor can reject its observer promptly, but command finalization still awaits settlement and publishes late confirmed child identities without changing focus. Explicit mutation timeouts cannot abandon that native operation; an actual late response takes precedence over an earlier timeout fallback. Codex's dispatch callback runs at native write invocation, distinguishing queued cancellation from possibly committed requests.

### 3. Keep history consistency claims honest

Keep owner/observation-revision invalidation, complete-versus-limited coverage, exact payload checks, and retained accepted history. Do not use catalogue timestamps, mtime, idle titles, elapsed delay, or two matching reads as revision tokens. Expose unresolved/unstable history through the existing details status without inventing a rewind or completing a turn.

Codex typed turn evidence can drive fresh reads and reject stale turns, but cannot guarantee those reads are atomic. Claude hooks and screen observations remain hints. If a future supported provider API supplies a revision-bound snapshot, add it behind the provider boundary, with tests rejecting stale revisions; do not synthesize one in the application core.

### Implementation and test gates

The implementation is split into provider evidence/receipts, actor/UI cancellation and retry, and finite-budget regressions/documentation. Both providers retain their strict copy-validation rules. General history reconciliation was not changed into a revision guarantee.

Deterministic coverage includes:

- Child visibility arriving after all former retry windows validates once, with exactly one mutation dispatch.
- Cancellation before dispatch is non-ambiguous; cancellation after dispatch without a response is ambiguous; cancellation after a valid child ID preserves an unverified child.
- Missing/short/read-failure evidence cannot become contradictory solely through elapsed time or attempts; actual provenance/payload contradictions fail closed immediately.
- Verification retry cannot dispatch a mutation, follows the captured source evidence despite parent rewind, and writes ancestry only after exact validation.
- A known but unreadable child cannot be launched as if resume were confirmed; unsupported permanent read failures do not loop forever.
- A slow verification does not block navigation, quit, or unrelated endpoints; late verification cannot steal newer focus or acknowledge an obsolete command.
- Changing reads terminate bounded history confirmation as unstable; matching reads remain explicitly heuristic; limited coverage and stale owner/observation results cannot prove completion.
- Explicit finite verification budgets preserve known children instead of reporting mutation ambiguity or repeatedly resetting the budget.
- Shutdown waits for admitted native verification settlement, closes persistence afterward, and neither saves late ancestry nor launches a child from a cancelled command.
- Metadata-only retry of an unstarted zero-prefix replay does not auto-launch it, survives refresh, and allows explicit Open through the original prepared launch.

Manual merge gate remains unchanged: exercise generation, launch, identity adoption, terminal restoration, second-signal forced exit, session resumability, and absence of owned children after **normal** shutdown with both stock providers on the slow VM. Failures block merge. Forced exit deliberately cannot guarantee writes or child termination.
