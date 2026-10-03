import { Cause, Clock, Context, Data, Deferred, Effect, Exit, Fiber, Layer, PubSub, Queue, Scope, Semaphore } from "effect"
import { Osc52Forwarder } from "../clipboard"
import { describeError, errorDetails, type ErrorDescription } from "../error-format"
import type { AgentActivity, BranchDerivation, DraftPreview, TerminalObservation } from "../domain/model"
import type { BranchRelation, IdentityTransitionKind } from "../domain/persistence"
import { PersistenceError, ProviderProtocolError, SessionOwnedError, SessionRemovedError, TerminalError, type ProviderError } from "../domain/errors"
import { cleanupProcessGroup } from "../infrastructure/process-group"
import type { SessionClaim, SessionGuard } from "../infrastructure/session-guard"
import type { TerminalProcess, TerminalProcessFactory, TerminalRenderer, TerminalSurface } from "../infrastructure/terminal"
import type { AcquiredTerminalLaunch, PreparedTerminal, TerminalLaunch, TerminalTransitionRequest, ProviderTerminalEvent } from "./provider"
import type { ProviderStateRepositoryApi } from "./provider-state-repository"
import { makeKeyedSerialExecutor, type KeyedSerialExecutor } from "./keyed-serial-executor"
import { PROVIDER_SUPERVISOR_CLEANUP_TIMEOUT_MS } from "./lifecycle-policy"
import { optionalOperationTimeout, withOperationTimeout } from "./operation-deadline"

const GRACE_PERIOD_MS = 200
const KILL_PERIOD_MS = 200
const ACTIVITY_PROBE_INTERVAL_MS = 2_000
const ACTIVITY_CONFIRMATION_DELAY_MS = 100
const PTY_DRAIN_PERIOD_MS = 250

export type TerminalOwnerState = "running" | "stopping" | "cleanup-incomplete"
export interface TerminalCleanupIssue {
  readonly ownerId: string
  readonly sessionId: string
  readonly stage: "term" | "wait" | "kill" | "verify" | "provider" | "runtime" | "guard" | "pty" | "ui"
  readonly message: string
  readonly cause?: unknown
}
export class TerminalCleanupError extends Data.TaggedError("TerminalCleanupError")<{
  readonly operation: "stop" | "shutdown" | "natural-exit" | "acquire-rollback"
  readonly issues: readonly TerminalCleanupIssue[]
  readonly ownershipReleased?: true
}> {
  override get message(): string { return errorDetails(this) }
  [describeError](): ErrorDescription {
    return { message: `Terminal ${this.operation} cleanup failed${this.issues.length ? ":" : " (no issue details available)"}`, children: this.issues.map((issue) => ({
      label: `${issue.sessionId ? `session ${issue.sessionId}` : issue.ownerId} [${issue.stage}]`, error: { message: issue.message, cause: issue.cause },
    })) }
  }
}
interface SequencedTerminalEvent { readonly ownerId: string; readonly sequenceId: number }
export interface TerminalExitEvent extends SequencedTerminalEvent {
  readonly sessionId: string; readonly exitCode: number; readonly wasActive: boolean
  readonly draftPreview?: DraftPreview; readonly outputTail?: string
  readonly cleanupError?: TerminalCleanupError; readonly ownershipReleased?: true
}
export interface TerminalActivityEvent extends SequencedTerminalEvent {
  readonly sessionId: string; readonly activity: AgentActivity; readonly wasActive: boolean
}
export interface TerminalObservationEvent extends SequencedTerminalEvent {
  readonly sessionId: string; readonly wasActive: boolean; readonly observation: TerminalObservation
}
export interface TerminalSessionChangedEvent extends SequencedTerminalEvent {
  readonly previousSessionId: string
  readonly kind: IdentityTransitionKind
  readonly session: PreparedTerminal["session"]
  readonly wasActive: boolean
  readonly adoptionToken: string
  readonly relation?: BranchRelation
  readonly acknowledgment?: Deferred.Deferred<void, unknown>
  readonly derivation?: Effect.Effect<BranchDerivation | undefined, ProviderError | ProviderProtocolError>
}
export interface TerminalSessionTransitionErrorEvent extends SequencedTerminalEvent {
  readonly sessionId: string
  readonly error: TerminalError | ProviderError | ProviderProtocolError | PersistenceError | SessionOwnedError | SessionRemovedError
  readonly wasActive: boolean
}
export interface TerminalSupervisorEvents {
  readonly onObservation?: (event: TerminalObservationEvent) => void
  readonly onProcessExited?: (event: TerminalExitEvent) => void
  readonly onActivityChanged?: (event: TerminalActivityEvent) => void
  readonly onSessionChanged?: (event: TerminalSessionChangedEvent) => void
  readonly onSessionTransitionError?: (event: TerminalSessionTransitionErrorEvent) => void
  readonly onCleanupError?: (error: TerminalCleanupError) => void
}
export interface TerminalSupervisorDependencies {
  readonly renderer: TerminalRenderer
  readonly processes: TerminalProcessFactory
  readonly guard: SessionGuard
  readonly metadata: Pick<ProviderStateRepositoryApi, "replaceIdentity">
  readonly events?: TerminalSupervisorEvents
  readonly gracePeriodMs?: number
  readonly killPeriodMs?: number
  readonly providerCleanupTimeoutMs?: number
  readonly transitionDerivationTimeoutMs?: number
  readonly applicationAcknowledgmentTimeoutMs?: number
  readonly acquisitionTimeoutMs?: number
}
export interface TerminalOwnershipSnapshot {
  readonly ownerId: string; readonly sessionId: string; readonly processGroupId: number
  readonly state: TerminalOwnerState; readonly active: boolean; readonly activity: AgentActivity; readonly exitCode: number | null
}
export interface TerminalActivityCheck {
  readonly ownerId: string; readonly sessionId: string; readonly sequenceId: number
  readonly activity?: AgentActivity; readonly issue?: "unrecognized-screen" | "observer-failed"
}
export interface TerminalSupervisorApi {
  readonly show: (prepared: PreparedTerminal) => Effect.Effect<string, ProviderError | ProviderProtocolError | PersistenceError | SessionOwnedError | SessionRemovedError | TerminalError | TerminalCleanupError>
  readonly hideActive: Effect.Effect<string | null>
  readonly stopSession: (sessionId: string, gracePeriodMs?: number, expectedOwnerId?: string) => Effect.Effect<boolean, TerminalCleanupError>
  readonly shutdown: (gracePeriodMs?: number) => Effect.Effect<void, TerminalCleanupError>
  readonly activeSessionId: Effect.Effect<string | null>
  readonly ownsInput: Effect.Effect<boolean>
  readonly runningSessionIds: Effect.Effect<ReadonlySet<string>>
  readonly ownedSessionIds: Effect.Effect<ReadonlySet<string>>
  readonly nonIdleSessionIds: Effect.Effect<ReadonlySet<string>>
  readonly activitySessionIds: (activity: AgentActivity) => Effect.Effect<ReadonlySet<string>>
  readonly draftPreviews: Effect.Effect<ReadonlyMap<string, DraftPreview>>
  readonly ownershipSnapshot: Effect.Effect<readonly TerminalOwnershipSnapshot[]>
  readonly reconcileActivity: Effect.Effect<readonly TerminalActivityCheck[]>
}
export class TerminalSupervisor extends Context.Service<TerminalSupervisor, TerminalSupervisorApi>()("claude-tree/TerminalSupervisor") {}

