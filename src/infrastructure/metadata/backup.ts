import { chmod, link, mkdtemp, open, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Database } from "bun:sqlite"

import { nativePersistencePlatform } from "./platform"
import { syncDirectory } from "./storage"

/** Publish a durable snapshot without overwriting a destination or exposing partial data. */
export async function backupDatabase(db: Database, destination: string): Promise<void> {
  const directory = await mkdtemp(join(dirname(destination), ".claude-tree-backup-"))
  try {
    await chmod(directory, 0o700)
    const snapshot = join(directory, "snapshot.sqlite")
    // macOS SQLite rejects even an empty existing VACUUM INTO destination.
    db.query("VACUUM INTO ?").run(snapshot)
    await chmod(snapshot, 0o600)
    const handle = await open(snapshot, "r")
    try { await handle.sync() } finally { await handle.close() }
    await link(snapshot, destination)
    await syncDirectory(nativePersistencePlatform, dirname(destination))
  } finally { await rm(directory, { recursive: true, force: true }) }
}
