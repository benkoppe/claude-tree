import { afterAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Cause, Deferred, Effect, Exit, Fiber, PubSub, Scope } from "effect"
import { TestClock } from "effect/testing"

import {
  NullTerminalObserver,
  type AgentActivity,
  type TerminalObserver,
  type TerminalScreen,
} from "../../src/domain/model"
import {
  PersistenceError,
  ProviderError,
  ProviderCleanupError,
  SessionOwnedError,
  TerminalError,
} from "../../src/domain/errors"
import type {
  BranchRelation,
  PendingIdentityAdoption,
  TerminalOwner as PersistedTerminalOwner,
} from "../../src/domain/persistence"
import type {
  TerminalProcess,
  TerminalProcessCallbacks,
  TerminalProcessFactory,
  TerminalRenderer,
  TerminalSurface,
  TerminalSurfaceCallbacks,
} from "../../src/infrastructure/terminal"
import { BunPtyProcessFactory } from "../../src/infrastructure/terminal"
import type {
  CodexAppServerClient,
  CodexThread,
} from "../../src/infrastructure/providers/codex/app-server"
import {
  CodexProvider,
  type CodexObservedServicesFactory,
} from "../../src/infrastructure/providers/codex/provider"
import {
  CodexTuiProxyError,
  type CodexTuiProxyTransitionRequest,
} from "../../src/infrastructure/providers/codex/tui-proxy"
import type {
  PreparedTerminal,
  TerminalLaunch,
  TerminalTransitionAcknowledgmentError,
  TerminalTransitionEvent,
  TerminalTransitionRequest,
} from "../../src/services/provider"
import {
  makeTerminalSupervisor,
  TerminalCleanupError,
  type TerminalActivityEvent,
  type TerminalExitEvent,
  type TerminalOwnershipRepository,
  type TerminalSessionChangedEvent,
  type TerminalSessionTransitionErrorEvent,
  type TerminalSupervisorApi,
  type TerminalSupervisorDependencies,
} from "../../src/services/terminal-supervisor"

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

test("show returns one immutable owner ID and records its process group before focus", async () => {
  const fixture = makeFixture()

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    const first = yield* supervisor.show(prepared("session", fixture))
    const second = yield* supervisor.show(prepared("session", fixture))
    const snapshot = (yield* supervisor.ownershipSnapshot)[0]!

    expect(first).toBe("terminal-owner-1")
    expect(second).toBe(first)
    expect(snapshot.ownerId).toBe(first)
    expect(snapshot.processGroupId).toBe(fixture.processes.processes[0]!.processGroupId)
    expect(fixture.log.indexOf("spawn:session")).toBeLessThan(
      fixture.log.indexOf(`lease-update:session:${snapshot.processGroupId}`),
    )
    expect(fixture.log.indexOf(`lease-update:session:${snapshot.processGroupId}`)).toBeLessThan(
      fixture.log.indexOf("focus:terminal-owner-1"),
    )
  }))
})

test("interruption during provider acquisition rolls back its scope and lease", async () => {
  const fixture = makeFixture()
  const started = Deferred.makeUnsafe<void>()
  const blocker = Deferred.makeUnsafe<void>()
  const interrupted: PreparedTerminal = {
    session: session("interrupted"),
    acquireLaunch: Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => fixture.log.push("provider-scope-release")))
      yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(blocker)
      return acquiredLaunch("interrupted", fixture)
    }),
  }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(supervisor.show(interrupted))
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)

    expect(fixture.leases.current("interrupted")).toBeUndefined()
    expect(fixture.processes.processes).toHaveLength(0)
    expect(fixture.log).toContain("provider-scope-release")
    expect(fixture.log).toContain("lease-release:interrupted")
  }))
})

test("one unbounded semantic queue preserves transition order and sequence IDs under pressure", async () => {
  const fixture = makeFixture()
  const transitions = await Effect.runPromise(PubSub.unbounded<TerminalTransitionRequest>())
  const observed: Array<TerminalActivityEvent | TerminalSessionChangedEvent | TerminalExitEvent> = []
  fixture.dependencies.events = {
    onActivityChanged: (event) => observed.push(event),
    onSessionChanged: (event) => {
      observed.push(event)
      if (event.acknowledgment) Effect.runSync(Deferred.succeed(event.acknowledgment, undefined))
    },
    onProcessExited: (event) => observed.push(event),
  }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    const ownerId = yield* supervisor.show(prepared("temporary", fixture, {
      transitions,
      observer: new OutputObserver(),
    }))
    const process = fixture.processes.processes[0]!
    const working = bytes("working")
    for (let index = 0; index < 20_000; index += 1) process.output(working)
    yield* eventually(() => observed.length >= 1)

    const acknowledgment = yield* publishTransition(transitions, {
      _tag: "SessionChanged",
      kind: "native-fork",
      session: session("real"),
    })
    yield* Deferred.await(acknowledgment)
    process.output(bytes("idle"))
    process.finish(0)
    yield* eventually(() => observed.some((event) => "exitCode" in event))

    expect(observed.map((event) => event.ownerId)).toEqual(observed.map(() => ownerId))
    expect(observed.map((event) => event.sequenceId)).toEqual(
      [...observed.map((event) => event.sequenceId)].sort((left, right) => left - right),
    )
    expect(new Set(observed.map((event) => event.sequenceId)).size).toBe(observed.length)
    expect(observed.map(eventName)).toEqual(["activity:working", "session:real", "activity:idle", "exit:real"])
  }))
})

test("a semantic transition defect fails its acknowledgment before supervised cleanup", async () => {
  const fixture = makeFixture()
  const transitions = await Effect.runPromise(PubSub.unbounded<TerminalTransitionRequest>())
  const errors: TerminalSessionTransitionErrorEvent[] = []
  const exits: TerminalExitEvent[] = []
  fixture.dependencies.events = {
    onSessionTransitionError: (event) => errors.push(event),
    onProcessExited: (event) => exits.push(event),
  }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("semantic-defect", fixture, { transitions }))
    const implementation = supervisor as unknown as {
      handleSemanticEvent(owner: unknown, event: { readonly _tag: string }): Effect.Effect<void>
    }
    const handleSemanticEvent = implementation.handleSemanticEvent.bind(implementation)
    implementation.handleSemanticEvent = (owner, event) => event._tag === "Transition"
      ? Effect.die(new Error("transition reducer defect"))
      : handleSemanticEvent(owner, event)

    const acknowledgment = yield* publishTransition(transitions, {
      _tag: "SessionChanged",
      kind: "native-fork",
      session: session("uncommitted"),
    })
    const error = yield* Effect.flip(Deferred.await(acknowledgment))
    expect(error).toBeInstanceOf(TerminalError)
    yield* eventually(() => exits.length === 1)

    expect(errors).toHaveLength(1)
    expect(errors[0]?.error).toBeInstanceOf(TerminalError)
    expect(errors[0]!.sequenceId).toBeLessThan(exits[0]!.sequenceId)
    expect(fixture.leases.current("semantic-defect")).toBeUndefined()
  }))
})

test("activity and exit defects do not strand natural cleanup", async () => {
  const fixture = makeFixture()
  const exits: TerminalExitEvent[] = []
  fixture.dependencies.events = { onProcessExited: (event) => exits.push(event) }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("event-defects", fixture, { observer: new OutputObserver() }))
    const implementation = supervisor as unknown as {
      handleSemanticEvent(owner: unknown, event: { readonly _tag: string }): Effect.Effect<void>
    }
    const handleSemanticEvent = implementation.handleSemanticEvent.bind(implementation)
    implementation.handleSemanticEvent = (owner, event) =>
      event._tag === "Activity" || event._tag === "Exited"
        ? Effect.die(new Error(`${event._tag} reducer defect`))
        : handleSemanticEvent(owner, event)

    fixture.processes.processes[0]!.output(bytes("working"))
    fixture.processes.processes[0]!.finish(0)
    yield* eventually(() => exits.length === 1)

    expect(exits[0]).toMatchObject({ sessionId: "event-defects", exitCode: 0 })
    expect(fixture.leases.current("event-defects")).toBeUndefined()
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
  }))
})

