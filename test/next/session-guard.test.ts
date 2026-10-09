import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { Cause, Deferred, Effect, Fiber } from "effect"
import { SessionOwnedError } from "../../src/domain/errors"
import { makeSessionGuard, nativeSessionGuardPlatform, type SessionGuardPlatform } from "../../src/infrastructure/session-guard"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function fixture() {
  await mkdir("/tmp/opencode", { recursive: true })
  const directory = await mkdtemp("/tmp/opencode/session-guard-test-")
  directories.push(directory)
  const guardRoot = join(directory, "session-guards")
  return { directory, guardRoot, guard: makeSessionGuard(guardRoot, "claude") }
}
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const sessionDirectory = (root: string, sessionId = "session") => join(root, "claude", createHash("sha256").update(sessionId).digest("hex"))

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
  const { guard, guardRoot } = await fixture()
  const claims = await Promise.all([run(guard.acquire("one")), run(guard.acquire("two")), run(makeSessionGuard(guardRoot, "codex").acquire("one"))])
  for (const claim of claims) await run(claim.release)
})

test("a shared guard root coordinates independent processes in different projects", async () => {
  const { directory, guard, guardRoot } = await fixture()
  const otherProject = join(directory, "other-project")
  await mkdir(otherProject)
  const first = await run(guard.acquire("session"))
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
      import { makeSessionGuard } from ${JSON.stringify(new URL("../../src/infrastructure/session-guard.ts", import.meta.url).pathname)};
      const result = await Effect.runPromise(Effect.result(makeSessionGuard(${JSON.stringify(guardRoot)}, 'claude').acquire('session')));
      if (result._tag !== 'Failure' || result.failure._tag !== 'SessionOwnedError') {
        if (result._tag === 'Success') await Effect.runPromise(result.success.release);
        throw new Error('A different project missed the live session claim');
      }
      console.log(result.failure.ownerPid);
    `], { cwd: otherProject, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(stdout.trim()).toBe(String(process.pid))
  } finally { await run(first.release) }
})

test("simultaneous independent processes admit one owner and warn the other", async () => {
  const { guardRoot } = await fixture()
  const launch = () => {
    let ready!: () => void
    let completed!: (result: { success: boolean; failure?: string; ownerPid?: number }) => void
    const readyPromise = new Promise<void>((resolve) => { ready = resolve })
    const resultPromise = new Promise<{ success: boolean; failure?: string; ownerPid?: number }>((resolve) => { completed = resolve })
    const child = Bun.spawn([process.execPath, "-e", `
      import { Effect } from 'effect';
      import { makeSessionGuard } from ${JSON.stringify(new URL("../../src/infrastructure/session-guard.ts", import.meta.url).pathname)};
      const start = new Promise(resolve => process.once('message', resolve));
      process.send({tag:'ready'});
      await start;
      const result = await Effect.runPromise(Effect.result(makeSessionGuard(${JSON.stringify(guardRoot)}, 'claude').acquire('session')));
      const stop = new Promise(resolve => process.once('message', resolve));
      process.send(result._tag === 'Success' ? {tag:'result', success:true} : {tag:'result', success:false, failure:result.failure._tag, ownerPid:result.failure.ownerPid});
      await stop;
      if (result._tag === 'Success') await Effect.runPromise(result.success.release);
      process.disconnect();
    `], { cwd: process.cwd(), stdout: "ignore", stderr: "pipe", ipc(message) {
      if (message.tag === "ready") ready()
      else if (message.tag === "result") completed(message)
    } })
    const unexpectedExit = child.exited.then(async (code): Promise<never> => { throw new Error(`Guard racer exited (${code}): ${await new Response(child.stderr).text()}`) })
    return { child, ready: Promise.race([readyPromise, unexpectedExit]), result: Promise.race([resultPromise, unexpectedExit]) }
  }
  const racers = [launch(), launch()]
  try {
    await Promise.all(racers.map((racer) => racer.ready))
    for (const racer of racers) racer.child.send("start")
    const results = await Promise.all(racers.map((racer) => racer.result))
    expect(results.filter((result) => result.success)).toHaveLength(1)
    const winner = results.findIndex((result) => result.success)
    expect(results.find((result) => !result.success)).toMatchObject({ failure: "SessionOwnedError", ownerPid: racers[winner]!.child.pid })
    for (const racer of racers) racer.child.send("stop")
    expect(await Promise.all(racers.map((racer) => racer.child.exited))).toEqual([0, 0])
  } finally {
    for (const racer of racers) if (racer.child.exitCode === null) racer.child.kill("SIGKILL")
    await Promise.all(racers.map((racer) => racer.child.exited))
  }
})

test("unlocked crash leftovers are pruned without removing live claims or the admission inode", async () => {
  const { guard, guardRoot } = await fixture()
  const first = await run(guard.acquire("session"))
  const directory = sessionDirectory(guardRoot)
  const admission = await stat(join(directory, "admission.lock"))
  const originalFiles = await readdir(directory)
  await writeFile(join(directory, "42-deadbeef.lock"), "")
  await writeFile(join(directory, "unrelated-file"), "leave untouched")
  try {
    expect(await run(Effect.flip(guard.acquire("session")))).toBeInstanceOf(SessionOwnedError)
    expect((await readdir(directory)).sort()).toEqual([...originalFiles, "unrelated-file"].sort())
    expect((await stat(join(directory, "admission.lock"))).ino).toBe(admission.ino)
    const override = await run(guard.acquire("session", true))
    try {
      expect((await readdir(directory)).filter((file) => file !== "admission.lock" && file.endsWith(".lock"))).toHaveLength(2)
    } finally { await run(override.release) }
    expect(await run(Effect.flip(guard.acquire("session")))).toBeInstanceOf(SessionOwnedError)
  } finally { await run(first.release) }
})

test("failure while locking a new claim closes it and removes its file", async () => {
  const { guard, guardRoot } = await fixture()
  const paths = new Map<number, string>()
  const nativeLock = nativeSessionGuardPlatform.fileLocker()
  const platform: SessionGuardPlatform = { ...nativeSessionGuardPlatform,
    open: async (...args) => { const handle = await nativeSessionGuardPlatform.open(...args); paths.set(handle.fd, args[0]); return handle },
    fileLocker: () => (fd, operation) => {
      const result = nativeLock(fd, operation)
      if (!paths.get(fd)?.endsWith("admission.lock")) throw new Error("claim lock failed after taking the lock")
      return result
    },
  }
  const result = await run(Effect.exit(makeSessionGuard(guardRoot, "claude", platform).acquire("session")))
  expect(result._tag).toBe("Failure")
  expect(await readdir(sessionDirectory(guardRoot))).toEqual(["admission.lock"])
  const fresh = await run(guard.acquire("session")); await run(fresh.release)
})

test("admission cleanup failure after acquiring a claim rolls that claim back", async () => {
  const { guard, guardRoot } = await fixture()
  let failAdmissionClose = true
  let failClaimClose = true
  const platform: SessionGuardPlatform = { ...nativeSessionGuardPlatform,
    open: async (...args) => {
      const handle = await nativeSessionGuardPlatform.open(...args)
      return { fd: handle.fd, close: async () => {
        if (args[0].endsWith("admission.lock") && failAdmissionClose) {
          failAdmissionClose = false; throw new Error("admission close failed")
        }
        if (!args[0].endsWith("admission.lock") && failClaimClose) {
          failClaimClose = false; throw new Error("claim close failed")
        }
        await handle.close()
      } }
    },
  }
  const result = await run(Effect.exit(makeSessionGuard(guardRoot, "claude", platform).acquire("session")))
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") {
    expect(Cause.pretty(result.cause)).toContain("admission close failed")
    expect(Cause.pretty(result.cause)).toContain("claim close failed")
  }
  expect(await readdir(sessionDirectory(guardRoot))).toEqual(["admission.lock"])
  const fresh = await run(guard.acquire("session")); await run(fresh.release)
})

test("directory inspection failure releases admission without creating a claim", async () => {
  const { guard, guardRoot } = await fixture()
  const broken = makeSessionGuard(guardRoot, "claude", { ...nativeSessionGuardPlatform,
    readdir: async () => { throw new Error("directory inspection failed") },
  })
  expect((await run(Effect.flip(broken.acquire("session")))).message).toContain("directory inspection failed")
  expect(await readdir(sessionDirectory(guardRoot))).toEqual(["admission.lock"])
  const fresh = await run(guard.acquire("session")); await run(fresh.release)
})

test("failed claim close keeps ownership until release successfully retries", async () => {
  const { guard, guardRoot } = await fixture()
  let failClaimClose = true
  const platform: SessionGuardPlatform = { ...nativeSessionGuardPlatform,
    open: async (...args) => {
      const handle = await nativeSessionGuardPlatform.open(...args)
      return { fd: handle.fd, close: async () => {
        if (!args[0].endsWith("admission.lock") && failClaimClose) { failClaimClose = false; throw new Error("claim close failed") }
        await handle.close()
      } }
    },
  }
  const claim = await run(makeSessionGuard(guardRoot, "claude", platform).acquire("session"))
  try {
    expect((await run(Effect.flip(claim.release))).message).toContain("claim close failed")
    expect(await run(Effect.flip(guard.acquire("session")))).toBeInstanceOf(SessionOwnedError)
  } finally { await run(claim.release) }
  const fresh = await run(guard.acquire("session")); await run(fresh.release)
})

test("interrupted admission waiting closes its descriptor", async () => {
  const { guardRoot } = await fixture()
  const waiting = Deferred.makeUnsafe<void>()
  let closes = 0
  const platform: SessionGuardPlatform = { ...nativeSessionGuardPlatform,
    fileLocker: () => () => { Deferred.doneUnsafe(waiting, Effect.void); return false },
    open: async (...args) => {
      const handle = await nativeSessionGuardPlatform.open(...args)
      return { fd: handle.fd, close: async () => { await handle.close(); closes++ } }
    },
  }
  await run(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(makeSessionGuard(guardRoot, "claude", platform).acquire("session"))
    yield* Deferred.await(waiting)
    yield* Fiber.interrupt(fiber)
  }))
  expect(closes).toBe(1)
  expect(await readdir(sessionDirectory(guardRoot))).toEqual(["admission.lock"])
})

test("failed claim-file deletion can be retried without closing its descriptor twice", async () => {
  const { guardRoot } = await fixture()
  let failUnlink = true
  let claimCloses = 0
  const platform: SessionGuardPlatform = { ...nativeSessionGuardPlatform,
    open: async (...args) => {
      const handle = await nativeSessionGuardPlatform.open(...args)
      return { fd: handle.fd, close: async () => {
        if (!args[0].endsWith("admission.lock")) claimCloses++
        await handle.close()
      } }
    },
    unlink: async (path) => { if (failUnlink) { failUnlink = false; throw new Error("unlink failed") }; await nativeSessionGuardPlatform.unlink(path) },
  }
  const claim = await run(makeSessionGuard(guardRoot, "claude", platform).acquire("session"))
  expect((await run(Effect.flip(claim.release))).message).toContain("unlink failed")
  await Promise.all([run(claim.release), run(claim.release)])
  await run(claim.release)
  expect(claimCloses).toBe(1)
  expect(await readdir(sessionDirectory(guardRoot))).toEqual(["admission.lock"])
})

test("reexecuting acquisition creates independent claims", async () => {
  const { guard } = await fixture()
  const acquisition = guard.acquire("session", true)
  const first = await run(acquisition)
  const second = await run(acquisition)
  try {
    await run(first.release)
    expect(await run(Effect.flip(guard.acquire("session")))).toBeInstanceOf(SessionOwnedError)
  } finally { await run(first.release); await run(second.release) }
})

test("invalid roots, provider paths, and empty identities are rejected", async () => {
  const { guardRoot, guard } = await fixture()
  expect(() => makeSessionGuard("relative/path", "claude")).toThrow("absolute")
  expect(() => makeSessionGuard(guardRoot, "../claude")).toThrow("provider")
  expect((await run(Effect.flip(guard.acquire("")))).message).toContain("nonempty")
})
test("SIGKILL releases the application-held lock even when a spawned child survives", async () => {
  const { guard, guardRoot } = await fixture()
  let ready!: () => void
  const started = new Promise<void>((resolve) => { ready = resolve })
  let survivorPid: number | undefined
  const child = Bun.spawn([process.execPath, "-e", `
    import { Effect } from 'effect';
    import { makeSessionGuard } from ${JSON.stringify(new URL("../../src/infrastructure/session-guard.ts", import.meta.url).pathname)};
    await Effect.runPromise(makeSessionGuard(${JSON.stringify(guardRoot)}, 'claude').acquire('session'));
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
