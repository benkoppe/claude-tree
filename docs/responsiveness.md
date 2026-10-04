# Responsiveness validation

Run `bun run benchmark:responsiveness` to exercise real SDK discovery and history reads, application reconciliation, isolated family projection, navigation persistence, keyboard input, and OpenTUI rendering together. The fixture and application state live in a disposable temporary directory; no agent terminal is launched and no real provider transcript is modified.

The benchmark measures startup, roots refresh, and a graph refresh that adds a real fixture message. It reports input-to-frame latency and sampled frame intervals while alternating cursor keys. Frame intervals include the benchmark's 16 ms pacing, actor queries, and rendering; they are not native FPS measurements.

Use `BENCHMARK_SESSIONS=1000 BENCHMARK_RECORDS=100 bun run benchmark:responsiveness` for a larger catalogue. `--inline` disables read/projection isolation for comparison, but retains the other optimizations; it is not the original implementation. Run comparisons sequentially without simultaneous tests or other benchmarks.

Aim for input-to-frame p95 below one 60 FPS frame (16.7 ms), with no operation-wide pauses. Wall-clock timings are intentionally not assertions in ordinary CI tests. Deterministic tests separately establish that stalled reads, persistence, launches, and projection cannot hold navigation; that stale preparation cannot replace newer terminal evidence or focus; and that worker failure, cancellation, and shutdown settle callers.

An isolated 1,000-session × 100-record run in the development environment measured input-to-frame p95 of 5.21 ms during startup, 5.83 ms during roots refresh, and 4.77 ms during graph refresh. Maximum sampled frame intervals were 51.25, 33.22, and 25.04 ms respectively. These are synthetic fixture measurements, not a guarantee for arbitrary history sizes or provider mutations; forks and terminal-resource acquisition still use foreground-owned provider effects.