test("a transition enqueue defect settles the request and cleans the owner", async () => {
  const fixture = makeFixture()
  const transitions = await Effect.runPromise(PubSub.unbounded<TerminalTransitionRequest>())
  const exits: TerminalExitEvent[] = []
  fixture.dependencies.events = { onProcessExited: (event) => exits.push(event) }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("enqueue-defect", fixture, { transitions }))
    const implementation = supervisor as unknown as {
      offerEvent(owner: unknown, event: { readonly _tag: string }): boolean
    }
    const offerEvent = implementation.offerEvent.bind(implementation)
    let failed = false
    implementation.offerEvent = (owner, event) => {
      if (!failed && event._tag === "Transition") {
        failed = true
        throw new Error("queue offer defect")
      }
      return offerEvent(owner, event)
    }

    const acknowledgment = yield* publishTransition(transitions, {
      _tag: "SessionChanged",
      kind: "native-fork",
      session: session("not-enqueued"),
    })
    const error = yield* Effect.flip(Deferred.await(acknowledgment))
    expect(error).toBeInstanceOf(TerminalError)
    yield* eventually(() => exits.length === 1)

    expect(fixture.leases.current("enqueue-defect")).toBeUndefined()
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
  }))
})

test("exit, stop, and shutdown converge on one idempotent cleanup", async () => {
  const fixture = makeFixture({ waitDelayMs: 20 })

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("race", fixture))
    const stopFiber = yield* Effect.forkChild(supervisor.stopSession("race"))
    yield* eventually(() => fixture.log.includes("wait:race:10"))
    fixture.processes.processes[0]!.finish(0)
    const shutdownFiber = yield* Effect.forkChild(supervisor.shutdown())
    yield* Fiber.join(stopFiber)
    yield* Fiber.join(shutdownFiber)

    expect(fixture.log.filter((entry) => entry === "provider-close:race")).toHaveLength(1)
    expect(fixture.log.filter((entry) => entry === "pty-close:race")).toHaveLength(1)
    expect(fixture.log.filter((entry) => entry === "lease-release:race")).toHaveLength(1)
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
  }))
})

test("provider cleanup is bounded, retryable, and releases the lease only after success", async () => {
  const fixture = makeFixture()
  fixture.providerCloseFailures = 2

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("provider-retry", fixture))
    yield* supervisor.stopSession("provider-retry")

    expect(fixture.providerCloseAttempts).toBe(3)
    expect(fixture.leases.current("provider-retry")).toBeUndefined()
  }))
})

test("incomplete provider cleanup preserves ownership and succeeds on a later retry", async () => {
  const fixture = makeFixture()
  fixture.providerCloseFailures = 10

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("provider-incomplete", fixture))
    const first = yield* Effect.exit(supervisor.stopSession("provider-incomplete"))

    expect(Exit.isFailure(first)).toBeTrue()
    expect(fixture.leases.current("provider-incomplete")).toBeDefined()
    expect((yield* supervisor.ownershipSnapshot)[0]?.state).toBe("cleanup-incomplete")

    fixture.providerCloseFailures = 0
    yield* supervisor.stopSession("provider-incomplete")
    expect(fixture.leases.current("provider-incomplete")).toBeUndefined()
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
  }))
})

test("synchronous cleanup mutation defects settle repeated stop and shutdown requests", async () => {
  const fixture = makeFixture()
  const cleanupErrors: TerminalCleanupError[] = []
  fixture.leases.markConstructionFailures = 100
  fixture.dependencies.events = { onCleanupError: (error) => cleanupErrors.push(error) }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("mark-defect", fixture))

    for (const cleanup of [
      supervisor.stopSession("mark-defect"),
      supervisor.stopSession("mark-defect"),
      supervisor.shutdown(),
    ]) {
      const exit = yield* Effect.exit(cleanup)
      expect(Exit.isFailure(exit)).toBeTrue()
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(TerminalCleanupError)
    }

    expect((yield* supervisor.ownershipSnapshot)[0]?.state).toBe("cleanup-incomplete")
    expect(cleanupErrors).toHaveLength(1)

    fixture.leases.markConstructionFailures = 0
    yield* supervisor.shutdown()
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
  }))
})

test("a cleanup finalization defect settles the plan and remains retryable", async () => {
  const fixture = makeFixture()
  const cleanupErrors: TerminalCleanupError[] = []
  fixture.dependencies.events = { onCleanupError: (error) => cleanupErrors.push(error) }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("finalize-defect", fixture))
    const implementation = supervisor as unknown as {
      deleteOwner(owner: unknown): void
    }
    const deleteOwner = implementation.deleteOwner.bind(implementation)
    let failed = false
    implementation.deleteOwner = (owner) => {
      if (!failed) {
        failed = true
        throw new Error("cleanup finalization failed")
      }
      deleteOwner(owner)
    }

    const first = yield* Effect.exit(supervisor.stopSession("finalize-defect"))
    expect(Exit.isFailure(first)).toBeTrue()
    if (Exit.isFailure(first)) expect(Cause.squash(first.cause)).toBeInstanceOf(TerminalCleanupError)
    expect((yield* supervisor.ownershipSnapshot)[0]?.state).toBe("cleanup-incomplete")
    expect(cleanupErrors).toHaveLength(1)

    yield* supervisor.stopSession("finalize-defect")
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
  }))
})

test("permanent provider cleanup failure still closes provider and runtime scopes", async () => {
  const fixture = makeFixture()
  fixture.providerCloseFailures = 100
  const terminal: PreparedTerminal = {
    session: session("scope-cleanup"),
    acquireLaunch: Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => fixture.log.push("provider-scope-release")))
      return acquiredLaunch("scope-cleanup", fixture)
    }),
  }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    const runtimeScope = (supervisor as unknown as { readonly runtimeScope: Scope.Closeable }).runtimeScope
    yield* Scope.addFinalizer(runtimeScope, Effect.sync(() => fixture.log.push("runtime-scope-release")))
    yield* supervisor.show(terminal)

    const shutdownExit = yield* Effect.exit(supervisor.shutdown())
    expect(Exit.isFailure(shutdownExit)).toBeTrue()
    expect(fixture.log).toContain("provider-scope-release")
    expect(fixture.log).toContain("runtime-scope-release")
    expect(fixture.leases.current("scope-cleanup")).toBeDefined()

    fixture.providerCloseFailures = 0
    yield* supervisor.shutdown()
    expect(fixture.leases.current("scope-cleanup")).toBeUndefined()
  }))
})

test("unknown process-group liveness preserves the lease until absence is proven", async () => {
  const fixture = makeFixture({ unknownLiveness: true })

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("unknown", fixture))
    const first = yield* Effect.exit(supervisor.stopSession("unknown"))
    expect(Exit.isFailure(first)).toBeTrue()
    expect(fixture.leases.current("unknown")).toBeDefined()

    fixture.processOptions.unknownLiveness = false
    fixture.processes.processes[0]!.finish(0)
    yield* supervisor.stopSession("unknown")
    expect(fixture.leases.current("unknown")).toBeUndefined()
  }))
})

test("a synchronous process wait defect is contained without escaping cleanup", async () => {
  const fixture = makeFixture()
  fixture.processOptions.waitConstructionFailures = 1

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("wait-defect", fixture))
    yield* supervisor.stopSession("wait-defect")
    expect(fixture.leases.current("wait-defect")).toBeUndefined()
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
  }))
})

test("stale callbacks cannot mutate a replacement owner", async () => {
  const fixture = makeFixture()
  const activities: TerminalActivityEvent[] = []
  fixture.dependencies.events = { onActivityChanged: (event) => activities.push(event) }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    const oldOwnerId = yield* supervisor.show(prepared("same", fixture, {
      observer: new OutputObserver(),
    }))
    const oldProcess = fixture.processes.processes[0]!
    yield* supervisor.stopSession("same")

    const newOwnerId = yield* supervisor.show(prepared("same", fixture, {
      observer: new OutputObserver(),
    }))
    oldProcess.output(bytes("working"))
    fixture.processes.processes[1]!.output(bytes("working"))
    yield* eventually(() => activities.length === 1)

    expect(newOwnerId).not.toBe(oldOwnerId)
    expect(activities).toEqual([
      expect.objectContaining({ ownerId: newOwnerId, sessionId: "same", activity: "working" }),
    ])
  }))
})

test("failed focus safely restores the previously active surface", async () => {
  const fixture = makeFixture()

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    const firstOwnerId = yield* supervisor.show(prepared("first", fixture))
    fixture.renderer.focusFailures = 1
    const second = yield* Effect.exit(supervisor.show(prepared("second", fixture)))

    expect(Exit.isFailure(second)).toBeTrue()
    expect(yield* supervisor.activeSessionId).toBe("first")
    expect(fixture.renderer.surfaces[0]!.active).toBeTrue()
    expect((yield* supervisor.ownershipSnapshot)[0]?.ownerId).toBe(firstOwnerId)
    expect(fixture.leases.current("second")).toBeUndefined()
  }))
})

