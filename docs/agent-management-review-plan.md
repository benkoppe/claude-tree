# Agent management adversarial review loop

This ledger records the initial orchestration revamp. Subsequent removal of
default productive-work deadlines and its separate review are documented in
[`timeout-policy.md`](timeout-policy.md); earlier acquisition deadline references
below describe that initial milestone, not the current default waiting policy.

## Constraints and acceptance

Preserve stock Claude Code/Codex TUIs, provider transcript truth, strict fork
integrity, forward-only identity adoption, mutation ambiguity, and fail-closed
durable ownership. No daemon, migration, outbox, or new generic plugin framework.

Each cycle: independent adversarial reviews → verify findings → smallest coherent
design → regression tests and implementation → full checks → independent re-review.
Do not equate a passing existing suite with completeness. Stop only with no
actionable reviewed blockers, or explicitly identify externally blocked checks.

## Cycle 1: known defects and independent review

Independent lifecycle and provider/protocol reviews drove the repairs below.

### Planned lifecycle repair

- Revalidate the requested identity when focusing an existing owner. Delay initial
  semantic processing until the launch transaction has completed its activation
  publication; never report an old identity for an already adopted owner.
- Release all admitted terminal surfaces immediately on shutdown. Start existing
  owner cleanup concurrently with launch rollback, then reconcile any owners that
  arrived during launch draining. Do not interrupt durable persistence transactions.
- Serialize identity mutations with owner-local cleanup. Claim destination aliases
  synchronously under the publication gate, commit persistence outside that gate,
  and publish the verified result under the gate. Keep uncertain aliases reserved.
- Regressions: reopen/adoption, unrelated focus/stop during identity persistence,
  shutdown with blocked rollback, adoption/stop/shutdown, and late registration.

### Integration and verification

- Exercise the real actor, provider adapter, supervisor, and provider-state
  repository together; substitute only external provider transport, PTY/rendering,
  process liveness, and controlled timing boundaries.
- Run targeted tests, `bun run check`, upstream extraction reproducibility, and
  whitespace checks after implementation.
- Keep live interactive approval/reconnect and real crash-recovery checks explicit
  until actually performed; do not mutate user conversations merely to claim a
  smoke test passed.

## Review ledger

### Cycle 1 findings and implementation

- Existing-owner activation races adoption: requested-ID and pending-mutation
  revalidation added; initial semantic processing starts after activation.
- Stop admitted against a moving session could silently clear a live adopted or
  replacement owner: actor and removal operations now capture immutable owner IDs,
  and false stop outcomes are failures rather than release evidence.
- Shutdown waited for launch rollback before touching unrelated terminals:
  immediate surface release and concurrent owner cleanup/launch draining added.
- Identity commits held the global gate: destination claims now precede external
  persistence, with owner-local serialization against cleanup. Derivation remains
  outside that lock (the existing stale-owner regression caught an initial overly
  broad lock and is retained).
- Pre-owner rollback failures disappeared from shutdown accounting: retained
  fail-closed evidence now participates in owned-session queries and shutdown.
  Uncertain scope/resource cleanup is reported, never reclassified as absent by
  blindly rerunning a scope close.
- Native unavailability could lose previously suppressed terminal evidence:
  candidates remain ordered and an unconditional recovery probe resumes observation.
- Vendor queue bypass and connection-scoped native authority repairs are
  implemented, with transport/proxy regressions and reproducible extraction.

Added `test/next/agent-management-replay.test.ts`: production actor, Codex adapter,
supervisor, filesystem provider-state repository, and actual proxy/native observer
exercise hidden completion, unread updates, child/stale/duplicate rejection, late
read rejection, and verified stop release. Only external transport/PTY/rendering
and process liveness are controlled boundaries. No live provider mutations.

### Cycle 2 findings and implementation

- Holding owner-local serialization across read-only derivation delayed stop:
  corrected during cycle 1 using the existing stale-owner regression.
- Delaying semantic processing exposed already-exited launches to focus:
  activation now rejects a process whose exit is already known, with a deferred
  registration/early-exit regression proving verified rollback and no focus.
