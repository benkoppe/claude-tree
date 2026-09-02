import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Queue,
  Scope,
  Semaphore,
} from "effect"

import { Osc52Forwarder } from "../clipboard"
import type {
  AgentActivity,
  AgentSession,
  BranchDerivation,
  DraftPreview,
} from "../domain/model"
import {
  TerminalError,
  type PersistenceError,
  type ProviderError,
  type ProviderProtocolError,
  type SessionOwnedError,
} from "../domain/errors"
import type {
  PreparedTerminal,
  TerminalLaunch,
  TerminalTransitionEvent,
} from "./provider"
import type {
  TerminalProcess,
  TerminalProcessFactory,
  TerminalRenderer,
  TerminalSurface,
} from "../infrastructure/terminal"
import { TerminalSpawnCleanupError } from "../infrastructure/terminal"
import type { SessionLease, SessionLeasesApi } from "./session-leases"

const DEFAULT_GRACE_PERIOD_MS = 200
const DEFAULT_KILL_PERIOD_MS = 200
const PTY_DRAIN_PERIOD_MS = 250
const ACTIVITY_QUEUE_CAPACITY = 64
const HERDR_SHUTDOWN_PERIOD_MS = 500

export type TerminalOwnerState = "running" | "stopping" | "cleanup-incomplete"

export interface TerminalCleanupIssue {
  readonly ownerId: string
  readonly sessionId: string
  readonly stage: "term" | "wait" | "kill" | "verify" | "provider" | "lease" | "pty" | "ui"
  readonly message: string
  readonly cause?: unknown
}

export class TerminalCleanupError extends Data.TaggedError("TerminalCleanupError")<{
  readonly operation: "stop" | "shutdown" | "natural-exit" | "acquire-rollback"
  readonly issues: readonly TerminalCleanupIssue[]
}> {}

export interface TerminalExitEvent {
  readonly sessionId: string
  readonly exitCode: number
  readonly wasActive: boolean
  readonly draftPreview?: DraftPreview
  readonly cleanupError?: TerminalCleanupError
}

export interface TerminalActivityEvent {
  readonly sessionId: string
  readonly activity: AgentActivity
  readonly wasActive: boolean
}

export interface TerminalSessionChangedEvent {
  readonly previousSessionId: string
  readonly session: AgentSession
  readonly wasActive: boolean
  readonly derivation?: Effect.Effect<
    BranchDerivation | undefined,
    ProviderError | ProviderProtocolError
  >
}

export interface TerminalSessionTransitionErrorEvent {
  readonly sessionId: string
  readonly error:
    | TerminalError
    | ProviderError
    | ProviderProtocolError
    | PersistenceError
    | SessionOwnedError
  readonly wasActive: boolean
}

export interface TerminalSupervisorEvents {
  readonly onProcessExited?: (event: TerminalExitEvent) => void
  readonly onActivityChanged?: (event: TerminalActivityEvent) => void
  readonly onSessionChanged?: (event: TerminalSessionChangedEvent) => void
  readonly onSessionTransitionError?: (event: TerminalSessionTransitionErrorEvent) => void
  readonly onCleanupError?: (error: TerminalCleanupError) => void
}

export interface TerminalHerdrReporter {
  report(activity: AgentActivity): void
  shutdown: Effect.Effect<void, unknown>
}

export const NULL_TERMINAL_HERDR_REPORTER: TerminalHerdrReporter = {
  report() {},
  shutdown: Effect.void,
}

export interface TerminalSupervisorDependencies {
  readonly renderer: TerminalRenderer
  readonly processes: TerminalProcessFactory
  readonly leases: SessionLeasesApi
  readonly events?: TerminalSupervisorEvents
  readonly herdr?: TerminalHerdrReporter
  readonly gracePeriodMs?: number
  readonly killPeriodMs?: number
}

export interface TerminalOwnershipSnapshot {
  readonly ownerId: string
  readonly sessionId: string
  readonly state: TerminalOwnerState
  readonly active: boolean
  readonly activity: AgentActivity
  readonly exitCode: number | null
}

export interface TerminalSupervisorApi {
  readonly show: (
    prepared: PreparedTerminal,
  ) => Effect.Effect<
    void,
    | ProviderError
    | ProviderProtocolError
    | PersistenceError
    | SessionOwnedError
    | TerminalError
    | TerminalCleanupError
  >
  readonly hideActive: Effect.Effect<string | null>
  readonly stopSession: (
    sessionId: string,
    gracePeriodMs?: number,
  ) => Effect.Effect<boolean, TerminalCleanupError>
  readonly shutdown: (gracePeriodMs?: number) => Effect.Effect<void, TerminalCleanupError>
  readonly replaceSessionId: (
    previousSessionId: string,
    sessionId: string,
  ) => Effect.Effect<boolean, TerminalError | PersistenceError | SessionOwnedError>
  readonly activeSessionId: Effect.Effect<string | null>
  readonly ownsInput: Effect.Effect<boolean>
  readonly runningSessionIds: Effect.Effect<ReadonlySet<string>>
  readonly ownedSessionIds: Effect.Effect<ReadonlySet<string>>
  readonly nonIdleSessionIds: Effect.Effect<ReadonlySet<string>>
  readonly activitySessionIds: (activity: AgentActivity) => Effect.Effect<ReadonlySet<string>>
  readonly draftPreviews: Effect.Effect<ReadonlyMap<string, DraftPreview>>
  readonly ownershipSnapshot: Effect.Effect<readonly TerminalOwnershipSnapshot[]>
}

export class TerminalSupervisor extends Context.Service<
  TerminalSupervisor,
  TerminalSupervisorApi
>()("claude-tree/TerminalSupervisor") {}

export const makeTerminalSupervisor = (
  dependencies: TerminalSupervisorDependencies,
): Effect.Effect<TerminalSupervisorApi, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new TerminalSupervisorImpl(dependencies)),
    (supervisor) =>
      supervisor.shutdown().pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            try {
              dependencies.events?.onCleanupError?.(error)
            } catch {
              // Application event callbacks cannot keep the scope open.
            }
          }),
        ),
      ),
  )

export const terminalSupervisorLayer = (
  dependencies: TerminalSupervisorDependencies,
): Layer.Layer<TerminalSupervisor> =>
  Layer.effect(TerminalSupervisor, makeTerminalSupervisor(dependencies))

interface LedgerEntry {
  readonly ownerId: string
  state: TerminalOwnerState
}