test("acknowledged identity adoption keeps owner identity and never rolls back an uncertain rename", async () => {
  const fixture = makeFixture()
  const transitions = await Effect.runPromise(PubSub.unbounded<TerminalTransitionRequest>())
  fixture.leases.replaceFailures = 1
  fixture.dependencies.events = {
    onSessionChanged: (event) => {
      if (event.acknowledgment) Effect.runSync(Deferred.succeed(event.acknowledgment, undefined))
    },
  }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    const ownerId = yield* supervisor.show(prepared("temporary", fixture, { transitions }))
    const acknowledgment = yield* publishTransition(transitions, {
      _tag: "SessionChanged",
      kind: "native-fork",
      session: session("real"),
    })
    const acknowledgmentExit = yield* Effect.exit(Deferred.await(acknowledgment))
    expect(Exit.isFailure(acknowledgmentExit)).toBeTrue()
    yield* eventually(() => fixture.leases.current("real") === undefined &&
      fixture.leases.current("temporary") === undefined)

    expect(fixture.leases.replaceCalls).toEqual(["temporary:real", "temporary:real"])
    expect(new Set(fixture.leases.identityCalls.map((call) => call.mutationToken)).size).toBe(1)
    expect(fixture.leases.replaceCalls).not.toContain("real:temporary")
    expect(ownerId).toBe("terminal-owner-1")
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
  }))
})

test("queues two pending transitions per owner until each application acknowledgment completes", async () => {
  const fixture = makeFixture()
  const transitions = await Effect.runPromise(PubSub.unbounded<TerminalTransitionRequest>())
  const changed: TerminalSessionChangedEvent[] = []
  fixture.dependencies.events = { onSessionChanged: (event) => changed.push(event) }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("source", fixture, { transitions }))
    const first = yield* publishTransition(transitions, {
      _tag: "SessionChanged",
      kind: "native-fork",
      session: session("child-one"),
    })
    const second = yield* publishTransition(transitions, {
      _tag: "SessionChanged",
      kind: "native-fork",
      session: session("child-two"),
    })
    yield* eventually(() => changed.length === 1)
    expect(changed[0]!.session.id).toBe("child-one")
    expect(yield* Deferred.isDone(first)).toBeFalse()
    expect(yield* Deferred.isDone(second)).toBeFalse()

    yield* Deferred.succeed(changed[0]!.acknowledgment!, undefined)
    yield* Deferred.await(first)
    yield* eventually(() => changed.length === 2)
    expect(changed[1]!.previousSessionId).toBe("child-one")
    yield* Deferred.succeed(changed[1]!.acknowledgment!, undefined)
    yield* Deferred.await(second)

    expect(changed.map((event) => event.sequenceId)).toEqual([1, 2])
    expect(yield* supervisor.runningSessionIds).toEqual(new Set(["child-two"]))
  }))
})

test("native fork validates and commits source metadata before notifying the application", async () => {
  const fixture = makeFixture()
  const transitions = await Effect.runPromise(PubSub.unbounded<TerminalTransitionRequest>())
  let changed: TerminalSessionChangedEvent | undefined
  fixture.dependencies.events = {
    onSessionChanged: (event) => {
      changed = event
      acknowledge(event)
    },
  }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("source", fixture, { transitions }))
    const providerAcknowledgment = yield* publishTransition(transitions, {
      _tag: "SessionChanged",
      kind: "native-fork",
      session: session("native-child"),
      derivation: Effect.succeed({
        childSessionId: "native-child",
        parentSessionId: "source",
        sourceMessageId: "turn-7",
        sharedMessages: [{ parentMessageId: "p-1", childMessageId: "c-1" }],
      }),
    })
    yield* Deferred.await(providerAcknowledgment)

    expect(fixture.leases.identityCalls[0]).toMatchObject({
      kind: "native-fork",
      relation: {
        childSessionId: "native-child",
        parentSessionId: "source",
        sourceMessageId: "turn-7",
      },
    })
    expect(fixture.leases.identityCalls[0]!.relation?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(changed?.relation).toEqual(fixture.leases.identityCalls[0]!.relation)
    expect(fixture.leases.current("source")).toBeUndefined()
    expect(fixture.leases.current("native-child")).toBeDefined()
  }))
})

test("a first Codex fork adopts its temporary owner with exact ancestry for family projection", async () => {
  const fixture = makeFixture()
  const projectPath = process.cwd()
  const sourceSessionId = "codex-source"
  const childSessionId = "codex-child"
  const parentThread: CodexThread = {
    id: sourceSessionId,
    name: null,
    preview: "Source",
    updatedAt: 1,
    cwd: projectPath,
    gitInfo: null,
    turns: [{
      id: "source-turn",
      status: "completed",
      items: [
        { id: "source-user", type: "userMessage", content: [{ type: "text", text: "Question" }] },
        { id: "source-agent", type: "agentMessage", text: "Answer" },
      ],
    }],
  }
  const childThread: CodexThread = {
    id: childSessionId,
    name: null,
    preview: "First fork",
    updatedAt: 2,
    cwd: projectPath,
    gitInfo: null,
    turns: [{
      id: "child-turn",
      status: "completed",
      items: [
        { id: "child-user", type: "userMessage", content: [{ type: "text", text: "Question" }] },
        { id: "child-agent", type: "agentMessage", text: "Answer" },
      ],
    }],
  }
  const appServer = {
    readThread: (sessionId: string) => Effect.succeed(
      sessionId === sourceSessionId ? parentThread : childThread,
    ),
    close: () => Effect.void,
  } as unknown as CodexAppServerClient
  let source!: PubSub.PubSub<CodexTuiProxyTransitionRequest>
  const observedServicesFactory: CodexObservedServicesFactory = () => Effect.gen(function*() {
    source = yield* PubSub.unbounded<CodexTuiProxyTransitionRequest>()
    return {
      remoteUrl: "ws://127.0.0.1:12348",
      bearerToken: "secret",
      transitions: source,
      close: () => Effect.void,
    }
  })
  const provider = new CodexProvider(projectPath, "/usr/bin/codex", {
    appServerFactory: () => Effect.succeed(appServer),
    observedServicesFactory,
    randomUUID: () => "first-fork",
    canonicalize: async (path) => path,
  })
  let projected: TerminalSessionChangedEvent | undefined
  fixture.dependencies.events = {
    onSessionChanged: (event) => {
      projected = event
      acknowledge(event)
    },
  }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    const prepared = yield* provider.prepareNewSession
    yield* supervisor.show(prepared)
    const acknowledgment = yield* Deferred.make<void, CodexTuiProxyError>()
    yield* PubSub.publish(source, {
      transition: {
        _tag: "CodexThreadTransition",
        operation: "fork",
        kind: "temporary-adoption",
        previousThreadId: prepared.session.id,
        requestedThreadId: sourceSessionId,
        forkPointTurnId: "source-turn",
        threadId: childSessionId,
        title: "First fork",
        updatedAt: 2,
        cwd: projectPath,
      },
      acknowledgment,
    })
    yield* Deferred.await(acknowledgment)

    const relation = {
      childSessionId,
      parentSessionId: sourceSessionId,
      sourceMessageId: "source-agent",
      sharedMessages: [
        { parentMessageId: "source-user", childMessageId: "child-user" },
        { parentMessageId: "source-agent", childMessageId: "child-agent" },
      ],
    }
    expect(fixture.leases.identityCalls[0]).toMatchObject({
      kind: "temporary-adoption",
      relation,
    })
    expect(fixture.leases.identityCalls[0]!.relation?.createdAt).toMatch(/T/)
    expect(projected).toMatchObject({
      previousSessionId: prepared.session.id,
      kind: "temporary-adoption",
      session: { id: childSessionId, transient: true },
      relation,
    })
    expect(projected?.relation).toEqual(fixture.leases.identityCalls[0]!.relation)
    expect(yield* supervisor.runningSessionIds).toEqual(new Set([childSessionId]))
  }))
})

test("temporary owners commit a temporary adoption and acknowledge the journal", async () => {
  const fixture = makeFixture()
  const transitions = await Effect.runPromise(PubSub.unbounded<TerminalTransitionRequest>())
  fixture.dependencies.events = { onSessionChanged: acknowledge }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("temporary", fixture, { transitions, transient: true }))
    const providerAcknowledgment = yield* publishTransition(transitions, {
      _tag: "SessionChanged",
      kind: "temporary-adoption",
      session: session("provider-id"),
    })
    yield* Deferred.await(providerAcknowledgment)
    expect(fixture.leases.identityCalls[0]?.kind).toBe("temporary-adoption")
    expect(fixture.log.some((entry) => entry.startsWith("lease-ack:"))).toBeTrue()
  }))
})