- Stop incorrectly returned absence for unresolved late reservation: it now
  reconciles matching pending ownership and reports typed cleanup failure until
  compensation is verified, with a controlled-clock regression.
- Delayed Show completion could overwrite an already adopted owner cursor;
  predecessor events could remain buffered after a replacement launch. Actor
  repairs and permanent regressions are implemented.

### Cycle 3 findings and implementation

- Reconnect incorrectly kept the previous connection's active-turn authority when
  a new start frame was missed: disconnect now clears that authority while retaining
  thread-local submission/settled-turn deduplication evidence.
- Unsupported authoritative root lifecycle fields pinned stale native activity:
  recognized root/source correlation is validated independently, and unsupported
  payloads release authority to conservative screen fallback. Malformed child or
  ancillary-client frames cannot disable healthy root observation.
- A failed reservation write could have committed before failing directory sync;
  failure was not absence evidence. Immediate and late uncertain failures now
  retain the exact owner/mutation token, inspect repository state, and compensate
  only the matching acquiring reservation. Inspection failure remains owned and
  fails stop/shutdown. No provider allocation is blindly retried.
- Production replay now includes reconnect with missed start, unsupported-root
  fallback, and subsequent completion. Ordered status barriers replace negative
  assertions that previously depended only on refresh idleness. Its test-server
  cleanup shares the existing listener-absence probe for Bun's unresolved WebSocket
  stop promises; it does not silently ignore an open listener.

### Final independent re-review and validation

- Ownership review: no actionable blockers; 90 supervisor plus 36
  repository/orchestration tests passed. Immediate/late uncertain reservations,
  owner-local mutation/cleanup ordering, and typed retained-ownership failures
  were reviewed. This is not exhaustive concurrency or crash fault injection.
- Actor/Codex review: no actionable blockers; 265 targeted tests passed. Adopted
  Show identity, predecessor event settlement, owner-bound stop/removal,
  caller-owned bounded dispatch, connection/schema fallback, and production replay
  were independently reviewed.
- Claude completeness review: no actionable safety/reliability blockers; 174
  targeted provider, lifecycle-hook, navigation-history, record-evidence, and
  observer-parity tests passed. Transcript normalization is a useful pure boundary;
  discovery, history acquisition, strict fork validation, and lazy scoped launch
  preparation retain explicit provider method boundaries. Additional module splits
  are optional organization, not a reliability requirement.
- `bun run check`: typecheck and all 966 tests pass.
- `bun scripts/update-t3-vendor.ts --check` and `git diff --check`: pass.
- Expanded production replay: 10 consecutive runs pass, including actual-proxy
  reconnect/fallback, ordered negative-evidence barriers, and durable stop release.
- Supervisor, application workflow, and Codex lifecycle suites: five repeated runs
  each pass (1,110 executions). Repetition is a stability check, not exhaustive
  concurrency exploration.
- Review cycles completed without commits or pushes; publication is handled
  separately on a dedicated pull-request branch.

Real installed Claude Code and Codex stock TUIs passed isolated startup/shutdown
smokes through the production supervisor, filesystem repository, OpenTUI terminal
renderer, and real Bun PTYs. Each acquired exactly one durable owner, emitted
recognizable stock startup output, and released ownership on verified shutdown.
Temporary projects/state were removed only after successful cleanup. Zero prompts
were submitted; no existing conversations were opened or modified.

Still external/unverified: interactive permission workflows, provider-native fork
behavior during live generation, and true application-crash recovery with live
provider resources. Deterministic regressions cover their local ownership seams,
but are not represented as live-provider proof.

The original roadmap also proposed separating Claude discovery, fork validation,
and launch preparation. Only transcript normalization has been extracted so far.
Independent completeness review classified further separation as optional
organization, not an actionable blocker. Keep the existing method boundaries
rather than moving provenance reconstruction merely to satisfy a file-count target.
The remaining live-provider verification limits above still preclude claiming the
whole original roadmap has been verified.