interface TerminalOwner {
  readonly ownerId: string
  sessionId: string
  readonly providerScope: Scope.Closeable
  readonly eventQueue: Queue.Queue<SemanticEvent>
  readonly activityQueue: Queue.Queue<readonly AgentActivity[]>
  stopResult: Deferred.Deferred<void, TerminalCleanupError>
  readonly observer: TerminalLaunch["observer"]
  readonly sessionAliases: Set<string>
  process: TerminalProcess
  surface: TerminalSurface
  lease: SessionLease
  leaseReleased: boolean
  leaseReleaseResult?: Deferred.Deferred<readonly TerminalCleanupIssue[]>
  semanticFiber?: Fiber.Fiber<void, never>
  activityFiber?: Fiber.Fiber<void, never>
  transitionFiber?: Fiber.Fiber<void, never>
  activity: AgentActivity
  exitCode: number | null
  draftPreview?: DraftPreview
  inputObserved: boolean
  uiReleased: boolean
  providerReleaseResult?: Deferred.Deferred<readonly TerminalCleanupIssue[]>
  ptyClosed: boolean
  cleanupStarted: boolean
  cleanupInProgress: boolean
  readonly cleanupIssues: TerminalCleanupIssue[]
}

type SemanticEvent =
  | { readonly _tag: "Exited"; readonly exitCode: number }
  | { readonly _tag: "Transition"; readonly transition: TerminalTransitionEvent }

type StopDecision =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Wait"; readonly owner: TerminalOwner }
  | { readonly _tag: "Start"; readonly owner: TerminalOwner }

class TerminalSupervisorImpl implements TerminalSupervisorApi {
  private readonly ledger = new Map<string, LedgerEntry>()
  private readonly owners = new Map<string, TerminalOwner>()
  private readonly completedSessionTransitions = new Map<string, string>()
  private readonly gate = Semaphore.makeUnsafe(1)
  private readonly runtimeScope = Scope.makeUnsafe("parallel")
  private readonly events: TerminalSupervisorEvents
  private readonly herdr: TerminalHerdrReporter
  private readonly gracePeriodMs: number
  private readonly killPeriodMs: number
  private nextOwnerId = 1
  private activeOwnerId: string | null = null
  private shuttingDown = false
  private shutdownResult: Deferred.Deferred<void, TerminalCleanupError> | undefined
  private readonly unsubscribeSelection: () => void

  constructor(private readonly dependencies: TerminalSupervisorDependencies) {
    this.events = dependencies.events ?? {}
    this.herdr = dependencies.herdr ?? NULL_TERMINAL_HERDR_REPORTER
    this.gracePeriodMs = dependencies.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS
    this.killPeriodMs = dependencies.killPeriodMs ?? DEFAULT_KILL_PERIOD_MS
    this.unsubscribeSelection = dependencies.renderer.onSelection((surface, text) => {
      this.ignoreCallback(() => {
        const active = this.activeOwner()
        if (active?.surface === surface) dependencies.renderer.copyToClipboard(text)
      })
    })
    this.reportHerdr("idle")
  }

  readonly show: TerminalSupervisorApi["show"] = (prepared) =>
    this.gate.withPermit(
      Effect.gen(function* (this: TerminalSupervisorImpl) {
        if (this.shuttingDown) {
          return yield* Effect.fail(
            new TerminalError({
              operation: "show",
              sessionId: prepared.session.id,
              message: "Cannot open an agent session while claude-tree is shutting down",
            }),
          )
        }

        const existingEntry = this.ledger.get(prepared.session.id)
        if (existingEntry) {
          const existing = this.owners.get(existingEntry.ownerId)
          if (!existing || existingEntry.state !== "running" || existing.exitCode !== null) {
            return yield* Effect.fail(
              new TerminalError({
                operation: "show",
                sessionId: prepared.session.id,
                message: `Agent session ${prepared.session.id} is still ${existingEntry.state}`,
              }),
            )
          }
          yield* this.activate(existing)
          return
        }

        const ownerId = `terminal-owner-${this.nextOwnerId++}`
        const lease = yield* this.dependencies.leases.acquire(prepared.session.id)
        const providerScope = yield* Scope.make("sequential")
        const launchExit = yield* Effect.exit(Scope.provide(prepared.acquireLaunch, providerScope))
        if (Exit.isFailure(launchExit)) {
          const providerIssues = yield* this.closeProviderScopeParts(
            ownerId,
            prepared.session.id,
            providerScope,
          )
          const rollbackIssues = [
            ...providerIssues,
            ...(providerIssues.length === 0
              ? yield* this.releaseLeaseParts(ownerId, lease)
              : []),
          ]
          if (rollbackIssues.length > 0) {
            return yield* Effect.fail(
              new TerminalCleanupError({ operation: "acquire-rollback", issues: rollbackIssues }),
            )
          }
          return yield* Effect.fail(
            Cause.squash(launchExit.cause) as ProviderError | ProviderProtocolError,
          )
        }

        const launch = launchExit.value
        if (launch.sessionId !== prepared.session.id) {
          const providerIssues = yield* this.closeProviderScopeParts(
            ownerId,
            prepared.session.id,
            providerScope,
          )
          const issues = [
            ...providerIssues,
            ...(providerIssues.length === 0
              ? yield* this.releaseLeaseParts(ownerId, lease)
              : []),
          ]
          if (issues.length > 0) {
            return yield* Effect.fail(
              new TerminalCleanupError({ operation: "acquire-rollback", issues }),
            )
          }
          return yield* Effect.fail(
            new TerminalError({
              operation: "acquire",
              sessionId: prepared.session.id,
              message: `Prepared terminal acquired a launch for ${launch.sessionId}`,
            }),
          )
        }

        const transitionSubscription = launch.transitions
          ? yield* Scope.provide(PubSub.subscribe(launch.transitions), providerScope)
          : undefined

        const ownerExit = yield* Effect.exit(
          this.createOwner(ownerId, launch, providerScope, lease),
        )
        if (Exit.isFailure(ownerExit)) {
          const ownerError = Cause.squash(ownerExit.cause) as TerminalError | TerminalCleanupError
          const providerIssues = yield* this.closeProviderScopeParts(
            ownerId,
            prepared.session.id,
            providerScope,
          )
          const unverifiedSpawn = terminalSpawnCleanupError(ownerError)
          if (unverifiedSpawn) {
            const leaseUpdateExit = yield* Effect.exit(this.dependencies.leases.update(lease, {
              processGroupId: unverifiedSpawn.processGroupId,
            }))
            const issues = [
              ...cleanupIssues(ownerError),
              ...providerIssues,
              ...(Exit.isFailure(leaseUpdateExit)
                ? [{
                    ownerId,
                    sessionId: prepared.session.id,
                    stage: "lease" as const,
                    message: `Unable to record unverified process group ${unverifiedSpawn.processGroupId}`,
                    cause: Cause.squash(leaseUpdateExit.cause),
                  }]
                : []),
            ]
            return yield* Effect.fail(new TerminalCleanupError({
              operation: "acquire-rollback",
              issues,
            }))
          }
          const issues = [
            ...providerIssues,
            ...(providerIssues.length === 0
              ? yield* this.releaseLeaseParts(ownerId, lease)
              : []),
          ]
          if (issues.length > 0) {
            return yield* Effect.fail(
              new TerminalCleanupError({ operation: "acquire-rollback", issues }),
            )
          }
          return yield* Effect.fail(ownerError)
        }

        const owner = ownerExit.value
        this.owners.set(owner.ownerId, owner)
        this.ledger.set(owner.sessionId, { ownerId, state: "running" })
        const leaseUpdateExit = yield* Effect.exit(
          this.dependencies.leases.update(owner.lease, { processGroupId: owner.process.pid }),
        )
        if (Exit.isFailure(leaseUpdateExit)) {
          owner.cleanupIssues.push(this.issue(
            owner,
            "lease",
            `Unable to record process group ${owner.process.pid} for ${owner.sessionId}`,
            Cause.squash(leaseUpdateExit.cause),
          ))
          this.ledger.get(owner.sessionId)!.state = "stopping"
          owner.cleanupStarted = true
          owner.cleanupInProgress = true
          owner.cleanupIssues.push(...this.releaseOwnerUi(owner))
          return yield* this.completeOwnerCleanup(
            owner,
            this.gracePeriodMs,
            "acquire-rollback",
            true,
          )
        }
        owner.lease = leaseUpdateExit.value
        owner.semanticFiber = yield* Effect.forkIn(this.semanticLoop(owner), this.runtimeScope)
        owner.activityFiber = yield* Effect.forkIn(this.activityLoop(owner), this.runtimeScope)
        if (transitionSubscription) {
          owner.transitionFiber = yield* Effect.forkIn(
            this.transitionLoop(owner, transitionSubscription),
            this.runtimeScope,
          )
        }
        void owner.process.exited.then((exitCode) => {
          Queue.offerUnsafe(owner.eventQueue, { _tag: "Exited", exitCode })
        })
        const activationExit = yield* Effect.exit(this.activate(owner))
        if (Exit.isFailure(activationExit)) {
          const error = Cause.squash(activationExit.cause) as TerminalError
          const entry = this.ledger.get(owner.sessionId)
          if (entry?.ownerId === owner.ownerId) entry.state = "stopping"
          owner.cleanupStarted = true
          owner.cleanupInProgress = true
          owner.cleanupIssues.push(...this.releaseOwnerUi(owner))
          const rollbackExit = yield* Effect.exit(
            this.completeOwnerCleanup(owner, this.gracePeriodMs, "acquire-rollback", true),
          )
          if (Exit.isFailure(rollbackExit)) {
            return yield* Effect.fail(Cause.squash(rollbackExit.cause) as TerminalCleanupError)
          }
          return yield* Effect.fail(error)
        }
      }.bind(this)),
    )

