import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, PubSub } from "effect"
import { TestClock } from "effect/testing"
import { NullTerminalObserver, type AgentActivity, type TerminalObserver } from "../../src/domain/model"
import { PersistenceError, ProviderCleanupError, SessionOwnedError, TerminalError } from "../../src/domain/errors"
import type { TerminalProcess, TerminalProcessCallbacks, TerminalRenderer, TerminalSurface } from "../../src/infrastructure/terminal"
import type { PreparedTerminal, TerminalLaunch, TerminalTransitionRequest } from "../../src/services/provider"
import { makeTerminalSupervisor, type TerminalActivityEvent, type TerminalExitEvent, type TerminalSupervisorApi, type TerminalSupervisorDependencies } from "../../src/services/terminal-supervisor"

function fixture() {
  const log: string[] = []
  const children: FakeProcess[] = []
  const surfaces: TerminalSurface[] = []
  let spawnFails = false
  let focusFails = false
  let closeFails = false
  const renderer: TerminalRenderer = {
    columns: 80, rows: 24, clearSelection() {}, copyToClipboard() {}, onSelection: () => () => {},
    createSurface(id, callbacks) {
      const surface: TerminalSurface = { id, write() { callbacks.onScreenChange() },
        screen: () => ({ lines: [], cursor: { x: 0, y: 0, visible: true } }),
        focus() { if (focusFails) throw new Error("focus failed"); log.push(`focus:${id}`) },
        blur() {}, setActive() {}, release() { log.push(`ui:${id}`) } }
      surfaces.push(surface)
      return surface
    },
  }
  const dependencies: TerminalSupervisorDependencies = {
    renderer, gracePeriodMs: 10, killPeriodMs: 10,
    guard: { acquire: (id, allowDuplicate) => Effect.sync(() => {
      log.push(`claim:${id}:${!!allowDuplicate}`)
      return { release: Effect.sync(() => { log.push(`release:${id}`) }) }
    }) },
    metadata: { replaceIdentity: (previous, next) => Effect.sync(() => { log.push(`identity:${previous}:${next}`) }) },
    processes: { spawn(launch, _size, callbacks) {
      if (spawnFails) throw new Error("spawn failed")
      const child = new FakeProcess(launch.sessionId, children.length + 100, callbacks, log)
      children.push(child)
      return child
    } },
  }
  const prepare = (id: string, extra: Partial<TerminalLaunch> = {}, transient = false): PreparedTerminal => ({
    session: { id, title: id, lastModified: 0, ...(transient ? { transient: true } : {}) },
    acquireLaunch: Effect.succeed({ launch: { sessionId: id, command: ["agent"], cwd: process.cwd(), observer: new NullTerminalObserver(), ...extra },
      close: Effect.suspend(() => {
        log.push(`provider:${id}`)
        return closeFails ? Effect.fail(new ProviderCleanupError({ providerId: "test", operation: "close", message: "close failed" })) : Effect.void
      }) }),
  })
  return { log, children, surfaces, dependencies, prepare,
    failSpawn: () => { spawnFails = true }, failFocus: () => { focusFails = true },
    failClose: () => { closeFails = true }, recoverClose: () => { closeFails = false } }
}
function use(f: ReturnType<typeof fixture>, effect: (supervisor: TerminalSupervisorApi) => Effect.Effect<void, unknown>, extra: Partial<TerminalSupervisorDependencies> = {}) {
  return Effect.runPromise(Effect.scoped(Effect.gen(function*() { const supervisor = yield* makeTerminalSupervisor({ ...f.dependencies, ...extra }); yield* effect(supervisor) })))
}
function eventually(condition: () => boolean): Effect.Effect<void> {
  return Effect.gen(function*() { for (let i = 0; i < 1_000; i++) { if (condition()) return; yield* Effect.yieldNow }; return yield* Effect.die("Condition not reached") })
}

