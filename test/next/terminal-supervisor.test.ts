import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Cause, Effect, Exit, Fiber, PubSub } from "effect"

import {
  BunPtyProcessFactory,
  TerminalSpawnCleanupError,
} from "../../src/infrastructure/terminal"
import type {
  TerminalProcess,
  TerminalProcessCallbacks,
  TerminalProcessFactory,
  TerminalRenderer,
  TerminalSurface,
  TerminalSurfaceCallbacks,
} from "../../src/infrastructure/terminal"
import {
  NullTerminalObserver,
  type AgentActivity,
  type TerminalObserver,
  type TerminalScreen,
} from "../../src/domain/model"
import { PersistenceError, SessionOwnedError } from "../../src/domain/errors"
import type {
  PreparedTerminal,
  TerminalLaunch,
  TerminalTransitionEvent,
} from "../../src/services/provider"
import {
  makeTerminalSupervisor,
  TerminalCleanupError,
  type TerminalSupervisorDependencies,
  type TerminalSupervisorApi,
} from "../../src/services/terminal-supervisor"
import type {
  SessionLease,
  SessionLeasesApi,
} from "../../src/services/session-leases"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

test("rejects lease acquisition before provider launch or process spawn", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)
  const leases = new FakeSessionLeases(log)
  leases.acquireFailure = new SessionOwnedError({
    providerId: "test-provider",
    sessionId: "occupied",
    ownerPid: 123,
  })

  await withSupervisor({ renderer, processes, leases }, (supervisor) =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        supervisor.show(prepared("occupied", log, () => log.push("provider-acquire"))),
      )

      expect(Exit.isFailure(exit)).toBeTrue()
      expect(processes.processes).toHaveLength(0)
      expect(log).toEqual(["lease-acquire:occupied"])
    }),
  )
})

test("records the spawned process group on the lease before focus", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)
  const leases = new FakeSessionLeases(log)

  await withSupervisor({ renderer, processes, leases }, (supervisor) =>
    Effect.gen(function*() {
      yield* supervisor.show(prepared("leased", log, () => log.push("provider-acquire")))

      const lease = leases.current("leased")
      expect(lease?.processGroupId).toBe(processes.processes[0]!.pid)
      expect(log.indexOf("lease-acquire:leased")).toBeLessThan(log.indexOf("provider-acquire"))
      expect(log.indexOf("provider-acquire")).toBeLessThan(log.indexOf("spawn:leased"))
      expect(log.indexOf(`lease-update:leased:${processes.processes[0]!.pid}`)).toBeGreaterThan(
        log.indexOf("spawn:leased"),
      )
    }),
  )
})

test("subscribes to provider transitions before an asynchronous process spawn completes", async () => {
  const log: string[] = []
  const transitions = await Effect.runPromise(PubSub.bounded<TerminalTransitionEvent>(1))
  const changes: string[] = []
  const processes = new FakeProcessFactory(log, {
    onSpawn: async () => {
      await Effect.runPromise(PubSub.publish(transitions, {
        _tag: "SessionChanged",
        session: { id: "real", title: "real", lastModified: 1 },
      }))
    },
  })

  await withSupervisor({
    renderer: new FakeRenderer(log),
    processes,
    events: { onSessionChanged: (event) => changes.push(event.session.id) },
  }, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("temporary", log, undefined, { transitions }))
    yield* Effect.sleep(10)
    expect(changes).toEqual(["real"])
  }))
})

test("reports failed surface rollback after process spawn failure", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  renderer.throwOnSurfaceRelease = true
  const leases = new FakeSessionLeases(log)
  const processes = new FakeProcessFactory(log, { spawnFailure: new Error("spawn failed") })

  await withSupervisor({ renderer, processes, leases }, (supervisor) => Effect.gen(function*() {
    const exit = yield* Effect.exit(supervisor.show(prepared("surface-rollback", log)))
    expect(Exit.isFailure(exit)).toBeTrue()
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(TerminalCleanupError)
      if (error instanceof TerminalCleanupError) {
        expect(error.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ stage: "ui", message: expect.stringContaining("surface") }),
        ]))
      }
    }
    expect(leases.current("surface-rollback")).toBeUndefined()
  }))
})

test("retains and annotates the lease when failed PTY acquisition cannot prove process death", async () => {
  const log: string[] = []
  const leases = new FakeSessionLeases(log)
  const processes = new FakeProcessFactory(log, {
    spawnFailure: new TerminalSpawnCleanupError(42_424, "process group survived"),
  })

  await withSupervisor({ renderer: new FakeRenderer(log), processes, leases }, (supervisor) =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(supervisor.show(prepared("unverified-spawn", log)))
      expect(Exit.isFailure(exit)).toBeTrue()
      expect(leases.current("unverified-spawn")?.processGroupId).toBe(42_424)
      expect(log).not.toContain("lease-release:unverified-spawn")
    }))
})

test("lazily acquires only the first owner for a running session", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)
  let acquisitions = 0

  await withSupervisor({ renderer, processes }, (supervisor) =>
    Effect.gen(function*() {
      yield* supervisor.show(prepared("session-a", log, () => acquisitions++))
      yield* supervisor.show(prepared("session-a", log, () => acquisitions++))

      expect(acquisitions).toBe(1)
      expect(processes.processes).toHaveLength(1)
      expect(renderer.surfaces.filter((surface) => !surface.released)).toHaveLength(1)
      expect(yield* supervisor.runningSessionIds).toEqual(new Set(["session-a"]))
    }),
  )
})

