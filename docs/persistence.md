# Application state

Application metadata is stored in `$XDG_STATE_HOME/claude-tree/state.sqlite` (default `~/.local/state/claude-tree/state.sqlite`). Keep this on a local filesystem, not a network share or an actively synchronized directory. Provider transcripts remain in provider storage.

## Existing JSON installations

Close **all old claude-tree invocations** before cutover. Old releases use a different session-guard namespace and continue writing their JSON files. Import each project/provider explicitly:

```sh
claude-tree state import-json /path/to/project
claude-tree state import-json --codex /path/to/project
```

Only strict, canonical schema v3 documents without obsolete lease/ownership layouts are imported. The operation preserves relationships, correspondence order, removals, timestamps, and workspace IDs. Original files are never deleted or rewritten. Reimporting identical source data is harmless; changed source data is not merged into an imported scope.

Fresh invocations still start from roots. `--resume WORKSPACE_ID PROJECT` copies saved navigation into a new workspace; it does not recover hidden agents or terminal state.

## Maintenance

```sh
claude-tree state check
claude-tree state backup /path/to/private-backup.sqlite
claude-tree state export /path/to/project
```

Backups are SQLite-consistent snapshots, including committed WAL data. Do not copy only the main file while the application is running or delete WAL/SHM files manually. Exports contain private paths and session identifiers; they are not anonymized history diagnostics.

Known schema versions upgrade through committed migrations. Close active invocations when an upgrade requests exclusive schema access. Unknown/newer schemas, corruption, and migration-history mismatches are rejected without resets or deletion. Do not downgrade against a newer database.

Projects have stable IDs; paths are mutable associations. Automatic rename detection, project relinking commands, and provider-side relocation are not implemented yet.

Session guards live separately at `$XDG_STATE_HOME/claude-tree/session-guards/<provider>/<session-hash>/`. They coordinate live invocations across project paths; they are not SQLite metadata or process-recovery records. On access, unlocked crash-leftover claim files are removed under the session admission lock. Admission files and directories intentionally remain, and must not be deleted while applications are running.

## Schema

`schema.ts` declares ten tables: projects, project/provider scopes, session references, branch relations, ordered shared-message mappings, removal headers/members/aliases, and workspaces/message aliases. `migrations/` contains reviewed SQL and the Drizzle ledger. SQL enforces scope, uniqueness, local variants, and types; repository validation enforces cycles, mapping boundaries, and alias membership.

Generate changes with `bun run db:generate`, then review the SQL before committing. Preserve STRICT declarations and atomic compatibility markers in migrations; Drizzle Kit does not model every SQLite runtime policy. Never use schema push as an application upgrade mechanism.
