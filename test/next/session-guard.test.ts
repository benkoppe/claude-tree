import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { SessionOwnedError } from "../../src/domain/errors"
import { makeSessionGuard } from "../../src/infrastructure/session-guard"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await mkdtemp("/tmp/opencode/session-guard-test-")
  directories.push(directory)
  const statePath = join(directory, "state.json")
  return { statePath, guard: makeSessionGuard(statePath, "claude") }
}
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

test("guard warns on live ownership and permits an explicit override without releasing the first claim", async () => {
  const { guard } = await fixture()
  const first = await run(guard.acquire("session"))
  try {
    expect(await run(Effect.flip(guard.acquire("session")))).toBeInstanceOf(SessionOwnedError)
    const second = await run(guard.acquire("session", true))
    await run(second.release)
    expect(await run(Effect.flip(guard.acquire("session")))).toBeInstanceOf(SessionOwnedError)
  } finally { await run(first.release) }
  const third = await run(guard.acquire("session"))
  await run(third.release)
  await run(third.release)
})
test("simultaneous admissions cannot both miss the duplicate-session warning", async () => {
  const { guard } = await fixture()
  const results = await Promise.all([run(Effect.result(guard.acquire("session"))), run(Effect.result(guard.acquire("session")))])
  expect(results.filter((result) => result._tag === "Success")).toHaveLength(1)
  for (const result of results) if (result._tag === "Success") await run(result.success.release)
})
test("different sessions and providers have independent guards", async () => {
  const { guard, statePath } = await fixture()
  const claims = await Promise.all([run(guard.acquire("one")), run(guard.acquire("two")), run(makeSessionGuard(join(statePath, "codex", "state.json"), "codex").acquire("one"))])
  for (const claim of claims) await run(claim.release)
})
test("SIGKILL releases the application-held lock even when a spawned child survives", async () => {
  const { guard, statePath } = await fixture()
  let ready!: () => void
  const started = new Promise<void>((resolve) => { ready = resolve })
  let survivorPid: number | undefined
  const child = Bun.spawn([process.execPath, "-e", `
    import { Effect } from 'effect';
    import { makeSessionGuard } from ${JSON.stringify(new URL("../../src/infrastructure/session-guard.ts", import.meta.url).pathname)};
    await Effect.runPromise(makeSessionGuard(${JSON.stringify(statePath)}, 'claude').acquire('session'));
    const survivor = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {stdin:'ignore',stdout:'ignore',stderr:'ignore'});
    survivor.unref();
    process.send({ready:true,survivorPid:survivor.pid});
    setInterval(() => {}, 1000);
  `], { cwd: process.cwd(), stdout: "ignore", stderr: "pipe", ipc(message) { if (message.ready) { survivorPid = message.survivorPid; ready() } } })
  try {
    await Promise.race([started, child.exited.then(async (code) => { throw new Error(`Guard child exited ${code}: ${await new Response(child.stderr).text()}`) })])
    expect(await run(Effect.flip(guard.acquire("session")))).toMatchObject({ ownerPid: child.pid })
    child.kill("SIGKILL")
    await child.exited
    expect(survivorPid).toBeDefined()
    process.kill(survivorPid!, 0)
    const fresh = await run(guard.acquire("session"))
    await run(fresh.release)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    if (survivorPid) { try { process.kill(survivorPid, "SIGKILL") } catch { /* Already exited. */ } }
  }
})