test("rolls back a spawned owner when terminal focus fails", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)
  const leases = new FakeSessionLeases(log)
  renderer.focusFailures = 1

  await withSupervisor(
    { renderer, processes, leases, gracePeriodMs: 10, killPeriodMs: 20 },
    (supervisor) => Effect.gen(function*() {
      const showExit = yield* Effect.exit(supervisor.show(prepared("focus-fails", log)))

      expect(Exit.isFailure(showExit)).toBeTrue()
      expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
      expect(processes.processes[0]!.ptyOpen).toBeFalse()
      expect(leases.current("focus-fails")).toBeUndefined()
      expect(log.indexOf("lease-release:focus-fails")).toBeGreaterThan(
        log.indexOf("provider-release:focus-fails"),
      )
      expect(log.filter((entry) => cleanupEntry(entry))).toEqual([
        "ui-release:session-1",
        "signal:focus-fails:SIGTERM",
        "wait:focus-fails:10",
        "signal:focus-fails:SIGKILL",
        "wait:focus-fails:20",
        "provider-release:focus-fails",
        "pty-close:focus-fails",
      ])
    }),
  )
})

test("keeps hidden emulators consuming bytes and queues ordered activity only", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)
  const activities: Array<{ sessionId: string; activity: AgentActivity; wasActive: boolean }> = []
  const observer = new OutputObserver()

  await withSupervisor(
    {
      renderer,
      processes,
      events: { onActivityChanged: (event) => activities.push(event) },
    },
    (supervisor) => Effect.gen(function*() {
      yield* supervisor.show(prepared("hidden", log, undefined, { observer }))
      yield* supervisor.show(prepared("visible", log, undefined, { observer }))

      processes.processes[0]!.output(new TextEncoder().encode("working,idle"))
      processes.processes[0]!.output(osc52("hidden-copy"))
      processes.processes[1]!.output(osc52("visible-copy"))
      yield* Effect.sleep(10)

      expect(renderer.surfaces[0]!.writes.length).toBe(2)
      expect(renderer.surfaces[1]!.writes.length).toBe(1)
      expect(renderer.copied).toEqual(["visible-copy"])
      expect(activities).toEqual([
        { sessionId: "hidden", activity: "working", wasActive: false },
        { sessionId: "hidden", activity: "idle", wasActive: false },
      ])
      expect(renderer.surfaces.filter((surface) => surface.active)).toHaveLength(1)
      expect(renderer.surfaces[1]!.active).toBeTrue()
    }),
  )
})

test("drops PTY output after stop releases the UI while leaving the PTY open", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)
  const leases = new FakeSessionLeases(log)
  const activities: AgentActivity[] = []

  await withSupervisor(
    {
      renderer,
      processes,
      leases,
      events: { onActivityChanged: ({ activity }) => activities.push(activity) },
    },
    (supervisor) => Effect.gen(function*() {
      yield* supervisor.show(prepared("stopping", log, undefined, {
        observer: new OutputObserver(),
      }))
      let emitted = false
      processes.processes[0]!.onWait = (process) => {
        if (emitted) return
        emitted = true
        expect(process.ptyOpen).toBeTrue()
        process.output(new TextEncoder().encode("working,idle"))
        process.output(osc52("stale-copy"))
      }

      yield* supervisor.stopSession("stopping")

      expect(emitted).toBeTrue()
      expect(renderer.surfaces[0]!.writes).toEqual([])
      expect(renderer.copied).toEqual([])
      expect(activities).toEqual([])
      expect(leases.current("stopping")).toBeUndefined()
      expect(log.indexOf("lease-release:stopping")).toBeGreaterThan(
        log.indexOf("provider-release:stopping"),
      )
    }),
  )
})

test("serializes concurrent stop and shutdown cleanup", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log, { waitDelayMs: 20 })

  await withSupervisor({ renderer, processes }, (supervisor) =>
    Effect.gen(function*() {
      yield* supervisor.show(prepared("concurrent", log))
      const stopFiber = yield* Effect.forkChild(supervisor.stopSession("concurrent"))
      yield* Effect.sleep(1)
      const shutdownFiber = yield* Effect.forkChild(supervisor.shutdown())
      const [stopExit, shutdownExit] = yield* Effect.all([
        Fiber.await(stopFiber),
        Fiber.await(shutdownFiber),
      ])

      expect(Exit.isSuccess(stopExit)).toBeTrue()
      expect(Exit.isSuccess(shutdownExit)).toBeTrue()
      expect(log.filter((entry) => entry === "signal:concurrent:SIGTERM")).toHaveLength(1)
      expect(log.filter((entry) => entry === "signal:concurrent:SIGKILL")).toHaveLength(1)
      expect(log.filter((entry) => entry === "provider-release:concurrent")).toHaveLength(1)
      expect(log.filter((entry) => entry === "pty-close:concurrent")).toHaveLength(1)
    }),
  )
})