test("failed pre-owner provider cleanup retains the guard and blocks replacement until a stop retry", async () => {
  const f = fixture()
  f.failSpawn()
  f.failClose()
  await use(f, (supervisor) => Effect.gen(function*() {
    expect(Exit.isFailure(yield* Effect.exit(supervisor.show(f.prepare("one"))))).toBeTrue()
    expect(f.log).not.toContain("release:one")
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set(["one"]))
    expect(Exit.isFailure(yield* Effect.exit(supervisor.show(f.prepare("one"))))).toBeTrue()
    expect(f.log.filter((entry) => entry.startsWith("claim:one:"))).toHaveLength(1)
    f.recoverClose()
    expect(yield* supervisor.stopSession("one")).toBeTrue()
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
    expect(f.log.filter((entry) => entry === "release:one")).toHaveLength(1)
  }))
})

test("shutdown retries a retained pre-owner rollback", async () => {
  const f = fixture()
  f.failSpawn()
  f.failClose()
  await use(f, (supervisor) => Effect.gen(function*() {
    yield* Effect.exit(supervisor.show(f.prepare("one")))
    expect(Exit.isFailure(yield* Effect.exit(supervisor.shutdown()))).toBeTrue()
    expect(f.log).not.toContain("release:one")
    f.recoverClose()
    yield* supervisor.shutdown()
    expect(f.log).toContain("release:one")
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
  }))
})

test("pre-owner rollback keeps its original scope completion through timeout and a stop retry", async () => {
  const f = fixture()
  f.failSpawn()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let finalizers = 0
    const supervisor = yield* makeTerminalSupervisor({ ...f.dependencies, providerCleanupTimeoutMs: 20 })
    const prepared = f.prepare("one")
    const show = yield* Effect.forkChild(Effect.exit(supervisor.show({ ...prepared, acquireLaunch: Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.gen(function*() {
        finalizers++
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      }))
      return yield* prepared.acquireLaunch
    }) })))
    yield* Deferred.await(entered)
    yield* TestClock.adjust(20)
    expect(Exit.isFailure(yield* Fiber.join(show))).toBeTrue()
    expect(f.log).not.toContain("release:one")
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set(["one"]))
    const stop = yield* Effect.forkChild(supervisor.stopSession("one"))
    yield* Effect.yieldNow
    expect(stop.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(stop)).toBeTrue()
    expect(f.log).toContain("release:one")
    expect(finalizers).toBe(1)
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("opening the same session reuses its terminal and hidden sessions stay running", async () => {
  const f = fixture()
  await use(f, (supervisor) => Effect.gen(function*() {
    const first = yield* supervisor.show(f.prepare("one"))
    yield* supervisor.show(f.prepare("two"))
    expect(yield* supervisor.show(f.prepare("one"))).toBe(first)
    expect(f.children).toHaveLength(2)
    expect(f.children.every((child) => child.alive)).toBeTrue()
    expect(yield* supervisor.hideActive).toBe("one")
    expect(yield* supervisor.activeSessionId).toBeNull()
    expect(yield* supervisor.runningSessionIds).toEqual(new Set(["one", "two"]))
  }))
})