export const makeTerminalSupervisor = (dependencies: TerminalSupervisorDependencies): Effect.Effect<TerminalSupervisorApi, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.gen(function*() {
    const launches = yield* makeKeyedSerialExecutor<string>()
    return new TerminalSupervisorImpl(dependencies, launches)
  }), (supervisor) => supervisor.shutdown().pipe(Effect.catch((error) => Effect.sync(() => supervisor.reportCleanupError(error)))))
export const terminalSupervisorLayer = (dependencies: TerminalSupervisorDependencies): Layer.Layer<TerminalSupervisor> =>
  Layer.effect(TerminalSupervisor, makeTerminalSupervisor(dependencies))

type SemanticEvent =
  | { readonly _tag: "Observation"; readonly observation: TerminalObservation; readonly sequenceId: number }
  | { readonly _tag: "Activity"; readonly activity: AgentActivity; readonly sequenceId: number; readonly provider?: true }
  | { readonly _tag: "Provider"; readonly event: ProviderTerminalEvent; readonly sequenceId: number }
  | { readonly _tag: "Exited"; readonly exitCode: number; readonly sequenceId: number }
  | { readonly _tag: "Transition"; readonly request: TerminalTransitionRequest; readonly sequenceId: number }
type UnsequencedEvent = SemanticEvent extends infer Event ? Event extends SemanticEvent ? Omit<Event, "sequenceId"> : never : never
interface PendingLaunch { readonly ownerId: string; readonly done: Deferred.Deferred<void>; readonly cancelled: Deferred.Deferred<void> }
interface TerminalOwner {
  readonly ownerId: string
  sessionId: string
  state: TerminalOwnerState
  readonly scope: Scope.Closeable
  readonly close: AcquiredTerminalLaunch["close"]
  claim: SessionClaim
  readonly claims: Set<SessionClaim>
  readonly process: TerminalProcess
  readonly surface: TerminalSurface
  readonly observer: TerminalLaunch["observer"]
  readonly failureDetails?: TerminalLaunch["failureDetails"]
  readonly queue: Queue.Queue<SemanticEvent>
  readonly ready: Deferred.Deferred<void>
  readonly cancelled: Deferred.Deferred<void>
  readonly gate: Semaphore.Semaphore
  readonly probeGate: Semaphore.Semaphore
  readonly pendingTransitions: Set<TerminalTransitionRequest>
  readonly fibers: Fiber.Fiber<void, never>[]
  sequence: number
  activity: AgentActivity
  lastQueuedActivity: AgentActivity
  providerActivity?: AgentActivity | undefined
  draft?: DraftPreview
  draftKey?: string
  inputObserved: boolean
  transient: boolean
  transitioning: boolean
  exitCode: number | null
  cleanup?: Deferred.Deferred<void, TerminalCleanupError>
  uiReleased: boolean
  providerClosed: boolean
  scopeClosed: boolean
  ptyClosed: boolean
  detached: boolean
  claimReleased: boolean
  exitNotified: boolean
}

class TerminalSupervisorImpl implements TerminalSupervisorApi {
  private readonly owners = new Map<string, TerminalOwner>()
  private readonly launches = new Map<string, PendingLaunch>()
  private readonly gate = Semaphore.makeUnsafe(1)
  private readonly scope = Scope.makeUnsafe("parallel")
  private readonly stopping = Deferred.makeUnsafe<void>()
  private readonly events: TerminalSupervisorEvents
  private readonly unsubscribe: () => void
  private active: TerminalOwner | undefined
  private shuttingDown = false
  private nextOwner = 1
  private shutdownResult: Deferred.Deferred<void, TerminalCleanupError> | undefined
  private readonly graceMs: number
  private readonly killMs: number
  private readonly closeMs: number

  constructor(private readonly dependencies: TerminalSupervisorDependencies, private readonly executor: KeyedSerialExecutor<string>) {
    this.events = dependencies.events ?? {}
    this.graceMs = dependencies.gracePeriodMs ?? GRACE_PERIOD_MS
    this.killMs = dependencies.killPeriodMs ?? KILL_PERIOD_MS
    this.closeMs = dependencies.providerCleanupTimeoutMs ?? PROVIDER_SUPERVISOR_CLEANUP_TIMEOUT_MS
    optionalOperationTimeout(dependencies.acquisitionTimeoutMs)
    optionalOperationTimeout(dependencies.transitionDerivationTimeoutMs)
    optionalOperationTimeout(dependencies.applicationAcknowledgmentTimeoutMs)
    this.unsubscribe = dependencies.renderer.onSelection((surface, text) => {
      if (this.active?.surface === surface) this.ignore(() => dependencies.renderer.copyToClipboard(text))
    })
  }