test("waits for in-flight provider cleanup before stop and shutdown settle", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)

  await withSupervisor({ renderer, processes }, (supervisor) =>
    Effect.gen(function*() {
      yield* supervisor.show(prepared("provider-wait", log, undefined, {
        providerCleanupDelayMs: 40,
      }))
      const stopFiber = yield* Effect.forkChild(supervisor.stopSession("provider-wait"))
      yield* Effect.sleep(5)
      expect(log).toContain("provider-release-start:provider-wait")
      expect(log).not.toContain("provider-release:provider-wait")

      const shutdownFiber = yield* Effect.forkChild(supervisor.shutdown())
      yield* Fiber.join(stopFiber)
      yield* Fiber.join(shutdownFiber)

      expect(log.filter((entry) => entry === "provider-release-start:provider-wait")).toHaveLength(1)
      expect(log.filter((entry) => entry === "provider-release:provider-wait")).toHaveLength(1)
      expect(log.indexOf("provider-release:provider-wait")).toBeLessThan(
        log.indexOf("pty-close:provider-wait"),
      )
    }),
  )
})

test("settles cleanup Deferreds when event and renderer callbacks throw", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)

  await withSupervisor(
    {
      renderer,
      processes,
      events: {
        onActivityChanged() {
          throw new Error("event callback failed")
        },
      },
    },
    (supervisor) => Effect.gen(function*() {
      yield* supervisor.show(prepared("callback-fails", log, undefined, {
        observer: new OutputObserver(),
      }))
      processes.processes[0]!.output(new TextEncoder().encode("working,idle"))
      yield* Effect.sleep(10)
      expect((yield* supervisor.ownershipSnapshot)[0]?.activity).toBe("idle")

      renderer.throwOnClearSelection = true
      renderer.throwOnSurfaceRelease = true
      const firstStop = yield* Effect.forkChild(Effect.exit(supervisor.stopSession("callback-fails")))
      const secondStop = yield* Effect.forkChild(Effect.exit(supervisor.stopSession("callback-fails")))
      const [firstExit, secondExit] = yield* Effect.all([
        Fiber.join(firstStop),
        Fiber.join(secondStop),
      ])

      expect(Exit.isFailure(firstExit)).toBeTrue()
      expect(Exit.isFailure(secondExit)).toBeTrue()
      const shutdownExit = yield* Effect.exit(supervisor.shutdown())
      expect(Exit.isFailure(shutdownExit)).toBeTrue()
      expect(log.filter((entry) => entry === "pty-close:callback-fails")).toHaveLength(1)
    }),
  )
})

test("bounds and ignores Herdr shutdown failures", async () => {
  const log: string[] = []
  const startedAt = performance.now()

  await withSupervisor(
    {
      renderer: new FakeRenderer(log),
      processes: new FakeProcessFactory(log),
      herdr: {
        report() {},
        shutdown: Effect.uninterruptible(Effect.never),
      },
    },
    (supervisor) => supervisor.shutdown(),
  )

  expect(performance.now() - startedAt).toBeLessThan(1_000)
})

test("coalesces activity under queue pressure without losing transitions or lifecycle events", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)
  const activities: Array<{ sessionId: string; activity: AgentActivity }> = []
  const identities: string[] = []
  const exits: string[] = []

  await withSupervisor(
    {
      renderer,
      processes,
      events: {
        onActivityChanged: ({ sessionId, activity }) => activities.push({ sessionId, activity }),
        onSessionChanged: ({ session }) => identities.push(session.id),
        onProcessExited: ({ sessionId }) => exits.push(sessionId),
      },
    },
    (supervisor) => Effect.gen(function*() {
      const transitions = yield* PubSub.unbounded<TerminalTransitionEvent>()
      yield* supervisor.show(prepared("pressure", log, undefined, {
        observer: new OutputObserver(),
        transitions,
      }))
      const working = new TextEncoder().encode("working")
      for (let index = 0; index < 5_000; index++) processes.processes[0]!.output(working)
      processes.processes[0]!.output(new TextEncoder().encode("working,idle"))
      PubSub.publishUnsafe(transitions, {
        _tag: "SessionChanged",
        session: { id: "pressure-real", title: "Pressure", lastModified: 1 },
      })
      yield* Effect.sleep(20)

      expect(activities.map(({ activity }) => activity)).toEqual(["working", "idle"])
      expect(activities.every(({ sessionId }) =>
        sessionId === "pressure" || sessionId === "pressure-real"
      )).toBeTrue()
      expect(identities).toEqual(["pressure-real"])
      processes.processes[0]!.finish(0)
      yield* Effect.sleep(20)
      expect(exits).toEqual(["pressure-real"])
    }),
  )
})

test("forwards active input and resize while preserving drafts across rekey", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)
  const leases = new FakeSessionLeases(log)
  const observer = new DraftObserver()

  await withSupervisor({ renderer, processes, leases }, (supervisor) =>
    Effect.gen(function*() {
      yield* supervisor.show(prepared("temporary", log, undefined, {
        observer,
        initialDraft: { text: "exact draft", exact: true },
      }))
      renderer.surfaces[0]!.input(new TextEncoder().encode("new draft"))
      renderer.surfaces[0]!.resize(90, 30)
      yield* supervisor.hideActive

      const before = (yield* supervisor.ownershipSnapshot)[0]!
      expect(yield* supervisor.replaceSessionId("temporary", "real-session")).toBeTrue()
      expect(yield* supervisor.replaceSessionId("temporary", "real-session")).toBeTrue()
      const after = (yield* supervisor.ownershipSnapshot)[0]!
      expect(after.ownerId).toBe(before.ownerId)
      expect(after.sessionId).toBe("real-session")
      expect(yield* supervisor.draftPreviews).toEqual(
        new Map([["real-session", { text: "new draft", exact: false }]]),
      )
      expect(processes.processes[0]!.writes).toHaveLength(1)
      expect(processes.processes[0]!.sizes).toEqual([[90, 30]])
      expect(log.filter((entry) => entry === "lease-replace:temporary:real-session")).toHaveLength(1)
    }),
  )
})

