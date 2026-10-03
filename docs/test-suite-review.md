# Test-suite value review

Reviewed all 38 test files after the slow-work timeout follow-up. The criterion
was redundant behavior and assertions, not test length or a target test count.
No production code changed.

## Changes

| Removed or consolidated | Retained coverage |
| --- | --- |
| Codex proxy's short acknowledgment-barrier test | `codex-slow-acquisition.test.ts` holds the real proxy acknowledgment across 120 seconds of controlled time; transport correlation still covers non-temporary start/resume/fork. |
| Codex provider's duplicate stalled-fork deadline subsection | `codex-provider.test.ts` tests reads consuming part of the budget before a dispatched fork stalls, with the same ambiguity and reason assertions. Listing/page/session-limit checks remain. |
| Supervisor's second slow-reservation phase row | Same deferred reserve wrapper, assertions, and execution branch; only its diagnostic phase string differed. The reserve and separate attach-stage tests remain. |
| Four supervisor negative-infinity budget rows | Each option still rejects positive infinity, NaN, zero, and negative finite values. Both infinities used the same non-finite rejection branch. |
| Metadata's v1 corruption row | v2 and unknown-version rows retain rejection before mutation and unchanged bytes; the separate startup legacy-state/reset-diagnostic test remains. |
| Standalone Claude SDK-only preservation/continuation test | Its exact ordered message-ID assertion moved to the initial source read in the preserved-history fork/fork-of-fork test, for both re-emitted and non-re-emitted records. |
| Graph's sparse child-prefix restoration test | Both descendant sparse-history cases retain restored ordering, parent/child aliases, empty warnings, all chain edges, and child endpoint attachment. |

Nine generated test cases were removed, including one assertion-preserving
consolidation, plus the duplicate subsection. The suite decreased from 1,056 to
1,047 cases. Most superficially similar tests were retained because they cover
different failure stages, evidence formats, public boundaries, or interleavings.

## Scope and preservation

- Claude: provider, navigation history, record evidence, lifecycle hooks,
  diagnostics, and real SDK integration.
- Codex: provider, transport/proxy, lifecycle, acquisition, and production-stack
  replay.
- Infrastructure: supervisor, metadata/provider-state repositories, navigation
  persistence/writer, ownership recovery, Herdr, orchestration primitives, and
  native terminal integration.
- Application/domain: workflows, state, startup hydration, graph/parity, activity,
  and scale.
- Presentation/utility: presentation, status rendering, both observer parity
  suites, observer recovery, CLI composition/options, build identity, error
  formatting, clipboard, and process title.

Small contract tests and mocked fault injection are not inherently trivial.
Retain distinct admission/dispatch/commit/cancellation stages, late settlement,
replacement ownership, lock reclamation, compaction/provenance, privacy, real
process/HTTP/PTY boundaries, and algorithmic scale assertions. Also retain
scope-only cleanup versus explicit-close backstops and response-before-write
settlement versus blocked pending responses: those are different interleavings.

## Validation

- `bun run check`: typecheck and all 1,047 tests pass.
- Independent coverage-preservation reviews check removed assertions against
  the retained tests. This is scoped behavioral review, not proof that the suite
  detects every possible regression.