test("rejects a transition kind that disagrees with the owner's adoption state", async () => {
  const fixture = makeFixture()
  const transitions = await Effect.runPromise(PubSub.unbounded<TerminalTransitionRequest>())

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("temporary", fixture, { transitions, transient: true }))
    const acknowledgment = yield* publishTransition(transitions, {
      _tag: "SessionChanged",
      kind: "native-fork",
      session: session("untrusted-child"),
    })
    expect(yield* Effect.flip(Deferred.await(acknowledgment))).toBeInstanceOf(TerminalError)
    yield* eventually(() => fixture.leases.current("temporary") === undefined)

    expect(fixture.leases.identityCalls).toEqual([])
    expect(fixture.leases.current("untrusted-child")).toBeUndefined()
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
  }))
})

test("a temporary Codex owner adopts once and treats every later transition as a native fork", async () => {
  const fixture = makeFixture()
  const transitions = await Effect.runPromise(PubSub.unbounded<TerminalTransitionRequest>())
  const changed: TerminalSessionChangedEvent[] = []
  fixture.dependencies.events = {
    onSessionChanged: (event) => {
      changed.push(event)
      acknowledge(event)
    },
  }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("temporary", fixture, { transitions, transient: true }))
    for (const transition of [
      {
        kind: "temporary-adoption" as const,
        previousSessionId: "temporary",
        session: { ...session("real"), transient: true },
      },
      {
        kind: "native-fork" as const,
        previousSessionId: "real",
        session: session("fork-one"),
      },
      {
        kind: "native-fork" as const,
        previousSessionId: "fork-one",
        session: session("fork-two"),
      },
    ]) {
      const acknowledgment = yield* publishTransition(transitions, {
        _tag: "SessionChanged",
        kind: transition.kind,
        session: transition.session,
        ...(transition.kind === "native-fork"
          ? {
              derivation: Effect.succeed({
                childSessionId: transition.session.id,
                parentSessionId: transition.previousSessionId,
                sourceMessageId: `${transition.previousSessionId}-source`,
                sharedMessages: [{
                  parentMessageId: `${transition.previousSessionId}-source`,
                  childMessageId: `${transition.session.id}-source`,
                }],
              }),
            }
          : {}),
      })
      yield* Deferred.await(acknowledgment)
    }

    expect(fixture.leases.identityCalls.map((call) => call.kind)).toEqual([
      "temporary-adoption",
      "native-fork",
      "native-fork",
    ])
    expect(fixture.leases.replaceCalls).toEqual([
      "temporary:real",
      "real:fork-one",
      "fork-one:fork-two",
    ])
    expect(changed.map((event) => ({
      previousSessionId: event.previousSessionId,
      sessionId: event.session.id,
      kind: event.kind,
      transient: event.session.transient === true,
    }))).toEqual([
      {
        previousSessionId: "temporary",
        sessionId: "real",
        kind: "temporary-adoption",
        transient: true,
      },
      {
        previousSessionId: "real",
        sessionId: "fork-one",
        kind: "native-fork",
        transient: false,
      },
      {
        previousSessionId: "fork-one",
        sessionId: "fork-two",
        kind: "native-fork",
        transient: false,
      },
    ])
    expect(yield* supervisor.runningSessionIds).toEqual(new Set(["fork-two"]))
    expect(fixture.leases.current("fork-two")?.ownerToken).toBeDefined()
  }))
})

test("a synchronous identity commit defect fails queued requests and completes forward cleanup", async () => {
  const fixture = makeFixture()
  const transitions = await Effect.runPromise(PubSub.unbounded<TerminalTransitionRequest>())
  const changed: TerminalSessionChangedEvent[] = []
  const transitionErrors: TerminalSessionTransitionErrorEvent[] = []
  const exits: TerminalExitEvent[] = []
  const derivationStarted = Deferred.makeUnsafe<void>()
  const releaseDerivation = Deferred.makeUnsafe<void>()
  fixture.leases.commitIdentityConstructionFailures = 1
  fixture.dependencies.events = {
    onSessionChanged: (event) => {
      changed.push(event)
      acknowledge(event)
    },
    onSessionTransitionError: (event) => transitionErrors.push(event),
    onProcessExited: (event) => exits.push(event),
  }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("commit-source", fixture, { transitions }))
    const first = yield* publishTransition(transitions, {
      _tag: "SessionChanged",
      kind: "native-fork",
      session: session("commit-child"),
      derivation: Effect.gen(function*() {
        yield* Deferred.succeed(derivationStarted, undefined)
        yield* Deferred.await(releaseDerivation)
        return undefined
      }),
    })
    yield* Deferred.await(derivationStarted)
    const later = yield* publishTransition(transitions, {
      _tag: "SessionChanged",
      kind: "native-fork",
      session: session("too-late"),
    })
    yield* Effect.yieldNow
    yield* Deferred.succeed(releaseDerivation, undefined)

    const firstError = yield* Effect.flip(Deferred.await(first))
    const laterError = yield* Effect.flip(Deferred.await(later))
    expect(firstError).toBeInstanceOf(TerminalError)
    expect(laterError).toBeInstanceOf(TerminalError)
    yield* eventually(() => exits.length === 1)

    expect(transitionErrors).toHaveLength(1)
    expect(transitionErrors[0]?.error).toBeInstanceOf(TerminalError)
    expect(changed.map((event) => event.session.id)).toEqual(["commit-child"])
    expect([
      transitionErrors[0]!.sequenceId,
      changed[0]!.sequenceId,
      exits[0]!.sequenceId,
    ]).toEqual([
      transitionErrors[0]!.sequenceId,
      changed[0]!.sequenceId,
      exits[0]!.sequenceId,
    ].sort((left, right) => left - right))
    expect(new Set([
      transitionErrors[0]!.sequenceId,
      changed[0]!.sequenceId,
      exits[0]!.sequenceId,
    ]).size).toBe(3)
    expect(fixture.leases.current("commit-source")).toBeUndefined()
    expect(fixture.leases.current("commit-child")).toBeUndefined()
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set())
  }))
})

test("provider transition failure forces cleanup and emits a sequenced exit", async () => {
  const fixture = makeFixture()
  const transitions = await Effect.runPromise(PubSub.unbounded<TerminalTransitionRequest>())
  const exits: TerminalExitEvent[] = []
  const changed: TerminalSessionChangedEvent[] = []
  fixture.dependencies.events = {
    onProcessExited: (event) => exits.push(event),
    onSessionChanged: (event) => changed.push(event),
  }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    const ownerId = yield* supervisor.show(prepared("failed-transition", fixture, { transitions }))
    const providerAcknowledgment = yield* publishTransition(transitions, {
      _tag: "TransitionFailed",
      error: new ProviderError({
        providerId: "test",
        operation: "transition",
        message: "provider rejected transition",
      }),
    })
    yield* Deferred.await(providerAcknowledgment)
    yield* eventually(() => exits.length === 1)

    expect(exits[0]).toMatchObject({ ownerId, sessionId: "failed-transition" })
    expect(exits[0]!.sequenceId).toBeGreaterThan(1)
    expect(changed).toEqual([])
    expect(fixture.leases.current("failed-transition")).toBeUndefined()
    expect(yield* supervisor.runningSessionIds).toEqual(new Set())
  }))
})

test("invalid derived ancestry fails before the identity commit and reports cleanup completion", async () => {
  const fixture = makeFixture()
  const transitions = await Effect.runPromise(PubSub.unbounded<TerminalTransitionRequest>())
  const exits: TerminalExitEvent[] = []
  fixture.dependencies.events = { onProcessExited: (event) => exits.push(event) }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("source", fixture, { transitions }))
    const providerAcknowledgment = yield* publishTransition(transitions, {
      _tag: "SessionChanged",
      kind: "native-fork",
      session: session("child"),
      derivation: Effect.succeed({
        childSessionId: "wrong-child",
        parentSessionId: "source",
        sourceMessageId: "turn",
        sharedMessages: [],
      }),
    })
    const acknowledgmentError = yield* Effect.flip(Deferred.await(providerAcknowledgment))
    expect(acknowledgmentError).toBeInstanceOf(TerminalError)
    yield* eventually(() => exits.length === 1)

    expect(fixture.leases.identityCalls).toEqual([])
    expect(exits[0]?.sessionId).toBe("source")
    expect(fixture.leases.current("source")).toBeUndefined()
  }))
})

