import {
  Cause,
  Clock,
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
import type {
  BranchRelation,
  IdentityTransitionKind,
  TerminalOwner as PersistedTerminalOwner,
} from "../domain/persistence"
import {
  PersistenceError,
  TerminalError,
  type ProviderError,
  ProviderProtocolError,
  type SessionOwnedError,
  type SessionRemovedError,
} from "../domain/errors"
import {
  cleanupProcessGroup,
  type ProcessGroupCleanupIssue,
} from "../infrastructure/process-group"
import type {
  AcquiredTerminalLaunch,
  PreparedTerminal,
  TerminalLaunch,
  TerminalTransitionRequest,
} from "./provider"
import type {
  TerminalProcess,
  TerminalProcessFactory,
  TerminalRenderer,
  TerminalSurface,
} from "../infrastructure/terminal"
import { TerminalSpawnCleanupError } from "../infrastructure/terminal"
import type { ProviderStateRepositoryApi } from "./provider-state-repository"

const DEFAULT_GRACE_PERIOD_MS = 200
const DEFAULT_KILL_PERIOD_MS = 200
const PTY_DRAIN_PERIOD_MS = 250
const HERDR_SHUTDOWN_PERIOD_MS = 500
const PROVIDER_CLEANUP_ATTEMPTS = 3
const PROVIDER_CLEANUP_RETRY_DELAY_MS = 10
const PROVIDER_CLEANUP_TIMEOUT_MS = 500
const PERSISTENCE_TIMEOUT_MS = 500
const TRANSITION_DERIVATION_TIMEOUT_MS = 2_000
const APPLICATION_ACKNOWLEDGMENT_TIMEOUT_MS = 10_000

export type TerminalOwnerState = "running" | "stopping" | "cleanup-incomplete"

export interface TerminalCleanupIssue {
  readonly ownerId: string
  readonly sessionId: string
  readonly stage: "term" | "wait" | "kill" | "verify" | "provider" | "runtime" | "lease" | "pty" | "ui"
  readonly message: string
  readonly cause?: unknown
}

export class TerminalCleanupError extends Data.TaggedError("TerminalCleanupError")<{
  readonly operation: "stop" | "shutdown" | "natural-exit" | "acquire-rollback"
  readonly issues: readonly TerminalCleanupIssue[]
}> {}

interface SequencedTerminalEvent {
  readonly ownerId: string
  readonly sequenceId: number
}

export interface TerminalExitEvent extends SequencedTerminalEvent {
  readonly sessionId: string
  readonly exitCode: number
  readonly wasActive: boolean
  readonly draftPreview?: DraftPreview
  readonly cleanupError?: TerminalCleanupError
}

export interface TerminalActivityEvent extends SequencedTerminalEvent {
  readonly sessionId: string
  readonly activity: AgentActivity
  readonly wasActive: boolean
}

export interface TerminalSessionChangedEvent extends SequencedTerminalEvent {
  readonly previousSessionId: string
  readonly session: AgentSession
  readonly wasActive: boolean
  readonly adoptionToken: string
  readonly relation?: BranchRelation
  /** The application completes this only after projection and durable journal acknowledgment. */
  readonly acknowledgment?: Deferred.Deferred<void, unknown>
  /** @deprecated Derivation is completed before the durable identity commit. */
  readonly derivation?: Effect.Effect<
    BranchDerivation | undefined,
    ProviderError | ProviderProtocolError
  >
}

export interface TerminalSessionTransitionErrorEvent extends SequencedTerminalEvent {
  readonly sessionId: string
  readonly error:
    | TerminalError
    | ProviderError
    | ProviderProtocolError
    | PersistenceError
    | SessionOwnedError
    | SessionRemovedError
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

export interface TerminalOwnershipRepository extends Pick<
  ProviderStateRepositoryApi,
  "reserve" | "attach" | "mark" | "release" | "commitIdentity" | "ack"
> {}

export interface TerminalSupervisorDependencies {
  readonly renderer: TerminalRenderer
  readonly processes: TerminalProcessFactory
  readonly ownership: TerminalOwnershipRepository
  readonly events?: TerminalSupervisorEvents
  readonly herdr?: TerminalHerdrReporter
  readonly gracePeriodMs?: number
  readonly killPeriodMs?: number
  readonly providerCleanupAttempts?: number
  readonly providerCleanupRetryDelayMs?: number
  readonly providerCleanupTimeoutMs?: number
  readonly persistenceTimeoutMs?: number
  readonly transitionDerivationTimeoutMs?: number
  readonly applicationAcknowledgmentTimeoutMs?: number
}

export interface TerminalOwnershipSnapshot {
  readonly ownerId: string
  readonly sessionId: string
  readonly processGroupId: number
  readonly state: TerminalOwnerState
  readonly active: boolean
  readonly activity: AgentActivity
  readonly exitCode: number | null
}

export interface TerminalSupervisorApi {
  readonly show: (
    prepared: PreparedTerminal,
  ) => Effect.Effect<
    string,
    | ProviderError
    | ProviderProtocolError
    | PersistenceError
    | SessionOwnedError
    | SessionRemovedError
    | TerminalError
    | TerminalCleanupError
  >
  readonly hideActive: Effect.Effect<string | null>
  readonly stopSession: (
    sessionId: string,
    gracePeriodMs?: number,
  ) => Effect.Effect<boolean, TerminalCleanupError>
  readonly shutdown: (gracePeriodMs?: number) => Effect.Effect<void, TerminalCleanupError>
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
        Effect.catch((error) => Effect.sync(() => supervisor.reportCleanupError(error))),
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

interface PendingIdentity {
  readonly previousSessionId: string
  readonly session: AgentSession
  readonly kind: IdentityTransitionKind
  readonly relation?: BranchRelation
  readonly mutationToken: string
}

interface MutationTokens {
  readonly attach: string
  readonly stopping: string
  readonly cleanupIncomplete: string
  readonly release: string
}

interface SequenceAllocator {
  next: number
}

interface TerminalOwner {
  readonly ownerId: string
  sessionId: string
  readonly providerScope: Scope.Closeable
  readonly providerClose: AcquiredTerminalLaunch["close"]
  readonly eventQueue: Queue.Queue<SemanticEvent>
  readonly pendingTransitions: Set<TerminalTransitionRequest>
  readonly sequence: SequenceAllocator
  cleanupResult: Deferred.Deferred<void, TerminalCleanupError>
  readonly observer: TerminalLaunch["observer"]
  readonly process: TerminalProcess
  readonly processGroupId: number
  readonly surface: TerminalSurface
  ownership: PersistedTerminalOwner
  readonly beganTransient: boolean
  readonly mutationTokens: MutationTokens
  semanticFiber?: Fiber.Fiber<void, never>
  transitionFiber?: Fiber.Fiber<void, never>
  lastQueuedActivity: AgentActivity
  activity: AgentActivity
  exitCode: number | null
  draftPreview?: DraftPreview
  inputObserved: boolean
  selectionClearPending: boolean
  uiReleased: boolean
  ptyClosed: boolean
  providerClosed: boolean
  providerScopeClosed: boolean
  providerScopeCloseUncertain: boolean
  providerScopeCloseCause?: unknown
  leaseReleased: boolean
  processDetached: boolean
  stoppingPersisted: boolean
  processRegistrationUncertain: boolean
  pendingIdentity?: PendingIdentity
  pendingAdoptionToken?: string
  adoptionApplicationAcknowledged: boolean
  cleanupStarted: boolean
  cleanupInProgress: boolean
  cleanupNotificationSent: boolean
  exitNotificationSent: boolean
}

interface TrackedPersistence {
  readonly fiber: Fiber.Fiber<unknown, unknown>
  readonly operation: string
  readonly sessionId: string
  readonly ownerId?: string
  readonly mutationToken?: string
  readonly mutationKey?: string
  abandoned: boolean
  observedByCaller: boolean
  reported: boolean
  exit?: Exit.Exit<unknown, unknown>
}

interface PersistenceTracking {
  readonly ownerId?: string
  readonly mutationToken?: string
  readonly mutationStage?: string
}

interface PendingReservation {
  readonly ownerId: string
  readonly sessionId: string
  readonly releaseMutationToken: string
  readonly reserve: TrackedPersistence
  ownership?: PersistedTerminalOwner
  release?: TrackedPersistence
}

type SemanticEvent =
  | { readonly _tag: "Exited"; readonly sequenceId: number; readonly exitCode: number }
  | { readonly _tag: "Activity"; readonly sequenceId: number; readonly activity: AgentActivity }
  | {
      readonly _tag: "Transition"
      readonly sequenceId: number
      readonly request: TerminalTransitionRequest
    }

interface CleanupPlan {
  readonly owner: TerminalOwner
  readonly result: Deferred.Deferred<void, TerminalCleanupError>
  readonly operation: TerminalCleanupError["operation"]
  readonly gracePeriodMs: number
  readonly naturalExit?: { readonly exitCode: number; readonly sequenceId: number; readonly wasActive: boolean }
  readonly forcedExit?: { readonly wasActive: boolean }
}

type CleanupDecision =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Wait"; readonly owner: TerminalOwner }
  | { readonly _tag: "Start"; readonly plan: CleanupPlan }

class TerminalSupervisorImpl implements TerminalSupervisorApi {
  private readonly ledger = new Map<string, LedgerEntry>()
  private readonly owners = new Map<string, TerminalOwner>()
  private readonly gate = Semaphore.makeUnsafe(1)
  private readonly runtimeScope = Scope.makeUnsafe("parallel")
  private readonly events: TerminalSupervisorEvents
  private readonly herdr: TerminalHerdrReporter
  private readonly gracePeriodMs: number
  private readonly killPeriodMs: number
  private readonly providerCleanupAttempts: number
  private readonly providerCleanupRetryDelayMs: number
  private readonly providerCleanupTimeoutMs: number
  private readonly persistenceTimeoutMs: number
  private readonly transitionDerivationTimeoutMs: number
  private readonly applicationAcknowledgmentTimeoutMs: number
  private nextOwnerId = 1
  private activeOwnerId: string | null = null
  private shuttingDown = false
  private shutdownResult: Deferred.Deferred<void, TerminalCleanupError> | undefined
  private runtimeScopeClosed = false
  private runtimeScopeCloseUncertain = false
  private runtimeScopeCloseCause: unknown
  private readonly persistenceFibers = new Set<TrackedPersistence>()
  private readonly persistenceMutations = new Map<string, TrackedPersistence>()
  private readonly pendingReservations = new Map<string, PendingReservation>()
  private readonly unsubscribeSelection: () => void

  constructor(private readonly dependencies: TerminalSupervisorDependencies) {
    this.events = dependencies.events ?? {}
    this.herdr = dependencies.herdr ?? NULL_TERMINAL_HERDR_REPORTER
    this.gracePeriodMs = dependencies.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS
    this.killPeriodMs = dependencies.killPeriodMs ?? DEFAULT_KILL_PERIOD_MS
    this.providerCleanupAttempts = Math.max(
      1,
      dependencies.providerCleanupAttempts ?? PROVIDER_CLEANUP_ATTEMPTS,
    )
    this.providerCleanupRetryDelayMs = dependencies.providerCleanupRetryDelayMs ??
      PROVIDER_CLEANUP_RETRY_DELAY_MS
    this.providerCleanupTimeoutMs = dependencies.providerCleanupTimeoutMs ??
      PROVIDER_CLEANUP_TIMEOUT_MS
    this.persistenceTimeoutMs = dependencies.persistenceTimeoutMs ?? PERSISTENCE_TIMEOUT_MS
    this.transitionDerivationTimeoutMs = dependencies.transitionDerivationTimeoutMs ??
      TRANSITION_DERIVATION_TIMEOUT_MS
    this.applicationAcknowledgmentTimeoutMs = dependencies.applicationAcknowledgmentTimeoutMs ??
      APPLICATION_ACKNOWLEDGMENT_TIMEOUT_MS
    this.unsubscribeSelection = dependencies.renderer.onSelection((surface, text) => {
      this.ignoreCallback(() => {
        const active = this.activeOwner()
        if (active?.surface === surface) dependencies.renderer.copyToClipboard(text)
      })
    })
    this.reportHerdr("idle")
  }

  readonly show: TerminalSupervisorApi["show"] = (prepared) =>
    Effect.uninterruptibleMask((restore) =>
      this.gate.withPermit(
        Effect.gen(function* (this: TerminalSupervisorImpl) {
          if (this.shuttingDown) {
            return yield* Effect.fail(new TerminalError({
              operation: "show",
              sessionId: prepared.session.id,
              message: "Cannot open an agent session while claude-tree is shutting down",
            }))
          }

          const pendingReservation = this.pendingReservations.get(prepared.session.id)
          if (pendingReservation) {
            const compensationExit = yield* Effect.exit(
              this.reconcilePendingReservation(pendingReservation, true),
            )
            if (Exit.isFailure(compensationExit)) {
              return yield* Effect.failCause(compensationExit.cause)
            }
          }

          const existingEntry = this.ledger.get(prepared.session.id)
          if (existingEntry) {
            const existing = this.owners.get(existingEntry.ownerId)
            if (!existing || existingEntry.state !== "running" || existing.exitCode !== null) {
              return yield* Effect.fail(new TerminalError({
                operation: "show",
                sessionId: prepared.session.id,
                message: `Agent session ${prepared.session.id} is still ${existingEntry.state}`,
              }))
            }
            yield* this.activate(existing)
            return existing.ownerId
          }

          const ownerId = `terminal-owner-${this.nextOwnerId++}`
          const lifecycleToken = crypto.randomUUID()
          const reserveMutationToken = `${lifecycleToken}:reserve`
          const mutationTokens: MutationTokens = {
            attach: `${lifecycleToken}:attach`,
            stopping: `${lifecycleToken}:stopping`,
            cleanupIncomplete: `${lifecycleToken}:cleanup-incomplete`,
            release: `${lifecycleToken}:release`,
          }
          const reserveExit = yield* Effect.exit(this.reserveOwnership(
            ownerId,
            prepared.session.id,
            reserveMutationToken,
            mutationTokens.release,
          ))
          if (Exit.isFailure(reserveExit)) return yield* Effect.failCause(reserveExit.cause)
          const ownership = reserveExit.value
          const providerScope = yield* Scope.make("sequential")
          const acquiredExit = yield* Effect.exit(
            restore(Scope.provide(prepared.acquireLaunch, providerScope)),
          )
          if (Exit.isFailure(acquiredExit)) {
            const issues = yield* this.rollbackBeforeOwner(
              ownerId,
              prepared.session.id,
              ownership,
              providerScope,
              mutationTokens,
            )
            if (issues.length > 0) {
              return yield* Effect.fail(new TerminalCleanupError({
                operation: "acquire-rollback",
                issues,
              }))
            }
            return yield* Effect.failCause(acquiredExit.cause)
          }

          const acquired = acquiredExit.value
          const launch = acquired.launch
          if (launch.sessionId !== prepared.session.id) {
            const issues = yield* this.rollbackBeforeOwner(
              ownerId,
              prepared.session.id,
              ownership,
              providerScope,
              mutationTokens,
              acquired,
            )
            if (issues.length > 0) {
              return yield* Effect.fail(new TerminalCleanupError({
                operation: "acquire-rollback",
                issues,
              }))
            }
            return yield* Effect.fail(new TerminalError({
              operation: "acquire",
              sessionId: prepared.session.id,
              message: `Prepared terminal acquired a launch for ${launch.sessionId}`,
            }))
          }

          const subscription = launch.transitions
            ? yield* Scope.provide(PubSub.subscribe(launch.transitions), providerScope)
            : undefined
          const ownerExit = yield* Effect.exit(
            this.createOwner(
              ownerId,
              acquired,
              providerScope,
              ownership,
              prepared.session.transient === true,
              mutationTokens,
            ),
          )
          if (Exit.isFailure(ownerExit)) {
            const error = Cause.squash(ownerExit.cause) as TerminalError | TerminalCleanupError
            const spawnFailure = terminalSpawnCleanupError(error)
            const issues = yield* this.rollbackBeforeOwner(
              ownerId,
              prepared.session.id,
              ownership,
              providerScope,
              mutationTokens,
              acquired,
              spawnFailure,
              error instanceof TerminalCleanupError ? error.issues : [],
            )
            if (issues.length > 0 || spawnFailure) {
              return yield* Effect.fail(new TerminalCleanupError({
                operation: "acquire-rollback",
                issues: spawnFailure && issues.length === 0
                  ? [{
                      ownerId,
                      sessionId: prepared.session.id,
                      stage: "verify",
                      message: `Unable to verify process group ${spawnFailure.processGroupId} exited`,
                      cause: spawnFailure,
                    }]
                  : issues,
              }))
            }
            return yield* Effect.fail(error as TerminalError)
          }

          const owner = ownerExit.value
          // No asynchronous boundary is allowed between spawn and ownership registration.
          this.owners.set(owner.ownerId, owner)
          this.ledger.set(owner.sessionId, { ownerId, state: "running" })
          void owner.process.exited.then((exitCode) => {
            this.offerEvent(owner, { _tag: "Exited", exitCode })
          })
          owner.semanticFiber = yield* Effect.forkIn(this.semanticLoop(owner), this.runtimeScope)
          if (subscription) {
            owner.transitionFiber = yield* Effect.forkIn(
              this.transitionLoop(owner, subscription),
              this.runtimeScope,
            )
          }

          const registrationExit = yield* Effect.exit(
            this.boundedPersistence(Effect.suspend(() =>
              this.dependencies.ownership.attach(owner.ownership, owner.processGroupId, {
                mutationToken: owner.mutationTokens.attach,
              })), "attach terminal process group", owner.sessionId, {
              ownerId: owner.ownerId,
              mutationToken: owner.mutationTokens.attach,
              mutationStage: "attach",
            }),
          )
          if (Exit.isFailure(registrationExit)) {
            const registrationError = Cause.squash(registrationExit.cause) as PersistenceError
            owner.processRegistrationUncertain = true
            const plan = this.beginCleanup(owner, "acquire-rollback", this.gracePeriodMs)
            yield* this.runCleanupPlan(plan, true)
            return yield* Effect.fail(registrationError)
          }
          owner.ownership = registrationExit.value

          const activationExit = yield* Effect.exit(this.activate(owner))
          if (Exit.isFailure(activationExit)) {
            const error = Cause.squash(activationExit.cause) as TerminalError
            const plan = this.beginCleanup(owner, "acquire-rollback", this.gracePeriodMs)
            const rollbackExit = yield* Effect.exit(this.runCleanupPlan(plan, true))
            if (Exit.isFailure(rollbackExit)) return yield* Effect.failCause(rollbackExit.cause)
            return yield* Effect.fail(error)
          }
          return owner.ownerId
        }.bind(this)),
      )
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
  ) => Effect.uninterruptible(Effect.gen(function* (this: TerminalSupervisorImpl) {
    const decision = yield* this.gate.withPermit(
      Effect.sync(() => this.cleanupDecision(sessionId, "stop", gracePeriodMs)),
    )
    if (decision._tag === "Missing") return false
    if (decision._tag === "Wait") {
      yield* Deferred.await(decision.owner.cleanupResult)
      return true
    }
    yield* this.runCleanupPlan(decision.plan)
    return true
  }.bind(this)))

  readonly shutdown: TerminalSupervisorApi["shutdown"] = (
    gracePeriodMs = this.gracePeriodMs,
  ) => Effect.uninterruptible(Effect.suspend(() => {
    if (this.shutdownResult) return Deferred.await(this.shutdownResult)
    const result = Deferred.makeUnsafe<void, TerminalCleanupError>()
    this.shutdownResult = result
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const exit = yield* Effect.exit(this.performShutdown(gracePeriodMs))
      if (Exit.isSuccess(exit)) {
        yield* Deferred.succeed(result, undefined)
        return
      }
      const error = this.cleanupErrorFromCause("shutdown", Cause.squash(exit.cause))
      this.shutdownResult = undefined
      yield* Deferred.fail(result, error)
      return yield* Effect.fail(error)
    }.bind(this))
  }))

  readonly activeSessionId: Effect.Effect<string | null> = Effect.sync(
    () => this.activeOwner()?.sessionId ?? null,
  )

  readonly ownsInput: Effect.Effect<boolean> = Effect.sync(() => this.activeOwnerId !== null)

  readonly runningSessionIds = this.sessionIdSet(
    (entry, owner, sessionId) =>
      sessionId === owner.sessionId && entry.state === "running" && owner.exitCode === null,
  )

  readonly ownedSessionIds: Effect.Effect<ReadonlySet<string>> = Effect.sync(
    () => new Set([...this.ledger.keys(), ...this.pendingReservations.keys()]),
  )

  readonly nonIdleSessionIds = this.sessionIdSet(
    (entry, owner, sessionId) =>
      sessionId === owner.sessionId &&
      entry.state === "running" &&
      owner.exitCode === null &&
      owner.activity !== "idle",
  )

  readonly activitySessionIds: TerminalSupervisorApi["activitySessionIds"] = (activity) =>
    this.sessionIdSet(
      (entry, owner, sessionId) =>
        sessionId === owner.sessionId &&
        entry.state === "running" &&
        owner.exitCode === null &&
        owner.activity === activity,
    )

  readonly draftPreviews: Effect.Effect<ReadonlyMap<string, DraftPreview>> = Effect.sync(
    () => new Map([...this.owners.values()].flatMap((owner) => {
      const entry = this.ledger.get(owner.sessionId)
      return entry?.state === "running" && owner.exitCode === null && owner.draftPreview !== undefined
        ? [[owner.sessionId, owner.draftPreview] as const]
        : []
    })),
  )

  readonly ownershipSnapshot: Effect.Effect<readonly TerminalOwnershipSnapshot[]> = Effect.sync(
    () => [...this.owners.values()].map((owner) => ({
      ownerId: owner.ownerId,
      sessionId: owner.sessionId,
      processGroupId: owner.processGroupId,
      state: this.ledger.get(owner.sessionId)?.state ?? "cleanup-incomplete",
      active: this.activeOwnerId === owner.ownerId,
      activity: owner.activity,
      exitCode: owner.exitCode,
    })),
  )

  reportCleanupError(error: TerminalCleanupError): void {
    this.ignoreCallback(() => this.events.onCleanupError?.(error))
  }

  private createOwner(
    ownerId: string,
    acquired: AcquiredTerminalLaunch,
    providerScope: Scope.Closeable,
    ownership: PersistedTerminalOwner,
    beganTransient: boolean,
    mutationTokens: MutationTokens,
  ): Effect.Effect<TerminalOwner, TerminalError | TerminalCleanupError> {
    const launch = acquired.launch
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const eventQueue = yield* Queue.unbounded<SemanticEvent>()
      const osc52 = new Osc52Forwarder()
      let owner: TerminalOwner | undefined
      let process: TerminalProcess | undefined
      const sequence: SequenceAllocator = { next: 1 }
      let lastQueuedActivity: AgentActivity = "idle"
      const offer = (
        event:
          | { readonly _tag: "Exited"; readonly exitCode: number }
          | { readonly _tag: "Activity"; readonly activity: AgentActivity }
          | { readonly _tag: "Transition"; readonly request: TerminalTransitionRequest },
      ) => Queue.offerUnsafe(eventQueue, { ...event, sequenceId: sequence.next++ })
      const offerActivities = (activities: readonly AgentActivity[]) => {
        for (const activity of activities) {
          if (activity === lastQueuedActivity) continue
          lastQueuedActivity = activity
          offer({ _tag: "Activity", activity })
        }
      }

      const surface = yield* this.attempt("create-emulator", launch.sessionId, () =>
        this.dependencies.renderer.createSurface(`agent-owner-${encodeURIComponent(ownerId)}`, {
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
              const activity = launch.observer.observeScreen(surface.screen())
              if (activity !== undefined) offerActivities([activity])
            })
          },
        }),
      )

      const processExit = yield* Effect.exit(this.attempt("spawn", launch.sessionId, () =>
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
              this.ignoreCallback(() => surface.write(data))
            },
            onPtyClosed() {},
          },
        )
      ))
      if (Exit.isFailure(processExit)) {
        const spawnError = Cause.squash(processExit.cause) as TerminalError
        try {
          surface.release()
        } catch (cause) {
          const spawnFailure = terminalSpawnCleanupError(spawnError)
          return yield* Effect.fail(new TerminalCleanupError({
            operation: "acquire-rollback",
            issues: [
              ...(spawnFailure === undefined
                ? []
                : [{
                    ownerId,
                    sessionId: launch.sessionId,
                    stage: "verify" as const,
                    message: `Unable to verify process group ${spawnFailure.processGroupId} exited`,
                    cause: spawnFailure,
                  }]),
              {
                ownerId,
                sessionId: launch.sessionId,
                stage: "ui",
                message: `Unable to release terminal surface for ${launch.sessionId}`,
                cause,
              },
            ],
          }))
        }
        return yield* Effect.fail(spawnError)
      }
      process = processExit.value

      owner = {
        ownerId,
        sessionId: launch.sessionId,
        providerScope,
        providerClose: acquired.close,
        eventQueue,
        pendingTransitions: new Set(),
        sequence,
        cleanupResult: Deferred.makeUnsafe<void, TerminalCleanupError>(),
        observer: launch.observer,
        process,
        processGroupId: process.processGroupId,
        surface,
        ownership,
        beganTransient,
        mutationTokens,
        lastQueuedActivity,
        activity: "idle",
        exitCode: null,
        ...(launch.initialDraft === undefined ? {} : { draftPreview: launch.initialDraft }),
        inputObserved: false,
        selectionClearPending: false,
        uiReleased: false,
        ptyClosed: false,
        providerClosed: false,
        providerScopeClosed: false,
        providerScopeCloseUncertain: false,
        leaseReleased: false,
        processDetached: false,
        stoppingPersisted: false,
        processRegistrationUncertain: false,
        adoptionApplicationAcknowledged: false,
        cleanupStarted: false,
        cleanupInProgress: false,
        cleanupNotificationSent: false,
        exitNotificationSent: false,
      }
      owner.lastQueuedActivity = lastQueuedActivity
      return owner
    }.bind(this))
  }

  private offerEvent(
    owner: TerminalOwner,
    event:
      | { readonly _tag: "Exited"; readonly exitCode: number }
      | { readonly _tag: "Activity"; readonly activity: AgentActivity }
      | { readonly _tag: "Transition"; readonly request: TerminalTransitionRequest },
  ): boolean {
    if (event._tag === "Activity") {
      if (event.activity === owner.lastQueuedActivity) return true
      owner.lastQueuedActivity = event.activity
    }
    return Queue.offerUnsafe(owner.eventQueue, { ...event, sequenceId: owner.sequence.next++ })
  }

  private semanticLoop(owner: TerminalOwner): Effect.Effect<void> {
    return Effect.forever(
      Queue.take(owner.eventQueue).pipe(
        Effect.flatMap((event) => Effect.suspend(() =>
          this.handleSemanticEvent(owner, event)).pipe(
            Effect.catchCause((cause) => this.containSemanticEventDefect(owner, event, cause)),
            Effect.ensuring(Effect.sync(() => {
              if (event._tag === "Transition") owner.pendingTransitions.delete(event.request)
            })),
          )),
      ),
    )
  }

  private transitionLoop(
    owner: TerminalOwner,
    subscription: PubSub.Subscription<TerminalTransitionRequest>,
  ): Effect.Effect<void> {
    return Effect.forever(
      PubSub.take(subscription).pipe(
        Effect.flatMap((request) => Effect.sync(() => {
          owner.pendingTransitions.add(request)
          if (!this.offerEvent(owner, { _tag: "Transition", request })) {
            throw new Error(`Terminal event queue for ${owner.sessionId} is unavailable`)
          }
        }).pipe(
          Effect.catchCause((cause) => this.containTransitionDefect(owner, request, cause)),
        )),
      ),
    )
  }

  private containSemanticEventDefect(
    owner: TerminalOwner,
    event: SemanticEvent,
    cause: Cause.Cause<unknown>,
  ): Effect.Effect<void> {
    if (event._tag === "Activity") return Effect.void
    if (event._tag === "Transition") {
      return this.containTransitionDefect(owner, event.request, cause)
    }
    return this.superviseDefectCleanup(owner, "natural-exit", {
      exitCode: event.exitCode,
      sequenceId: event.sequenceId,
      wasActive: this.activeOwnerId === owner.ownerId,
    })
  }

  private containTransitionDefect(
    owner: TerminalOwner,
    request: TerminalTransitionRequest,
    cause: Cause.Cause<unknown>,
  ): Effect.Effect<void> {
    const error = this.transitionErrorFromCause(owner.sessionId, cause)
    Deferred.doneUnsafe(request.acknowledgment, Effect.fail(error))
    this.emitTransitionError(owner, owner.sequence.next++, error)
    return this.superviseDefectCleanup(owner, "stop", undefined, true)
  }

  private superviseDefectCleanup(
    owner: TerminalOwner,
    operation: TerminalCleanupError["operation"],
    naturalExit?: CleanupPlan["naturalExit"],
    forcedExit = false,
  ): Effect.Effect<void> {
    return Effect.uninterruptible(Effect.gen(function* (this: TerminalSupervisorImpl) {
      const decisionExit = yield* Effect.exit(Effect.suspend(() => this.gate.withPermit(
        Effect.sync((): CleanupDecision => {
          if (naturalExit) owner.exitCode = naturalExit.exitCode
          if (owner.cleanupInProgress) return { _tag: "Wait", owner }
          if (this.owners.get(owner.ownerId) !== owner) return { _tag: "Missing" }
          return {
            _tag: "Start",
            plan: this.beginCleanup(owner, operation, this.gracePeriodMs, naturalExit, forcedExit),
          }
        }),
      )))
      if (Exit.isFailure(decisionExit)) {
        this.settleDefectiveCleanup(owner, operation, Cause.squash(decisionExit.cause))
        return
      }
      const decision = decisionExit.value
      if (decision._tag === "Missing") return
      yield* Effect.exit(decision._tag === "Start"
        ? this.runCleanupPlan(decision.plan)
        : Deferred.await(decision.owner.cleanupResult))
    }.bind(this))).pipe(Effect.catchCause((cleanupCause) => Effect.sync(() => {
      this.settleDefectiveCleanup(owner, operation, Cause.squash(cleanupCause))
    })))
  }

  private handleSemanticEvent(owner: TerminalOwner, event: SemanticEvent): Effect.Effect<void> {
    return Effect.uninterruptible(Effect.gen(function* (this: TerminalSupervisorImpl) {
      if (event._tag === "Exited") yield* this.waitForPtyDrain(owner.process)
      const plan = event._tag === "Transition"
        ? yield* this.applyTransition(owner, event)
        : yield* this.gate.withPermit(Effect.sync(() => this.applyLocalEvent(owner, event)))
      if (plan) yield* this.runCleanupPlan(plan).pipe(Effect.catch(() => Effect.void))
    }.bind(this)))
  }

  private applyLocalEvent(
    owner: TerminalOwner,
    event: Exclude<SemanticEvent, { readonly _tag: "Transition" }>,
  ): CleanupPlan | undefined {
    const entry = this.ledger.get(owner.sessionId)
    if (
      this.owners.get(owner.ownerId) !== owner ||
      !entry ||
      entry.ownerId !== owner.ownerId ||
      entry.state !== "running"
    ) return undefined

    if (event._tag === "Activity") {
      if (owner.activity === event.activity) return undefined
      owner.activity = event.activity
      const wasActive = this.activeOwnerId === owner.ownerId
      this.ignoreCallback(() => this.events.onActivityChanged?.({
        ownerId: owner.ownerId,
        sequenceId: event.sequenceId,
        sessionId: owner.sessionId,
        activity: event.activity,
        wasActive,
      }))
      if (wasActive) this.reportHerdr(event.activity)
      return undefined
    }

    owner.exitCode = event.exitCode
    const wasActive = this.activeOwnerId === owner.ownerId
    return this.beginCleanup(owner, "natural-exit", this.gracePeriodMs, {
      exitCode: event.exitCode,
      sequenceId: event.sequenceId,
      wasActive,
    })
  }

  private applyTransition(
    owner: TerminalOwner,
    semantic: Extract<SemanticEvent, { readonly _tag: "Transition" }>,
  ): Effect.Effect<CleanupPlan | undefined> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const { request, sequenceId } = semantic
      const running = yield* this.gate.withPermit(Effect.sync(() => this.isRunningOwner(owner)))
      if (!running) {
        yield* Deferred.fail(request.acknowledgment, new TerminalError({
          operation: "native-session-transition",
          sessionId: owner.sessionId,
          message: `Terminal owner ${owner.ownerId} is stale`,
        }))
        return undefined
      }

      const transition = request.event
      if (transition._tag === "TransitionFailed") {
        return yield* this.gate.withPermit(Effect.gen(function* (this: TerminalSupervisorImpl) {
          if (!this.isRunningOwner(owner)) {
            yield* Deferred.fail(request.acknowledgment, transition.error)
            return undefined
          }
          this.emitTransitionError(owner, sequenceId, transition.error)
          yield* Deferred.succeed(request.acknowledgment, undefined)
          return this.beginCleanup(owner, "stop", this.gracePeriodMs, undefined, true)
        }.bind(this)))
      }

      const previousSessionId = owner.sessionId
      const sessionId = transition.session.id
      if (sessionId === previousSessionId) {
        yield* Deferred.succeed(request.acknowledgment, undefined)
        return undefined
      }
      const kind: IdentityTransitionKind = owner.beganTransient
        ? "temporary-adoption"
        : "native-fork"
      const relationExit = yield* Effect.exit(this.deriveRelation(
        previousSessionId,
        sessionId,
        kind,
        transition.derivation,
      ))
      if (Exit.isFailure(relationExit)) {
        const error = this.transitionErrorFromCause(previousSessionId, relationExit.cause)
        return yield* this.gate.withPermit(Effect.gen(function* (this: TerminalSupervisorImpl) {
          if (!this.isRunningOwner(owner)) {
            yield* Deferred.fail(request.acknowledgment, error)
            return undefined
          }
          this.emitTransitionError(owner, sequenceId, error)
          yield* Deferred.fail(request.acknowledgment, error)
          return this.beginCleanup(owner, "stop", this.gracePeriodMs, undefined, true)
        }.bind(this)))
      }
      const relation = relationExit.value
      const mutationToken = `${crypto.randomUUID()}:identity`

      const committed = yield* this.gate.withPermit(Effect.gen(function* (this: TerminalSupervisorImpl) {
        if (!this.isRunningOwner(owner)) {
          const error = new TerminalError({
            operation: "native-session-transition",
            sessionId: previousSessionId,
            message: `Terminal owner ${owner.ownerId} stopped while deriving its transition`,
          })
          yield* Deferred.fail(request.acknowledgment, error)
          return { cleanup: undefined, error } as const
        }
        const existing = this.ledger.get(sessionId)
        if (existing && existing.ownerId !== owner.ownerId) {
          const error = new TerminalError({
            operation: "native-session-transition",
            sessionId: previousSessionId,
            message: `Agent session ${sessionId} already has an owned terminal; stopped the duplicate process`,
          })
          this.emitTransitionError(owner, sequenceId, error)
          yield* Deferred.fail(request.acknowledgment, error)
          return {
            cleanup: this.beginCleanup(owner, "stop", this.gracePeriodMs, undefined, true),
            error,
          } as const
        }

        const replacementExit = yield* Effect.exit(
          this.boundedPersistence(Effect.suspend(() =>
            this.dependencies.ownership.commitIdentity({
              owner: owner.ownership,
              sessionId,
              kind,
              mutationToken,
              ...(relation === undefined ? {} : { relation }),
            })), "commit terminal identity", previousSessionId, {
            ownerId: owner.ownerId,
            mutationToken,
            mutationStage: "identity",
          }),
        )
        if (Exit.isFailure(replacementExit)) {
          const error = this.transitionErrorFromCause(previousSessionId, replacementExit.cause)
          if (
            error._tag === "PersistenceError" ||
            replacementExit.cause.reasons.some(Cause.isDieReason)
          ) {
            owner.pendingIdentity = {
              previousSessionId,
              session: transition.session,
              kind,
              mutationToken,
              ...(relation === undefined ? {} : { relation }),
            }
            this.reserveAlias(owner, sessionId)
          }
          this.emitTransitionError(owner, sequenceId, error)
          yield* Deferred.fail(request.acknowledgment, error)
          return {
            cleanup: this.beginCleanup(owner, "stop", this.gracePeriodMs, undefined, true),
            error,
          } as const
        }

        this.commitIdentity(owner, previousSessionId, sessionId, replacementExit.value.owner)
        owner.pendingAdoptionToken = replacementExit.value.adoption.adoptionToken
        return { value: replacementExit.value } as const
      }.bind(this)))
      if ("cleanup" in committed) return committed.cleanup

      const applicationAcknowledgment = Deferred.makeUnsafe<void, unknown>()
      const applicationEvent: TerminalSessionChangedEvent = {
        ownerId: owner.ownerId,
        sequenceId,
        previousSessionId,
        session: transition.session,
        wasActive: this.activeOwnerId === owner.ownerId,
        adoptionToken: committed.value.adoption.adoptionToken,
        acknowledgment: applicationAcknowledgment,
        ...(relation === undefined ? {} : { relation }),
      }
      const applicationListener = this.events.onSessionChanged
      if (applicationListener === undefined) {
        yield* Deferred.fail(applicationAcknowledgment, new Error(
          "No application session-transition listener is installed",
        ))
      } else {
        try {
          applicationListener(applicationEvent)
        } catch (cause) {
          yield* Deferred.fail(applicationAcknowledgment, cause)
        }
      }

      const applicationExit = yield* Effect.exit(
        Effect.interruptible(Deferred.await(applicationAcknowledgment)).pipe(
          Effect.timeoutOrElse({
            duration: this.applicationAcknowledgmentTimeoutMs,
            orElse: () => Effect.fail(new Error(
              `Application did not acknowledge session ${sessionId}`,
            )),
          }),
        ),
      )
      const journalExit = Exit.isSuccess(applicationExit)
        ? yield* Effect.exit(Effect.sync(() => {
            owner.adoptionApplicationAcknowledged = true
          }).pipe(Effect.andThen(
            this.boundedPersistence(
              Effect.suspend(() =>
                this.dependencies.ownership.ack(committed.value.adoption.adoptionToken)),
              "acknowledge terminal identity",
              sessionId,
              {
                ownerId: owner.ownerId,
                mutationToken: committed.value.adoption.adoptionToken,
                mutationStage: "ack",
              },
            ),
          )))
        : applicationExit
      if (Exit.isFailure(journalExit)) {
        const error = new TerminalError({
          operation: "native-session-transition",
          sessionId,
          message: `Application did not complete session transition to ${sessionId}`,
          cause: Cause.squash(journalExit.cause),
        })
        const plan = yield* this.gate.withPermit(Effect.sync(() => {
          const errorSequenceId = owner.sequence.next++
          this.emitTransitionError(owner, errorSequenceId, error)
          return owner.cleanupStarted
            ? undefined
            : this.beginCleanup(owner, "stop", this.gracePeriodMs, undefined, true)
        }))
        yield* Deferred.fail(request.acknowledgment, error)
        return plan
      }

      delete owner.pendingAdoptionToken
      owner.adoptionApplicationAcknowledged = false
      yield* Deferred.succeed(request.acknowledgment, undefined)
      return undefined
    }.bind(this))
  }

  private emitTransitionError(
    owner: TerminalOwner,
    sequenceId: number,
    error: TerminalSessionTransitionErrorEvent["error"],
  ): void {
    this.ignoreCallback(() => this.events.onSessionTransitionError?.({
      ownerId: owner.ownerId,
      sequenceId,
      sessionId: owner.sessionId,
      error,
      wasActive: this.activeOwnerId === owner.ownerId,
    }))
  }

  private deriveRelation(
    previousSessionId: string,
    sessionId: string,
    kind: IdentityTransitionKind,
    derivation: Effect.Effect<
      BranchDerivation | undefined,
      ProviderError | ProviderProtocolError
    > | undefined,
  ): Effect.Effect<BranchRelation | undefined, TerminalError | ProviderError | ProviderProtocolError> {
    if (derivation === undefined) return Effect.succeed(undefined)
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const derived = yield* Effect.interruptible(derivation).pipe(Effect.timeoutOrElse({
        duration: this.transitionDerivationTimeoutMs,
        orElse: () => Effect.fail(new TerminalError({
          operation: "native-session-transition",
          sessionId,
          message: `Timed out deriving branch metadata for ${sessionId}`,
        })),
      }))
      if (derived === undefined) return undefined
      yield* Effect.try({
        try: () => validateBranchDerivation(derived, previousSessionId, sessionId, kind),
        catch: (cause) => new TerminalError({
          operation: "native-session-transition",
          sessionId,
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      })
      const now = yield* Clock.currentTimeMillis
      return { ...derived, createdAt: new Date(now).toISOString() }
    }.bind(this))
  }

  private completeRecoveredIdentity(
    owner: TerminalOwner,
    pending: PendingIdentity,
    adoptionToken: string,
  ): Effect.Effect<readonly TerminalCleanupIssue[]> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const acknowledgment = Deferred.makeUnsafe<void, unknown>()
      const listener = this.events.onSessionChanged
      const event: TerminalSessionChangedEvent = {
        ownerId: owner.ownerId,
        sequenceId: owner.sequence.next++,
        previousSessionId: pending.previousSessionId,
        session: pending.session,
        wasActive: this.activeOwnerId === owner.ownerId,
        adoptionToken,
        acknowledgment,
        ...(pending.relation === undefined ? {} : { relation: pending.relation }),
      }
      if (listener === undefined) {
        yield* Deferred.fail(acknowledgment, new Error(
          "No application session-transition listener is installed",
        ))
      } else {
        try {
          listener(event)
        } catch (cause) {
          yield* Deferred.fail(acknowledgment, cause)
        }
      }
      const applicationExit = yield* Effect.exit(
        Effect.interruptible(Deferred.await(acknowledgment)).pipe(
          Effect.timeoutOrElse({
            duration: this.applicationAcknowledgmentTimeoutMs,
            orElse: () => Effect.fail(new Error(
              `Application did not acknowledge recovered session ${pending.session.id}`,
            )),
          }),
        ),
      )
      if (Exit.isFailure(applicationExit)) {
        return [this.issue(
          owner,
          "lease",
          `Application did not project recovered session ${pending.session.id}`,
          Cause.squash(applicationExit.cause),
        )]
      }
      owner.adoptionApplicationAcknowledged = true
      const acknowledgmentExit = yield* Effect.exit(this.boundedPersistence(
        Effect.suspend(() => this.dependencies.ownership.ack(adoptionToken)),
        "acknowledge recovered terminal identity",
        owner.sessionId,
        { ownerId: owner.ownerId, mutationToken: adoptionToken, mutationStage: "ack" },
      ))
      if (Exit.isFailure(acknowledgmentExit)) {
        return [this.issue(
          owner,
          "lease",
          `Unable to acknowledge recovered session ${pending.session.id}`,
          Cause.squash(acknowledgmentExit.cause),
        )]
      }
      delete owner.pendingAdoptionToken
      owner.adoptionApplicationAcknowledged = false
      return []
    }.bind(this))
  }

  private cleanupDecision(
    sessionId: string,
    operation: TerminalCleanupError["operation"],
    gracePeriodMs: number,
  ): CleanupDecision {
    const owner = this.ownerForSession(sessionId)
    if (!owner) return { _tag: "Missing" }
    if (owner.cleanupInProgress) return { _tag: "Wait", owner }
    return { _tag: "Start", plan: this.beginCleanup(owner, operation, gracePeriodMs) }
  }

  private beginCleanup(
    owner: TerminalOwner,
    operation: TerminalCleanupError["operation"],
    gracePeriodMs: number,
    naturalExit?: CleanupPlan["naturalExit"],
    forcedExit = false,
  ): CleanupPlan {
    owner.cleanupStarted = true
    owner.cleanupInProgress = true
    owner.cleanupResult = Deferred.makeUnsafe<void, TerminalCleanupError>()
    this.setOwnerState(owner, "stopping")
    return {
      owner,
      result: owner.cleanupResult,
      operation,
      gracePeriodMs,
      ...(naturalExit === undefined ? {} : { naturalExit }),
      ...(forcedExit
        ? {
            forcedExit: {
              wasActive: this.activeOwnerId === owner.ownerId,
            },
          }
        : {}),
    }
  }

  private runCleanupPlan(
    plan: CleanupPlan,
    gateHeld = false,
  ): Effect.Effect<void, TerminalCleanupError> {
    const outcome = Effect.suspend(() => this.cleanupPlanOutcome(plan, gateHeld)).pipe(
      Effect.catchCause((cause) => Effect.succeed(
        this.cleanupPlanError(plan, "Unexpected terminal cleanup failure", Cause.squash(cause)),
      )),
    )
    return Effect.uninterruptible(outcome.pipe(
      Effect.flatMap((error) => Effect.sync(() => {
        this.settleCleanupPlan(plan, error)
      }).pipe(Effect.andThen(error === undefined ? Effect.void : Effect.fail(error)))),
    ))
  }

  private cleanupPlanOutcome(
    plan: CleanupPlan,
    gateHeld: boolean,
  ): Effect.Effect<TerminalCleanupError | undefined> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const cleanupExit = yield* Effect.exit(Effect.suspend(() =>
        this.cleanupOwnerResources(plan.owner, plan.gracePeriodMs)))
      const issues = Exit.isSuccess(cleanupExit)
        ? [...cleanupExit.value]
        : [this.issue(
            plan.owner,
            "verify",
            "Unexpected terminal resource cleanup failure",
            Cause.squash(cleanupExit.cause),
          )]

      if (issues.length > 0) {
        const persistExit = yield* Effect.exit(Effect.suspend(() =>
          this.persistCleanupIncomplete(plan.owner)))
        if (Exit.isSuccess(persistExit)) {
          issues.push(...persistExit.value)
        } else {
          issues.push(this.issue(
            plan.owner,
            "lease",
            `Unable to persist incomplete cleanup ownership for ${plan.owner.sessionId}`,
            Cause.squash(persistExit.cause),
          ))
        }
      }

      let error = issues.length === 0
        ? undefined
        : new TerminalCleanupError({ operation: plan.operation, issues })
      const finalizeExit = yield* Effect.exit(Effect.suspend(() => {
        const finalize = Effect.sync(() => this.finalizeCleanupPlan(plan, error))
        return gateHeld ? finalize : this.gate.withPermit(finalize)
      }))
      if (Exit.isFailure(finalizeExit)) {
        error = this.cleanupPlanError(
          plan,
          "Unable to finalize terminal cleanup",
          Cause.squash(finalizeExit.cause),
          error?.issues,
        )
      }
      return error
    }.bind(this))
  }

  private finalizeCleanupPlan(
    plan: CleanupPlan,
    error: TerminalCleanupError | undefined,
  ): void {
    this.settlePendingTransitions(plan.owner)
    if (error) {
      this.markLocalCleanupIncomplete(plan.owner)
    } else {
      this.deleteOwner(plan.owner)
    }
    this.emitCleanupExit(plan, error)
  }

  private settleCleanupPlan(
    plan: CleanupPlan,
    error: TerminalCleanupError | undefined,
  ): void {
    this.settlePendingTransitions(plan.owner)
    this.emitCleanupExit(plan, error)
    if (error) {
      this.markLocalCleanupIncomplete(plan.owner)
      this.reportOwnerCleanupError(plan.owner, error)
      Deferred.doneUnsafe(plan.result, Effect.fail(error))
      return
    }
    Deferred.doneUnsafe(plan.result, Effect.void)
  }

  private settleDefectiveCleanup(
    owner: TerminalOwner,
    operation: TerminalCleanupError["operation"],
    cause: unknown,
  ): void {
    const error = new TerminalCleanupError({
      operation,
      issues: [this.issue(owner, "verify", "Unexpected terminal cleanup failure", cause)],
    })
    this.settlePendingTransitions(owner)
    this.markLocalCleanupIncomplete(owner)
    this.reportOwnerCleanupError(owner, error)
    Deferred.doneUnsafe(owner.cleanupResult, Effect.fail(error))
  }

  private markLocalCleanupIncomplete(owner: TerminalOwner): void {
    try {
      this.owners.set(owner.ownerId, owner)
      if (![...this.ledger.values()].some((entry) => entry.ownerId === owner.ownerId)) {
        this.ledger.set(owner.sessionId, { ownerId: owner.ownerId, state: "cleanup-incomplete" })
      }
      this.setOwnerState(owner, "cleanup-incomplete")
    } catch {
      // The owner object remains the final fail-closed source if local indexing itself defects.
    }
    owner.cleanupStarted = true
    owner.cleanupInProgress = false
  }

  private settlePendingTransitions(owner: TerminalOwner): void {
    const error = new TerminalError({
      operation: "native-session-transition",
      sessionId: owner.sessionId,
      message: `Terminal owner ${owner.ownerId} stopped while deriving its transition`,
    })
    for (const request of owner.pendingTransitions) {
      Deferred.doneUnsafe(request.acknowledgment, Effect.fail(error))
    }
    owner.pendingTransitions.clear()
  }

  private reportOwnerCleanupError(owner: TerminalOwner, error: TerminalCleanupError): void {
    if (owner.cleanupNotificationSent) return
    owner.cleanupNotificationSent = true
    this.reportCleanupError(error)
  }

  private emitCleanupExit(
    plan: CleanupPlan,
    error: TerminalCleanupError | undefined,
  ): void {
    if (plan.owner.exitNotificationSent) return
    const exitNotification = plan.naturalExit ?? (plan.forcedExit === undefined
      ? undefined
      : { ...plan.forcedExit, sequenceId: plan.owner.sequence.next++ })
    if (!exitNotification) return
    plan.owner.exitNotificationSent = true
    this.ignoreCallback(() => this.events.onProcessExited?.({
      ownerId: plan.owner.ownerId,
      sequenceId: exitNotification.sequenceId,
      sessionId: plan.owner.sessionId,
      exitCode: plan.naturalExit?.exitCode ?? plan.owner.process.exitCode ?? 1,
      wasActive: exitNotification.wasActive,
      ...(plan.owner.draftPreview === undefined
        ? {}
        : { draftPreview: plan.owner.draftPreview }),
      ...(error === undefined ? {} : { cleanupError: error }),
    }))
  }

  private cleanupPlanError(
    plan: CleanupPlan,
    message: string,
    cause: unknown,
    priorIssues: readonly TerminalCleanupIssue[] = [],
  ): TerminalCleanupError {
    return new TerminalCleanupError({
      operation: plan.operation,
      issues: [...priorIssues, this.issue(plan.owner, "verify", message, cause)],
    })
  }

  private cleanupOwnerResources(
    owner: TerminalOwner,
    gracePeriodMs: number,
  ): Effect.Effect<readonly TerminalCleanupIssue[]> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const issues: TerminalCleanupIssue[] = []
      issues.push(...this.releaseOwnerUi(owner))
      issues.push(...yield* this.persistStopping(owner))
      const processResult = yield* cleanupProcessGroup(owner.process, {
        gracePeriodMs,
        killPeriodMs: this.killPeriodMs,
      })
      if (processResult.status !== "absent") {
        issues.push(...processResult.issues.map((issue) => this.processIssue(owner, issue)))
      }

      const providerIssues = yield* this.releaseProvider(owner)
      issues.push(...providerIssues)
      issues.push(...this.closePty(owner))
      issues.push(...this.unref(owner))

      if (processResult.status === "absent") {
        issues.push(...yield* this.stabilizeLease(owner))
      }
      if (
        processResult.status === "absent" &&
        owner.providerClosed &&
        owner.providerScopeClosed &&
        owner.uiReleased &&
        owner.ptyClosed &&
        owner.processDetached &&
        owner.pendingIdentity === undefined &&
        owner.pendingAdoptionToken === undefined &&
        !owner.processRegistrationUncertain &&
        owner.stoppingPersisted &&
        issues.length === 0
      ) {
        issues.push(...yield* this.releaseOwnerLease(owner))
      }
      if (owner.pendingAdoptionToken !== undefined) {
        issues.push(this.issue(
          owner,
          "lease",
          `Session identity journal ${owner.pendingAdoptionToken} is still pending`,
        ))
      }
      return issues
    }.bind(this))
  }

  private persistStopping(owner: TerminalOwner): Effect.Effect<readonly TerminalCleanupIssue[]> {
    if (owner.stoppingPersisted) return Effect.succeed([])
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const issues: TerminalCleanupIssue[] = []
      if (owner.processRegistrationUncertain) {
        const attachExit = yield* Effect.exit(this.boundedPersistence(
          Effect.suspend(() => this.dependencies.ownership.attach(
            owner.ownership,
            owner.processGroupId,
            { mutationToken: owner.mutationTokens.attach },
          )),
          "reconcile terminal process group",
          owner.sessionId,
          {
            ownerId: owner.ownerId,
            mutationToken: owner.mutationTokens.attach,
            mutationStage: "attach",
          },
        ))
        if (Exit.isSuccess(attachExit)) {
          owner.ownership = attachExit.value
          owner.processRegistrationUncertain = false
        }
      }
      const markExit = yield* Effect.exit(this.boundedPersistence(
        Effect.suspend(() => this.dependencies.ownership.mark(
          owner.ownership,
          "stopping",
          {
            processGroupId: owner.processGroupId,
            mutationToken: owner.mutationTokens.stopping,
          },
        )),
        "persist stopping terminal ownership",
        owner.sessionId,
        {
          ownerId: owner.ownerId,
          mutationToken: owner.mutationTokens.stopping,
          mutationStage: "stopping",
        },
      ))
      if (Exit.isSuccess(markExit)) {
        owner.ownership = markExit.value
        owner.processRegistrationUncertain = false
        owner.stoppingPersisted = true
      } else {
        issues.push(this.issue(
          owner,
          "lease",
          `Unable to persist stopping ownership for ${owner.sessionId}`,
          Cause.squash(markExit.cause),
        ))
      }
      return issues
    }.bind(this))
  }

  private persistCleanupIncomplete(
    owner: TerminalOwner,
  ): Effect.Effect<readonly TerminalCleanupIssue[]> {
    const persist = this.boundedPersistence(
      Effect.suspend(() => this.dependencies.ownership.mark(
        owner.ownership,
        "cleanup-incomplete",
        {
          processGroupId: owner.processGroupId,
          mutationToken: owner.mutationTokens.cleanupIncomplete,
        },
      )),
      "persist incomplete terminal cleanup",
      owner.sessionId,
      {
        ownerId: owner.ownerId,
        mutationToken: owner.mutationTokens.cleanupIncomplete,
        mutationStage: "cleanup-incomplete",
      },
    )
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const exit = yield* Effect.exit(persist)
      if (Exit.isSuccess(exit)) {
        owner.ownership = exit.value
        owner.stoppingPersisted = false
        return []
      }
      return [this.issue(
        owner,
        "lease",
        `Unable to persist incomplete cleanup ownership for ${owner.sessionId}`,
        Cause.squash(exit.cause),
      )]
    }.bind(this))
  }

  private stabilizeLease(owner: TerminalOwner): Effect.Effect<readonly TerminalCleanupIssue[]> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const issues: TerminalCleanupIssue[] = []
      let registrationCause: unknown
      if (owner.processRegistrationUncertain) {
        const updateExit = yield* Effect.exit(
          this.boundedPersistence(
            Effect.suspend(() =>
              this.dependencies.ownership.attach(owner.ownership, owner.processGroupId, {
                mutationToken: owner.mutationTokens.attach,
              })),
            "confirm terminal process group",
            owner.sessionId,
            {
              ownerId: owner.ownerId,
              mutationToken: owner.mutationTokens.attach,
              mutationStage: "attach",
            },
          ),
        )
        if (Exit.isSuccess(updateExit)) {
          owner.ownership = updateExit.value
          owner.processRegistrationUncertain = false
        } else {
          registrationCause = Cause.squash(updateExit.cause)
        }
      }

      if (owner.pendingIdentity) {
        const pending = owner.pendingIdentity
        const replacementExit = yield* Effect.exit(
          this.boundedPersistence(
            Effect.suspend(() => this.dependencies.ownership.commitIdentity({
              owner: owner.ownership,
              sessionId: pending.session.id,
              kind: pending.kind,
              mutationToken: pending.mutationToken,
              ...(pending.relation === undefined ? {} : { relation: pending.relation }),
            })),
            "confirm terminal identity",
            owner.sessionId,
            {
              ownerId: owner.ownerId,
              mutationToken: pending.mutationToken,
              mutationStage: "identity",
            },
          ),
        )
        if (Exit.isSuccess(replacementExit)) {
          this.commitIdentity(
            owner,
            pending.previousSessionId,
            pending.session.id,
            replacementExit.value.owner,
          )
          delete owner.pendingIdentity
          owner.pendingAdoptionToken = replacementExit.value.adoption.adoptionToken
          if (replacementExit.value.owner.processGroupId === owner.processGroupId) {
            owner.processRegistrationUncertain = false
          }
          issues.push(...yield* this.completeRecoveredIdentity(
            owner,
            pending,
            replacementExit.value.adoption.adoptionToken,
          ))
        } else {
          issues.push(this.issue(
            owner,
            "lease",
            `Unable to confirm session ownership transition to ${pending.session.id}`,
            Cause.squash(replacementExit.cause),
          ))
        }
      }
      if (owner.pendingAdoptionToken !== undefined && owner.adoptionApplicationAcknowledged) {
        const adoptionToken = owner.pendingAdoptionToken
        const acknowledgmentExit = yield* Effect.exit(
          this.boundedPersistence(
            Effect.suspend(() => this.dependencies.ownership.ack(adoptionToken)),
            "reconcile terminal identity acknowledgment",
            owner.sessionId,
            { ownerId: owner.ownerId, mutationToken: adoptionToken, mutationStage: "ack" },
          ),
        )
        if (Exit.isSuccess(acknowledgmentExit)) {
          delete owner.pendingAdoptionToken
          owner.adoptionApplicationAcknowledged = false
        } else {
          issues.push(this.issue(
            owner,
            "lease",
            `Unable to reconcile identity acknowledgment ${adoptionToken}`,
            Cause.squash(acknowledgmentExit.cause),
          ))
        }
      }
      if (owner.processRegistrationUncertain) {
        issues.push(this.issue(
          owner,
          "lease",
          `Unable to confirm process group ${owner.processGroupId} on the session lease`,
          registrationCause,
        ))
      }
      return issues
    }.bind(this))
  }

  private releaseProvider(owner: TerminalOwner): Effect.Effect<readonly TerminalCleanupIssue[]> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const issues: TerminalCleanupIssue[] = []
      if (!owner.providerClosed) {
        let lastCause: unknown
        for (let attempt = 0; attempt < this.providerCleanupAttempts; attempt += 1) {
          const closeExit = yield* Effect.exit(
            Effect.interruptible(Effect.suspend(() => owner.providerClose)).pipe(
              Effect.timeoutOrElse({
                duration: this.providerCleanupTimeoutMs,
                orElse: () => Effect.fail(new Error("Provider cleanup timed out")),
              }),
            ),
          )
          if (Exit.isSuccess(closeExit)) {
            owner.providerClosed = true
            break
          }
          lastCause = Cause.squash(closeExit.cause)
          if (attempt + 1 < this.providerCleanupAttempts) {
            yield* Effect.sleep(this.providerCleanupRetryDelayMs)
          }
        }
        if (!owner.providerClosed) {
          issues.push(this.issue(
            owner,
            "provider",
            `Unable to clean up provider resources for ${owner.sessionId}`,
            lastCause,
          ))
        }
      }

      if (owner.providerScopeCloseUncertain) {
        issues.push(this.issue(
          owner,
          "provider",
          `Provider scope cleanup remains uncertain for ${owner.sessionId}`,
          owner.providerScopeCloseCause,
        ))
      } else if (!owner.providerScopeClosed) {
        owner.transitionFiber?.interruptUnsafe()
        const scopeExit = yield* this.closeProviderScope(owner.providerScope)
        if (Exit.isFailure(scopeExit)) {
          owner.providerScopeCloseUncertain = true
          owner.providerScopeCloseCause = Cause.squash(scopeExit.cause)
          issues.push(this.issue(
            owner,
            "provider",
            `Provider scope cleanup is uncertain for ${owner.sessionId}`,
            owner.providerScopeCloseCause,
          ))
        } else {
          owner.providerScopeClosed = true
        }
      }
      return issues
    }.bind(this))
  }

  private releaseOwnerLease(owner: TerminalOwner): Effect.Effect<readonly TerminalCleanupIssue[]> {
    if (owner.leaseReleased) return Effect.succeed([])
    if (owner.pendingAdoptionToken !== undefined) {
      return Effect.succeed([this.issue(
        owner,
        "lease",
        `Cannot release ownership while identity journal ${owner.pendingAdoptionToken} is pending`,
      )])
    }
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const drainIssues = yield* this.drainOwnerPersistence(owner)
      if (drainIssues.length > 0) return drainIssues
      const exit = yield* Effect.exit(this.boundedPersistence(
        Effect.suspend(() => this.dependencies.ownership.release(owner.ownership, {
          mutationToken: owner.mutationTokens.release,
        })),
        "release terminal ownership",
        owner.sessionId,
        {
          ownerId: owner.ownerId,
          mutationToken: owner.mutationTokens.release,
          mutationStage: "release",
        },
      ))
      if (Exit.isSuccess(exit)) {
        owner.leaseReleased = true
        return []
      }
      return [this.issue(
        owner,
        "lease",
        `Unable to release session lease for ${owner.sessionId}`,
        Cause.squash(exit.cause),
      )]
    }.bind(this))
  }

  private rollbackBeforeOwner(
    ownerId: string,
    sessionId: string,
    ownership: PersistedTerminalOwner,
    providerScope: Scope.Closeable,
    mutationTokens: MutationTokens,
    acquired?: AcquiredTerminalLaunch,
    spawnFailure?: TerminalSpawnCleanupError,
    priorIssues: readonly TerminalCleanupIssue[] = [],
  ): Effect.Effect<readonly TerminalCleanupIssue[]> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const issues: TerminalCleanupIssue[] = [...priorIssues]
      let currentOwnership = ownership
      if (acquired) {
        const closeExit = yield* this.retryProviderClose(acquired.close)
        if (Exit.isFailure(closeExit)) {
          issues.push({
            ownerId,
            sessionId,
            stage: "provider",
            message: `Unable to roll back provider resources for ${sessionId}`,
            cause: Cause.squash(closeExit.cause),
          })
        }
      }
      const scopeExit = yield* this.closeProviderScope(providerScope)
      if (Exit.isFailure(scopeExit)) {
        issues.push({
          ownerId,
          sessionId,
          stage: "provider",
          message: `Unable to roll back provider scope for ${sessionId}`,
          cause: Cause.squash(scopeExit.cause),
        })
      }
      if (spawnFailure) {
        const updateExit = yield* Effect.exit(
          this.boundedPersistence(
            Effect.suspend(() =>
              this.dependencies.ownership.attach(ownership, spawnFailure.processGroupId, {
                mutationToken: mutationTokens.attach,
              })),
            "record unverified terminal process group",
            sessionId,
            { ownerId, mutationToken: mutationTokens.attach, mutationStage: "attach" },
          ),
        )
        issues.push({
          ownerId,
          sessionId,
          stage: "verify",
          message: `Unable to verify process group ${spawnFailure.processGroupId} exited`,
          cause: spawnFailure,
        })
        if (Exit.isFailure(updateExit)) {
          issues.push({
            ownerId,
            sessionId,
            stage: "lease",
            message: `Unable to record unverified process group ${spawnFailure.processGroupId}`,
            cause: Cause.squash(updateExit.cause),
          })
        } else {
          currentOwnership = updateExit.value
        }
      } else if (issues.length === 0) {
        issues.push(...yield* this.drainPersistence(ownerId, sessionId))
      }
      if (!spawnFailure && issues.length === 0) {
        const releaseExit = yield* Effect.exit(this.boundedPersistence(
          Effect.suspend(() => this.dependencies.ownership.release(ownership, {
            mutationToken: mutationTokens.release,
          })),
          "release rolled back terminal ownership",
          sessionId,
          { ownerId, mutationToken: mutationTokens.release, mutationStage: "release" },
        ))
        if (Exit.isFailure(releaseExit)) {
          issues.push({
            ownerId,
            sessionId,
            stage: "lease",
            message: `Unable to release session lease for ${sessionId}`,
            cause: Cause.squash(releaseExit.cause),
          })
        }
      }
      if (issues.length > 0) {
        const incompleteExit = yield* Effect.exit(this.boundedPersistence(
          Effect.suspend(() => this.dependencies.ownership.mark(
            currentOwnership,
            "cleanup-incomplete",
            {
              ...(spawnFailure === undefined ? {} : { processGroupId: spawnFailure.processGroupId }),
              mutationToken: mutationTokens.cleanupIncomplete,
            },
          )),
          "persist incomplete terminal rollback",
          sessionId,
          {
            ownerId,
            mutationToken: mutationTokens.cleanupIncomplete,
            mutationStage: "cleanup-incomplete",
          },
        ))
        if (Exit.isFailure(incompleteExit)) {
          issues.push({
            ownerId,
            sessionId,
            stage: "lease",
            message: `Unable to persist incomplete rollback ownership for ${sessionId}`,
            cause: Cause.squash(incompleteExit.cause),
          })
        }
      }
      return issues
    }.bind(this))
  }

  private retryProviderClose(
    close: AcquiredTerminalLaunch["close"],
  ): Effect.Effect<Exit.Exit<void, unknown>> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      let lastExit: Exit.Exit<void, unknown> = Exit.void
      for (let attempt = 0; attempt < this.providerCleanupAttempts; attempt += 1) {
        lastExit = yield* Effect.exit(
          Effect.interruptible(Effect.suspend(() => close)).pipe(
            Effect.timeoutOrElse({
              duration: this.providerCleanupTimeoutMs,
              orElse: () => Effect.fail(new Error("Provider cleanup timed out")),
            }),
          ),
        )
        if (Exit.isSuccess(lastExit)) return lastExit
        if (attempt + 1 < this.providerCleanupAttempts) {
          yield* Effect.sleep(this.providerCleanupRetryDelayMs)
        }
      }
      return lastExit
    }.bind(this))
  }

  private closeProviderScope(
    scope: Scope.Closeable,
  ): Effect.Effect<Exit.Exit<void, unknown>> {
    return Effect.exit(
      Effect.interruptible(Effect.suspend(() => Scope.close(scope, Exit.void))).pipe(
        Effect.timeoutOrElse({
          duration: this.providerCleanupTimeoutMs,
          orElse: () => Effect.fail(new Error("Provider scope cleanup timed out")),
        }),
      ),
    )
  }

  private closeRuntimeScope(): Effect.Effect<Exit.Exit<void, unknown>> {
    return Effect.exit(
      Effect.interruptible(Effect.suspend(() => Scope.close(this.runtimeScope, Exit.void))).pipe(
        Effect.timeoutOrElse({
          duration: this.providerCleanupTimeoutMs,
          orElse: () => Effect.fail(new Error("Terminal runtime scope cleanup timed out")),
        }),
      ),
    )
  }

  private performShutdown(gracePeriodMs: number): Effect.Effect<void, TerminalCleanupError> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const decisions = yield* this.gate.withPermit(Effect.sync(() => {
        this.shuttingDown = true
        this.ignoreCallback(this.unsubscribeSelection)
        const active = this.activeOwner()
        if (active) active.selectionClearPending = true
        this.activeOwnerId = null
        return [...this.owners.values()].map((owner): CleanupDecision =>
          owner.cleanupInProgress
            ? { _tag: "Wait", owner }
            : {
                _tag: "Start",
                plan: this.beginCleanup(owner, "shutdown", gracePeriodMs),
              }
        )
      }))
      this.reportHerdr("idle")

      const cleanupExits = yield* Effect.all(decisions.map((decision) =>
        Effect.exit(decision._tag === "Start"
          ? this.runCleanupPlan(decision.plan)
          : decision._tag === "Wait"
          ? Deferred.await(decision.owner.cleanupResult)
          : Effect.void)
      ), { concurrency: "unbounded" })
      const issues = cleanupExits.flatMap((exit) => Exit.isSuccess(exit)
        ? []
        : this.cleanupErrorFromCause("shutdown", Cause.squash(exit.cause)).issues)
      const pendingReservations = [...this.pendingReservations.values()]
      const reservationExits = yield* Effect.all(
        pendingReservations.map((pending) =>
          Effect.exit(this.reconcilePendingReservation(pending, true))),
        { concurrency: "unbounded" },
      )
      issues.push(...reservationExits.flatMap((exit, index) => {
        if (Exit.isSuccess(exit)) return []
        const pending = pendingReservations[index]
        if (pending === undefined) return []
        return [{
          ownerId: pending.ownerId,
          sessionId: pending.sessionId,
          stage: "lease" as const,
          message: `Late terminal reservation cleanup remains incomplete for ${pending.sessionId}`,
          cause: Cause.squash(exit.cause),
        }]
      }))

      const herdrFiber = yield* Effect.forkDetach(Effect.exit(this.herdr.shutdown), {
        startImmediately: true,
        uninterruptible: false,
      })
      yield* Effect.interruptible(Fiber.await(herdrFiber)).pipe(
        Effect.timeoutOrElse({
          duration: HERDR_SHUTDOWN_PERIOD_MS,
          orElse: () => Effect.sync(() => herdrFiber.interruptUnsafe()),
        }),
      )
      if (this.runtimeScopeCloseUncertain) {
        issues.push({
          ownerId: "terminal-supervisor",
          sessionId: "",
          stage: "runtime",
          message: "Terminal runtime scope cleanup remains uncertain",
          ...(this.runtimeScopeCloseCause === undefined
            ? {}
            : { cause: this.runtimeScopeCloseCause }),
        })
      } else if (!this.runtimeScopeClosed) {
        const runtimeScopeExit = yield* this.closeRuntimeScope()
        if (Exit.isSuccess(runtimeScopeExit)) {
          this.runtimeScopeClosed = true
        } else {
          this.runtimeScopeCloseUncertain = true
          this.runtimeScopeCloseCause = Cause.squash(runtimeScopeExit.cause)
          issues.push({
            ownerId: "terminal-supervisor",
            sessionId: "",
            stage: "runtime",
            message: "Terminal runtime scope cleanup is uncertain",
            cause: this.runtimeScopeCloseCause,
          })
        }
      }
      if (issues.length > 0) {
        return yield* Effect.fail(new TerminalCleanupError({ operation: "shutdown", issues }))
      }
    }.bind(this))
  }

  private activate(owner: TerminalOwner): Effect.Effect<void, TerminalError> {
    return this.attempt("focus", owner.sessionId, () => {
      const previous = this.activeOwner()
      this.dependencies.renderer.clearSelection()
      try {
        owner.surface.setActive(true)
        owner.surface.focus()
        if (previous && previous !== owner) {
          this.captureDraft(previous)
          previous.surface.blur()
          previous.surface.setActive(false)
        }
        this.activeOwnerId = owner.ownerId
        this.reportHerdr(owner.activity)
      } catch (cause) {
        this.ignoreCallback(() => owner.surface.blur())
        this.ignoreCallback(() => owner.surface.setActive(false))
        if (previous && previous !== owner) {
          this.ignoreCallback(() => previous.surface.setActive(true))
          this.ignoreCallback(() => previous.surface.focus())
          this.activeOwnerId = previous.ownerId
          this.reportHerdr(previous.activity)
        } else {
          this.activeOwnerId = previous?.ownerId ?? null
          if (!previous) this.reportHerdr("idle")
        }
        throw cause
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
    const issues: TerminalCleanupIssue[] = []
    const release = (message: string, run: () => void) => {
      try {
        run()
      } catch (cause) {
        issues.push(this.issue(owner, "ui", message, cause))
      }
    }
    if (this.activeOwnerId === owner.ownerId) {
      this.activeOwnerId = null
      owner.selectionClearPending = true
      this.reportHerdr("idle")
    }
    if (owner.selectionClearPending) {
      release("Unable to clear terminal selection", () => {
        this.dependencies.renderer.clearSelection()
        owner.selectionClearPending = false
      })
    }
    this.captureDraft(owner)
    if (!owner.uiReleased) {
      release(`Unable to release terminal surface for ${owner.sessionId}`, () => {
        owner.surface.release()
        owner.uiReleased = true
      })
    }
    return issues
  }

  private closePty(owner: TerminalOwner): readonly TerminalCleanupIssue[] {
    if (owner.ptyClosed) return []
    try {
      owner.process.closePty()
      owner.ptyClosed = true
      return []
    } catch (cause) {
      return [this.issue(owner, "pty", `Unable to close PTY for ${owner.sessionId}`, cause)]
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

  private unref(owner: TerminalOwner): readonly TerminalCleanupIssue[] {
    if (owner.processDetached) return []
    try {
      owner.process.unref()
      owner.processDetached = true
      return []
    } catch (cause) {
      return [this.issue(owner, "pty", `Unable to detach process ${owner.process.pid}`, cause)]
    }
  }

  private processIssue(
    owner: TerminalOwner,
    issue: ProcessGroupCleanupIssue,
  ): TerminalCleanupIssue {
    return this.issue(owner, issue.stage, issue.message, issue.cause)
  }

  private commitIdentity(
    owner: TerminalOwner,
    previousSessionId: string,
    sessionId: string,
    ownership: PersistedTerminalOwner,
  ): void {
    const entry = this.ledger.get(previousSessionId) ?? this.ledger.get(sessionId)
    for (const [key, candidate] of this.ledger) {
      if (candidate.ownerId === owner.ownerId) this.ledger.delete(key)
    }
    owner.ownership = ownership
    owner.sessionId = sessionId
    if (entry) this.ledger.set(sessionId, entry)
  }

  private reserveAlias(owner: TerminalOwner, sessionId: string): void {
    const entry = this.ledger.get(owner.sessionId)
    if (entry) this.ledger.set(sessionId, entry)
  }

  private setOwnerState(owner: TerminalOwner, state: TerminalOwnerState): void {
    for (const entry of this.ledger.values()) {
      if (entry.ownerId === owner.ownerId) entry.state = state
    }
  }

  private deleteOwner(owner: TerminalOwner): void {
    for (const [sessionId, entry] of this.ledger) {
      if (entry.ownerId === owner.ownerId) this.ledger.delete(sessionId)
    }
    this.owners.delete(owner.ownerId)
    owner.cleanupInProgress = false
    owner.semanticFiber?.interruptUnsafe()
    owner.transitionFiber?.interruptUnsafe()
    this.clearPersistenceOwner(owner.ownerId)
  }

  private clearPersistenceOwner(ownerId: string): void {
    for (const [mutationToken, tracked] of this.persistenceMutations) {
      if (tracked.ownerId === ownerId && tracked.exit !== undefined) {
        this.persistenceMutations.delete(mutationToken)
      }
    }
  }

  private ownerForSession(sessionId: string): TerminalOwner | undefined {
    const entry = this.ledger.get(sessionId)
    return entry ? this.owners.get(entry.ownerId) : undefined
  }

  private activeOwner(): TerminalOwner | undefined {
    return this.activeOwnerId ? this.owners.get(this.activeOwnerId) : undefined
  }

  private sessionIdSet(
    predicate: (entry: LedgerEntry, owner: TerminalOwner, sessionId: string) => boolean,
  ): Effect.Effect<ReadonlySet<string>> {
    return Effect.sync(() => {
      const sessionIds = new Set<string>()
      for (const [sessionId, entry] of this.ledger) {
        const owner = this.owners.get(entry.ownerId)
        if (owner && predicate(entry, owner, sessionId)) sessionIds.add(sessionId)
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

  private reserveOwnership(
    ownerId: string,
    sessionId: string,
    reserveMutationToken: string,
    releaseMutationToken: string,
  ): Effect.Effect<
    PersistedTerminalOwner,
    PersistenceError | SessionOwnedError | SessionRemovedError
  > {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const tracked = yield* this.trackPersistence(
        Effect.suspend(() => this.dependencies.ownership.reserve(sessionId, {
          mutationToken: reserveMutationToken,
        })),
        "reserve terminal ownership",
        sessionId,
        { ownerId, mutationToken: reserveMutationToken, mutationStage: "reserve" },
      )
      const exit = yield* Effect.exit(this.awaitPersistence<
        PersistedTerminalOwner,
        PersistenceError | SessionOwnedError | SessionRemovedError
      >(tracked))
      if (Exit.isSuccess(exit)) return exit.value
      if (!tracked.observedByCaller) {
        const pending: PendingReservation = {
          ownerId,
          sessionId,
          releaseMutationToken,
          reserve: tracked,
        }
        this.pendingReservations.set(sessionId, pending)
        yield* Effect.forkDetach(this.observePendingReservation(pending), {
          startImmediately: true,
          uninterruptible: false,
        })
      }
      return yield* Effect.failCause(exit.cause)
    }.bind(this))
  }

  private observePendingReservation(pending: PendingReservation): Effect.Effect<void> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const reserveExit = pending.reserve.exit ?? (yield* Fiber.await(pending.reserve.fiber))
      if (Exit.isFailure(reserveExit)) {
        this.deletePendingReservation(pending)
        return
      }
      pending.ownership = reserveExit.value as PersistedTerminalOwner
      const release = yield* this.pendingReservationRelease(pending, false)
      const boundedExit = yield* Effect.exit(this.awaitPersistence<void>(release))
      if (Exit.isFailure(boundedExit) && !release.observedByCaller) {
        this.reportPendingReservationIssue(
          pending,
          `Compensating ownership release timed out for ${pending.sessionId}`,
          Cause.squash(boundedExit.cause),
          release,
        )
      }
      const releaseExit = release.exit ?? (yield* Fiber.await(release.fiber))
      if (Exit.isSuccess(releaseExit)) {
        this.deletePendingReservation(pending)
      } else {
        this.reportPendingReservationIssue(
          pending,
          `Unable to compensate late terminal reservation for ${pending.sessionId}`,
          Cause.squash(releaseExit.cause),
          release,
        )
      }
    }.bind(this)).pipe(Effect.catchCause(() => Effect.void))
  }

  private reconcilePendingReservation(
    pending: PendingReservation,
    retryFailedRelease: boolean,
  ): Effect.Effect<void, PersistenceError> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const reserveExit = yield* Effect.exit(
        this.awaitPersistence<
          PersistedTerminalOwner,
          PersistenceError | SessionOwnedError | SessionRemovedError
        >(pending.reserve),
      )
      if (Exit.isFailure(reserveExit)) {
        if (pending.reserve.exit !== undefined) {
          this.deletePendingReservation(pending)
          return
        }
        return yield* Effect.failCause(reserveExit.cause as Cause.Cause<PersistenceError>)
      }
      pending.ownership = reserveExit.value
      const release = yield* this.pendingReservationRelease(pending, retryFailedRelease)
      const releaseExit = yield* Effect.exit(this.awaitPersistence<void, PersistenceError>(release))
      if (Exit.isFailure(releaseExit)) return yield* Effect.failCause(releaseExit.cause)
      this.deletePendingReservation(pending)
    }.bind(this))
  }

  private pendingReservationRelease(
    pending: PendingReservation,
    retryFailed: boolean,
  ): Effect.Effect<TrackedPersistence> {
    const existing = pending.release
    if (
      existing !== undefined &&
      (!retryFailed || existing.exit === undefined || Exit.isSuccess(existing.exit))
    ) return Effect.succeed(existing)
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const ownership = pending.ownership
      if (ownership === undefined) {
        return yield* Effect.die(new Error("Cannot compensate an unresolved terminal reservation"))
      }
      const release = yield* this.trackPersistence(
        Effect.suspend(() => this.dependencies.ownership.release(ownership, {
          mutationToken: pending.releaseMutationToken,
        })),
        "compensate late terminal reservation",
        pending.sessionId,
        {
          ownerId: pending.ownerId,
          mutationToken: pending.releaseMutationToken,
          mutationStage: "release",
        },
      )
      pending.release = release
      return release
    }.bind(this))
  }

  private deletePendingReservation(pending: PendingReservation): void {
    if (this.pendingReservations.get(pending.sessionId) !== pending) return
    this.pendingReservations.delete(pending.sessionId)
    this.clearPersistenceOwner(pending.ownerId)
  }

  private reportPendingReservationIssue(
    pending: PendingReservation,
    message: string,
    cause: unknown,
    tracked: TrackedPersistence,
  ): void {
    if (tracked.reported) return
    tracked.reported = true
    this.reportCleanupError(new TerminalCleanupError({
      operation: "acquire-rollback",
      issues: [{
        ownerId: pending.ownerId,
        sessionId: pending.sessionId,
        stage: "lease",
        message,
        cause,
      }],
    }))
  }

  private drainOwnerPersistence(owner: TerminalOwner): Effect.Effect<readonly TerminalCleanupIssue[]> {
    return this.drainPersistence(owner.ownerId, owner.sessionId).pipe(
      Effect.map((issues) => issues.map((issue) => this.issue(
        owner,
        "lease",
        issue.message,
        issue.cause,
      ))),
    )
  }

  private drainPersistence(
    ownerId: string,
    sessionId: string,
  ): Effect.Effect<readonly TerminalCleanupIssue[]> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const pending = [...this.persistenceFibers].filter((tracked) => tracked.ownerId === ownerId)
      if (pending.length === 0) return []
      yield* Effect.interruptible(Effect.all(
        pending.map((tracked) => Fiber.await(tracked.fiber)),
        { concurrency: "unbounded" },
      )).pipe(Effect.timeoutOrElse({
        duration: this.persistenceTimeoutMs,
        orElse: () => Effect.void,
      }))
      const unresolved = [...this.persistenceFibers].filter((tracked) => tracked.ownerId === ownerId)
      if (unresolved.length === 0) return []
      return [{
        ownerId,
        sessionId,
        stage: "lease" as const,
        message: `Persistence cleanup remains unresolved for ${sessionId}: ${unresolved.map((tracked) =>
          tracked.operation).join(", ")}`,
      }]
    }.bind(this))
  }

  private boundedPersistence<A, E>(
    effect: Effect.Effect<A, E>,
    operation: string,
    sessionId: string,
    tracking: PersistenceTracking = {},
  ): Effect.Effect<A, E | PersistenceError> {
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const tracked = yield* this.trackPersistence(effect, operation, sessionId, tracking)
      return yield* this.awaitPersistence<A, E>(tracked)
    }.bind(this))
  }

  private trackPersistence<A, E>(
    effect: Effect.Effect<A, E>,
    operation: string,
    sessionId: string,
    tracking: PersistenceTracking,
  ): Effect.Effect<TrackedPersistence> {
    const mutationKey = tracking.mutationToken === undefined
      ? undefined
      : `${tracking.mutationStage ?? operation}:${tracking.mutationToken}`
    const existing = mutationKey === undefined
      ? undefined
      : this.persistenceMutations.get(mutationKey)
    if (existing !== undefined && (existing.exit === undefined || Exit.isSuccess(existing.exit))) {
      return Effect.succeed(existing)
    }
    return Effect.gen(function* (this: TerminalSupervisorImpl) {
      const fiber = yield* Effect.forkDetach(effect, {
        startImmediately: true,
        uninterruptible: false,
      })
      const tracked: TrackedPersistence = {
        fiber: fiber as Fiber.Fiber<unknown, unknown>,
        operation,
        sessionId,
        ...tracking,
        ...(mutationKey === undefined ? {} : { mutationKey }),
        abandoned: false,
        observedByCaller: false,
        reported: false,
      }
      this.persistenceFibers.add(tracked)
      if (mutationKey !== undefined) {
        this.persistenceMutations.set(mutationKey, tracked)
      }
      fiber.addObserver((exit) => {
        tracked.exit = exit as Exit.Exit<unknown, unknown>
        this.persistenceFibers.delete(tracked)
        if (
          Exit.isFailure(exit) &&
          tracked.mutationKey !== undefined &&
          this.persistenceMutations.get(tracked.mutationKey) === tracked
        ) this.persistenceMutations.delete(tracked.mutationKey)
        this.reportAbandonedPersistenceFailure(tracked)
      })
      return tracked
    }.bind(this))
  }

  private awaitPersistence<A, E = unknown>(
    tracked: TrackedPersistence,
  ): Effect.Effect<A, E | PersistenceError> {
    const awaited = tracked.exit === undefined
      ? Effect.interruptible(Fiber.await(tracked.fiber)).pipe(
        Effect.map((exit) => ({ _tag: "Completed" as const, exit })),
        Effect.timeoutOrElse({
          duration: this.persistenceTimeoutMs,
          orElse: () => Effect.succeed({ _tag: "TimedOut" as const }),
        }),
      )
      : Effect.succeed({ _tag: "Completed" as const, exit: tracked.exit })
    return Effect.gen(function*() {
        const result = yield* awaited
        if (result._tag === "TimedOut") {
          return yield* Effect.fail(new PersistenceError({
            operation: tracked.operation,
            path: tracked.sessionId,
            message: `${tracked.operation} timed out for ${tracked.sessionId}`,
          }))
        }
        tracked.observedByCaller = true
        if (Exit.isFailure(result.exit)) {
          return yield* Effect.failCause(result.exit.cause as Cause.Cause<E>)
        }
        return result.exit.value as A
      }).pipe(Effect.onExit((exit) => Effect.sync(() => {
        if (Exit.isFailure(exit) && !tracked.observedByCaller) {
          tracked.abandoned = true
          this.reportAbandonedPersistenceFailure(tracked)
        }
      })))
  }

  private reportAbandonedPersistenceFailure(tracked: TrackedPersistence): void {
    if (
      tracked.reported ||
      !tracked.abandoned ||
      tracked.exit === undefined ||
      Exit.isSuccess(tracked.exit) ||
      Cause.hasInterruptsOnly(tracked.exit.cause)
    ) return
    tracked.reported = true
    this.reportCleanupError(new TerminalCleanupError({
      operation: "shutdown",
      issues: [{
        ownerId: "terminal-supervisor",
        sessionId: tracked.sessionId,
        stage: "lease",
        message: `${tracked.operation} failed after its caller stopped waiting`,
        cause: Cause.squash(tracked.exit.cause),
      }],
    }))
  }

  private acceptsTerminalData(owner: TerminalOwner): boolean {
    if (owner.uiReleased || owner.cleanupStarted) return false
    const entry = this.ledger.get(owner.sessionId)
    return entry === undefined || (entry.ownerId === owner.ownerId && entry.state === "running")
  }

  private isRunningOwner(owner: TerminalOwner): boolean {
    const entry = this.ledger.get(owner.sessionId)
    return this.owners.get(owner.ownerId) === owner &&
      entry?.ownerId === owner.ownerId &&
      entry.state === "running"
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

  private transitionErrorFromCause(
    sessionId: string,
    cause: Cause.Cause<unknown>,
  ): TerminalSessionTransitionErrorEvent["error"] {
    const error = Cause.squash(cause)
    if (error instanceof TerminalError || error instanceof ProviderProtocolError) return error
    if (!cause.reasons.some(Cause.isDieReason) && isTerminalTransitionError(error)) return error
    return new TerminalError({
      operation: "native-session-transition",
      sessionId,
      message: `Unexpected terminal session transition failure for ${sessionId}`,
      cause: error,
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

function isTerminalTransitionError(
  error: unknown,
): error is TerminalSessionTransitionErrorEvent["error"] {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false
  return [
    "TerminalError",
    "ProviderError",
    "ProviderProtocolError",
    "PersistenceError",
    "SessionOwnedError",
    "SessionRemovedError",
  ].includes(String(error._tag))
}

function terminalSpawnCleanupError(error: unknown): TerminalSpawnCleanupError | undefined {
  if (error instanceof TerminalSpawnCleanupError) return error
  if (error instanceof TerminalError) return terminalSpawnCleanupError(error.cause)
  if (error instanceof TerminalCleanupError) {
    for (const issue of error.issues) {
      const spawnFailure = terminalSpawnCleanupError(issue.cause)
      if (spawnFailure) return spawnFailure
    }
  }
  return undefined
}

function validateBranchDerivation(
  derivation: BranchDerivation,
  previousSessionId: string,
  sessionId: string,
  kind: IdentityTransitionKind,
): void {
  if (derivation.childSessionId !== sessionId) {
    throw new Error("Provider returned branch metadata for a different child session")
  }
  if (kind === "native-fork" && derivation.parentSessionId !== previousSessionId) {
    throw new Error("Native fork metadata does not preserve the source session")
  }
  for (const [label, value] of [
    ["child session ID", derivation.childSessionId],
    ["parent session ID", derivation.parentSessionId],
    ["source message ID", derivation.sourceMessageId],
  ] as const) {
    if (value.length === 0) throw new Error(`Branch ${label} cannot be empty`)
  }
  if (derivation.childSessionId === derivation.parentSessionId) {
    throw new Error("A branch session cannot be its own parent")
  }
  const parentIds = derivation.sharedMessages.map((mapping) => mapping.parentMessageId)
  const childIds = derivation.sharedMessages.map((mapping) => mapping.childMessageId)
  if (parentIds.some((id) => id.length === 0) || childIds.some((id) => id.length === 0)) {
    throw new Error("Shared message IDs cannot be empty")
  }
  if (new Set(parentIds).size !== parentIds.length || new Set(childIds).size !== childIds.length) {
    throw new Error("Shared message mappings must be unique")
  }
}