test("stops a native identity transition when the persistent lease target collides", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)
  const leases = new FakeSessionLeases(log)
  const changed: string[] = []
  const failures: unknown[] = []
  leases.seed("occupied")

  await withSupervisor(
    {
      renderer,
      processes,
      leases,
      events: {
        onSessionChanged: ({ session }) => changed.push(session.id),
        onSessionTransitionError: ({ error }) => failures.push(error),
      },
    },
    (supervisor) => Effect.gen(function*() {
      const transitions = yield* PubSub.unbounded<TerminalTransitionEvent>()
      yield* supervisor.show(prepared("temporary", log, undefined, { transitions }))
      PubSub.publishUnsafe(transitions, {
        _tag: "SessionChanged",
        session: { id: "occupied", title: "Occupied", lastModified: 1 },
      })
      yield* Effect.sleep(20)

      expect(changed).toEqual([])
      expect(failures[0]).toBeInstanceOf(SessionOwnedError)
      expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
      expect(leases.current("temporary")).toBeUndefined()
      expect(leases.current("occupied")).toBeDefined()
    }),
  )
})

test("native transitions rekey one owner and stop a duplicate target", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)
  const failures: string[] = []

  await withSupervisor(
    {
      renderer,
      processes,
      events: {
        onSessionTransitionError: ({ error }) => failures.push(error.message),
      },
    },
    (supervisor) => Effect.gen(function*() {
      const transitions = yield* PubSub.unbounded<TerminalTransitionEvent>()
      yield* supervisor.show(prepared("temporary", log, undefined, { transitions }))
      PubSub.publishUnsafe(transitions, {
        _tag: "SessionChanged",
        session: { id: "real", title: "Real", lastModified: 1 },
      })
      yield* Effect.sleep(10)
      expect(yield* supervisor.runningSessionIds).toEqual(new Set(["real"]))

      yield* supervisor.show(prepared("occupied", log))
      PubSub.publishUnsafe(transitions, {
        _tag: "SessionChanged",
        session: { id: "occupied", title: "Occupied", lastModified: 2 },
      })
      yield* Effect.sleep(10)

      expect(failures[0]).toContain("already has an owned terminal")
      expect(yield* supervisor.runningSessionIds).toEqual(new Set(["occupied"]))
    }),
  )
})

test("retains typed ownership when bounded cleanup cannot prove death", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log, { survivesKill: true })
  const leases = new FakeSessionLeases(log)

  await withSupervisor(
    { renderer, processes, leases, gracePeriodMs: 10, killPeriodMs: 20 },
    (supervisor) => Effect.gen(function*() {
      yield* supervisor.show(prepared("stuck", log))
      const shutdownExit = yield* Effect.exit(supervisor.shutdown())

      expect(Exit.isFailure(shutdownExit)).toBeTrue()
      if (Exit.isFailure(shutdownExit)) {
        const error = shutdownExit.cause.reasons.find(
          (reason) => reason._tag === "Fail" && reason.error instanceof TerminalCleanupError,
        )
        expect(error?._tag).toBe("Fail")
      }
      expect(yield* supervisor.ownedSessionIds).toEqual(new Set(["stuck"]))
      expect((yield* supervisor.ownershipSnapshot)[0]?.state).toBe("cleanup-incomplete")
      expect(leases.current("stuck")).toBeDefined()
      expect(log).not.toContain("lease-release:stuck")
      expect(log.filter((entry) => cleanupEntry(entry))).toEqual([
        "ui-release:session-1",
        "signal:stuck:SIGTERM",
        "wait:stuck:10",
        "signal:stuck:SIGKILL",
        "wait:stuck:20",
        "provider-release:stuck",
        "pty-close:stuck",
      ])
    }),
  )
})

test("retries a cleanup-incomplete stop instead of awaiting its failed result", async () => {
  const log: string[] = []
  const processOptions = { survivesKill: true }
  const processes = new FakeProcessFactory(log, processOptions)
  const leases = new FakeSessionLeases(log)

  await withSupervisor(
    {
      renderer: new FakeRenderer(log),
      processes,
      leases,
      gracePeriodMs: 10,
      killPeriodMs: 20,
    },
    (supervisor) => Effect.gen(function*() {
      yield* supervisor.show(prepared("retry-stop", log))
      expect(Exit.isFailure(yield* Effect.exit(supervisor.stopSession("retry-stop")))).toBeTrue()
      expect((yield* supervisor.ownershipSnapshot)[0]?.state).toBe("cleanup-incomplete")

      processOptions.survivesKill = false
      expect(yield* supervisor.stopSession("retry-stop")).toBeTrue()

      expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
      expect(leases.current("retry-stop")).toBeUndefined()
      expect(log.filter((entry) => entry === "signal:retry-stop:SIGTERM")).toHaveLength(2)
      expect(log.filter((entry) => entry === "signal:retry-stop:SIGKILL")).toHaveLength(2)
    }),
  )
})