test("application rejection cleans the adopted owner forward-only and retains its pending journal", async () => {
  const fixture = makeFixture()
  const transitions = await Effect.runPromise(PubSub.unbounded<TerminalTransitionRequest>())
  const observed: Array<TerminalSessionChangedEvent | TerminalExitEvent> = []
  let statusAtExit: PersistedTerminalOwner["status"] | undefined
  fixture.dependencies.events = {
    onSessionChanged: (event) => {
      observed.push(event)
      Effect.runSync(Deferred.fail(event.acknowledgment!, new Error("projection rejected")))
    },
    onProcessExited: (event) => {
      statusAtExit = fixture.leases.current(event.sessionId)?.status
      observed.push(event)
    },
  }

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("source", fixture, { transitions }))
    const providerAcknowledgment = yield* publishTransition(transitions, {
      _tag: "SessionChanged",
      kind: "native-fork",
      session: session("actual-owner"),
    })
    const acknowledgmentError = yield* Effect.flip(Deferred.await(providerAcknowledgment))
    expect(acknowledgmentError).toBeInstanceOf(TerminalError)
    yield* eventually(() => observed.some((event) => "exitCode" in event))

    expect(observed[0]!.sequenceId).toBe(1)
    expect(observed[1]!.sequenceId).toBeGreaterThan(observed[0]!.sequenceId)
    expect(observed[1]).toMatchObject({ sessionId: "actual-owner" })
    expect((observed[1] as TerminalExitEvent).cleanupError).toBeInstanceOf(TerminalCleanupError)
    expect(fixture.leases.current("source")).toBeUndefined()
    expect(fixture.leases.current("actual-owner")?.status).toBe("cleanup-incomplete")
    expect(statusAtExit).toBe("cleanup-incomplete")
    expect(fixture.log.some((entry) => entry.startsWith("lease-release:actual-owner"))).toBeFalse()
  }))
})

test("a transition fails with a typed stale-owner error without waiting for cleanup", async () => {
  const fixture = makeFixture({ unknownLiveness: true })
  const transitions = await Effect.runPromise(PubSub.unbounded<TerminalTransitionRequest>())
  const derivationStarted = Deferred.makeUnsafe<void>()
  const releaseDerivation = Deferred.makeUnsafe<void>()

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("stale-source", fixture, { transitions }))
    const acknowledgment = yield* publishTransition(transitions, {
      _tag: "SessionChanged",
      kind: "native-fork",
      session: session("stale-child"),
      derivation: Effect.gen(function*() {
        yield* Deferred.succeed(derivationStarted, undefined)
        yield* Deferred.await(releaseDerivation)
        return undefined
      }),
    })
    yield* Deferred.await(derivationStarted)
    const stopExit = yield* Effect.exit(supervisor.stopSession("stale-source"))
    expect(Exit.isFailure(stopExit)).toBeTrue()

    yield* Deferred.succeed(releaseDerivation, undefined)
    const acknowledgmentError = yield* Effect.flip(
      Deferred.await(acknowledgment).pipe(Effect.timeout(1_000)),
    )
    expect(acknowledgmentError).toBeInstanceOf(TerminalError)
    expect(acknowledgmentError.message).toContain("stopped while deriving")

    fixture.processOptions.unknownLiveness = false
    fixture.processes.processes[0]!.finish(0)
    yield* supervisor.stopSession("stale-source")
  }))
})

