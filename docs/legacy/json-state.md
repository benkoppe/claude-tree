# Importing legacy JSON state

For projects used before the SQLite switch, close **all old claude-tree invocations**, then import each project/provider you used:

```sh
claude-tree state import-json /path/to/project
claude-tree state import-json --codex /path/to/project
```

The importer accepts canonical schema v3 JSON without obsolete lease/ownership layouts. It preserves relationships, message correspondence, removals, timestamps, and workspace IDs in `$XDG_STATE_HOME/claude-tree/state.sqlite` (default `~/.local/state/claude-tree/state.sqlite`). Original JSON files and provider transcripts remain untouched.

Reimporting identical data is harmless; changed source data is not merged into an already imported scope. Fresh invocations start from roots. To reuse saved navigation, run `claude-tree [--codex] --resume WORKSPACE_ID /path/to/project`; this does not restore hidden agents or terminal state.

See [persistence](../persistence.md) for database backup and maintenance commands.