  readonly hideActive: Effect.Effect<string | null> = this.gate.withPermit(
    Effect.sync(() => {
      const active = this.activeOwner()
      this.activeOwnerId = null
      this.ignoreCallback(() => this.dependencies.renderer.clearSelection())
      if (active) {
        this.captureDraft(active)
        this.ignoreCallback(() => active.surface.blur())
        this.ignoreCallback(() => active.surface.setActive(false))
      }
      this.reportHerdr("idle")
      return active?.sessionId ?? null
    }),
  )

  readonly stopSession: TerminalSupervisorApi["stopSession"] = (
    sessionId,
    gracePeriodMs = this.gracePeriodMs,
  ) =>
    Effect.uninterruptible(Effect.gen(function* (this: TerminalSupervisorImpl) {
      const decision = yield* this.gate.withPermit(
        Effect.sync((): StopDecision => {
          const owner = this.ownerForSession(sessionId)
          if (!owner) return { _tag: "Missing" }
          const entry = this.ledger.get(sessionId)!
          if (entry.state === "stopping" && owner.cleanupInProgress) {
            return { _tag: "Wait", owner }
          }
          if (entry.state !== "running") {
            entry.state = "stopping"
            owner.stopResult = Deferred.makeUnsafe<void, TerminalCleanupError>()
            owner.cleanupInProgress = true
            return { _tag: "Start", owner }
          }
          entry.state = "stopping"
          owner.cleanupStarted = true
          owner.cleanupInProgress = true
          owner.cleanupIssues.push(...this.releaseOwnerUi(owner))
          return { _tag: "Start", owner }
        }),
      )
      if (decision._tag === "Missing") return false
      if (decision._tag === "Wait") {
        yield* Deferred.await(decision.owner.stopResult)
        return true
      }

      yield* this.completeOwnerCleanup(decision.owner, gracePeriodMs, "stop")
      return true
    }.bind(this)))

  readonly shutdown: TerminalSupervisorApi["shutdown"] = (
    gracePeriodMs = this.gracePeriodMs,
  ) =>
    Effect.uninterruptible(Effect.suspend(() => {
      if (this.shutdownResult) return Deferred.await(this.shutdownResult)
      this.shutdownResult = Deferred.makeUnsafe<void, TerminalCleanupError>()
      const result = this.shutdownResult
      return Effect.gen(function* (this: TerminalSupervisorImpl) {
        const exit = yield* Effect.exit(this.performShutdown(gracePeriodMs))
        if (Exit.isSuccess(exit)) {
          yield* Deferred.succeed(result, undefined)
          return
        }
        const error = this.cleanupErrorFromCause(
          "shutdown",
          Cause.squash(exit.cause),
        )
        this.shutdownResult = undefined
        yield* Deferred.fail(result, error)
        return yield* Effect.fail(error)
      }.bind(this))
    }))