test("a timed-out provider scope cannot release its guard until the original finalizer finishes", async () => {
  const f = fixture()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let finalizers = 0
    const supervisor = yield* makeTerminalSupervisor({ ...f.dependencies, providerCleanupTimeoutMs: 20 })
    const prepared = f.prepare("one")
    yield* supervisor.show({ ...prepared, acquireLaunch: Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.gen(function*() {
        finalizers++
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      }))
      return yield* prepared.acquireLaunch
    }) })
    const first = yield* Effect.forkChild(Effect.exit(supervisor.stopSession("one")))
    yield* Deferred.await(entered)
    yield* TestClock.adjust(20)
    expect(Exit.isFailure(yield* Fiber.join(first))).toBeTrue()
    expect(f.log).not.toContain("release:one")
    const second = yield* Effect.forkChild(Effect.exit(supervisor.stopSession("one")))
    yield* Effect.yieldNow
    expect(second.pollUnsafe()).toBeUndefined()
    expect(f.log).not.toContain("release:one")
    yield* Deferred.succeed(release, undefined)
    expect(Exit.isSuccess(yield* Fiber.join(second))).toBeTrue()
    expect(f.log).toContain("release:one")
    expect(finalizers).toBe(1)
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("graceful terminal shutdown awaits slow provider cleanup without a default observation deadline", async () => {
  const f = fixture()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const supervisor = yield* makeTerminalSupervisor(f.dependencies)
    const prepared = f.prepare("one")
    yield* supervisor.show({ ...prepared, acquireLaunch: prepared.acquireLaunch.pipe(Effect.map((acquired) => ({
      ...acquired, close: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    }))) })
    const close = yield* Effect.forkChild(supervisor.shutdown())
    yield* Deferred.await(entered)
    yield* TestClock.adjust(120_000)
    expect(close.pollUnsafe()).toBeUndefined()
    expect(f.log).not.toContain("release:one")
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(close)
    expect(f.log).toContain("release:one")
  }).pipe(Effect.provide(TestClock.layer()))))
})
test("a superseded acquisition registers its owner without activating its surface", async () => {
  const f = fixture()
  await use(f, (supervisor) => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let current = true
    const prepared = f.prepare("slow")
    const slow = yield* Effect.forkChild(supervisor.show({ ...prepared,
      acquireLaunch: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(prepared.acquireLaunch)),
    }, () => current))
    yield* Deferred.await(entered)
    current = false
    yield* supervisor.show(f.prepare("other"))
    yield* Deferred.succeed(release, undefined)
    const owner = yield* Fiber.join(slow)
    expect(yield* supervisor.activeSessionId).toBe("other")
    expect(yield* supervisor.runningSessionIds).toEqual(new Set(["slow", "other"]))
    expect(f.log).not.toContain(`focus:${owner}`)
    yield* supervisor.show(f.prepare("slow"))
    expect(yield* supervisor.activeSessionId).toBe("slow")
  }))
})
test("stopping one endpoint does not stop its sibling and stale stop IDs cannot stop replacements", async () => {
  const f = fixture()
  await use(f, (supervisor) => Effect.gen(function*() {
    const old = yield* supervisor.show(f.prepare("one"))
    yield* supervisor.show(f.prepare("two"))
    yield* supervisor.stopSession("one")
    expect(f.children[1]!.alive).toBeTrue()
    const replacement = yield* supervisor.show(f.prepare("one"))
    expect(replacement).not.toBe(old)
    expect(yield* supervisor.stopSession("one", undefined, old)).toBeFalse()
    expect(f.children[2]!.alive).toBeTrue()
  }))
})
for (const stage of ["spawn", "focus"] as const) test(`${stage} failure rolls back provider resources and the guard`, async () => {
  const f = fixture()
  stage === "spawn" ? f.failSpawn() : f.failFocus()
  await use(f, (supervisor) => Effect.gen(function*() {
    expect(Exit.isFailure(yield* Effect.exit(supervisor.show(f.prepare("failed"))))).toBeTrue()
    expect(f.log).toContain("provider:failed")
    expect(f.log).toContain("release:failed")
    expect([...yield* supervisor.ownedSessionIds]).toEqual([])
  }))
})
test("provider acquisition failure releases its claim", async () => {
  const f = fixture()
  await use(f, (supervisor) => Effect.gen(function*() {
    const prepared = f.prepare("failed")
    const acquireLaunch = Effect.fail(new ProviderCleanupError({ providerId: "test", operation: "acquire", message: "failed" })) as unknown as PreparedTerminal["acquireLaunch"]
    expect(Exit.isFailure(yield* Effect.exit(supervisor.show({ ...prepared, acquireLaunch })))).toBeTrue()
    expect(f.children).toHaveLength(0)
    expect(f.log).toContain("release:failed")
  }))
})
test("duplicate warning does not acquire provider resources and explicit override reaches the guard", async () => {
  const f = fixture()
  await use(f, (supervisor) => Effect.gen(function*() {
    expect(yield* Effect.flip(supervisor.show(f.prepare("owned")))).toBeInstanceOf(SessionOwnedError)
    expect(f.children).toHaveLength(0)
    yield* supervisor.show({ ...f.prepare("owned"), allowDuplicate: true })
    expect(f.children).toHaveLength(1)
  }), { guard: { acquire: (sessionId, override) => override ? f.dependencies.guard.acquire(sessionId, true)
    : Effect.fail(new SessionOwnedError({ providerId: "test", sessionId, ownerPid: 99 })) } })
})
test("cleanup keeps the PTY open through TERM/KILL and releases the guard last", async () => {
  const f = fixture()
  await use(f, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(f.prepare("one"))
    f.children[0]!.ignoreTerm = true
    yield* supervisor.stopSession("one")
    expect(f.log.indexOf("term:one")).toBeLessThan(f.log.indexOf("kill:one"))
    expect(f.log.indexOf("kill:one")).toBeLessThan(f.log.indexOf("pty:one"))
    expect(f.log.indexOf("provider:one")).toBeLessThan(f.log.indexOf("release:one"))
  }))
})
test("in-process incomplete cleanup can be retried, without writing recovery metadata", async () => {
  const f = fixture()
  await use(f, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(f.prepare("one"))
    f.failClose()
    expect(Exit.isFailure(yield* Effect.exit(supervisor.stopSession("one")))).toBeTrue()
    expect((yield* supervisor.ownershipSnapshot)[0]?.state).toBe("cleanup-incomplete")
    expect(f.log).not.toContain("release:one")
    f.recoverClose()
    yield* supervisor.stopSession("one")
    expect(f.log).toContain("release:one")
  }))
})
test("natural exit has owner-scoped sequence and cleanup evidence", async () => {
  const f = fixture()
  const exits: TerminalExitEvent[] = []
  await use(f, (supervisor) => Effect.gen(function*() {
    const ownerId = yield* supervisor.show(f.prepare("one"))
    f.children[0]!.finish(1)
    yield* eventually(() => exits.length === 1)
    expect(exits[0]).toMatchObject({ ownerId, sessionId: "one", exitCode: 1, wasActive: true, ownershipReleased: true })
    expect([...yield* supervisor.ownedSessionIds]).toEqual([])
  }), { events: { onProcessExited: (event) => exits.push(event) } })
})
test("observations from hidden terminals remain ordered and provider activity outranks fallback output", async () => {
  const f = fixture()
  const activities: TerminalActivityEvent[] = []
  await use(f, (supervisor) => Effect.gen(function*() {
    const observer: TerminalObserver = { ...new NullTerminalObserver(),
      observeOutput: () => ["working", "blocked", "idle"] as AgentActivity[], observeScreen: () => undefined, observeDraft: () => undefined }
    yield* supervisor.show(f.prepare("one", { observer }))
    yield* supervisor.show(f.prepare("two"))
    f.children[0]!.callbacks.onOutput(new Uint8Array())
    yield* eventually(() => activities.length === 3)
    expect(activities.map((event) => event.activity)).toEqual(["working", "blocked", "idle"])
    expect(activities.every((event) => !event.wasActive)).toBeTrue()
    expect(activities[2]!.sequenceId).toBeGreaterThan(activities[1]!.sequenceId)
  }), { events: { onActivityChanged: (event) => activities.push(event) } })
})
for (const transient of [false, true]) test(`native identity change is acknowledged without a crash journal (temporary=${transient})`, async () => {
  const f = fixture()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const transitions = yield* PubSub.unbounded<TerminalTransitionRequest>()
    const supervisor = yield* makeTerminalSupervisor({ ...f.dependencies, events: { onSessionChanged: (event) => { Deferred.doneUnsafe(event.acknowledgment!, Effect.void) } } })
    yield* supervisor.show(f.prepare("source", { transitions }, transient))
    const acknowledgment = yield* Deferred.make<void, import("../../src/services/provider").TerminalTransitionAcknowledgmentError>()
    yield* PubSub.publish(transitions, { event: { _tag: "SessionChanged", session: { id: "child", title: "Child", lastModified: 1 }, kind: transient ? "temporary-adoption" : "native-fork" }, acknowledgment })
    yield* Deferred.await(acknowledgment)
    expect(yield* supervisor.activeSessionId).toBe("child")
    expect(yield* supervisor.runningSessionIds).toEqual(new Set(["child"]))
    expect(f.log).toContain("identity:source:child")
    expect(f.log).toContain("release:source")
  })))
})
test("quit cancels stalled provider acquisition without spawning a late terminal", async () => {
  const f = fixture()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const supervisor = yield* makeTerminalSupervisor(f.dependencies)
    const opening = yield* Effect.forkScoped(Effect.exit(supervisor.show({ ...f.prepare("slow"), acquireLaunch: Effect.never })))
    yield* eventually(() => f.log.includes("claim:slow:false"))
    yield* supervisor.shutdown()
    expect(Exit.isFailure(yield* Fiber.join(opening))).toBeTrue()
    expect(f.log).toContain("release:slow")
    expect(f.children).toHaveLength(0)
  })))
})