  readonly show: TerminalSupervisorApi["show"] = (prepared) => this.executor.withLock(prepared.session.id,
    Effect.acquireUseRelease(Effect.sync(() => {
      const launch = { ownerId: `terminal-owner-${this.nextOwner++}`, done: Deferred.makeUnsafe<void>(), cancelled: Deferred.makeUnsafe<void>() }
      this.launches.set(prepared.session.id, launch)
      return launch
    }), (pending) => Effect.uninterruptibleMask((restore) => Effect.gen({ self: this }, function*() {
      if (this.shuttingDown) return yield* Effect.fail(this.error("show", prepared.session.id, "Cannot open a session during shutdown"))
      const existing = this.owners.get(prepared.session.id)
      if (existing) {
        if (existing.state !== "running" || existing.transitioning) return yield* Effect.fail(this.error("show", existing.sessionId, "Session is stopping or switching identity"))
        yield* this.gate.withPermit(this.activate(existing))
        return existing.ownerId
      }
      const claim = yield* restore(this.untilCancelled(this.dependencies.guard.acquire(prepared.session.id, prepared.allowDuplicate), pending.cancelled))
      const scope = yield* Scope.make("sequential")
      let acquired: AcquiredTerminalLaunch | undefined
      let owner: TerminalOwner | undefined
      const opened = yield* Effect.exit(Effect.gen({ self: this }, function*() {
        acquired = yield* restore(this.untilCancelled(Scope.provide(withOperationTimeout(prepared.acquireLaunch, this.dependencies.acquisitionTimeoutMs,
          () => Effect.fail(this.error("acquire", prepared.session.id, "Provider acquisition timed out"))), scope), pending.cancelled))
        if (acquired.launch.sessionId !== prepared.session.id) return yield* Effect.fail(this.error("acquire", prepared.session.id, "Provider acquired a different session"))
        if (this.shuttingDown || (yield* Deferred.isDone(pending.cancelled))) return yield* Effect.fail(this.error("acquire", prepared.session.id, "Launch cancelled"))
        const transitions = acquired.launch.transitions ? yield* Scope.provide(PubSub.subscribe(acquired.launch.transitions), scope) : undefined
        const hints = acquired.launch.activityHints ? yield* Scope.provide(PubSub.subscribe(acquired.launch.activityHints), scope) : undefined
        const providerEvents = acquired.launch.providerEvents ? yield* Scope.provide(PubSub.subscribe(acquired.launch.providerEvents), scope) : undefined
        owner = yield* this.createOwner(pending.ownerId, acquired, scope, claim, prepared.session.transient === true)
        this.owners.set(owner.sessionId, owner)
        const current = owner
        void current.process.exited.then((exitCode) => {
          Deferred.doneUnsafe(current.cancelled, Effect.void)
          this.offer(current, { _tag: "Exited", exitCode })
        })
        current.fibers.push(yield* Effect.forkIn(Deferred.await(current.ready).pipe(Effect.andThen(this.semanticLoop(current))), this.scope))
        current.fibers.push(yield* Effect.forkIn(Effect.forever(Effect.sleep(ACTIVITY_PROBE_INTERVAL_MS).pipe(
          Effect.andThen(Effect.suspend(() => current.lastQueuedActivity === "idle" ? Effect.void : this.probe(current).pipe(Effect.asVoid))))), this.scope))
        if (transitions) current.fibers.push(yield* Effect.forkIn(Effect.forever(PubSub.take(transitions).pipe(Effect.andThen((request) => Effect.sync(() => {
          current.pendingTransitions.add(request)
          this.offer(current, { _tag: "Transition", request })
        })))), this.scope))
        if (hints) current.fibers.push(yield* Effect.forkIn(Effect.forever(PubSub.take(hints).pipe(Effect.andThen(this.probe(current)), Effect.asVoid)), this.scope))
        if (providerEvents) current.fibers.push(yield* Effect.forkIn(Effect.forever(PubSub.take(providerEvents).pipe(Effect.andThen((event) => Effect.sync(() => {
          this.offer(current, { _tag: "Provider", event })
        })))), this.scope))
        yield* this.gate.withPermit(Effect.suspend(() => this.shuttingDown || current.state !== "running" || current.process.exitCode !== null || Deferred.isDoneUnsafe(pending.cancelled)
          ? Effect.fail(this.error("activate", current.sessionId, "Terminal stopped before activation")) : this.activate(current)))
        Deferred.doneUnsafe(current.ready, Effect.void)
        return current.ownerId
      }))
      if (Exit.isSuccess(opened)) return opened.value
      if (owner) {
        const failureOutput = this.failureOutput(owner)
        yield* this.cleanup(owner, "acquire-rollback", this.graceMs)
        const cause = Cause.squash(opened.cause)
        if (failureOutput && owner.process.exitCode !== null && owner.process.exitCode !== 0) return yield* Effect.fail(this.error("acquire", owner.sessionId, `Agent exited with code ${owner.process.exitCode}\n\n${failureOutput}`, cause))
      } else {
        const issues: TerminalCleanupIssue[] = []
        for (const [stage, effect] of [["provider", acquired?.close ?? Effect.void], ["provider", Scope.close(scope, Exit.void)], ["guard", claim.release]] as const) {
          const exit = yield* Effect.exit(this.bounded(effect as Effect.Effect<void, unknown>))
          if (Exit.isFailure(exit)) issues.push({ ownerId: pending.ownerId, sessionId: prepared.session.id, stage, message: "Launch rollback failed", cause: Cause.squash(exit.cause) })
        }
        if (issues.length) return yield* Effect.fail(new TerminalCleanupError({ operation: "acquire-rollback", issues }))
      }
      return yield* Effect.failCause(opened.cause)
    })), (pending) => Effect.sync(() => {
      if (this.launches.get(prepared.session.id) === pending) this.launches.delete(prepared.session.id)
      Deferred.doneUnsafe(pending.done, Effect.void)
    })))