  readonly replaceSessionId: TerminalSupervisorApi["replaceSessionId"] = (
    previousSessionId,
    sessionId,
  ) =>
    Effect.uninterruptible(this.gate.withPermit(
      Effect.gen(function* (this: TerminalSupervisorImpl) {
        if (previousSessionId === sessionId) return this.ownerForSession(sessionId) !== undefined
        const owner = this.ownerForSession(previousSessionId)
        if (!owner) {
          const currentOwner = this.ownerForSession(sessionId)
          return currentOwner?.sessionAliases.has(previousSessionId) ??
            this.completedSessionTransitions.get(previousSessionId) === sessionId
        }
        const existing = this.ledger.get(sessionId)
        if (existing && existing.ownerId !== owner.ownerId) {
          return yield* Effect.fail(
            new TerminalError({
              operation: "replace-session-id",
              sessionId,
              message: `Agent session ${sessionId} already has an owned terminal`,
            }),
          )
        }
        const replacement = yield* this.dependencies.leases.replaceSessionId(
          owner.lease,
          sessionId,
        )
        const entry = this.ledger.get(previousSessionId)!
        owner.lease = replacement
        this.ledger.delete(previousSessionId)
        owner.sessionAliases.add(previousSessionId)
        owner.sessionId = sessionId
        this.ledger.set(sessionId, entry)
        return true
      }.bind(this)),
    ))

  readonly activeSessionId: Effect.Effect<string | null> = Effect.sync(
    () => this.activeOwner()?.sessionId ?? null,
  )

  readonly ownsInput: Effect.Effect<boolean> = Effect.sync(() => this.activeOwnerId !== null)

  readonly runningSessionIds = this.sessionIdSet(
    (entry, owner) => entry.state === "running" && owner.exitCode === null,
  )

  readonly ownedSessionIds: Effect.Effect<ReadonlySet<string>> = Effect.sync(
    () => new Set(this.ledger.keys()),
  )

  readonly nonIdleSessionIds = this.sessionIdSet(
    (entry, owner) =>
      entry.state === "running" && owner.exitCode === null && owner.activity !== "idle",
  )

  readonly activitySessionIds: TerminalSupervisorApi["activitySessionIds"] = (activity) =>
    this.sessionIdSet(
      (entry, owner) =>
        entry.state === "running" && owner.exitCode === null && owner.activity === activity,
    )

  readonly draftPreviews: Effect.Effect<ReadonlyMap<string, DraftPreview>> = Effect.sync(
    () =>
      new Map(
        [...this.ledger].flatMap(([sessionId, entry]) => {
          const owner = this.owners.get(entry.ownerId)
          return entry.state === "running" &&
            owner?.exitCode === null &&
            owner.draftPreview !== undefined
            ? [[sessionId, owner.draftPreview] as const]
            : []
        }),
      ),
  )

  readonly ownershipSnapshot: Effect.Effect<readonly TerminalOwnershipSnapshot[]> = Effect.sync(
    () =>
      [...this.ledger].flatMap(([sessionId, entry]) => {
        const owner = this.owners.get(entry.ownerId)
        return owner
          ? [{
              ownerId: entry.ownerId,
              sessionId,
              state: entry.state,
              active: this.activeOwnerId === entry.ownerId,
              activity: owner.activity,
              exitCode: owner.exitCode,
            }]
          : []
      }),
  )

  private createOwner(
    ownerId: string,
    launch: TerminalLaunch,
    providerScope: Scope.Closeable,
    lease: SessionLease,
  ): Effect.Effect<TerminalOwner, TerminalError | TerminalCleanupError> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const eventQueue = yield* Queue.unbounded<SemanticEvent>()
      const activityQueue = yield* Queue.sliding<readonly AgentActivity[]>(
        ACTIVITY_QUEUE_CAPACITY,
      )
      const stopResult = yield* Deferred.make<void, TerminalCleanupError>()
      const osc52 = new Osc52Forwarder()
      let process: TerminalProcess | undefined
      let surface: TerminalSurface | undefined
      let owner: TerminalOwner | undefined
      let lastOfferedActivity: AgentActivity = "idle"
      const offerActivities = (activities: readonly AgentActivity[]) => {
        const transitions: AgentActivity[] = []
        for (const activity of activities) {
          if (activity === lastOfferedActivity) continue
          lastOfferedActivity = activity
          transitions.push(activity)
        }
        if (transitions.length > 0) Queue.offerUnsafe(activityQueue, transitions)
      }

      const surfaceExit = yield* Effect.exit(
        this.attempt("create-emulator", launch.sessionId, () =>
          this.dependencies.renderer.createSurface(
            `agent-owner-${encodeURIComponent(ownerId)}`,
            {
              onData: (data, source) => {
                const current = owner
                if (current && !this.acceptsTerminalData(current)) return
                this.ignoreCallback(() => {
                  if (source === "input" && current) {
                    current.inputObserved = true
                    launch.observer.observeInput?.(data)
                    const draft = launch.observer.observeDraft(current.surface.screen())
                    if (draft?.rewind) current.draftPreview = draft
                  }
                })
                this.ignoreCallback(() => process?.write(data))
              },
              onResize: (columns, rows) => {
                const current = owner
                if (current && !this.acceptsTerminalData(current)) return
                this.ignoreCallback(() => process?.resize(columns, rows))
              },
              onScreenChange: () => {
                const current = owner
                if (current && !this.acceptsTerminalData(current)) return
                this.ignoreCallback(() => {
                  const screen = current?.surface.screen() ?? surface?.screen()
                  if (!screen) return
                  const activity = launch.observer.observeScreen(screen)
                  if (activity !== undefined) offerActivities([activity])
                })
              },
            },
          ),
        ),
      )
      if (Exit.isFailure(surfaceExit)) {
        return yield* Effect.fail(Cause.squash(surfaceExit.cause) as TerminalError)
      }
      surface = surfaceExit.value

      const processExit = yield* Effect.exit(
        this.attemptPromise("spawn", launch.sessionId, () =>
          this.dependencies.processes.spawn(
            launch,
            {
              columns: Math.max(1, this.dependencies.renderer.columns),
              rows: Math.max(1, this.dependencies.renderer.rows),
            },
            {
              onOutput: (data) => {
                const current = owner
                if (current && !this.acceptsTerminalData(current)) return
                this.ignoreCallback(() => offerActivities(launch.observer.observeOutput(data)))
                this.ignoreCallback(() => {
                  if (this.activeOwnerId === ownerId) {
                    for (const text of osc52.observe(data)) {
                      this.dependencies.renderer.copyToClipboard(text)
                    }
                  } else {
                    osc52.observe(data)
                  }
                })
                this.ignoreCallback(() => surface?.write(data))
              },
              onPtyClosed() {},
            },
          ),
        ),
      )
      if (Exit.isFailure(processExit)) {
        const spawnError = Cause.squash(processExit.cause) as TerminalError
        const issues: TerminalCleanupIssue[] = []
        const unverifiedSpawn = terminalSpawnCleanupError(spawnError)
        if (unverifiedSpawn) {
          issues.push({
            ownerId,
            sessionId: launch.sessionId,
            stage: "verify",
            message: `Unable to verify process group ${unverifiedSpawn.processGroupId} exited after PTY acquisition failed`,
            cause: unverifiedSpawn,
          })
        }
        try {
          surface.release()
        } catch (cause) {
          issues.push({
            ownerId,
            sessionId: launch.sessionId,
            stage: "ui",
            message: `Unable to release terminal surface for ${launch.sessionId} after spawn failed`,
            cause,
          })
        }
        return yield* issues.length > 0
          ? Effect.fail(new TerminalCleanupError({ operation: "acquire-rollback", issues }))
          : Effect.fail(spawnError)
      }
      process = processExit.value