for (const failedStage of ["metadata", "source-guard-release"] as const) test(`identity ${failedStage} failure stops the terminal and releases both session guards`, async () => {
  const f = fixture()
  let sourceReleaseFails = failedStage === "source-guard-release"
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const transitions = yield* PubSub.unbounded<TerminalTransitionRequest>()
    const supervisor = yield* makeTerminalSupervisor({ ...f.dependencies,
      metadata: { replaceIdentity: (previous, next, options) => failedStage === "metadata"
        ? Effect.fail(new PersistenceError({ operation: "identity", path: "/state", message: "write failed" }))
        : f.dependencies.metadata.replaceIdentity(previous, next, options) },
      guard: { acquire: (sessionId) => f.dependencies.guard.acquire(sessionId).pipe(Effect.map((claim) => ({
        release: Effect.suspend(() => {
          if (sessionId === "source" && sourceReleaseFails) {
            sourceReleaseFails = false
            return Effect.fail(new TerminalError({ operation: "release", sessionId, message: "release failed" }))
          }
          return claim.release
        }),
      }))) },
    })
    yield* supervisor.show(f.prepare("source", { transitions }))
    const acknowledgment = yield* Deferred.make<void, import("../../src/services/provider").TerminalTransitionAcknowledgmentError>()
    yield* PubSub.publish(transitions, { event: { _tag: "SessionChanged", session: { id: "child", title: "Child", lastModified: 1 }, kind: "native-fork" }, acknowledgment })
    expect(Exit.isFailure(yield* Effect.exit(Deferred.await(acknowledgment)))).toBeTrue()
    yield* eventually(() => f.log.includes("release:source") && f.log.includes("release:child"))
    expect(f.children[0]!.alive).toBeFalse()
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
  })))
})
test("shutdown is idempotent", async () => {
  const f = fixture()
  await use(f, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(f.prepare("one"))
    yield* supervisor.shutdown()
    yield* supervisor.shutdown()
  }))
  expect(f.log.filter((entry) => entry === "release:one")).toHaveLength(1)
})
test("fallback activity probes use a controlled clock", async () => {
  const f = fixture()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const supervisor = yield* makeTerminalSupervisor(f.dependencies)
    yield* supervisor.show(f.prepare("one"))
    const probe = yield* Effect.forkScoped(supervisor.reconcileActivity)
    yield* TestClock.adjust(100)
    expect((yield* Fiber.join(probe))[0]?.issue).toBe("unrecognized-screen")
  })).pipe(Effect.provide(TestClock.layer())))
})

