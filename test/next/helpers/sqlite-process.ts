import { Effect } from "effect"
import { Database } from "bun:sqlite"
import { PersistencePlatform, nativePersistencePlatform } from "../../../src/infrastructure/metadata/platform"
import { makeProviderStateRepository } from "../../../src/services/provider-state-repository"

const repository = await Effect.runPromise(makeProviderStateRepository({ projectDirectory: process.argv[2]!, stateHome: process.argv[3]!,
  providerId: "claude", instanceId: process.argv[4]! }).pipe(Effect.provideService(PersistencePlatform, nativePersistencePlatform)))
try {
  if (process.argv[5] === "crash") {
    const db = new Database(repository.statePath)
    db.run("BEGIN IMMEDIATE")
    db.run("UPDATE branch_relations SET source_message_id = 'uncommitted'")
    process.stdout.write("transaction-held\n")
    await Bun.sleep(3_600_000)
    throw new Error("Crash test failed to kill the transaction holder")
  }
  for (let index = 0; index < 20; index++) await Effect.runPromise(repository.saveRelation({ childSessionId: `${process.argv[4]}-${index}`,
    parentSessionId: "root", sourceMessageId: "source", sharedMessages: [], createdAt: "2026-01-01T00:00:00.000Z" }))
} finally { await Effect.runPromise(repository.close) }