test("shutdown retains ownership until a timed-out owner mutation settles", async () => {
  const fixture = makeFixture()
  const dependencies = { ...fixture.dependencies, persistenceTimeoutMs: 10 }
  const stoppingBarrier = Deferred.makeUnsafe<void>()
  fixture.leases.markBarriers.push(stoppingBarrier)

  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const supervisor = yield* makeTerminalSupervisor(dependencies)
    yield* supervisor.show(prepared("blocked-persistence", fixture))

    const shutdown = yield* Effect.forkScoped(supervisor.shutdown())
    yield* eventually(() => fixture.log.includes("lease-mark:blocked-persistence:stopping"))
    yield* TestClock.adjust(10)
    yield* eventually(() => fixture.log.includes("lease-mark:blocked-persistence:cleanup-incomplete"))
    const shutdownExit = yield* Fiber.await(shutdown)

    expect(Exit.isFailure(shutdownExit)).toBeTrue()
    expect(fixture.renderer.surfaces[0]?.released).toBeTrue()
    expect(fixture.processes.processes[0]?.ptyOpen).toBeFalse()
    expect(fixture.log).toContain("signal:blocked-persistence:SIGTERM")
    expect(fixture.log).toContain("signal:blocked-persistence:SIGKILL")
    expect(fixture.log).toContain("provider-close:blocked-persistence")
    expect(fixture.log).not.toContain("lease-release:blocked-persistence")
    expect(fixture.leases.current("blocked-persistence")).toBeDefined()
    expect((yield* supervisor.ownershipSnapshot)[0]?.state).toBe("cleanup-incomplete")

    const retry = yield* Effect.forkScoped(supervisor.shutdown())
    yield* TestClock.adjust(10)
    expect(Exit.isFailure(yield* Fiber.await(retry))).toBeTrue()
    expect(fixture.log.filter((entry) =>
      entry === "lease-mark:blocked-persistence:stopping")).toHaveLength(1)
    expect(fixture.log.filter((entry) =>
      entry === "lease-mark:blocked-persistence:cleanup-incomplete")).toHaveLength(1)
    expect(fixture.log).not.toContain("lease-release:blocked-persistence")

    yield* Deferred.succeed(stoppingBarrier, undefined)
    yield* eventually(() => fixture.leases.current("blocked-persistence")?.status === "stopping")
    yield* supervisor.shutdown()
    expect(fixture.leases.current("blocked-persistence")).toBeUndefined()
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("a late reserve is compensated before retry and can never recreate released ownership", async () => {
  const fixture = makeFixture()
  const reserveBarrier = Deferred.makeUnsafe<void>()
  const compensationBarrier = Deferred.makeUnsafe<void>()
  const cleanupErrors: TerminalCleanupError[] = []
  fixture.leases.reserveBarriers.push(reserveBarrier)
  fixture.leases.releaseBarriers.push(compensationBarrier)
  const dependencies = {
    ...fixture.dependencies,
    persistenceTimeoutMs: 10,
    events: { onCleanupError: (error: TerminalCleanupError) => cleanupErrors.push(error) },
  }

  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const supervisor = yield* makeTerminalSupervisor(dependencies)
    const firstShow = yield* Effect.forkScoped(supervisor.show(prepared("late-reserve", fixture)))
    yield* eventually(() => fixture.log.includes("lease-acquire:late-reserve"))
    yield* TestClock.adjust(10)
    expect(Exit.isFailure(yield* Fiber.await(firstShow))).toBeTrue()
    expect(fixture.leases.mutationCalls.filter((call) => call.stage === "reserve")).toHaveLength(1)
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set(["late-reserve"]))

    yield* Deferred.succeed(reserveBarrier, undefined)
    yield* eventually(() => fixture.log.includes("lease-release:late-reserve"))
    yield* TestClock.adjust(10)
    yield* eventually(() => cleanupErrors.length === 1)

    const blockedRetry = yield* Effect.forkScoped(
      supervisor.show(prepared("late-reserve", fixture)),
    )
    yield* TestClock.adjust(10)
    expect(Exit.isFailure(yield* Fiber.await(blockedRetry))).toBeTrue()
    expect(fixture.leases.mutationCalls.filter((call) => call.stage === "reserve")).toHaveLength(1)
    expect(fixture.leases.current("late-reserve")).toBeDefined()

    fixture.leases.releaseFailures = 1
    yield* Deferred.succeed(compensationBarrier, undefined)
    yield* eventually(() => fixture.leases.releaseSettlements === 1)
    yield* Effect.yieldNow
    expect(fixture.leases.current("late-reserve")).toBeDefined()
    expect(yield* supervisor.ownedSessionIds).toEqual(new Set(["late-reserve"]))

    // Admission retries the settled compensation with its original token before reserving anew.
    yield* supervisor.show(prepared("late-reserve", fixture))
    yield* supervisor.stopSession("late-reserve")
    expect(fixture.leases.current("late-reserve")).toBeUndefined()
    expect(fixture.leases.mutationCalls.filter((call) => call.stage === "reserve")).toHaveLength(2)
    const releases = fixture.leases.mutationCalls.filter((call) => call.stage === "release")
    expect(releases).toHaveLength(3)
    expect(releases[0]?.token).toBe(releases[1]?.token)
    expect(releases[2]?.token).not.toBe(releases[0]?.token)
    expect(releases.every((call) => call.token !== undefined)).toBeTrue()
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("a timed-out provider scope close remains uncertain and never releases its lease", async () => {
  const fixture = makeFixture()
  const dependencies = {
    ...fixture.dependencies,
    providerCleanupTimeoutMs: 10,
  }
  const terminal: PreparedTerminal = {
    session: session("uncertain-scope"),
    acquireLaunch: Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.gen(function*() {
        fixture.log.push("provider-scope-close:uncertain-scope")
        yield* Effect.never
      }))
      return acquiredLaunch("uncertain-scope", fixture)
    }),
  }

  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const supervisor = yield* makeTerminalSupervisor(dependencies)
    yield* supervisor.show(terminal)

    const firstStop = yield* Effect.forkScoped(supervisor.stopSession("uncertain-scope"))
    yield* eventually(() => fixture.log.includes("provider-scope-close:uncertain-scope"))
    yield* TestClock.adjust(10)
    const firstExit = yield* Fiber.await(firstStop)

    expect(Exit.isFailure(firstExit)).toBeTrue()
    expect(fixture.leases.current("uncertain-scope")).toBeDefined()
    expect((yield* supervisor.ownershipSnapshot)[0]?.state).toBe("cleanup-incomplete")

    const secondExit = yield* Effect.exit(supervisor.stopSession("uncertain-scope"))
    expect(Exit.isFailure(secondExit)).toBeTrue()
    expect(fixture.log.filter((entry) =>
      entry === "provider-scope-close:uncertain-scope")).toHaveLength(1)
    expect(fixture.log).not.toContain("lease-release:uncertain-scope")
    expect(fixture.leases.current("uncertain-scope")).toBeDefined()
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("reserve, provider acquisition, surface creation, and spawn failures roll back transactionally", async () => {
  const reserveFixture = makeFixture()
  reserveFixture.leases.reserveFailures = 2
  await withSupervisor(reserveFixture.dependencies, (supervisor) => Effect.gen(function*() {
    expect(Exit.isFailure(yield* Effect.exit(supervisor.show(prepared("reserve", reserveFixture))))).toBeTrue()
    expect(reserveFixture.processes.processes).toHaveLength(0)
  }))

  const providerFixture = makeFixture()
  const providerFailure: PreparedTerminal = {
    session: session("provider"),
    acquireLaunch: Effect.fail(new ProviderError({
      providerId: "test",
      operation: "acquire",
      message: "acquire failed",
    })),
  }
  await withSupervisor(providerFixture.dependencies, (supervisor) => Effect.gen(function*() {
    expect(Exit.isFailure(yield* Effect.exit(supervisor.show(providerFailure)))).toBeTrue()
    expect(providerFixture.leases.current("provider")).toBeUndefined()
  }))

  const surfaceFixture = makeFixture()
  surfaceFixture.renderer.createFailures = 1
  await withSupervisor(surfaceFixture.dependencies, (supervisor) => Effect.gen(function*() {
    expect(Exit.isFailure(yield* Effect.exit(supervisor.show(prepared("surface", surfaceFixture))))).toBeTrue()
    expect(surfaceFixture.log).toContain("provider-close:surface")
    expect(surfaceFixture.leases.current("surface")).toBeUndefined()
  }))

  const spawnFixture = makeFixture()
  spawnFixture.processes.spawnFailures = 1
  await withSupervisor(spawnFixture.dependencies, (supervisor) => Effect.gen(function*() {
    expect(Exit.isFailure(yield* Effect.exit(supervisor.show(prepared("spawn", spawnFixture))))).toBeTrue()
    expect(spawnFixture.renderer.surfaces[0]?.released).toBeTrue()
    expect(spawnFixture.leases.current("spawn")).toBeUndefined()
  }))
})

test("resolved failures retry with stable lifecycle tokens without retrying reserve automatically", async () => {
  const reserveFixture = makeFixture()
  reserveFixture.leases.reserveFailures = 1
  await withSupervisor(reserveFixture.dependencies, (supervisor) => Effect.gen(function*() {
    expect(Exit.isFailure(
      yield* Effect.exit(supervisor.show(prepared("reserve-retry", reserveFixture))),
    )).toBeTrue()
    const tokens = reserveFixture.leases.mutationCalls
      .filter((call) => call.stage === "reserve")
      .map((call) => call.token)
    expect(tokens).toHaveLength(1)
  }))

  const attachFixture = makeFixture()
  attachFixture.leases.attachFailures = 1
  await withSupervisor(attachFixture.dependencies, (supervisor) => Effect.gen(function*() {
    expect(Exit.isFailure(yield* Effect.exit(supervisor.show(prepared("attach", attachFixture))))).toBeTrue()
    const tokens = attachFixture.leases.mutationCalls
      .filter((call) => call.stage === "attach")
      .map((call) => call.token)
    expect(tokens).toHaveLength(2)
    expect(new Set(tokens).size).toBe(1)
    expect(attachFixture.leases.current("attach")).toBeUndefined()
  }))

  const releaseFixture = makeFixture()
  releaseFixture.leases.releaseFailures = 1
  await withSupervisor(releaseFixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("release", releaseFixture))
    expect(Exit.isFailure(yield* Effect.exit(supervisor.stopSession("release")))).toBeTrue()
    expect(releaseFixture.leases.current("release")?.status).toBe("cleanup-incomplete")
    yield* supervisor.stopSession("release")
    const tokens = releaseFixture.leases.mutationCalls
      .filter((call) => call.stage === "release")
      .map((call) => call.token)
    expect(tokens).toHaveLength(2)
    expect(new Set(tokens).size).toBe(1)
  }))
})

test("a UI release exception is retryable and does not permanently poison ownership", async () => {
  const fixture = makeFixture()
  fixture.renderer.surfaceReleaseFailures = 1

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("ui-retry", fixture))
    expect(Exit.isFailure(yield* Effect.exit(supervisor.stopSession("ui-retry")))).toBeTrue()
    expect(fixture.leases.current("ui-retry")?.status).toBe("cleanup-incomplete")
    yield* supervisor.stopSession("ui-retry")
    expect(fixture.renderer.surfaces[0]?.released).toBeTrue()
    expect(fixture.leases.current("ui-retry")).toBeUndefined()
    const stoppingTokens = fixture.leases.mutationCalls
      .filter((call) => call.stage === "mark:stopping")
      .map((call) => call.token)
    expect(new Set(stoppingTokens).size).toBe(1)
  }))
})

test("a resolved signal exception does not retain the session lease", async () => {
  const fixture = makeFixture()

  await withSupervisor(fixture.dependencies, (supervisor) => Effect.gen(function*() {
    yield* supervisor.show(prepared("signal-recovery", fixture))
    fixture.processes.processes[0]!.signalFailures = 1
    yield* supervisor.stopSession("signal-recovery")
    expect(fixture.leases.current("signal-recovery")).toBeUndefined()
  }))
})

test.skipIf(process.platform !== "linux")(
  "real Bun PTY cleanup terminates the detached process group",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-tree-terminal-"))
    temporaryDirectories.push(directory)
    const marker = join(directory, "pids")
    const fixture = makeFixture()
    const dependencies = { ...fixture.dependencies, processes: new BunPtyProcessFactory() }
    const command = [
      "/bin/sh",
      "-c",
      `trap '' HUP TERM; sleep 30 & child=$!; printf '%s %s\\n' "$$" "$child" > ${JSON.stringify(marker)}; wait "$child"`,
    ] as const

    await withSupervisor(dependencies, (supervisor) => Effect.gen(function*() {
      yield* supervisor.show(prepared("real-pty", fixture, { command }))
      const processIds = yield* Effect.promise(() => readProcessIds(marker))
      yield* supervisor.shutdown(30)
      yield* Effect.promise(() => waitUntil(() => processIds.every((pid) => !isProcessAlive(pid))))
    }))
  },
)

function withSupervisor(
  dependencies: TerminalSupervisorDependencies,
  use: (supervisor: TerminalSupervisorApi) => Effect.Effect<void, unknown>,
): Promise<void> {
  return Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const supervisor = yield* makeTerminalSupervisor(dependencies)
    yield* use(supervisor)
  })))
}

interface Fixture {
  readonly log: string[]
  readonly renderer: FakeRenderer
  readonly processes: FakeProcessFactory
  readonly leases: FakeOwnershipRepository
  readonly dependencies: TerminalSupervisorDependencies & {
    events?: TerminalSupervisorDependencies["events"]
  }
  readonly processOptions: ProcessOptions
  providerCloseAttempts: number
  providerCloseFailures: number
}