  readonly hideActive = this.gate.withPermit(Effect.sync(() => {
    const active = this.active
    this.active = undefined
    this.ignore(() => this.dependencies.renderer.clearSelection())
    if (active) {
      this.captureDraft(active)
      this.ignore(() => active.surface.blur())
      this.ignore(() => active.surface.setActive(false))
    }
    return active?.sessionId ?? null
  }))
  readonly activeSessionId = Effect.sync(() => this.active?.sessionId ?? null)
  readonly ownsInput = Effect.sync(() => this.active !== undefined)
  readonly runningSessionIds = this.sessionIds((owner) => owner.state === "running" && owner.exitCode === null)
  readonly ownedSessionIds = Effect.sync(() => new Set([...this.owners.keys(), ...this.launches.keys()]))
  readonly nonIdleSessionIds = this.sessionIds((owner) => owner.state === "running" && owner.exitCode === null && owner.activity !== "idle")
  readonly activitySessionIds = (activity: AgentActivity) => this.sessionIds((owner) => owner.state === "running" && owner.exitCode === null && owner.activity === activity)
  readonly draftPreviews = Effect.sync(() => new Map([...new Set(this.owners.values())].flatMap((owner) =>
    owner.state === "running" && owner.draft ? [[owner.sessionId, owner.draft] as const] : [])))
  readonly ownershipSnapshot = Effect.sync(() => [...new Set(this.owners.values())].map((owner): TerminalOwnershipSnapshot => ({
    ownerId: owner.ownerId, sessionId: owner.sessionId, processGroupId: owner.process.processGroupId, state: owner.state,
    active: this.active === owner, activity: owner.activity, exitCode: owner.exitCode,
  })))
  readonly reconcileActivity = Effect.suspend(() => Effect.forEach([...new Set(this.owners.values())], (owner) => this.probe(owner), { concurrency: "unbounded" }).pipe(
    Effect.map((checks) => checks.filter((check): check is TerminalActivityCheck => check !== undefined))))

  readonly stopSession: TerminalSupervisorApi["stopSession"] = (sessionId, graceMs = this.graceMs, expectedOwnerId) => Effect.uninterruptible(Effect.suspend(() => {
    const owner = this.owners.get(sessionId)
    const pending = this.launches.get(sessionId)
    const ownerId = expectedOwnerId ?? owner?.ownerId ?? pending?.ownerId
    if (!ownerId) return Effect.succeed(false)
    if (owner?.ownerId === ownerId) Deferred.doneUnsafe(owner.cancelled, Effect.void)
    if (pending?.ownerId === ownerId) Deferred.doneUnsafe(pending.cancelled, Effect.void)
    return Effect.gen({ self: this }, function*() {
      if (pending?.ownerId === ownerId) yield* this.bounded(Deferred.await(pending.done)).pipe(Effect.mapError((cause) => this.cleanupFailure("stop", sessionId, cause)))
      const current = [...this.owners.values()].find((candidate) => candidate.ownerId === ownerId)
      if (current) yield* this.cleanup(current, "stop", graceMs)
      return current !== undefined || pending?.ownerId === ownerId
    })
  }))

  readonly shutdown: TerminalSupervisorApi["shutdown"] = (graceMs = this.graceMs) => Effect.uninterruptible(Effect.suspend(() => {
    if (this.shutdownResult) return Deferred.await(this.shutdownResult)
    this.shuttingDown = true
    Deferred.doneUnsafe(this.stopping, Effect.void)
    const result = Deferred.makeUnsafe<void, TerminalCleanupError>()
    this.shutdownResult = result
    return Effect.gen({ self: this }, function*() {
      const exit = yield* Effect.exit(Effect.gen({ self: this }, function*() {
        this.ignore(this.unsubscribe)
        for (const owner of new Set(this.owners.values())) this.releaseUi(owner)
        const first = yield* Effect.forEach([...new Set(this.owners.values())], (owner) => Effect.exit(this.cleanup(owner, "shutdown", graceMs)), { concurrency: "unbounded" })
        const launches = yield* Effect.exit(this.bounded(Effect.all([...this.launches.values()].map((pending) => Deferred.await(pending.done)), { concurrency: "unbounded", discard: true })))
        const late = yield* Effect.forEach([...new Set(this.owners.values())], (owner) => Effect.exit(this.cleanup(owner, "shutdown", graceMs)), { concurrency: "unbounded" })
        const closed = yield* Effect.exit(this.bounded(Scope.close(this.scope, Exit.void)))
        const issues = [...first, ...late].flatMap((exit) => Exit.isFailure(exit) ? this.cleanupFailure("shutdown", "", Cause.squash(exit.cause)).issues : [])
        for (const exit of [launches, closed]) if (Exit.isFailure(exit)) issues.push(...this.cleanupFailure("shutdown", "", Cause.squash(exit.cause)).issues)
        if (issues.length) return yield* Effect.fail(new TerminalCleanupError({ operation: "shutdown", issues }))
      }))
      Deferred.doneUnsafe(result, exit)
      if (Exit.isFailure(exit)) { this.shutdownResult = undefined; return yield* Effect.failCause(exit.cause) }
    })
  }))