test("shutdown retries TERM and KILL for a cleanup-incomplete owner", async () => {
  const log: string[] = []
  const processOptions = { survivesKill: true }
  const processes = new FakeProcessFactory(log, processOptions)
  const leases = new FakeSessionLeases(log)

  await withSupervisor(
    {
      renderer: new FakeRenderer(log),
      processes,
      leases,
      gracePeriodMs: 10,
      killPeriodMs: 20,
    },
    (supervisor) => Effect.gen(function*() {
      yield* supervisor.show(prepared("retry-shutdown", log))
      expect(Exit.isFailure(
        yield* Effect.exit(supervisor.stopSession("retry-shutdown")),
      )).toBeTrue()

      processOptions.survivesKill = false
      yield* supervisor.shutdown()

      expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
      expect(leases.current("retry-shutdown")).toBeUndefined()
      expect(log.filter((entry) => entry === "signal:retry-shutdown:SIGTERM")).toHaveLength(2)
      expect(log.filter((entry) => entry === "signal:retry-shutdown:SIGKILL")).toHaveLength(2)
    }),
  )
})

test("retains ownership when provider-scope cleanup fails", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)
  const leases = new FakeSessionLeases(log)

  await withSupervisor({ renderer, processes, leases }, (supervisor) =>
    Effect.gen(function*() {
      yield* supervisor.show(prepared("cleanup-fails", log, undefined, {
        providerCleanupFailure: new Error("sidecar cleanup failed"),
      }))
      const stopExit = yield* Effect.exit(supervisor.stopSession("cleanup-fails"))

      expect(Exit.isFailure(stopExit)).toBeTrue()
      expect((yield* supervisor.ownershipSnapshot)[0]?.state).toBe("cleanup-incomplete")
      expect(yield* supervisor.ownedSessionIds).toEqual(new Set(["cleanup-fails"]))
      expect(leases.current("cleanup-fails")).toBeDefined()
      expect(log).not.toContain("lease-release:cleanup-fails")
      expect(log.indexOf("provider-release:cleanup-fails")).toBeLessThan(
        log.indexOf("pty-close:cleanup-fails"),
      )

      const shutdownExit = yield* Effect.exit(supervisor.shutdown())
      expect(Exit.isFailure(shutdownExit)).toBeTrue()
      expect((yield* supervisor.ownershipSnapshot)[0]?.state).toBe("cleanup-incomplete")
    }),
  )
})

test("reports lease release failures and retains cleanup-incomplete ownership", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)
  const leases = new FakeSessionLeases(log)
  leases.releaseFailure = new PersistenceError({
    operation: "release test lease",
    path: "/test/lease",
    message: "lease release failed",
  })

  await withSupervisor({ renderer, processes, leases }, (supervisor) =>
    Effect.gen(function*() {
      yield* supervisor.show(prepared("lease-release-fails", log))
      const exit = yield* Effect.exit(supervisor.stopSession("lease-release-fails"))

      expect(Exit.isFailure(exit)).toBeTrue()
      if (Exit.isFailure(exit)) {
        const error = exit.cause.reasons.flatMap((reason) =>
          reason._tag === "Fail" && reason.error instanceof TerminalCleanupError
            ? [reason.error]
            : []
        )[0]
        expect(error?.issues.some((issue) => issue.stage === "lease")).toBeTrue()
      }
      expect(leases.current("lease-release-fails")).toBeDefined()
      expect((yield* supervisor.ownershipSnapshot)[0]?.state).toBe("cleanup-incomplete")
    }),
  )
})

test("natural exit releases its scope and reports the active owner", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)
  const leases = new FakeSessionLeases(log)
  const exits: Array<{ sessionId: string; exitCode: number; wasActive: boolean }> = []

  await withSupervisor(
    {
      renderer,
      processes,
      leases,
      events: { onProcessExited: (event) => exits.push(event) },
    },
    (supervisor) => Effect.gen(function*() {
      yield* supervisor.show(prepared("natural", log))
      processes.processes[0]!.finish(7)
      yield* Effect.sleep(10)

      expect(exits).toEqual([{ sessionId: "natural", exitCode: 7, wasActive: true }])
      expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
      expect(leases.current("natural")).toBeUndefined()
      expect(log.indexOf("lease-release:natural")).toBeGreaterThan(
        log.indexOf("provider-release:natural"),
      )
      expect(log.filter((entry) => cleanupEntry(entry))).toEqual([
        "ui-release:session-1",
        "provider-release:natural",
        "pty-close:natural",
      ])
    }),
  )
})

test("natural-exit cleanup failure remains owned and can be retried", async () => {
  const log: string[] = []
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log)
  const leases = new FakeSessionLeases(log)
  const exits: Array<{ cleanupError?: TerminalCleanupError }> = []
  leases.releaseFailure = new PersistenceError({
    operation: "release natural lease",
    path: "/test/lease",
    message: "temporary lease failure",
  })

  await withSupervisor(
    {
      renderer,
      processes,
      leases,
      events: { onProcessExited: (event) => exits.push(event) },
    },
    (supervisor) => Effect.gen(function*() {
      yield* supervisor.show(prepared("natural-incomplete", log))
      processes.processes[0]!.finish(0)
      yield* Effect.sleep(20)

      expect(exits[0]?.cleanupError).toBeInstanceOf(TerminalCleanupError)
      expect((yield* supervisor.ownershipSnapshot)[0]?.state).toBe("cleanup-incomplete")
      expect(leases.current("natural-incomplete")).toBeDefined()

      leases.releaseFailure = undefined
      expect(yield* supervisor.stopSession("natural-incomplete")).toBeTrue()
      expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
      expect(leases.current("natural-incomplete")).toBeUndefined()
    }),
  )
})