class FakeProcess implements TerminalProcess {
  alive = true
  ignoreTerm = false
  exitCode: number | null = null
  ptyOpen = true
  outputTail = ""
  readonly processGroupId: number
  readonly exited: Promise<number>
  ptyOutput: TerminalProcess["ptyOutput"] = Promise.resolve({ _tag: "Ended", status: "eof" })
  private resolve!: (code: number) => void
  constructor(readonly id: string, readonly pid: number, readonly callbacks: TerminalProcessCallbacks, private readonly log: string[]) {
    this.processGroupId = pid
    this.exited = new Promise((resolve) => { this.resolve = resolve })
  }
  write() {}
  resize() {}
  signalGroup(signal: NodeJS.Signals) {
    this.log.push(`${signal === "SIGTERM" ? "term" : "kill"}:${this.id}`)
    expect(this.ptyOpen).toBeTrue()
    if (signal === "SIGKILL" || !this.ignoreTerm) this.finish(0)
  }
  isGroupAlive() { return this.alive }
  waitForGroupExit() { return Effect.sync(() => !this.alive) }
  closePty() { this.ptyOpen = false; this.log.push(`pty:${this.id}`) }
  unref() { this.log.push(`unref:${this.id}`) }
  finish(code: number) {
    this.alive = false
    if (this.exitCode === null) { this.exitCode = code; this.resolve(code) }
  }
}

