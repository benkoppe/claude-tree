# Responsiveness validation

Run `bun run benchmark:responsiveness` to exercise real SDK discovery and history reads, application reconciliation, isolated family projection, navigation persistence, keyboard input, and OpenTUI rendering together. The fixture and application state live in a disposable temporary directory; no agent terminal is launched and no real provider transcript is modified.

The benchmark measures startup, roots refresh, and a graph refresh that adds a real fixture message. `inputToVisibleSelection` starts immediately before injecting a specific arrow key and ends only after the actor accepts that request's new selection identity, presentation receives the same acknowledgment and destination, and a rendered frame highlights the expected root or message. Keys deliberately alternate between two known adjacent roots or graph nodes. Unchanged selections, optimistic paints without acknowledgment, and refresh-only frame changes are not samples. Waiting for actor/presentation acknowledgment includes stalls; a 60-second acknowledgment failure aborts rather than reporting a successful sample.

`sampledAcknowledgedFrameIntervals` measures time between successful acknowledged-selection frames. These intervals include the benchmark's 16 ms pacing between inputs, actor queries, and forced test rendering; they are **not native FPS measurements**. Input latency also includes acknowledgment polling and test-renderer overhead. At least ten successful selection changes are sampled per phase, continuing until the refresh finishes.

Use `BENCHMARK_SESSIONS=1000 BENCHMARK_RECORDS=100 bun run benchmark:responsiveness` for a larger catalogue. `--inline` disables read/projection isolation for comparison, but retains the other optimizations; it is not the original implementation. Run comparisons sequentially without simultaneous tests or other benchmarks.

Aim for input-to-visible-selection p95 below one 60 FPS frame (16.7 ms), with no operation-wide pauses. Wall-clock timings are intentionally not assertions in ordinary CI tests. Deterministic tests separately establish that stalled reads, persistence, launches, and projection cannot hold navigation; that stale preparation cannot replace newer terminal evidence or focus; and that worker failure, cancellation, and shutdown settle callers.

An isolated default 200-session × 200-record run with acknowledged-selection measurement reported:

| Phase | Successful selections | Latency p50 | Latency p95 | Latency maximum | Maximum sampled interval |
| --- | ---: | ---: | ---: | ---: | ---: |
| Startup | 47 | 12.45 ms | 24.02 ms | 26.91 ms | 50.70 ms |
| Roots refresh | 32 | 8.04 ms | 11.68 ms | 12.77 ms | 32.26 ms |
| Graph refresh | 28 | 11.42 ms | 18.76 ms | 21.95 ms | 34.59 ms |

Startup and graph refresh exceeded the 16.7 ms p95 target in this run. Earlier input-to-frame results did not establish that a changed selection was acknowledged and visible, so they are not comparable and have been removed. These synthetic fixture measurements are not a guarantee for arbitrary history sizes or provider mutations; forks and terminal-resource acquisition still use foreground-owned provider effects.