  private createOwner(ownerId: string, acquired: AcquiredTerminalLaunch, scope: Scope.Closeable, claim: SessionClaim, transient: boolean): Effect.Effect<TerminalOwner, TerminalError> {
    return Effect.gen({ self: this }, function*() {
      const launch = acquired.launch
      const queue = yield* Queue.unbounded<SemanticEvent>()
      let owner: TerminalOwner | undefined
      let child: TerminalProcess | undefined
      let sequence = 1
      let lastActivity: AgentActivity = "idle"
      const osc52 = new Osc52Forwarder()
      const offer = (event: UnsequencedEvent) => {
        if (owner) return this.offer(owner, event)
        if (event._tag === "Activity") { if (event.activity === lastActivity) return; lastActivity = event.activity }
        Queue.offerUnsafe(queue, { ...event, sequenceId: sequence++ })
      }
      const observations = () => { for (const observation of launch.observer.takeObservations?.() ?? []) offer({ _tag: "Observation", observation }) }
      const surface = yield* this.attempt("create-emulator", launch.sessionId, () => this.dependencies.renderer.createSurface(`agent-owner-${ownerId}`, {
        onData: (data, source) => {
          if (owner && owner.state !== "running") return
          this.ignore(() => {
            if (source === "input" && owner) {
              this.captureDraft(owner)
              owner.inputObserved = true
              const observation = launch.observer.observeInput?.(data)
              observations()
              if (observation) { delete owner.draft; delete owner.draftKey; offer({ _tag: "Observation", observation }) }
            }
          })
          this.ignore(() => child?.write(data))
        },
        onResize: (columns, rows) => { if (!owner || owner.state === "running") this.ignore(() => child?.resize(columns, rows)) },
        onScreenChange: () => {
          if (owner && owner.state !== "running") return
          this.ignore(() => {
            const screen = surface.screen()
            const activity = launch.observer.observeScreen(screen)
            const draft = launch.observer.observeDraft(screen)
            observations()
            if (owner) this.recordDraft(owner, draft)
            if (activity !== undefined) offer({ _tag: "Activity", activity })
          })
        },
      }))
      const spawned = yield* Effect.exit(this.attempt("spawn", launch.sessionId, () => this.dependencies.processes.spawn(launch,
        { columns: Math.max(1, this.dependencies.renderer.columns), rows: Math.max(1, this.dependencies.renderer.rows) }, {
          onOutput: (data) => {
            if (owner && owner.state !== "running") return
            this.ignore(() => {
              for (const activity of launch.observer.observeOutput(data)) offer({ _tag: "Activity", activity })
              observations()
            })
            this.ignore(() => {
              for (const text of osc52.observe(data)) if (this.active?.ownerId === ownerId) this.dependencies.renderer.copyToClipboard(text)
            })
            this.ignore(() => surface.write(data))
          }, onPtyClosed() {},
        })))
      if (Exit.isFailure(spawned)) { this.ignore(() => surface.release()); return yield* Effect.failCause(spawned.cause) }
      child = spawned.value
      owner = {
        ownerId, sessionId: launch.sessionId, state: "running", scope, close: acquired.close, claim, claims: new Set([claim]), process: child, surface,
        observer: launch.observer, ...(launch.failureDetails ? { failureDetails: launch.failureDetails } : {}), queue,
        ready: Deferred.makeUnsafe<void>(), cancelled: Deferred.makeUnsafe<void>(), gate: Semaphore.makeUnsafe(1), probeGate: Semaphore.makeUnsafe(1),
        pendingTransitions: new Set(), fibers: [], sequence, activity: "idle", lastQueuedActivity: lastActivity,
        ...(launch.initialDraft ? { draft: launch.initialDraft } : {}), inputObserved: false, transient, transitioning: false, exitCode: null,
        uiReleased: false, providerClosed: false, scopeClosed: false, ptyClosed: false, detached: false, claimReleased: false, exitNotified: false,
      }
      return owner
    })
  }

  private offer(owner: TerminalOwner, event: UnsequencedEvent): void {
    if (event._tag === "Activity") {
      if (event.activity === owner.lastQueuedActivity) return
      owner.lastQueuedActivity = event.activity
    }
    Queue.offerUnsafe(owner.queue, { ...event, sequenceId: owner.sequence++ })
  }
  private semanticLoop(owner: TerminalOwner): Effect.Effect<void> {
    return Effect.forever(Queue.take(owner.queue).pipe(Effect.andThen((event) => Effect.suspend(() => this.handleEvent(owner, event)).pipe(
      Effect.catchCause((cause) => {
        if (event._tag === "Activity" || event._tag === "Observation" || event._tag === "Provider") return Effect.void
        if (event._tag === "Transition") Deferred.doneUnsafe(event.request.acknowledgment, Effect.fail(this.error("transition", owner.sessionId, "Session transition failed", Cause.squash(cause))))
        return this.cleanup(owner, "stop", this.graceMs).pipe(Effect.catch((error) => Effect.sync(() => this.reportCleanupError(error))))
      }), Effect.ensuring(Effect.sync(() => { if (event._tag === "Transition") owner.pendingTransitions.delete(event.request) })),
    ))))
  }
  private handleEvent(owner: TerminalOwner, event: SemanticEvent): Effect.Effect<void, TerminalCleanupError> {
    if (this.owners.get(owner.sessionId) !== owner || owner.state !== "running") {
      if (event._tag === "Transition") Deferred.doneUnsafe(event.request.acknowledgment, Effect.fail(this.error("transition", owner.sessionId, "Terminal stopped")))
      return Effect.void
    }
    if (event._tag === "Transition") return this.transition(owner, event)
    if (event._tag === "Exited") return Effect.uninterruptible(Effect.gen({ self: this }, function*() {
      yield* Effect.promise(() => Promise.race([owner.process.ptyDrained, Bun.sleep(PTY_DRAIN_PERIOD_MS)]))
      owner.exitCode = event.exitCode
      const wasActive = this.active === owner
      const outputTail = event.exitCode !== 0 ? this.failureOutput(owner) : undefined
      const cleaned = yield* Effect.exit(this.cleanup(owner, "natural-exit", this.graceMs))
      this.notifyExit(owner, event.sequenceId, wasActive, Exit.isFailure(cleaned) ? Cause.squash(cleaned.cause) as TerminalCleanupError : undefined, outputTail)
    }))
    if (event._tag === "Provider") {
      if (event.event.sessionId !== owner.sessionId) return Effect.void
      if (event.event._tag === "Unavailable") {
        owner.providerActivity = undefined
        owner.lastQueuedActivity = owner.activity
        return this.probe(owner).pipe(Effect.asVoid)
      }
      if (event.event._tag === "Activity") {
        owner.providerActivity = event.event.activity
        owner.lastQueuedActivity = event.event.activity
        return this.handleEvent(owner, { _tag: "Activity", sequenceId: event.sequenceId, activity: event.event.activity, provider: true })
      }
      return this.handleEvent(owner, { _tag: "Observation", sequenceId: event.sequenceId, observation: event.event.observation })
    }
    return Effect.sync(() => {
      const common = { ownerId: owner.ownerId, sessionId: owner.sessionId, sequenceId: event.sequenceId, wasActive: this.active === owner }
      if (event._tag === "Observation") this.ignore(() => this.events.onObservation?.({ ...common, observation: event.observation }))
      else {
        if (!event.provider && owner.providerActivity !== undefined && owner.providerActivity !== event.activity) { owner.lastQueuedActivity = owner.activity; return }
        if (owner.activity === event.activity) return
        owner.activity = event.activity
        this.ignore(() => this.events.onActivityChanged?.({ ...common, activity: event.activity }))
      }
    })
  }