test("orders immediate identity transition before exit and keeps adoption idempotent", async () => {
  const log: string[] = []
  const processes = new FakeProcessFactory(log)
  const events: string[] = []

  await withSupervisor(
    {
      renderer: new FakeRenderer(log),
      processes,
      events: {
        onSessionChanged: ({ previousSessionId, session }) => {
          events.push(`changed:${previousSessionId}:${session.id}`)
        },
        onProcessExited: ({ sessionId }) => events.push(`exited:${sessionId}`),
      },
    },
    (supervisor) => Effect.gen(function*() {
      const transitions = yield* PubSub.unbounded<TerminalTransitionEvent>()
      yield* supervisor.show(prepared("temporary", log, undefined, { transitions }))
      PubSub.publishUnsafe(transitions, {
        _tag: "SessionChanged",
        session: { id: "real", title: "Real", lastModified: 1 },
      })
      processes.processes[0]!.finish(0)
      yield* Effect.sleep(30)

      expect(events).toEqual(["changed:temporary:real", "exited:real"])
      expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
      expect(yield* supervisor.replaceSessionId("temporary", "real")).toBeTrue()
    }),
  )
})

test.skipIf(process.platform !== "linux")(
  "Bun PTY shutdown kills the detached process group after the TERM window",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-tree-effect-pty-"))
    temporaryDirectories.push(directory)
    const marker = join(directory, "pids")
    const renderer = new FakeRenderer([])
    const command = [
      "/bin/sh",
      "-c",
      `trap '' HUP TERM; sleep 30 & child=$!; printf '%s %s\\n' "$$" "$child" > ${JSON.stringify(marker)}; wait "$child"`,
    ] as const

    await withSupervisor(
      { renderer, processes: new BunPtyProcessFactory(), gracePeriodMs: 30, killPeriodMs: 200 },
      (supervisor) => Effect.gen(function*() {
        yield* supervisor.show(prepared("real-pty", [], undefined, { command }))
        const processIds = yield* Effect.promise(() => readProcessIds(marker))
        yield* supervisor.shutdown()
        yield* Effect.promise(() => waitUntil(() => processIds.every((pid) => !isProcessAlive(pid))))
      }),
    )
  },
)

function withSupervisor(
  dependencies: Omit<TerminalSupervisorDependencies, "leases"> & {
    readonly leases?: SessionLeasesApi
  },
  use: (supervisor: TerminalSupervisorApi) => Effect.Effect<void, unknown>,
): Promise<void> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const supervisor = yield* makeTerminalSupervisor({
          ...dependencies,
          leases: dependencies.leases ?? new FakeSessionLeases([]),
        })
        yield* use(supervisor)
      }),
    ),
  )
}

function prepared(
  sessionId: string,
  log: string[],
  onAcquire?: () => void,
  options: {
    readonly observer?: TerminalLaunch["observer"]
    readonly initialDraft?: TerminalLaunch["initialDraft"]
    readonly transitions?: PubSub.PubSub<TerminalTransitionEvent>
    readonly command?: TerminalLaunch["command"]
    readonly providerCleanupFailure?: Error
    readonly providerCleanupDelayMs?: number
  } = {},
): PreparedTerminal {
  return {
    session: { id: sessionId, title: sessionId, lastModified: 0 },
    acquireLaunch: Effect.gen(function*() {
      onAcquire?.()
      yield* Effect.addFinalizer(() => options.providerCleanupDelayMs === undefined
        ? Effect.sync(() => {
            log.push(`provider-release:${sessionId}`)
            if (options.providerCleanupFailure) throw options.providerCleanupFailure
          })
        : Effect.promise(async () => {
            log.push(`provider-release-start:${sessionId}`)
            await Bun.sleep(options.providerCleanupDelayMs!)
            log.push(`provider-release:${sessionId}`)
          }))
      return {
        sessionId,
        command: options.command ?? [process.execPath, "-e", "setTimeout(() => {}, 30_000)"],
        cwd: process.cwd(),
        observer: options.observer ?? new NullTerminalObserver(),
        ...(options.initialDraft === undefined ? {} : { initialDraft: options.initialDraft }),
        ...(options.transitions === undefined ? {} : { transitions: options.transitions }),
      }
    }),
  }
}

class FakeSessionLeases implements SessionLeasesApi {
  readonly projectPath = "/test/project"
  acquireFailure: PersistenceError | SessionOwnedError | undefined
  updateFailure: PersistenceError | undefined
  replaceFailure: PersistenceError | SessionOwnedError | undefined
  releaseFailure: PersistenceError | undefined
  private readonly leases = new Map<string, SessionLease>()
  private nextToken = 1

  constructor(private readonly log: string[]) {}

  readonly acquire: SessionLeasesApi["acquire"] = (sessionId, options) =>
    Effect.suspend(() => {
      this.log.push(`lease-acquire:${sessionId}`)
      if (this.acquireFailure) return Effect.fail(this.acquireFailure)
      const existing = this.leases.get(sessionId)
      if (existing) {
        return Effect.fail(new SessionOwnedError({
          providerId: "test-provider",
          sessionId,
          ownerPid: existing.ownerPid,
        }))
      }
      const lease = this.makeLease(sessionId, options?.processGroupId)
      this.leases.set(sessionId, lease)
      return Effect.succeed(lease)
    })