      owner = {
        ownerId,
        sessionId: launch.sessionId,
        providerScope,
        eventQueue,
        activityQueue,
        stopResult,
        observer: launch.observer,
        sessionAliases: new Set(),
        process,
        surface,
        lease,
        leaseReleased: false,
        activity: "idle",
        exitCode: null,
        ...(launch.initialDraft === undefined ? {} : { draftPreview: launch.initialDraft }),
        inputObserved: false,
        uiReleased: false,
        ptyClosed: false,
        cleanupStarted: false,
        cleanupInProgress: false,
        cleanupIssues: [],
      }
      return owner
    }.bind(this))
  }

  private semanticLoop(owner: TerminalOwner): Effect.Effect<void> {
    return Effect.forever(
      Queue.take(owner.eventQueue).pipe(
        Effect.flatMap((event) => this.gate.withPermit(this.handleSemanticEvent(owner, event))),
      ),
    )
  }

  private activityLoop(owner: TerminalOwner): Effect.Effect<void> {
    return Effect.forever(
      Queue.take(owner.activityQueue).pipe(
        Effect.flatMap((activities) =>
          this.gate.withPermit(
            Effect.sync(() => {
              for (const activity of activities) this.handleActivity(owner, activity)
            }),
          )
        ),
      ),
    )
  }

  private transitionLoop(
    owner: TerminalOwner,
    subscription: PubSub.Subscription<TerminalTransitionEvent>,
  ): Effect.Effect<void> {
    return Effect.gen(function*() {
      yield* Effect.forever(
        PubSub.take(subscription).pipe(
          Effect.tap((transition) =>
            Effect.sync(() => {
              Queue.offerUnsafe(owner.eventQueue, { _tag: "Transition", transition })
            }),
          ),
        ),
      )
    })
  }

  private handleSemanticEvent(
    owner: TerminalOwner,
    event: SemanticEvent,
  ): Effect.Effect<void> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      if (this.owners.get(owner.ownerId) !== owner) return
      if (event._tag === "Exited") {
        owner.exitCode = event.exitCode
        const entry = this.ledger.get(owner.sessionId)
        if (!entry || entry.ownerId !== owner.ownerId || entry.state !== "running") return
        yield* Effect.forkIn(this.handleNaturalExit(owner, event.exitCode), this.runtimeScope)
        return
      }
      const entry = this.ledger.get(owner.sessionId)
      if (!entry || entry.ownerId !== owner.ownerId || entry.state !== "running") return
      yield* this.applyTransition(owner, event.transition)
    }.bind(this))
  }

  private handleActivity(owner: TerminalOwner, activity: AgentActivity): void {
    const entry = this.ledger.get(owner.sessionId)
    if (
      this.owners.get(owner.ownerId) !== owner ||
      !entry ||
      entry.ownerId !== owner.ownerId ||
      entry.state !== "running" ||
      owner.activity === activity
    ) return
    owner.activity = activity
    const wasActive = this.activeOwnerId === owner.ownerId
    this.ignoreCallback(() => this.events.onActivityChanged?.({
      sessionId: owner.sessionId,
      activity,
      wasActive,
    }))
    if (wasActive) this.reportHerdr(activity)
  }

  private applyTransition(
    owner: TerminalOwner,
    transition: TerminalTransitionEvent,
  ): Effect.Effect<void> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      if (transition._tag === "TransitionFailed") {
        const wasActive = this.activeOwnerId === owner.ownerId
        this.ignoreCallback(() => this.events.onSessionTransitionError?.({
          sessionId: owner.sessionId,
          error: transition.error,
          wasActive,
        }))
        yield* this.startCleanupFromEvent(owner)
        return
      }

      const previousSessionId = owner.sessionId
      const sessionId = transition.session.id
      if (sessionId === previousSessionId) return
      const entry = this.ledger.get(previousSessionId)
      if (!entry || entry.ownerId !== owner.ownerId) return
      const existing = this.ledger.get(sessionId)
      if (existing && existing.ownerId !== owner.ownerId) {
        const wasActive = this.activeOwnerId === owner.ownerId
        const error = new TerminalError({
          operation: "native-session-transition",
          sessionId: previousSessionId,
          message: `Agent session ${sessionId} already has an owned terminal; stopped the duplicate process`,
        })
        this.ignoreCallback(() =>
          this.events.onSessionTransitionError?.({ sessionId: previousSessionId, error, wasActive })
        )
        yield* this.startCleanupFromEvent(owner)
        return
      }

      const replacementExit = yield* Effect.exit(
        this.dependencies.leases.replaceSessionId(owner.lease, sessionId),
      )
      if (Exit.isFailure(replacementExit)) {
        const wasActive = this.activeOwnerId === owner.ownerId
        this.ignoreCallback(() => this.events.onSessionTransitionError?.({
          sessionId: previousSessionId,
          error: Cause.squash(replacementExit.cause) as PersistenceError | SessionOwnedError,
          wasActive,
        }))
        yield* this.startCleanupFromEvent(owner)
        return
      }

      owner.lease = replacementExit.value
      this.ledger.delete(previousSessionId)
      owner.sessionAliases.add(previousSessionId)
      owner.sessionId = sessionId
      this.ledger.set(sessionId, entry)
      for (const alias of owner.sessionAliases) {
        this.completedSessionTransitions.set(alias, sessionId)
      }
      this.ignoreCallback(() => this.events.onSessionChanged?.({
        previousSessionId,
        session: transition.session,
        wasActive: this.activeOwnerId === owner.ownerId,
        ...(transition.derivation === undefined ? {} : { derivation: transition.derivation }),
      }))
    }.bind(this))
  }

  private startCleanupFromEvent(owner: TerminalOwner): Effect.Effect<void> {
    const entry = this.ledger.get(owner.sessionId)
    if (!entry || entry.ownerId !== owner.ownerId || entry.state !== "running") {
      return Effect.void
    }
    entry.state = "stopping"
    owner.cleanupStarted = true
    owner.cleanupInProgress = true
    owner.cleanupIssues.push(...this.releaseOwnerUi(owner))
    const cleanup = this.completeOwnerCleanup(owner, this.gracePeriodMs, "stop").pipe(
      Effect.catch((error) =>
        Effect.sync(() => this.ignoreCallback(() =>
          this.events.onSessionTransitionError?.({
            sessionId: owner.sessionId,
            error: new TerminalError({
              operation: "native-session-transition-cleanup",
              sessionId: owner.sessionId,
              message: error.issues.map((issue) => issue.message).join("; "),
              cause: error,
            }),
            wasActive: false,
          })
        )),
      ),
    )
    return Effect.forkIn(Effect.uninterruptible(cleanup), this.runtimeScope).pipe(Effect.asVoid)
  }

  private handleNaturalExit(owner: TerminalOwner, exitCode: number): Effect.Effect<void> {
    return Effect.uninterruptible(Effect.gen(function* (this: TerminalSupervisorImpl) {
      yield* this.waitForPtyDrain(owner.process)
      yield* Effect.yieldNow
      const decision = yield* this.gate.withPermit(
        Effect.sync(() => {
          const entry = this.ledger.get(owner.sessionId)
          if (!entry || entry.ownerId !== owner.ownerId || entry.state !== "running") {
            return { proceed: false, wasActive: false }
          }
          const wasActive = this.activeOwnerId === owner.ownerId
          entry.state = "stopping"
          owner.cleanupStarted = true
          owner.cleanupInProgress = true
          owner.cleanupIssues.push(...this.releaseOwnerUi(owner))
          return { proceed: true, wasActive }
        }),
      )
      if (!decision.proceed) return

      const cleanupExit = yield* Effect.exit(
        this.cleanupOwnerResources(owner, this.gracePeriodMs),
      )
      const issues = Exit.isSuccess(cleanupExit)
        ? cleanupExit.value
        : [
            ...owner.cleanupIssues,
            this.issue(
              owner,
              "verify",
              `Unexpected failure while cleaning agent process group ${owner.process.pid}`,
              Cause.squash(cleanupExit.cause),
            ),
          ]
      const cleanupError = issues.length === 0
        ? undefined
        : new TerminalCleanupError({ operation: "natural-exit", issues })

      yield* this.gate.withPermit(
        Effect.sync(() => {
          if (cleanupError) {
            this.setOwnerState(owner, "cleanup-incomplete")
            owner.cleanupInProgress = false
          } else {
            this.deleteOwner(owner)
          }
          this.ignoreCallback(() => this.events.onProcessExited?.({
            sessionId: owner.sessionId,
            exitCode,
            wasActive: decision.wasActive,
            ...(owner.draftPreview === undefined ? {} : { draftPreview: owner.draftPreview }),
            ...(cleanupError === undefined ? {} : { cleanupError }),
          }))
        }),
      )
      if (cleanupError) {
        yield* Deferred.fail(owner.stopResult, cleanupError)
      } else {
        yield* Deferred.succeed(owner.stopResult, undefined)
      }
    }.bind(this)))
  }

  private completeOwnerCleanup(
    owner: TerminalOwner,
    gracePeriodMs: number,
    operation: TerminalCleanupError["operation"],
    gateHeld = false,
  ): Effect.Effect<void, TerminalCleanupError> {
    return Effect.uninterruptible(Effect.gen(function* (this: TerminalSupervisorImpl) {
      const cleanupExit = yield* Effect.exit(this.cleanupOwnerResources(owner, gracePeriodMs))
      const issues = Exit.isSuccess(cleanupExit)
        ? cleanupExit.value
        : [
            ...owner.cleanupIssues,
            this.issue(
              owner,
              "verify",
              `Unexpected failure while cleaning agent process group ${owner.process.pid}`,
              Cause.squash(cleanupExit.cause),
            ),
          ]
      const error = issues.length === 0
        ? undefined
        : new TerminalCleanupError({ operation, issues })
      const finalize = Effect.sync(() => {
        if (error) {
          this.setOwnerState(owner, "cleanup-incomplete")
          owner.cleanupInProgress = false
        } else {
          this.deleteOwner(owner)
        }
      })
      if (gateHeld) yield* finalize
      else yield* this.gate.withPermit(finalize)

      if (error) {
        yield* Deferred.fail(owner.stopResult, error)
        return yield* Effect.fail(error)
      }
      yield* Deferred.succeed(owner.stopResult, undefined)
    }.bind(this)))
  }

  private cleanupOwnerResources(
    owner: TerminalOwner,
    gracePeriodMs: number,
  ): Effect.Effect<readonly TerminalCleanupIssue[]> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const issues = [...owner.cleanupIssues]
      let groupAbsent = !this.isGroupAlive(owner, issues)
      if (!groupAbsent) {
        issues.push(...this.signal(owner, "SIGTERM", "term"))
        yield* this.waitForGroupExit(owner, gracePeriodMs, issues)
        groupAbsent = !this.isGroupAlive(owner, issues)
      }
      if (!groupAbsent) {
        issues.push(...this.signal(owner, "SIGKILL", "kill"))
        yield* this.waitForGroupExit(owner, this.killPeriodMs, issues)
        groupAbsent = !this.isGroupAlive(owner, issues)
      }
      if (!groupAbsent) {
        issues.push(this.issue(owner, "verify", `Agent process group ${owner.process.pid} did not stop`))
      }
      const providerIssues = yield* this.releaseProvider(owner)
      issues.push(...providerIssues)
      if (groupAbsent && providerIssues.length === 0) {
        issues.push(...yield* this.releaseOwnerLease(owner))
      }
      issues.push(...this.closePty(owner))
      issues.push(...this.unref(owner))
      return issues
    }.bind(this))
  }

  private performShutdown(gracePeriodMs: number): Effect.Effect<void, TerminalCleanupError> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const decisions = yield* this.gate.withPermit(
        Effect.sync(() => {
          this.shuttingDown = true
          this.ignoreCallback(this.unsubscribeSelection)
          this.activeOwnerId = null
          this.ignoreCallback(() => this.dependencies.renderer.clearSelection())
          const owned = [...this.owners.values()]
          return owned.map((owner) => {
            const entry = this.ledger.get(owner.sessionId)
            if (!entry || entry.ownerId !== owner.ownerId) {
              owner.stopResult = Deferred.makeUnsafe<void, TerminalCleanupError>()
              owner.cleanupStarted = true
              owner.cleanupInProgress = true
              return { owner, start: true }
            }
            if (entry.state === "stopping" && owner.cleanupInProgress) {
              return { owner, start: false }
            }
            entry.state = "stopping"
            owner.stopResult = Deferred.makeUnsafe<void, TerminalCleanupError>()
            const start = true
            owner.cleanupStarted = true
            owner.cleanupInProgress = true
            owner.cleanupIssues.push(...this.releaseOwnerUi(owner))
            return { owner, start }
          })
        }),
      )
      this.reportHerdr("idle")

      const cleanupExits = yield* Effect.all(
        decisions.map(({ owner, start }) =>
          Effect.exit(
            start
              ? this.completeOwnerCleanup(owner, gracePeriodMs, "shutdown")
              : Deferred.await(owner.stopResult),
          )
        ),
        { concurrency: "unbounded" },
      )
      const issues = cleanupExits.flatMap((exit) => {
        if (Exit.isSuccess(exit)) return []
        const error = this.cleanupErrorFromCause("shutdown", Cause.squash(exit.cause))
        return [...error.issues]
      })

      const herdrFiber = yield* Effect.forkDetach(
        Effect.exit(this.herdr.shutdown),
        { startImmediately: true, uninterruptible: false },
      )
      yield* Effect.interruptible(Fiber.await(herdrFiber)).pipe(
        Effect.timeoutOrElse({
          duration: HERDR_SHUTDOWN_PERIOD_MS,
          orElse: () => Effect.sync(() => herdrFiber.interruptUnsafe()),
        }),
      )
      yield* Scope.close(this.runtimeScope, Exit.void)

      if (issues.length > 0) {
        return yield* Effect.fail(new TerminalCleanupError({ operation: "shutdown", issues }))
      }
    }.bind(this))
  }

  private activate(owner: TerminalOwner): Effect.Effect<void, TerminalError> {
    return this.attempt("focus", owner.sessionId, () => {
      const active = this.activeOwner()
      this.activeOwnerId = null
      this.dependencies.renderer.clearSelection()
      if (active) {
        this.captureDraft(active)
        active.surface.blur()
        active.surface.setActive(false)
      }
      owner.surface.setActive(true)
      try {
        owner.surface.focus()
        this.activeOwnerId = owner.ownerId
        this.reportHerdr(owner.activity)
      } catch (error) {
        this.ignoreCallback(() => owner.surface.setActive(false))
        this.reportHerdr("idle")
        throw error
      }
    })
  }

  private captureDraft(owner: TerminalOwner): void {
    if (!owner.inputObserved && owner.draftPreview?.exact) return
    try {
      const observed = owner.observer.observeDraft(owner.surface.screen())
      if (observed !== undefined) owner.draftPreview = observed
      else if (owner.inputObserved && !owner.draftPreview?.rewind) delete owner.draftPreview
    } catch {
      // Observer defects must not block process cleanup.
    } finally {
      owner.inputObserved = false
    }
  }

  private releaseOwnerUi(owner: TerminalOwner): readonly TerminalCleanupIssue[] {
    if (owner.uiReleased) return []
    owner.uiReleased = true
    const issues: TerminalCleanupIssue[] = []
    const release = (message: string, run: () => void) => {
      try {
        run()
      } catch (error) {
        issues.push(this.issue(owner, "ui", message, error))
      }
    }
    if (this.activeOwnerId === owner.ownerId) {
      this.activeOwnerId = null
      release("Unable to clear terminal selection", () => this.dependencies.renderer.clearSelection())
      this.reportHerdr("idle")
    }
    this.captureDraft(owner)
    release(`Unable to release terminal surface for ${owner.sessionId}`, () => owner.surface.release())
    return issues
  }

  private releaseProvider(owner: TerminalOwner): Effect.Effect<readonly TerminalCleanupIssue[]> {
    return Effect.suspend(() => {
      if (owner.providerReleaseResult) return Deferred.await(owner.providerReleaseResult)
      const result = Deferred.makeUnsafe<readonly TerminalCleanupIssue[]>()
      owner.providerReleaseResult = result
      return Effect.gen(function* (this: TerminalSupervisorImpl) {
        const releaseExit = yield* Effect.exit(
          Effect.gen(function*() {
            if (owner.transitionFiber) yield* Fiber.interrupt(owner.transitionFiber)
            yield* Scope.close(owner.providerScope, Exit.void)
          }),
        )
        const issues = Exit.isSuccess(releaseExit)
          ? []
          : [this.issue(
              owner,
              "provider",
              `Unable to clean up provider resources for ${owner.sessionId}`,
              Cause.squash(releaseExit.cause),
            )]
        yield* Deferred.succeed(result, issues)
        return issues
      }.bind(this))
    })
  }

  private closeProviderScopeParts(
    ownerId: string,
    sessionId: string,
    scope: Scope.Closeable,
  ): Effect.Effect<readonly TerminalCleanupIssue[]> {
    return Effect.exit(Scope.close(scope, Exit.void)).pipe(
      Effect.map((exit) => Exit.isFailure(exit)
        ? [{
            ownerId,
            sessionId,
            stage: "provider" as const,
            message: `Unable to roll back provider resources for ${sessionId}`,
            cause: Cause.squash(exit.cause),
          }]
        : []),
    )
  }

  private releaseLeaseParts(
    ownerId: string,
    lease: SessionLease,
  ): Effect.Effect<readonly TerminalCleanupIssue[]> {
    return Effect.exit(this.dependencies.leases.release(lease)).pipe(
      Effect.map((exit) => Exit.isFailure(exit)
        ? [{
            ownerId,
            sessionId: lease.sessionId,
            stage: "lease" as const,
            message: `Unable to release session lease for ${lease.sessionId}`,
            cause: Cause.squash(exit.cause),
          }]
        : []),
    )
  }

  private releaseOwnerLease(
    owner: TerminalOwner,
  ): Effect.Effect<readonly TerminalCleanupIssue[]> {
    return Effect.suspend(() => {
      if (owner.leaseReleased) return Effect.succeed([])
      if (owner.leaseReleaseResult) return Deferred.await(owner.leaseReleaseResult)
      const result = Deferred.makeUnsafe<readonly TerminalCleanupIssue[]>()
      owner.leaseReleaseResult = result
      return Effect.gen(function* (this: TerminalSupervisorImpl) {
        const issues = yield* this.releaseLeaseParts(owner.ownerId, owner.lease)
        if (issues.length === 0) owner.leaseReleased = true
        yield* Deferred.succeed(result, issues)
        if (issues.length > 0) delete owner.leaseReleaseResult
        return issues
      }.bind(this))
    })
  }

  private closePty(owner: TerminalOwner): readonly TerminalCleanupIssue[] {
    if (owner.ptyClosed) return []
    try {
      owner.process.closePty()
      owner.ptyClosed = true
      return []
    } catch (error) {
      return [this.issue(owner, "pty", `Unable to close PTY for ${owner.sessionId}`, error)]
    }
  }

  private signal(
    owner: TerminalOwner,
    signal: NodeJS.Signals,
    stage: "term" | "kill",
  ): readonly TerminalCleanupIssue[] {
    try {
      owner.process.signalGroup(signal)
      return []
    } catch (error) {
      return [this.issue(owner, stage, `Unable to send ${signal} to process group ${owner.process.pid}`, error)]
    }
  }

  private waitForGroupExit(
    owner: TerminalOwner,
    timeoutMs: number,
    issues: TerminalCleanupIssue[],
  ): Effect.Effect<void> {
    return Effect.exit(
      Effect.interruptible(owner.process.waitForGroupExit(timeoutMs)).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.succeed(false),
        }),
      ),
    ).pipe(
      Effect.map((exit) => {
        if (Exit.isFailure(exit)) {
          issues.push(this.issue(
            owner,
            "wait",
            `Unable to wait for process group ${owner.process.pid}`,
            Cause.squash(exit.cause),
          ))
        }
      }),
    )
  }

  private isGroupAlive(owner: TerminalOwner, issues: TerminalCleanupIssue[]): boolean {
    try {
      return owner.process.isGroupAlive()
    } catch (error) {
      issues.push(this.issue(
        owner,
        "verify",
        `Unable to verify process group ${owner.process.pid}`,
        error,
      ))
      return true
    }
  }

  private unref(owner: TerminalOwner): readonly TerminalCleanupIssue[] {
    try {
      owner.process.unref()
      return []
    } catch (error) {
      return [this.issue(owner, "pty", `Unable to detach process ${owner.process.pid}`, error)]
    }
  }

  private waitForPtyDrain(process: TerminalProcess): Effect.Effect<void> {
    return Effect.promise(async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        process.ptyDrained,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, PTY_DRAIN_PERIOD_MS)
        }),
      ]).catch(() => {})
      if (timeout) clearTimeout(timeout)
    })
  }

  private setOwnerState(owner: TerminalOwner, state: TerminalOwnerState): void {
    const entry = this.ledger.get(owner.sessionId)
    if (entry?.ownerId === owner.ownerId) entry.state = state
  }

  private deleteOwner(owner: TerminalOwner): void {
    const entry = this.ledger.get(owner.sessionId)
    if (entry?.ownerId === owner.ownerId) this.ledger.delete(owner.sessionId)
    this.owners.delete(owner.ownerId)
    owner.semanticFiber?.interruptUnsafe()
    owner.activityFiber?.interruptUnsafe()
  }

  private ownerForSession(sessionId: string): TerminalOwner | undefined {
    const entry = this.ledger.get(sessionId)
    return entry ? this.owners.get(entry.ownerId) : undefined
  }

  private activeOwner(): TerminalOwner | undefined {
    return this.activeOwnerId ? this.owners.get(this.activeOwnerId) : undefined
  }

  private sessionIdSet(
    predicate: (entry: LedgerEntry, owner: TerminalOwner) => boolean,
  ): Effect.Effect<ReadonlySet<string>> {
    return Effect.sync(() => {
      const sessionIds = new Set<string>()
      for (const [sessionId, entry] of this.ledger) {
        const owner = this.owners.get(entry.ownerId)
        if (owner && predicate(entry, owner)) sessionIds.add(sessionId)
      }
      return sessionIds
    })
  }

  private attempt<A>(
    operation: string,
    sessionId: string,
    run: () => A,
  ): Effect.Effect<A, TerminalError> {
    return Effect.try({
      try: run,
      catch: (cause) => new TerminalError({
        operation,
        sessionId,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
    })
  }

  private attemptPromise<A>(
    operation: string,
    sessionId: string,
    run: () => A | Promise<A>,
  ): Effect.Effect<A, TerminalError> {
    return Effect.tryPromise({
      try: async () => await run(),
      catch: (cause) => new TerminalError({
        operation,
        sessionId,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
    })
  }

  private acceptsTerminalData(owner: TerminalOwner): boolean {
    if (owner.uiReleased || owner.cleanupStarted) return false
    const entry = this.ledger.get(owner.sessionId)
    return entry === undefined || (entry.ownerId === owner.ownerId && entry.state === "running")
  }

  private cleanupErrorFromCause(
    operation: TerminalCleanupError["operation"],
    cause: unknown,
  ): TerminalCleanupError {
    if (cause instanceof TerminalCleanupError) return cause
    return new TerminalCleanupError({
      operation,
      issues: [{
        ownerId: "terminal-supervisor",
        sessionId: "",
        stage: "verify",
        message: "Unexpected terminal cleanup failure",
        cause,
      }],
    })
  }

  private ignoreCallback(run: () => void): void {
    try {
      run()
    } catch {
      // External callbacks must not alter terminal lifecycle state.
    }
  }

  private issue(
    owner: TerminalOwner,
    stage: TerminalCleanupIssue["stage"],
    message: string,
    cause?: unknown,
  ): TerminalCleanupIssue {
    return {
      ownerId: owner.ownerId,
      sessionId: owner.sessionId,
      stage,
      message,
      ...(cause === undefined ? {} : { cause }),
    }
  }

  private reportHerdr(activity: AgentActivity): void {
    try {
      this.herdr.report(activity)
    } catch {
      // Reporting is optional and must never alter terminal ownership.
    }
  }
}

function cleanupIssues(error: TerminalError | TerminalCleanupError): readonly TerminalCleanupIssue[] {
  return error instanceof TerminalCleanupError ? error.issues : []
}

function terminalSpawnCleanupError(error: unknown): TerminalSpawnCleanupError | undefined {
  if (error instanceof TerminalSpawnCleanupError) return error
  if (error instanceof TerminalError) return terminalSpawnCleanupError(error.cause)
  if (error instanceof TerminalCleanupError) {
    for (const issue of error.issues) {
      const failure = terminalSpawnCleanupError(issue.cause)
      if (failure) return failure
    }
  }
  return undefined
}