interface ProcessOptions {
  unknownLiveness: boolean
  readonly waitDelayMs: number
  waitConstructionFailures: number
}

function makeFixture(options: Partial<ProcessOptions> = {}): Fixture {
  const log: string[] = []
  const processOptions: ProcessOptions = {
    unknownLiveness: options.unknownLiveness ?? false,
    waitDelayMs: options.waitDelayMs ?? 0,
    waitConstructionFailures: options.waitConstructionFailures ?? 0,
  }
  const renderer = new FakeRenderer(log)
  const processes = new FakeProcessFactory(log, processOptions)
  const leases = new FakeOwnershipRepository(log)
  const fixture: Fixture = {
    log,
    renderer,
    processes,
    leases,
    processOptions,
    providerCloseAttempts: 0,
    providerCloseFailures: 0,
    dependencies: {
      renderer,
      processes,
      ownership: leases,
      gracePeriodMs: 10,
      killPeriodMs: 10,
      providerCleanupAttempts: 3,
      providerCleanupRetryDelayMs: 0,
      providerCleanupTimeoutMs: 50,
    },
  }
  return fixture
}

function prepared(
  sessionId: string,
  fixture: Fixture,
  options: {
    readonly transitions?: PubSub.PubSub<TerminalTransitionRequest>
    readonly observer?: TerminalObserver
    readonly transient?: boolean
    readonly command?: TerminalLaunch["command"]
  } = {},
): PreparedTerminal {
  return {
    session: {
      ...session(sessionId),
      ...(options.transient === true ? { transient: true } : {}),
    },
    acquireLaunch: Effect.succeed(acquiredLaunch(sessionId, fixture, options)),
  }
}

function acquiredLaunch(
  sessionId: string,
  fixture: Fixture,
  options: {
    readonly transitions?: PubSub.PubSub<TerminalTransitionRequest>
    readonly observer?: TerminalObserver
    readonly command?: TerminalLaunch["command"]
  } = {},
) {
  const launch: TerminalLaunch = {
    sessionId,
    command: options.command ?? [process.execPath, "-e", "setTimeout(() => {}, 30_000)"],
    cwd: process.cwd(),
    observer: options.observer ?? new NullTerminalObserver(),
    ...(options.transitions === undefined ? {} : { transitions: options.transitions }),
  }
  return {
    launch,
    close: Effect.suspend(() => {
      fixture.providerCloseAttempts += 1
      fixture.log.push(`provider-close:${sessionId}`)
      if (fixture.providerCloseFailures > 0) {
        fixture.providerCloseFailures -= 1
        return Effect.fail(new ProviderCleanupError({
          providerId: "test",
          operation: "close",
          message: "provider cleanup failed",
        }))
      }
      return Effect.void
    }),
  }
}

function session(id: string) {
  return { id, title: id, lastModified: 0 }
}

function publishTransition(
  transitions: PubSub.PubSub<TerminalTransitionRequest>,
  event: TerminalTransitionEvent,
): Effect.Effect<Deferred.Deferred<void, TerminalTransitionAcknowledgmentError>> {
  return Effect.gen(function*() {
    const acknowledgment = yield* Deferred.make<void, TerminalTransitionAcknowledgmentError>()
    yield* PubSub.publish(transitions, { event, acknowledgment })
    return acknowledgment
  })
}

function eventually(condition: () => boolean): Effect.Effect<void> {
  return Effect.gen(function*() {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (condition()) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error("Condition did not become true"))
  })
}

function eventName(event: TerminalActivityEvent | TerminalSessionChangedEvent | TerminalExitEvent): string {
  if ("activity" in event) return `activity:${event.activity}`
  if ("session" in event) return `session:${event.session.id}`
  return `exit:${event.sessionId}`
}

class FakeOwnershipRepository implements TerminalOwnershipRepository {
  reserveFailures = 0
  attachFailures = 0
  markFailures = 0
  releaseFailures = 0
  releaseSettlements = 0
  ackFailures = 0
  replaceFailures = 0
  markConstructionFailures = 0
  commitIdentityConstructionFailures = 0
  readonly reserveBarriers: Array<Deferred.Deferred<void>> = []
  readonly markBarriers: Array<Deferred.Deferred<void>> = []
  readonly releaseBarriers: Array<Deferred.Deferred<void>> = []
  readonly replaceCalls: string[] = []
  readonly mutationCalls: Array<{ readonly stage: string; readonly token: string | undefined }> = []
  readonly identityCalls: Array<{
    readonly kind: "temporary-adoption" | "native-fork"
    readonly mutationToken: string | undefined
    readonly relation?: BranchRelation
  }> = []
  private readonly leases = new Map<string, PersistedTerminalOwner>()
  private readonly adoptions = new Map<string, PendingIdentityAdoption>()
  private nextToken = 1

  constructor(private readonly log: string[]) {}

  readonly reserve: TerminalOwnershipRepository["reserve"] = (
    sessionId,
    options,
  ): Effect.Effect<PersistedTerminalOwner, PersistenceError | SessionOwnedError> =>
    Effect.gen(function* (this: FakeOwnershipRepository) {
      this.mutationCalls.push({ stage: "reserve", token: options?.mutationToken })
      this.log.push(`lease-acquire:${sessionId}`)
      const barrier = this.reserveBarriers.shift()
      if (barrier) yield* Deferred.await(barrier)
      if (this.reserveFailures-- > 0) return yield* Effect.fail(this.failure("reserve", sessionId))
      const existing = this.leases.get(sessionId)
      if (existing) {
        return yield* Effect.fail(new SessionOwnedError({
          providerId: "test",
          sessionId,
          ownerPid: existing.ownerPid,
        }))
      }
      const mutationToken = options?.mutationToken ?? `token-${this.nextToken++}`
      const lease = this.makeLease(sessionId, undefined, mutationToken, "reserved", mutationToken)
      this.leases.set(sessionId, lease)
      return lease
    }.bind(this))

  readonly attach: TerminalOwnershipRepository["attach"] = (lease, processGroupId, options) =>
    Effect.suspend(() => {
      this.mutationCalls.push({ stage: "attach", token: options?.mutationToken })
      this.log.push(`lease-update:${lease.sessionId}:${processGroupId}`)
      if (this.attachFailures-- > 0) return Effect.fail(this.failure("update", lease.sessionId))
      const current = this.leases.get(lease.sessionId)
      if (current?.ownerToken !== lease.ownerToken) return Effect.fail(this.failure("update", lease.sessionId))
      const updated = this.makeLease(
        lease.sessionId,
        processGroupId,
        lease.ownerToken,
        "running",
        options?.mutationToken,
      )
      this.leases.set(lease.sessionId, updated)
      return Effect.succeed(updated)
    })

  readonly mark: TerminalOwnershipRepository["mark"] = (lease, status, options) => {
    if (this.markConstructionFailures-- > 0) throw new Error("mark construction failed")
    return Effect.gen(function* (this: FakeOwnershipRepository) {
      this.mutationCalls.push({ stage: `mark:${status}`, token: options?.mutationToken })
      this.log.push(`lease-mark:${lease.sessionId}:${status}`)
      const barrier = this.markBarriers.shift()
      if (barrier) yield* Deferred.await(barrier)
      if (this.markFailures-- > 0) return yield* Effect.fail(this.failure("mark", lease.sessionId))
      const current = this.leases.get(lease.sessionId)
      if (current?.ownerToken !== lease.ownerToken) {
        return yield* Effect.fail(this.failure("mark", lease.sessionId))
      }
      const processGroupId = options?.processGroupId === null
        ? undefined
        : options?.processGroupId ?? current.processGroupId
      const updated = this.makeLease(
        lease.sessionId,
        processGroupId,
        lease.ownerToken,
        status,
        options?.mutationToken,
      )
      this.leases.set(lease.sessionId, updated)
      return updated
    }.bind(this))
  }