  readonly update: SessionLeasesApi["update"] = (lease, options) =>
    Effect.suspend(() => {
      this.log.push(`lease-update:${lease.sessionId}:${options.processGroupId ?? "none"}`)
      if (this.updateFailure) return Effect.fail(this.updateFailure)
      const current = this.leases.get(lease.sessionId)
      if (current?.ownerToken !== lease.ownerToken) {
        return Effect.fail(this.persistenceFailure("update", lease.sessionId))
      }
      const processGroupId = options.processGroupId === null
        ? undefined
        : options.processGroupId ?? current.processGroupId
      const updated = this.makeLease(
        lease.sessionId,
        processGroupId,
        current.ownerToken,
        current.acquiredAt,
      )
      this.leases.set(lease.sessionId, updated)
      return Effect.succeed(updated)
    })

  readonly replaceSessionId: SessionLeasesApi["replaceSessionId"] = (lease, sessionId) =>
    Effect.suspend(() => {
      this.log.push(`lease-replace:${lease.sessionId}:${sessionId}`)
      if (this.replaceFailure) return Effect.fail(this.replaceFailure)
      const existing = this.leases.get(sessionId)
      if (existing) {
        return Effect.fail(new SessionOwnedError({
          providerId: "test-provider",
          sessionId,
          ownerPid: existing.ownerPid,
        }))
      }
      const current = this.leases.get(lease.sessionId)
      if (current?.ownerToken !== lease.ownerToken) {
        return Effect.fail(this.persistenceFailure("replace", lease.sessionId))
      }
      const replacement = this.makeLease(
        sessionId,
        current.processGroupId,
        `lease-token-${this.nextToken++}`,
        current.acquiredAt,
      )
      this.leases.delete(lease.sessionId)
      this.leases.set(sessionId, replacement)
      return Effect.succeed(replacement)
    })

  readonly release: SessionLeasesApi["release"] = (lease) =>
    Effect.suspend(() => {
      this.log.push(`lease-release:${lease.sessionId}`)
      if (this.releaseFailure) return Effect.fail(this.releaseFailure)
      const current = this.leases.get(lease.sessionId)
      if (current?.ownerToken !== lease.ownerToken) {
        return Effect.fail(this.persistenceFailure("release", lease.sessionId))
      }
      this.leases.delete(lease.sessionId)
      return Effect.void
    })

  current(sessionId: string): SessionLease | undefined {
    return this.leases.get(sessionId)
  }

  seed(sessionId: string): SessionLease {
    const lease = this.makeLease(sessionId)
    this.leases.set(sessionId, lease)
    return lease
  }

  private makeLease(
    sessionId: string,
    processGroupId?: number,
    ownerToken = `lease-token-${this.nextToken++}`,
    acquiredAt = "2026-01-01T00:00:00.000Z",
  ): SessionLease {
    return {
      sessionId,
      ownerToken,
      ownerPid: process.pid,
      ...(processGroupId === undefined ? {} : { processGroupId }),
      acquiredAt,
      updatedAt: "2026-01-01T00:00:01.000Z",
    }
  }

  private persistenceFailure(operation: string, sessionId: string): PersistenceError {
    return new PersistenceError({
      operation,
      path: `/test/leases/${sessionId}`,
      message: `Unable to ${operation} ${sessionId}`,
    })
  }
}

class FakeRenderer implements TerminalRenderer {
  readonly columns = 80
  readonly rows = 24
  readonly surfaces: FakeSurface[] = []
  readonly copied: string[] = []
  focusFailures = 0
  throwOnClearSelection = false
  throwOnSurfaceRelease = false
  private selectionListener: ((surface: TerminalSurface, text: string) => void) | undefined

  constructor(private readonly log: string[]) {}

  createSurface(id: string, callbacks: TerminalSurfaceCallbacks): TerminalSurface {
    const surface = new FakeSurface(id, callbacks, this.log, {
      focus: () => {
        if (this.focusFailures === 0) return
        this.focusFailures--
        throw new Error("focus failed")
      },
      release: () => {
        if (this.throwOnSurfaceRelease) throw new Error("surface release failed")
      },
    })
    this.surfaces.push(surface)
    return surface
  }

  clearSelection(): void {
    if (this.throwOnClearSelection) throw new Error("clear selection failed")
  }

  copyToClipboard(text: string): void {
    this.copied.push(text)
  }

  onSelection(listener: (surface: TerminalSurface, text: string) => void): () => void {
    this.selectionListener = listener
    return () => {
      this.selectionListener = undefined
    }
  }
}

class FakeSurface implements TerminalSurface {
  readonly writes: Uint8Array[] = []
  active = false
  released = false
  private lines: string[] = []

  constructor(
    readonly id: string,
    private readonly callbacks: TerminalSurfaceCallbacks,
    private readonly log: string[],
    private readonly defects: {
      readonly focus: () => void
      readonly release: () => void
    },
  ) {}

  write(data: Uint8Array): void {
    this.writes.push(data)
    this.lines = [new TextDecoder().decode(data)]
    this.callbacks.onScreenChange()
  }

