import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { PersistenceError } from "../../src/domain/errors"
import type { NavigationState } from "../../src/domain/model"
import { nativePersistencePlatform, PersistencePlatform } from "../../src/infrastructure/metadata/platform"
import { makeProviderStateRepository, type ProviderStateRepositoryOptions } from "../../src/services/provider-state-repository"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const open = (options: ProviderStateRepositoryOptions) => run(makeProviderStateRepository(options).pipe(Effect.provideService(PersistencePlatform, nativePersistencePlatform)))
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "workspace-test-"))
  directories.push(directory)
  return { projectDirectory: directory, providerId: "claude", stateHome: join(directory, "state"), instanceId: "original" }
}

for (const navigation of [
  { view: "roots", selectedSessionId: "root" },
  { view: "graph", familySessionId: "root", target: { kind: "message", preferred: { sessionId: "root", messageId: "message" }, aliases: [{ sessionId: "root", messageId: "message" }] } },
  { view: "terminal", sessionId: "child" },
] satisfies NavigationState[]) {
  test(`workspace resume copies ${navigation.view} navigation without sharing its writer`, async () => {
    const options = await fixture()
    const original = await open(options)
    await run(original.saveNavigation(navigation))
    const resumed = await open({ ...options, instanceId: "resumed", resumeWorkspaceId: "original" })
    expect((await run(resumed.loadMetadata)).navigation).toEqual(navigation)
    await run(resumed.saveNavigation({ view: "roots", selectedSessionId: null }))
    expect((await run(original.loadMetadata)).navigation).toEqual(navigation)
    expect((await run(resumed.loadMetadata)).navigation).toEqual({ view: "roots", selectedSessionId: null })
    expect(await run(original.load)).not.toHaveProperty("terminalOwners")
    expect(await run(original.load)).not.toHaveProperty("pendingIdentityAdoptions")
  })
}
test("new invocations do not silently restore another workspace", async () => {
  const options = await fixture()
  const first = await open(options)
  await run(first.saveNavigation({ view: "terminal", sessionId: "session" }))
  const fresh = await open({ ...options, instanceId: "fresh" })
  expect((await run(fresh.loadMetadata)).navigation).toBeUndefined()
})
test("unknown workspace and wrong provider fail without rewriting existing state", async () => {
  const options = await fixture()
  const first = await open(options)
  const before = await readFile(first.statePath, "utf8")
  expect(await run(Effect.flip(makeProviderStateRepository({ ...options, resumeWorkspaceId: "missing" }).pipe(Effect.provideService(PersistencePlatform, nativePersistencePlatform))))).toBeInstanceOf(PersistenceError)
  expect(await readFile(first.statePath, "utf8")).toBe(before)
  await expect(open({ ...options, providerId: "codex", resumeWorkspaceId: "original" })).rejects.toThrow("Provider state is missing")
})
test("obsolete ownership state is rejected in place, without migration or deletion", async () => {
  const options = await fixture()
  const repository = await open(options)
  const old = JSON.stringify({ schemaVersion: 3, relations: [], removals: [], navigations: [], terminalOwners: [], pendingIdentityAdoptions: [] })
  await writeFile(repository.statePath, old)
  await expect(open(options)).rejects.toThrow()
  expect(await readFile(repository.statePath, "utf8")).toBe(old)
})
test("temporary identity replacement atomically updates metadata and every saved workspace", async () => {
  const options = await fixture()
  const first = await open(options)
  const second = await open({ ...options, instanceId: "second" })
  await run(first.updateMetadata((state) => ({ ...state, relations: [{ parentSessionId: "parent", childSessionId: "temporary", sourceMessageId: "source",
    sharedMessages: [], createdAt: "2026-01-01T00:00:00.000Z" }] })))
  await run(first.saveNavigation({ view: "terminal", sessionId: "temporary" }))
  await run(second.saveNavigation({ view: "roots", selectedSessionId: "temporary" }))
  await run(first.replaceIdentity("temporary", "actual", { kind: "temporary-adoption" }))
  expect((await run(first.loadMetadata)).navigation).toEqual({ view: "terminal", sessionId: "actual" })
  expect((await run(second.loadMetadata)).navigation).toEqual({ view: "roots", selectedSessionId: "actual" })
  expect((await run(first.loadMetadata)).relations[0]?.childSessionId).toBe("actual")
})
test("native fork preserves the source and unrelated workspace navigation", async () => {
  const options = await fixture()
  const first = await open(options)
  const second = await open({ ...options, instanceId: "second" })
  await run(first.saveNavigation({ view: "terminal", sessionId: "source" }))
  await run(second.saveNavigation({ view: "terminal", sessionId: "source" }))
  const relation = { parentSessionId: "source", childSessionId: "child", sourceMessageId: "message", sharedMessages: [{ parentMessageId: "message", childMessageId: "copy" }], createdAt: "2026-01-01T00:00:00.000Z" }
  await run(first.replaceIdentity("source", "child", { kind: "native-fork", relation }))
  expect((await run(first.loadMetadata)).navigation).toEqual({ view: "terminal", sessionId: "child" })
  expect((await run(second.loadMetadata)).navigation).toEqual({ view: "terminal", sessionId: "source" })
  expect((await run(first.loadMetadata)).relations).toEqual([relation])
})