  readonly commitIdentity: TerminalOwnershipRepository["commitIdentity"] = (options) => {
    if (this.commitIdentityConstructionFailures-- > 0) {
      throw new Error("commitIdentity construction failed")
    }
    return Effect.suspend(() => {
      const { owner, sessionId } = options
      this.identityCalls.push({
        kind: options.kind,
        mutationToken: options.mutationToken,
        ...(options.relation === undefined ? {} : { relation: options.relation }),
      })
      this.replaceCalls.push(`${owner.sessionId}:${sessionId}`)
      this.log.push(`lease-replace:${owner.sessionId}:${sessionId}`)
      if (this.replaceFailures > 0) {
        this.replaceFailures -= 1
        return Effect.fail(this.failure("replace", sessionId))
      }
      const current = this.leases.get(owner.sessionId) ?? [...this.leases.values()].find(
        (candidate) => candidate.ownerToken === owner.ownerToken && candidate.sessionId === sessionId,
      )
      if (!current) return Effect.fail(this.failure("replace", owner.sessionId))
      const replacement = this.makeLease(
        sessionId,
        current.processGroupId,
        current.ownerToken,
        current.status,
        options.mutationToken,
      )
      this.leases.delete(owner.sessionId)
      this.leases.set(sessionId, replacement)
      const adoptionToken = options.mutationToken ?? `adoption-${this.nextToken++}`
      const adoption: PendingIdentityAdoption = {
        adoptionToken,
        kind: options.kind,
        instanceId: replacement.instanceId,
        ownerToken: replacement.ownerToken,
        ownerPid: replacement.ownerPid,
        processGroupId: replacement.processGroupId!,
        previousSessionId: owner.sessionId,
        sessionId,
        createdAt: "2026-01-01T00:00:02.000Z",
        ...(options.relation === undefined ? {} : { relation: options.relation }),
      }
      this.adoptions.set(adoptionToken, adoption)
      return Effect.succeed({
        owner: replacement,
        adoption,
        metadata: {
          relations: options.relation === undefined ? [] : [options.relation],
          removals: [],
        },
      })
    })
  }

  readonly ack: TerminalOwnershipRepository["ack"] = (adoptionToken) => Effect.sync(() => {
    this.log.push(`lease-ack:${adoptionToken}`)
    if (this.ackFailures-- > 0) throw this.failure("ack", adoptionToken)
    this.adoptions.delete(adoptionToken)
  })

  readonly release: TerminalOwnershipRepository["release"] = (lease, options) =>
    Effect.gen(function* (this: FakeOwnershipRepository) {
      this.mutationCalls.push({ stage: "release", token: options?.mutationToken })
      this.log.push(`lease-release:${lease.sessionId}`)
      const barrier = this.releaseBarriers.shift()
      if (barrier) yield* Deferred.await(barrier)
      this.releaseSettlements += 1
      if (this.releaseFailures-- > 0) return yield* Effect.fail(this.failure("release", lease.sessionId))
      const current = this.leases.get(lease.sessionId)
      if (current?.ownerToken !== lease.ownerToken) {
        return yield* Effect.fail(this.failure("release", lease.sessionId))
      }
      if ([...this.adoptions.values()].some((adoption) => adoption.ownerToken === lease.ownerToken)) {
        return yield* Effect.fail(this.failure("release-pending", lease.sessionId))
      }
      this.leases.delete(lease.sessionId)
    }.bind(this))

  current(sessionId: string): PersistedTerminalOwner | undefined {
    return this.leases.get(sessionId)
  }

  private makeLease(
    sessionId: string,
    processGroupId?: number,
    ownerToken = `token-${this.nextToken++}`,
    status: PersistedTerminalOwner["status"] = processGroupId === undefined ? "reserved" : "running",
    mutationToken = ownerToken,
  ): PersistedTerminalOwner {
    return {
      instanceId: "test-instance",
      sessionId,
      ownerToken,
      lastMutationToken: mutationToken,
      ownerPid: process.pid,
      status,
      ...(processGroupId === undefined ? {} : { processGroupId }),
      reservedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    }
  }

  private failure(operation: string, sessionId: string): PersistenceError {
    return new PersistenceError({
      operation,
      path: `/leases/${sessionId}`,
      message: `${operation} failed`,
    })
  }
}

class FakeRenderer implements TerminalRenderer {
  readonly columns = 80
  readonly rows = 24
  readonly surfaces: FakeSurface[] = []
  focusFailures = 0
  createFailures = 0
  surfaceReleaseFailures = 0

  constructor(private readonly log: string[]) {}

  createSurface(id: string, callbacks: TerminalSurfaceCallbacks): TerminalSurface {
    if (this.createFailures-- > 0) throw new Error("surface creation failed")
    const surface = new FakeSurface(id, callbacks, this.log, () => {
      if (this.focusFailures <= 0) return
      this.focusFailures -= 1
      throw new Error("focus failed")
    }, () => {
      if (this.surfaceReleaseFailures-- > 0) throw new Error("surface release failed")
    })
    this.surfaces.push(surface)
    return surface
  }

  clearSelection(): void {}
  copyToClipboard(): void {}
  onSelection(): () => void { return () => {} }
}

class FakeSurface implements TerminalSurface {
  active = false
  released = false
  private lines: string[] = []

  constructor(
    readonly id: string,
    private readonly callbacks: TerminalSurfaceCallbacks,
    private readonly log: string[],
    private readonly focusFailure: () => void,
    private readonly releaseFailure: () => void,
  ) {}

  write(data: Uint8Array): void {
    this.lines = [new TextDecoder().decode(data)]
    this.callbacks.onScreenChange()
  }

  screen(): TerminalScreen {
    return { lines: this.lines, cursor: { x: 0, y: 0, visible: true } }
  }

  focus(): void {
    this.log.push(`focus:${this.id.replace("agent-owner-", "")}`)
    this.focusFailure()
  }

  blur(): void {}
  setActive(active: boolean): void { this.active = active }

  release(): void {
    if (this.released) return
    this.releaseFailure()
    this.released = true
    this.active = false
    this.log.push(`surface-release:${this.id}`)
  }
}

class FakeProcessFactory implements TerminalProcessFactory {
  readonly processes: FakeProcess[] = []
  private nextPid = 10_000
  spawnFailures = 0

  constructor(
    private readonly log: string[],
    private readonly options: ProcessOptions,
  ) {}

  spawn(
    launch: TerminalLaunch,
    _dimensions: { readonly columns: number; readonly rows: number },
    callbacks: TerminalProcessCallbacks,
  ): TerminalProcess {
    this.log.push(`spawn:${launch.sessionId}`)
    if (this.spawnFailures-- > 0) throw new Error("spawn failed")
    const process = new FakeProcess(
      this.nextPid++,
      launch.sessionId,
      callbacks,
      this.log,
      this.options,
    )
    this.processes.push(process)
    return process
  }
}

class FakeProcess implements TerminalProcess {
  readonly processGroupId: number
  readonly ptyDrained: Promise<void>
  readonly exited: Promise<number>
  exitCode: number | null = null
  ptyOpen = true
  signalFailures = 0
  private alive = true
  private resolveExit!: (code: number) => void
  private resolveDrain!: () => void

  constructor(
    readonly pid: number,
    private readonly sessionId: string,
    private readonly callbacks: TerminalProcessCallbacks,
    private readonly log: string[],
    private readonly options: ProcessOptions,
  ) {
    this.processGroupId = pid
    this.exited = new Promise((resolve) => { this.resolveExit = resolve })
    this.ptyDrained = new Promise((resolve) => { this.resolveDrain = resolve })
  }

  write(): void {}
  resize(): void {}

  signalGroup(signal: NodeJS.Signals): void {
    this.log.push(`signal:${this.sessionId}:${signal}`)
    if (this.signalFailures-- > 0) throw new Error("signal failed")
    if (signal === "SIGKILL" && !this.options.unknownLiveness) this.finish(137)
  }

  isGroupAlive(): boolean {
    if (this.options.unknownLiveness) throw new Error("liveness unknown")
    return this.alive
  }

  waitForGroupExit(timeoutMs: number): Effect.Effect<boolean> {
    if (this.options.waitConstructionFailures-- > 0) throw new Error("wait construction failed")
    return Effect.promise(async () => {
      this.log.push(`wait:${this.sessionId}:${timeoutMs}`)
      if (this.options.waitDelayMs > 0) await Bun.sleep(this.options.waitDelayMs)
      return !this.alive
    })
  }

  closePty(): void {
    if (!this.ptyOpen) return
    this.ptyOpen = false
    this.log.push(`pty-close:${this.sessionId}`)
    this.resolveDrain()
    this.callbacks.onPtyClosed()
  }

  unref(): void {}
  output(data: Uint8Array): void { this.callbacks.onOutput(data) }

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
    const value = new TextDecoder().decode(data)
    return value === "working" ? ["working"] : value === "idle" ? ["idle"] : []
  }

  observeScreen(): undefined { return undefined }
  observeDraft(): undefined { return undefined }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function acknowledge(event: TerminalSessionChangedEvent): void {
  if (event.acknowledgment) {
    Effect.runSync(Deferred.succeed(event.acknowledgment, undefined))
  }
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
