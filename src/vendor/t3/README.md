# T3 Code reuse

Source: https://github.com/pingdotgg/t3code/pull/2829

Pinned merge revision: `de343914273eceb852a1d1d739cd1d38df7796ee`.
The MIT notice is retained in `LICENSE`.

`codex/` contains the upstream Effect Codex protocol and its supporting errors,
plus the dependency-closed generated lifecycle codecs we actually consume.
Regenerate with `bun scripts/update-t3-vendor.ts`; verify reproducibility with
`bun scripts/update-t3-vendor.ts --check`. Never update automatically at runtime.

The updater explicitly reapplies host-integration adaptations: caller-assigned
request IDs and a caller-owned `sendWire` seam that bypasses the upstream outgoing
queue. Pending correlation is finalized across both dispatch and response waits.
Requests and notifications await actual host-writer dispatch completion, preserving
bounded retention, unsent-request cancellation, and mutation-dispatch evidence.
The default upstream writer retains failure termination. Correlation, routing,
and scoped subscriptions remain in use. Strict framing and process ownership
remain host responsibilities.

The full generated client is intentionally not imported: it couples discovery to
all fields of a newer protocol and would discard unknown payload data needed for
exact copied-prefix validation. The host validates its admitted transcript shape
and preserves payloads; unsupported shapes still fail closed.

`src/services/keyed-serial-executor.ts` adapts the upstream keyed executor to this
repository's formatting. Its policy is unchanged: serialize one identity, not all
provider work. Application state still belongs to the foreground actor.

Provider-specific ownership, mutation ambiguity, process cleanup, and exact fork
validation belong outside the vendored client. No T3 contracts, database, daemon,
or SDK-driven chat runtime are imported.