  private transition(owner: TerminalOwner, event: Extract<SemanticEvent, { _tag: "Transition" }>): Effect.Effect<void, TerminalCleanupError> {
    return owner.gate.withPermit(Effect.gen({ self: this }, function*() {
      const request = event.request
      const previousSessionId = owner.sessionId
      const changed = yield* Effect.exit(Effect.gen({ self: this }, function*() {
        if (request.event._tag === "TransitionFailed") return yield* Effect.fail(request.event.error)
        const transition = request.event
        if (transition.session.id === previousSessionId) return
        const expectedKind = owner.transient ? "temporary-adoption" : "native-fork"
        if (transition.kind !== expectedKind) return yield* Effect.fail(this.error("transition", previousSessionId, `Expected ${expectedKind}, received ${transition.kind}`))
        const destination = transition.session.id
        if (this.owners.has(destination) || this.launches.has(destination)) return yield* Effect.fail(this.error("transition", destination, "Session already has a terminal in this invocation"))
        owner.transitioning = true
        this.owners.set(destination, owner)
        const derived = transition.derivation ? yield* this.untilCancelled(withOperationTimeout(transition.derivation, this.dependencies.transitionDerivationTimeoutMs,
          () => Effect.fail(this.error("transition", destination, "Branch derivation timed out"))), owner.cancelled) : undefined
        if (derived) yield* this.attempt("transition", destination, () => validateBranchDerivation(derived, previousSessionId, destination, transition.kind))
        const now = yield* Clock.currentTimeMillis
        const relation = derived ? { ...derived, createdAt: new Date(now).toISOString() } : undefined
        const claim = yield* this.untilCancelled(this.dependencies.guard.acquire(destination), owner.cancelled)
        owner.claims.add(claim)
        const committed = yield* Effect.exit(this.dependencies.metadata.replaceIdentity(previousSessionId, destination, { kind: transition.kind, ...(relation ? { relation } : {}) }))
        if (Exit.isFailure(committed)) return yield* Effect.failCause(committed.cause)
        yield* owner.claim.release
        owner.claims.delete(owner.claim)
        owner.claim = claim
        this.owners.delete(previousSessionId)
        owner.sessionId = destination
        owner.transient = false
        owner.providerActivity = undefined
        const acknowledgment = Deferred.makeUnsafe<void, unknown>()
        const applicationEvent: TerminalSessionChangedEvent = { ownerId: owner.ownerId, sequenceId: event.sequenceId,
          previousSessionId, session: transition.session, kind: transition.kind, wasActive: this.active === owner,
          adoptionToken: crypto.randomUUID(), acknowledgment, ...(relation ? { relation } : {}) }
        yield* Effect.try({ try: () => {
          if (!this.events.onSessionChanged) throw new Error("No application session-transition listener is installed")
          this.events.onSessionChanged(applicationEvent)
        }, catch: (cause) => this.error("transition", destination, "Unable to publish session identity", cause) })
        yield* this.untilCancelled(withOperationTimeout(Deferred.await(acknowledgment), this.dependencies.applicationAcknowledgmentTimeoutMs,
          () => Effect.fail(this.error("transition", destination, "Application did not acknowledge session identity"))), owner.cancelled)
        owner.transitioning = false
      }))
      if (Exit.isSuccess(changed)) { Deferred.doneUnsafe(request.acknowledgment, Effect.void); return false }
      const cause = Cause.squash(changed.cause)
      const error = cause instanceof TerminalError || cause instanceof ProviderProtocolError || cause instanceof PersistenceError || cause instanceof SessionOwnedError || cause instanceof SessionRemovedError
        ? cause : this.error("transition", owner.sessionId, "Session transition failed", cause)
      Deferred.doneUnsafe(request.acknowledgment, Effect.fail(error))
      this.ignore(() => this.events.onSessionTransitionError?.({ ownerId: owner.ownerId, sessionId: owner.sessionId,
        sequenceId: owner.sequence++, error, wasActive: this.active === owner }))
      return true
    })).pipe(Effect.andThen((failed) => failed ? this.cleanup(owner, "stop", this.graceMs, true) : Effect.void))
  }