  screen() {
    return { lines: this.lines, cursor: { x: 0, y: 0, visible: true } }
  }

  focus(): void {
    this.defects.focus()
  }
  blur(): void {}

  setActive(active: boolean): void {
    this.active = active
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.active = false
    this.log.push(`ui-release:${this.sessionId()}`)
    this.defects.release()
  }

  input(data: Uint8Array): void {
    this.lines = [new TextDecoder().decode(data)]
    this.callbacks.onData(data, "input")
  }

  resize(columns: number, rows: number): void {
    this.callbacks.onResize(columns, rows)
  }

  private sessionId(): string {
    return this.id.replace(/^agent-owner-terminal-owner-/, "session-")
  }
}

class FakeProcessFactory implements TerminalProcessFactory {
  readonly processes: FakeProcess[] = []

  constructor(
    private readonly log: string[],
    private readonly options: {
      readonly survivesKill?: boolean
      readonly waitDelayMs?: number
      readonly onSpawn?: () => void | Promise<void>
      readonly spawnFailure?: Error
    } = {},
  ) {}

  spawn(
    launch: TerminalLaunch,
    _dimensions: { readonly columns: number; readonly rows: number },
    callbacks: TerminalProcessCallbacks,
  ): TerminalProcess | Promise<TerminalProcess> {
    this.log.push(`spawn:${launch.sessionId}`)
    const create = () => {
      if (this.options.spawnFailure) throw this.options.spawnFailure
      const process = new FakeProcess(launch.sessionId, callbacks, this.log, this.options)
      this.processes.push(process)
      return process
    }
    const pending = this.options.onSpawn?.()
    return pending ? Promise.resolve(pending).then(create) : create()
  }
}

class FakeProcess implements TerminalProcess {
  readonly pid: number
  readonly writes: Uint8Array[] = []
  readonly sizes: Array<[number, number]> = []
  readonly ptyDrained: Promise<void>
  readonly exited: Promise<number>
  exitCode: number | null = null
  ptyOpen = true
  onWait: ((process: FakeProcess) => void) | undefined
  private alive = true
  private resolveExit!: (code: number) => void
  private resolveDrain!: () => void

  constructor(
    private readonly sessionId: string,
    private readonly callbacks: TerminalProcessCallbacks,
    private readonly log: string[],
    private readonly options: {
      readonly survivesKill?: boolean
      readonly waitDelayMs?: number
    },
  ) {
    this.pid = 10_000 + Math.floor(Math.random() * 10_000)
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve
    })
    this.ptyDrained = new Promise((resolve) => {
      this.resolveDrain = resolve
    })
  }

  write(data: Uint8Array): void {
    if (this.ptyOpen) this.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    if (this.ptyOpen) this.sizes.push([cols, rows])
  }

  signalGroup(signal: NodeJS.Signals): void {
    this.log.push(`signal:${this.sessionId}:${signal}`)
    if (signal === "SIGKILL" && !this.options.survivesKill) this.finish(137)
  }

  isGroupAlive(): boolean {
    return this.alive
  }

  waitForGroupExit(timeoutMs: number): Effect.Effect<boolean> {
    return Effect.promise(async () => {
      this.log.push(`wait:${this.sessionId}:${timeoutMs}`)
      this.onWait?.(this)
      if (this.options.waitDelayMs) await Bun.sleep(this.options.waitDelayMs)
      return !this.alive
    })
  }

  closePty(): void {
    if (!this.ptyOpen) return
    this.log.push(`pty-close:${this.sessionId}`)
    this.ptyOpen = false
    this.resolveDrain()
    this.callbacks.onPtyClosed()
  }

  unref(): void {}

  output(data: Uint8Array): void {
    this.callbacks.onOutput(data)
  }

  finish(code: number): void {
    if (!this.alive) return
    this.alive = false
    this.exitCode = code
    this.resolveDrain()
    this.callbacks.onPtyClosed()
    this.resolveExit(code)
  }
}

class OutputObserver implements TerminalObserver {
  observeOutput(data: Uint8Array): readonly AgentActivity[] {
    const text = new TextDecoder().decode(data)
    if (text === "working,idle") return ["working", "idle"]
    if (text === "working") return ["working"]
    if (text === "idle") return ["idle"]
    return []
  }

  observeScreen(): undefined { return undefined }
  observeDraft(): undefined { return undefined }
}

class DraftObserver implements TerminalObserver {
  observeOutput(): readonly AgentActivity[] { return [] }
  observeScreen(): undefined { return undefined }

  observeDraft(screen: TerminalScreen) {
    const text = screen.lines.join("\n")
    return text.length > 0 ? { text, exact: false as const } : undefined
  }
}

function osc52(text: string): Uint8Array {
  return new TextEncoder().encode(`\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`)
}

function cleanupEntry(entry: string): boolean {
  return /^(ui-release|signal|wait|provider-release|pty-close):/.test(entry)
}

async function readProcessIds(path: string): Promise<number[]> {
  let contents = ""
  await waitUntil(async () => {
    try {
      contents = await readFile(path, "utf8")
      return contents.length > 0
    } catch {
      return false
    }
  })
  return contents.trim().split(/\s+/).map(Number)
}

async function waitUntil(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 2_000
  while (!(await condition()) && performance.now() < deadline) await Bun.sleep(10)
  expect(await condition()).toBeTrue()
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
