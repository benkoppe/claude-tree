# Slow-work timeout policy

## Objective

Slow machines and large histories must not make valid work fail merely because a
fixed wall-clock budget elapsed. Normal discovery, history reads/reconstruction,
fork creation/validation, provider startup, and durable foreground writes should
wait for their actual result or explicit cancellation, not an arbitrary total-work
deadline. Explicit finite budgets remain available at test/integration boundaries.

## Safety boundaries

- Preserve asynchronous execution outside the actor, bounded queues/concurrency,
  and rejection of obsolete results. Waiting longer must not freeze navigation.
- Quit must cancel pending productive work; resource finalizers still verify cleanup.
- Never retry a provider mutation after dispatch merely because waiting ended.
  Interruption can be ambiguous just as a timeout can be.
- Never interrupt a durable transaction in its commit phase. Cancel observation,
  retain exact ownership/mutation evidence, and reconcile late results.
- Keep finite process termination, scope/resource close, shutdown drain, and
  shutdown persistence-observation limits. These report incomplete cleanup rather
  than declaring an unresolved owner absent.
- Retry/backoff, debounce, screen confirmation, heartbeat, and protocol admission
  limits are not productive-work deadlines; keep their distinct semantics.

## Implementation checklist

- Audit both providers, diagnostic reads, provider startup, lifecycle persistence,
  transaction lock contention, and navigation worker admission.
- Remove default total-work deadlines without replacing them with larger constants.
- Retain explicit bounded overrides and strict validation/mutation ambiguity.
- Add controlled-clock regressions that finish successfully beyond former budgets,
  plus cancellation/quit regressions for indefinitely pending work.
- Verify cleanup and uncertain ownership regressions still fail closed.
- Update architecture and user-facing documentation; run full checks and an
  independent adversarial review before publication.

## Audit and implementation

- Claude SDK calls, imports, history reconstruction, executable lookup, and fork
  work no longer inherit 5/10-second defaults. An explicitly configured child
  validation budget begins after creation rather than before source acquisition.
- Codex metadata operations and protocol requests/notifications no longer inherit
  15/30-second defaults. Metadata process cleanup has a separate finite budget.
- Provider acquisition, proxy identity acknowledgment, and read-only diagnostics
  no longer have default productive deadlines. Explicit finite limits use a small
  shared helper that does not allocate a timer when no limit is supplied.
- Supervisor productive persistence/identity and derivation waits observe owner
  cleanup and shutdown signals. Transactions remain admitted and tracked separately
  from their cancellable observers; cleanup reconciliation remains bounded.
- Ordinary live-lock contention and lock reads, plus navigation worker readiness,
  no longer time out solely because work is slow. Liveness uncertainty, abandoned
  reclaim claims, and worker close keep their safety semantics.
- Authenticated hook HTTP admission, optional Herdr/build-info subprocesses,
  process liveness/termination, and resource/shutdown cleanup retain finite limits.
  They are bounded safety or optional observational boundaries, not history-work
  patience. Timer expiry never establishes resource absence or transcript truth.

The first independent metadata review found a pre-existing concurrent recoverable
lock unlink race. A delayed reclaimer could delete a replacement owner's lock;
the repair reuses exclusive filesystem reclaim coordination, with deterministic
replacement-lock/no-overlap coverage and an independent re-review.
That re-review also reproduced lock-token reuse when executing the same Effect
again after a failed release. Lock identities must be allocated per execution,
separately from stable document mutation tokens, so an old reclaimer cannot match
a new live lock. This second repair is covered by a reusable-Effect race regression.

The first cancellation reviews also found two dependencies previously hidden by
deadlines: same-session stop queued behind pending launch admission, and connected
Codex initialization did not observe sidecar process exit. Repairs publish exact
launch cancellation before waiting for admission and observe startup process death
without imposing a productive deadline. Slow healthy connection handshakes must
not be repeatedly abandoned by short readiness-probe timers. These repairs passed
independent re-review. Productive override validation is shared: omitted
means no deadline; NaN, infinity, zero, and negative limits are rejected.
The subsequent stop review reproduced an unrelated replacement launch acquiring
the session key ahead of a stop waiting for the cancelled predecessor. Stop must
await the captured launch's own completion and reconcile that exact owner, not
queue behind the replacement's productive work. A deterministic queued-launch
regression covers both completion and replacement noninterference.

## Validation

- Full check: typecheck and all 1,056 tests pass.
- Vendor reproducibility and whitespace checks pass.
- Final independent provider review: no blockers; 161 targeted tests passed.
  Readiness observes process death through connection, initialization, and retry
  waits, with no default handshake cutoff or auth/protocol retry.
- Final independent storage review: no blockers; 63 metadata/provider-state tests
  passed. Fresh lock identities, exclusive claims, exact-token release, and
  conservative unknown liveness were reviewed.
- Final independent supervisor review: no blockers; 136 tests passed. Stop awaits
  its captured launch rather than a queued replacement, checks exact-owner cleanup
  evidence, and fails closed on bounded rollback or persistence uncertainty.
- Supervisor, metadata, Codex provider/acquisition, and diagnostic suites passed
  five repeated runs (1,185 executions before the last two stop regressions).
  The final 136-test supervisor suite also passed five runs (680 executions).
  Repetition checks stability; it is not exhaustive concurrency exploration.
- Installed stock Claude Code and Codex passed isolated startup/shutdown checks
  with the new defaults, real Bun PTYs, production rendering, and filesystem
  ownership persistence. Each acquired one owner and released it on shutdown;
  zero prompts were submitted and no existing conversations were modified.

Controlled-clock tests establish success beyond the old limits and cancellation
of pending work. Stock startup/shutdown checks do not establish live approvals,
forks during generation, actual slow-VM performance, or crash recovery.

No claim of faster synchronous CPU-bound reconstruction is made. Removing false
deadlines does not supply CPU preemption or prove real slow-VM performance.