  private cleanup(owner: TerminalOwner, operation: TerminalCleanupError["operation"], graceMs: number, notify = false): Effect.Effect<void, TerminalCleanupError> {
    return Effect.uninterruptible(Effect.suspend(() => {
      if (owner.cleanup) return Deferred.await(owner.cleanup)
      const result = Deferred.makeUnsafe<void, TerminalCleanupError>()
      owner.cleanup = result
      owner.state = "stopping"
      Deferred.doneUnsafe(owner.cancelled, Effect.void)
      const wasActive = this.active === owner
      return Effect.gen({ self: this }, function*() {
        const exit = yield* Effect.exit(owner.gate.withPermit(Effect.gen({ self: this }, function*() {
          const issues = [...this.releaseUi(owner)]
          const stopped = yield* cleanupProcessGroup(owner.process, { gracePeriodMs: graceMs, killPeriodMs: this.killMs })
          if (stopped.status !== "absent") issues.push(...stopped.issues.map((issue) => ({ ...issue, ownerId: owner.ownerId, sessionId: owner.sessionId })))
          const close = asyncEffectStage.bind(this, owner, issues)
          if (!owner.providerClosed) owner.providerClosed = yield* close("provider", "Unable to close provider resources", owner.close)
          if (!owner.scopeClosed) owner.scopeClosed = yield* close("provider", "Unable to close provider scope", Scope.close(owner.scope, Exit.void))
          if (!owner.ptyClosed) owner.ptyClosed = yield* close("pty", "Unable to close PTY", Effect.sync(() => owner.process.closePty()))
          if (!owner.detached) owner.detached = yield* close("pty", "Unable to detach process", Effect.sync(() => owner.process.unref()))
          if (stopped.status === "absent" && owner.providerClosed && owner.scopeClosed && owner.ptyClosed && owner.detached && owner.uiReleased) {
            for (const claim of owner.claims) {
              if (yield* close("guard", "Unable to release session guard", claim.release)) owner.claims.delete(claim)
            }
            owner.claimReleased = owner.claims.size === 0
          }
          if (owner.claimReleased) {
            for (const [id, current] of this.owners) if (current === owner) this.owners.delete(id)
            for (const fiber of owner.fibers) fiber.interruptUnsafe()
          } else owner.state = "cleanup-incomplete"
          for (const pending of owner.pendingTransitions) Deferred.doneUnsafe(pending.acknowledgment, Effect.fail(this.error("transition", owner.sessionId, "Terminal stopped")))
          owner.pendingTransitions.clear()
          if (issues.length) return yield* Effect.fail(new TerminalCleanupError({ operation, issues, ...(owner.claimReleased ? { ownershipReleased: true as const } : {}) }))
        })))
        Deferred.doneUnsafe(result, exit)
        if (notify) this.notifyExit(owner, owner.sequence++, wasActive, Exit.isFailure(exit) ? Cause.squash(exit.cause) as TerminalCleanupError : undefined)
        if (Exit.isFailure(exit)) {
          delete owner.cleanup
          const error = this.cleanupFailure(operation, owner.sessionId, Cause.squash(exit.cause))
          this.reportCleanupError(error)
          return yield* Effect.fail(error)
        }
      })
    }))

    function asyncEffectStage(this: TerminalSupervisorImpl, owner: TerminalOwner, issues: TerminalCleanupIssue[], stage: TerminalCleanupIssue["stage"], message: string, effect: Effect.Effect<void, unknown>): Effect.Effect<boolean> {
      return Effect.exit(this.bounded(effect)).pipe(Effect.map((exit) => {
        if (Exit.isSuccess(exit)) return true
        issues.push({ ownerId: owner.ownerId, sessionId: owner.sessionId, stage, message, cause: Cause.squash(exit.cause) })
        return false
      }))
    }
  }
  private notifyExit(owner: TerminalOwner, sequenceId: number, wasActive: boolean, cleanupError?: TerminalCleanupError, outputTail?: string): void {
    if (owner.exitNotified) return
    owner.exitNotified = true
    this.ignore(() => this.events.onProcessExited?.({ ownerId: owner.ownerId, sessionId: owner.sessionId, sequenceId,
      wasActive, exitCode: owner.process.exitCode ?? 1, ...(owner.draft ? { draftPreview: owner.draft } : {}),
      ...(cleanupError ? { cleanupError } : {}), ...(outputTail ? { outputTail } : {}), ...(owner.claimReleased ? { ownershipReleased: true as const } : {}) }))
  }
  private releaseUi(owner: TerminalOwner): readonly TerminalCleanupIssue[] {
    const issues: TerminalCleanupIssue[] = []
    if (this.active === owner) { this.active = undefined; this.ignore(() => this.dependencies.renderer.clearSelection()) }
    this.captureDraft(owner)
    if (!owner.uiReleased) {
      try { owner.surface.release(); owner.uiReleased = true } catch (cause) {
        issues.push({ ownerId: owner.ownerId, sessionId: owner.sessionId, stage: "ui", message: "Unable to release terminal surface", cause })
      }
    }
    return issues
  }
  private activate(owner: TerminalOwner): Effect.Effect<void, TerminalError> {
    return this.attempt("focus", owner.sessionId, () => {
      if (this.shuttingDown || owner.state !== "running" || owner.process.exitCode !== null) throw new Error("Cannot focus a stopped terminal")
      const previous = this.active
      this.dependencies.renderer.clearSelection()
      try {
        owner.surface.setActive(true)
        owner.surface.focus()
        if (previous && previous !== owner) { this.captureDraft(previous); previous.surface.blur(); previous.surface.setActive(false) }
        this.active = owner
      } catch (cause) {
        this.ignore(() => owner.surface.setActive(false))
        if (previous) { this.ignore(() => previous.surface.setActive(true)); this.ignore(() => previous.surface.focus()) }
        this.active = previous
        throw cause
      }
    })
  }
  private captureDraft(owner: TerminalOwner): void {
    this.ignore(() => {
      const screen = owner.surface.screen()
      const activity = owner.observer.observeScreen(screen)
      this.takeObservations(owner)
      this.recordDraft(owner, owner.observer.observeDraft(screen))
      if (activity !== undefined) this.offer(owner, { _tag: "Activity", activity })
    })
    owner.inputObserved = false
  }
  private takeObservations(owner: TerminalOwner): void {
    for (const observation of owner.observer.takeObservations?.() ?? []) {
      if (observation._tag === "Rewind") { delete owner.draft; delete owner.draftKey }
      this.offer(owner, { _tag: "Observation", observation })
    }
  }
  private recordDraft(owner: TerminalOwner, draft: DraftPreview | null | undefined): void {
    if (draft === undefined) return
    if (draft === null) delete owner.draft
    else if (owner.inputObserved || !owner.draft?.exact) owner.draft = { text: draft.text, exact: draft.exact }
    const key = JSON.stringify(draft)
    if (key === owner.draftKey) return
    owner.draftKey = key
    this.offer(owner, { _tag: "Observation", observation: { _tag: "Draft", draft } })
  }
  private probe(owner: TerminalOwner): Effect.Effect<TerminalActivityCheck | undefined> {
    return owner.probeGate.withPermit(Effect.gen({ self: this }, function*() {
      const sessionId = owner.sessionId
      const usable = () => !this.shuttingDown && owner.state === "running" && !owner.uiReleased && !owner.transitioning && owner.sessionId === sessionId && this.owners.get(sessionId) === owner
      if (!usable()) return
      if (owner.providerActivity !== undefined) return { ownerId: owner.ownerId, sessionId, sequenceId: owner.sequence - 1, activity: owner.providerActivity }
      const sample = (phase: "sample" | "confirm"): TerminalActivityCheck => {
        try {
          const screen = owner.surface.screen()
          const activity = owner.observer.reconcileScreen ? owner.observer.reconcileScreen(screen, phase) : owner.observer.observeScreen(screen)
          this.takeObservations(owner)
          this.recordDraft(owner, owner.observer.observeDraft(screen))
          if (activity !== undefined) this.offer(owner, { _tag: "Activity", activity })
          return { ownerId: owner.ownerId, sessionId, sequenceId: owner.sequence - 1, ...(activity === undefined ? { issue: "unrecognized-screen" as const } : { activity }) }
        } catch { return { ownerId: owner.ownerId, sessionId, sequenceId: owner.sequence - 1, issue: "observer-failed" } }
      }
      const first = sample("sample")
      if (first.activity !== undefined || first.issue === "observer-failed") return first
      yield* Effect.sleep(ACTIVITY_CONFIRMATION_DELAY_MS)
      return usable() ? sample("confirm") : undefined
    }))
  }
  private sessionIds(predicate: (owner: TerminalOwner) => boolean): Effect.Effect<ReadonlySet<string>> {
    return Effect.sync(() => new Set([...new Set(this.owners.values())].filter(predicate).map((owner) => owner.sessionId)))
  }
  private untilCancelled<A, E>(effect: Effect.Effect<A, E>, cancelled: Deferred.Deferred<void>): Effect.Effect<A, E | TerminalError> {
    return Effect.raceFirst(effect, Effect.raceFirst(Deferred.await(this.stopping), Deferred.await(cancelled)).pipe(
      Effect.andThen(Effect.fail(this.error("acquire", "", "Terminal operation cancelled by stop or shutdown")))))
  }
  private bounded<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | Error> {
    return Effect.interruptible(effect).pipe(Effect.timeoutOrElse({ duration: this.closeMs, orElse: () => Effect.fail(new Error("Resource cleanup timed out")) }))
  }
  private failureOutput(owner: TerminalOwner): string {
    let details: string | undefined
    this.ignore(() => { details = owner.failureDetails?.()?.slice(-8 * 1_024) })
    return [owner.process.outputTail, details].filter(Boolean).join("\n\n")
  }
  private attempt<A>(operation: string, sessionId: string, run: () => A): Effect.Effect<A, TerminalError> {
    return Effect.try({ try: run, catch: (cause) => this.error(operation, sessionId, cause instanceof Error ? cause.message : String(cause), cause) })
  }
  private error(operation: string, sessionId: string, message: string, cause?: unknown): TerminalError {
    return new TerminalError({ operation, sessionId, message, ...(cause === undefined ? {} : { cause }) })
  }
  private cleanupFailure(operation: TerminalCleanupError["operation"], sessionId: string, cause: unknown): TerminalCleanupError {
    return cause instanceof TerminalCleanupError ? cause : new TerminalCleanupError({ operation,
      issues: [{ ownerId: "terminal-supervisor", sessionId, stage: "runtime", message: "Terminal cleanup failed", cause }] })
  }
  reportCleanupError(error: TerminalCleanupError): void { this.ignore(() => this.events.onCleanupError?.(error)) }
  private ignore(run: () => void): void { try { run() } catch { /* External callbacks cannot change lifecycle outcomes. */ } }
}

function validateBranchDerivation(derivation: BranchDerivation, previousSessionId: string, sessionId: string, kind: IdentityTransitionKind): void {
  if (derivation.childSessionId !== sessionId || (kind === "native-fork" && derivation.parentSessionId !== previousSessionId)) throw new Error("Provider returned branch metadata for different sessions")
  if (!derivation.parentSessionId || !derivation.childSessionId || !derivation.sourceMessageId || derivation.parentSessionId === derivation.childSessionId) throw new Error("Invalid branch session identity")
  const parents = derivation.sharedMessages.map((entry) => entry.parentMessageId)
  const children = derivation.sharedMessages.map((entry) => entry.childMessageId)
  if (parents.some((id) => !id) || children.some((id) => !id) || new Set(parents).size !== parents.length || new Set(children).size !== children.length) throw new Error("Invalid shared message mappings")
}