test("natural exit cleans descendants before awaiting slow final output and shares cleanup with stop", async () => {
  const f = fixture()
  const exits: TerminalExitEvent[] = []
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const supervisor = yield* makeTerminalSupervisor({ ...f.dependencies, events: { onProcessExited: (event) => { exits.push(event) } } })
    yield* supervisor.show(f.prepare("one", { failureDetails: () => "provider snapshot" }))
    const child = f.children[0]!
    let settle!: (value: Awaited<TerminalProcess["ptyOutput"]>) => void
    child.ptyOutput = new Promise((resolve) => { settle = resolve })
    child.finish(1)
    child.alive = true // A descendant still owns the slave end of the PTY.
    child.ignoreTerm = true
    yield* eventually(() => f.log.includes("kill:one"))
    const stop = yield* Effect.forkChild(supervisor.stopSession("one"))
    yield* TestClock.adjust(120_000)
    expect(stop.pollUnsafe()).toBeUndefined()
    expect(f.log).not.toContain("pty:one")
    expect(f.log).not.toContain("release:one")
    expect(exits).toEqual([])
    child.outputTail = "late final error"
    child.callbacks.onOutput(new TextEncoder().encode(child.outputTail))
    settle({ _tag: "Ended", status: "error-or-hangup" })
    yield* Fiber.join(stop)
    yield* eventually(() => exits.length === 1)
    expect(exits[0]?.outputTail).toBe("late final error\n\nprovider snapshot")
    expect(exits[0]?.ownershipReleased).toBeTrue()
    expect(f.log.filter((entry) => entry === "provider:one")).toHaveLength(1)
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("an explicit PTY observation deadline retains ownership and permits late-settlement retry", async () => {
  const f = fixture()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const supervisor = yield* makeTerminalSupervisor({ ...f.dependencies, providerCleanupTimeoutMs: 20 })
    yield* supervisor.show(f.prepare("one"))
    const child = f.children[0]!
    let settle!: (value: Awaited<TerminalProcess["ptyOutput"]>) => void
    child.ptyOutput = new Promise((resolve) => { settle = resolve })
    const stop = yield* Effect.forkChild(Effect.exit(supervisor.stopSession("one")))
    yield* eventually(() => f.log.includes("provider:one"))
    yield* TestClock.adjust(20)
    expect(Exit.isFailure(yield* Fiber.join(stop))).toBeTrue()
    expect(child.ptyOpen).toBeTrue()
    expect(f.log).not.toContain("release:one")
    settle({ _tag: "Ended", status: "eof" })
    yield* supervisor.stopSession("one")
    expect(f.log).toContain("release:one")
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("forced PTY closure reports unconfirmed output rather than a natural drain", async () => {
  const f = fixture()
  await use(f, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(f.prepare("one"))
    f.children[0]!.ptyOutput = Promise.resolve({ _tag: "Closed" })
    const result = yield* Effect.flip(supervisor.stopSession("one"))
    expect(result.issues.some((issue) => issue.message.includes("final output is unconfirmed"))).toBeTrue()
    expect(result.ownershipReleased).toBeTrue()
  }))
})
