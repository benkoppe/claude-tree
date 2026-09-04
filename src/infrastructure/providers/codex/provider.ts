import { randomUUID as nodeRandomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { Cause, Clock, Deferred, Effect, Exit, Layer, PubSub, Scope } from "effect"

import { ProviderCleanupError, ProviderError, ProviderProtocolError } from "../../../domain/errors"
import type {
  AgentMessage,
  AgentSession,
  AgentSessionSnapshot,
  BranchDerivation,
  MessageRef,
  TerminalObserver,
  TranscriptRead,
} from "../../../domain/model"
import {
  AgentProvider,
  type AgentProviderApi,
  type AmbiguousBranchMutation,
  type BranchOutcome,
  makeBranchMutationReconciliationSignal,
  type PreparedTerminal,
  type TerminalLaunch,
  type TerminalTransitionAcknowledgmentError,
  type TerminalTransitionEvent,
  type TerminalTransitionRequest,
} from "../../../services/provider"
import {
  CodexMutationAmbiguousError,
  CodexProtocolError,
  CodexRpcError,
  connectCodexAppServerSidecar,
  makeCodexAppServerClient,
  type CodexAppServerClient,
  type CodexAppServerError,
  type CodexThread,
  type CodexThreadItem,
  type CodexThreadListParams,
  type CodexTurn,
  type CodexTurnStatus,
  type CodexUserInput,
} from "./app-server"
import {
  makeCodexSidecar,
  type CodexSidecar,
  CodexSidecarError,
} from "./sidecar"
import { CodexTerminalObserver } from "./terminal-observer"
import {
  makeCodexTuiProxy,
  CodexTuiProxyError,
  type CodexThreadTransition,
  type CodexTuiProxyTransition,
  type CodexTuiProxyTransitionRequest,
} from "./tui-proxy"

const TRANSCRIPT_READ_CONCURRENCY = 16
const OVERLOAD_RETRY_DELAYS_MS = [25, 50, 100, 200]
const SIDECAR_START_TIMEOUT_MS = 5_000
const OBSERVED_SERVICES_CLEANUP_TIMEOUT_MS = 1_000
const SIDECAR_RETRY_DELAY_MS = 10
const TOKEN_ENVIRONMENT_VARIABLE = "CLAUDE_TREE_CODEX_TOKEN"
const METADATA_DEADLINE_MS = 30_000
const THREAD_LIST_PAGE_LIMIT = 100
const SNAPSHOT_SESSION_LIMIT = 10_000

export interface CodexMessage extends AgentMessage {
  readonly rawItem: CodexThreadItem
  readonly rawTurn: CodexTurn
  readonly turnId: string
  readonly turnStatus: CodexTurnStatus
  readonly itemIndex: number
}

export type CodexAppServerFactory = () => Effect.Effect<
  CodexAppServerClient,
  CodexAppServerError,
  Scope.Scope
>

export interface CodexObservedServices {
  readonly remoteUrl: string
  readonly bearerToken: string
  readonly transitions: PubSub.PubSub<CodexTuiProxyTransitionRequest>
  readonly close: () => Effect.Effect<void, CodexObservedServicesError>
}

export type CodexObservedServicesError =
  | CodexAppServerError
  | CodexSidecarError
  | CodexTuiProxyError

export type CodexObservedServicesFactory = (
  executable: string,
  initialThreadId: string,
) => Effect.Effect<CodexObservedServices, CodexObservedServicesError, Scope.Scope>

export interface CodexObservedServicesDependencies {
  readonly sidecarFactory?: (
    executable: string,
  ) => Effect.Effect<CodexSidecar, CodexSidecarError, Scope.Scope>
  readonly waitUntilReady?: (
    sidecar: CodexSidecar,
  ) => Effect.Effect<void, CodexAppServerError | CodexSidecarError>
  readonly proxyFactory?: typeof makeCodexTuiProxy
}

export interface CodexProviderRuntimeDependencies {
  readonly appServerFactory?: CodexAppServerFactory
  readonly observedServicesFactory?: CodexObservedServicesFactory
  readonly observerFactory?: () => TerminalObserver
  readonly randomUUID?: () => string
  readonly canonicalize?: (path: string) => string | PromiseLike<string>
}

export interface CodexProviderDependencies extends CodexProviderRuntimeDependencies {
  readonly resolveExecutable?: () => string | null | PromiseLike<string | null>
}

export interface CodexProviderOptions {
  readonly transcriptReadConcurrency?: number
  readonly overloadRetryDelaysMs?: readonly number[]
  readonly metadataDeadlineMs?: number
  readonly maxThreadListPages?: number
  readonly maxSnapshotSessions?: number
}

export class CodexProvider implements AgentProviderApi {
  readonly id = "codex"
  readonly displayName = "Codex"
  readonly capabilities = {
    historicalBranching: true,
    exactMessageForks: false,
    completedTurnForks: true,
    userMessageReplay: false,
    temporarySessionIds: true,
    nativeSessionSwitching: true,
  } as const

  readonly loadSessionSnapshot: Effect.Effect<
    AgentSessionSnapshot,
    ProviderError | ProviderProtocolError
  >
  readonly prepareNewSession: Effect.Effect<
    PreparedTerminal,
    ProviderError | ProviderProtocolError
  >
  readonly takeBranchMutationReconciliation: Effect.Effect<AmbiguousBranchMutation>

  private readonly appServerFactory: CodexAppServerFactory
  private readonly observedServicesFactory: CodexObservedServicesFactory
  private readonly observerFactory: () => TerminalObserver
  private readonly makeUuid: () => string
  private readonly canonicalizePath: (path: string) => string | PromiseLike<string>
  private readonly readConcurrency: number
  private readonly overloadRetryDelays: readonly number[]
  private readonly metadataDeadlineMs: number
  private readonly maxThreadListPages: number
  private readonly maxSnapshotSessions: number
  private readonly branchMutationReconciliations = makeBranchMutationReconciliationSignal()

  constructor(
    private readonly projectPath: string,
    private readonly executable: string,
    dependencies: CodexProviderRuntimeDependencies = {},
    options: CodexProviderOptions = {},
  ) {
    this.appServerFactory = dependencies.appServerFactory ??
      (() => makeCodexAppServerClient(this.executable))
    this.observedServicesFactory = dependencies.observedServicesFactory ?? makeObservedServices
    this.observerFactory = dependencies.observerFactory ?? (() => new CodexTerminalObserver())
    this.makeUuid = dependencies.randomUUID ?? nodeRandomUUID
    this.canonicalizePath = dependencies.canonicalize ?? realpath
    this.readConcurrency = positiveInteger(
      options.transcriptReadConcurrency,
      TRANSCRIPT_READ_CONCURRENCY,
    )
    this.overloadRetryDelays = options.overloadRetryDelaysMs ?? OVERLOAD_RETRY_DELAYS_MS
    this.metadataDeadlineMs = positiveDuration(options.metadataDeadlineMs, METADATA_DEADLINE_MS)
    this.maxThreadListPages = positiveInteger(options.maxThreadListPages, THREAD_LIST_PAGE_LIMIT)
    this.maxSnapshotSessions = positiveInteger(options.maxSnapshotSessions, SNAPSHOT_SESSION_LIMIT)
    this.takeBranchMutationReconciliation = this.branchMutationReconciliations.take

    this.loadSessionSnapshot = this.withServer((server) => Effect.gen({ self: this }, function*() {
      const sessions = yield* this.listSessionsFrom(server)
      const transcripts = yield* this.readTranscriptsFrom(
        server,
        sessions.map((session) => session.id),
      )
      return { sessions, transcripts }
    }), "loadSessionSnapshot", true)

    this.prepareNewSession = Effect.gen({ self: this }, function*() {
      const sessionId = yield* Effect.try({
        try: () => `pending-codex-${this.makeUuid()}`,
        catch: (cause) => this.providerError(
          "prepareNewSession",
          "Could not allocate a pending Codex session ID",
          cause,
        ),
      })
      yield* this.validateSessionId(sessionId, "prepareNewSession")
      const now = yield* Clock.currentTimeMillis
      const session: AgentSession = {
        id: sessionId,
        title: "Untitled conversation",
        lastModified: now,
        transient: true,
      }
      return {
        session,
        acquireLaunch: this.acquireObservedLaunch("new", sessionId),
      }
    })
  }

  readTranscripts(
    sessionIds: readonly string[],
  ): Effect.Effect<ReadonlyMap<string, TranscriptRead>, ProviderError | ProviderProtocolError> {
    return this.withServer(
      (server) => this.readTranscriptsFrom(server, sessionIds),
      "readTranscripts",
      true,
    )
  }

  loadSessionSnapshotFor(
    sessionIds: readonly string[],
  ): Effect.Effect<AgentSessionSnapshot, ProviderError | ProviderProtocolError> {
    return this.withServer((server) => Effect.gen({ self: this }, function*() {
      const sessions = yield* this.listSessionsFrom(server)
      const transcripts = yield* this.readTranscriptsFrom(server, sessionIds)
      return { sessions, transcripts }
    }), "loadSessionSnapshotFor", true)
  }

  prepareResume(
    session: AgentSession,
  ): Effect.Effect<PreparedTerminal, ProviderError | ProviderProtocolError> {
    return this.validateSessionId(session.id, "prepareResume").pipe(
      Effect.as({
        session,
        acquireLaunch: this.acquireObservedLaunch("resume", session.id),
      }),
    )
  }

  branchFrom(
    target: MessageRef,
  ): Effect.Effect<BranchOutcome, ProviderError | ProviderProtocolError> {
    let mutationMayHaveDispatched = false
    let deadlineExpired = false
    const operation = this.withServer((server) => Effect.gen({ self: this }, function*() {
      yield* this.validateSessionId(target.sessionId, "branchFrom")
      const parentThread = yield* this.requireThread(server, target.sessionId, "branchFrom")
      if (!(yield* this.threadBelongsToProject(parentThread))) {
        return yield* Effect.fail(this.protocolError(
          "branchFrom",
          `Codex session ${target.sessionId} belongs to another project`,
        ))
      }
      const parentTranscript = yield* this.normalizeThread(parentThread, "branchFrom")
      const selectedIndex = parentTranscript.findIndex((message) => message.id === target.messageId)
      const selected = parentTranscript[selectedIndex]
      if (selected === undefined) {
        return yield* Effect.fail(this.providerError(
          "branchFrom",
          "The selected historical message is no longer available",
        ))
      }
      yield* this.validateForkTarget(selected, parentThread)

      const copiedParent = parentTranscript.slice(0, selectedIndex + 1)
      mutationMayHaveDispatched = true
      const mutation = yield* server.forkThread(
        target.sessionId,
        selected.turnId,
        this.projectPath,
      ).pipe(
        Effect.map((thread) => ({ _tag: "Success" as const, thread })),
        Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
      )
      if (mutation._tag === "Failure") {
        if (mutation.error instanceof CodexMutationAmbiguousError) {
          return {
            _tag: "AmbiguousBranchMutation" as const,
            providerId: this.id,
            parentSessionId: target.sessionId,
            sourceMessageId: selected.id,
            reason: mutation.error.message,
            reconciliation: "full-snapshot" as const,
          }
        }
        return yield* Effect.fail(this.mapTransportError("branchFrom", mutation.error))
      }
      const childThread = mutation.thread
      const childIdValid = isValidSessionId(childThread.id) && childThread.id !== target.sessionId
      const childInProject = yield* this.threadBelongsToProject(childThread)
      if (!childIdValid || !childInProject) {
        return ambiguity(
          !childIdValid
            ? "Codex thread/fork returned an invalid or non-distinct child thread ID after dispatch"
            : `Codex thread/fork returned child ${childThread.id} outside the canonical project after dispatch`,
        )
      }
      const now = yield* Clock.currentTimeMillis
      const provisionalSession = provisionalSessionFromThread(childThread, now)
      let transcript: TranscriptRead = {
        _tag: "Unavailable",
        reason: `The created Codex transcript ${childThread.id} has not been read`,
      }

      return yield* Effect.gen({ self: this }, function*() {
        yield* this.validateSessionId(childThread.id, "branchFrom")
        const childRead = yield* this.readThreadWithOverloadRetry(server, childThread.id).pipe(
          Effect.mapError((error) => this.mapTransportError("validateFork", error)),
        )
        if (!(yield* this.threadBelongsToProject(childRead))) {
          return ambiguity(
            `Codex fork child ${childThread.id} resolved outside the canonical project after dispatch`,
          )
        }
        const childTranscript = yield* this.normalizeThread(childRead, "validateFork")
        transcript = { _tag: "Available", messages: childTranscript }
        yield* this.validateCopiedPrefix(childThread.id, copiedParent, childTranscript)
        const session = yield* this.sessionFromThread(childRead, "validateFork")
        return {
          _tag: "ValidatedBranch" as const,
          session,
          acquireLaunch: this.acquireObservedLaunch("resume", session.id),
          derivation: {
            childSessionId: session.id,
            parentSessionId: target.sessionId,
            sourceMessageId: selected.id,
            sharedMessages: copiedParent.map((message, index) => ({
              parentMessageId: message.id,
              childMessageId: childTranscript[index]!.id,
            })),
          },
        }
      }).pipe(
        Effect.catch((error) => {
          if (isMissingCodexThreadErrorCause(error.cause)) transcript = { _tag: "Missing" }
          else if (transcript._tag !== "Available") {
            transcript = { _tag: "Unavailable", reason: error.message }
          }
          const launchable = isValidSessionId(provisionalSession.id)
          return Effect.succeed({
            _tag: "CreatedIndependentSession" as const,
            session: provisionalSession,
            transcript,
            reason: `Fork ${provisionalSession.id || "(unknown)"} was created, but ${error.message}`,
            ...(launchable
              ? { acquireLaunch: this.acquireObservedLaunch("resume", provisionalSession.id) }
              : {}),
          })
        }),
      )
    }), "branchFrom")
    const ambiguity = (reason: string): AmbiguousBranchMutation => ({
      _tag: "AmbiguousBranchMutation",
      providerId: this.id,
      parentSessionId: target.sessionId,
      sourceMessageId: target.messageId,
      reason,
      reconciliation: "full-snapshot",
    })
    const deadline = Effect.sleep(this.metadataDeadlineMs).pipe(
      Effect.tap(() => Effect.sync(() => {
        deadlineExpired = true
      })),
      Effect.flatMap(() => mutationMayHaveDispatched
        ? Effect.succeed(ambiguity(
            `Codex branchFrom exceeded the ${this.metadataDeadlineMs}ms overall deadline after thread/fork dispatch`,
          ))
        : Effect.fail(this.providerError(
            "branchFrom",
            `Codex branchFrom exceeded the ${this.metadataDeadlineMs}ms overall deadline`,
          ))),
    )
    return Effect.raceFirst(
      operation.pipe(Effect.onInterrupt(() => mutationMayHaveDispatched && !deadlineExpired
        ? Effect.sync(() => this.branchMutationReconciliations.offer(ambiguity(
            "Codex thread/fork was interrupted after dispatch and may have created a child thread",
          )))
        : Effect.void)),
      deadline,
    )
  }

  private withServer<A>(
    use: (
      server: CodexAppServerClient,
    ) => Effect.Effect<A, ProviderError | ProviderProtocolError>,
    operation: string,
    bounded = false,
  ): Effect.Effect<A, ProviderError | ProviderProtocolError> {
    const operationEffect = Effect.uninterruptibleMask((restore) => Effect.gen({ self: this }, function*() {
      const scope = yield* Scope.make("sequential")
      const acquisition = yield* Effect.exit(restore(Scope.provide(
        this.appServerFactory().pipe(
          Effect.mapError((error) => this.mapTransportError(operation, error)),
        ),
        scope,
      )))
      if (Exit.isFailure(acquisition)) {
        const scopeCleanup = yield* Effect.exit(this.boundedServerCleanup(
          Scope.close(scope, acquisition),
          operation,
        ))
        if (Exit.isFailure(scopeCleanup)) {
          return yield* Effect.fail(this.mapTransportError(operation, new AggregateError([
            Cause.squash(acquisition.cause),
            Cause.squash(scopeCleanup.cause),
          ])))
        }
        return yield* Effect.failCause(acquisition.cause)
      }

      const outcome = yield* Effect.exit(restore(use(acquisition.value)))
      const explicitCleanup = yield* Effect.exit(this.boundedServerCleanup(
        acquisition.value.close(),
        operation,
      ))
      const scopeCleanup = yield* Effect.exit(this.boundedServerCleanup(
        Scope.close(scope, outcome),
        operation,
      ))
      const cleanupFailures = [explicitCleanup, scopeCleanup].flatMap((exit) =>
        Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [])
      if (cleanupFailures.length > 0) {
        const cleanupError = this.mapTransportError(
          operation,
          cleanupFailures.length === 1
            ? cleanupFailures[0]
            : new AggregateError(cleanupFailures),
        )
        if (Exit.isSuccess(outcome) && isBranchOutcome(outcome.value)) {
          yield* Effect.logError(
            `Codex ${operation} committed, but app-server cleanup failed: ${cleanupError.message}`,
          )
          return outcome.value
        }
        if (Exit.isFailure(outcome)) {
          yield* Effect.logError(
            `Codex ${operation} also encountered an app-server cleanup failure: ${cleanupError.message}`,
          )
          return yield* Effect.failCause(outcome.cause)
        }
        return yield* Effect.fail(cleanupError)
      }
      if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause)
      return outcome.value
    }))
    if (!bounded) return operationEffect
    return operationEffect.pipe(Effect.timeoutOrElse({
      duration: this.metadataDeadlineMs,
      orElse: () => Effect.fail(this.providerError(
        operation,
        `Codex ${operation} exceeded the ${this.metadataDeadlineMs}ms overall deadline`,
      )),
    }))
  }

  private boundedServerCleanup<A, E, R>(
    effect: Effect.Effect<A, E, R>,
    operation: string,
  ): Effect.Effect<A, E | ProviderError, R> {
    return effect.pipe(Effect.timeoutOrElse({
      duration: this.metadataDeadlineMs,
      orElse: () => Effect.fail(this.providerError(
        operation,
        `Codex ${operation} app-server cleanup exceeded ${this.metadataDeadlineMs}ms`,
      )),
    }))
  }

  private listSessionsFrom(
    server: CodexAppServerClient,
  ): Effect.Effect<readonly AgentSession[], ProviderError | ProviderProtocolError> {
    return Effect.gen({ self: this }, function*() {
      const sessions: AgentSession[] = []
      const seenCursors = new Set<string>()
      let cursor: string | undefined
      const filters: Omit<CodexThreadListParams, "cursor"> = {
        cwd: this.projectPath,
        modelProviders: [],
        sourceKinds: ["cli", "vscode", "appServer"],
        sortKey: "updated_at",
      }

      while (true) {
        if (seenCursors.size >= this.maxThreadListPages) {
          return yield* Effect.fail(this.protocolError(
            "listSessions",
            `Codex thread/list exceeded ${this.maxThreadListPages} pages`,
          ))
        }
        const page = yield* this.transport(
          server.listThreads({ ...filters, ...(cursor === undefined ? {} : { cursor }) }),
          "listSessions",
        )
        for (const thread of page.data) {
          if (!(yield* this.threadBelongsToProject(thread))) continue
          if (sessions.length >= this.maxSnapshotSessions) {
            return yield* Effect.fail(this.protocolError(
              "listSessions",
              `Codex thread/list exceeded ${this.maxSnapshotSessions} sessions`,
            ))
          }
          sessions.push(yield* this.sessionFromThread(thread, "listSessions"))
        }
        if (page.nextCursor === null) return sessions
        if (seenCursors.has(page.nextCursor)) {
          return yield* Effect.fail(this.protocolError(
            "listSessions",
            `Codex repeated thread/list cursor ${JSON.stringify(page.nextCursor)}`,
          ))
        }
        seenCursors.add(page.nextCursor)
        cursor = page.nextCursor
      }
    })
  }

  private readTranscriptsFrom(
    server: CodexAppServerClient,
    sessionIds: readonly string[],
  ): Effect.Effect<ReadonlyMap<string, TranscriptRead>, ProviderProtocolError> {
    if (sessionIds.length > this.maxSnapshotSessions) {
      return Effect.fail(this.protocolError(
        "readTranscripts",
        `Codex transcript read exceeded ${this.maxSnapshotSessions} sessions`,
      ))
    }
    return Effect.all(
      sessionIds.map((sessionId) => this.readTranscriptOutcome(server, sessionId).pipe(
        Effect.map((transcript): readonly [string, TranscriptRead] => [sessionId, transcript]),
      )),
      { concurrency: this.readConcurrency },
    ).pipe(Effect.map((entries) => new Map(entries)))
  }

  private readTranscriptOutcome(
    server: CodexAppServerClient,
    sessionId: string,
  ): Effect.Effect<TranscriptRead> {
    return this.readThreadWithOverloadRetry(server, sessionId).pipe(
      Effect.flatMap((thread) => this.normalizeThread(thread, "readTranscripts")),
      Effect.match({
        onFailure: (cause): TranscriptRead => {
          if (isMissingCodexThreadErrorCause(cause)) return { _tag: "Missing" }
          return {
            _tag: "Unavailable",
            reason: this.mapTransportError("readTranscripts", cause).message,
          }
        },
        onSuccess: (messages): TranscriptRead => ({ _tag: "Available", messages }),
      }),
    )
  }

  private readThreadWithOverloadRetry(
    server: CodexAppServerClient,
    sessionId: string,
    attempt = 0,
  ): Effect.Effect<CodexThread, CodexAppServerError> {
    return server.readThread(sessionId).pipe(
      Effect.catch((error) => {
        const delay = this.overloadRetryDelays[attempt]
        if (!isOverloadedCodexError(error) || delay === undefined) return Effect.fail(error)
        return Effect.sleep(delay).pipe(
          Effect.flatMap(() => this.readThreadWithOverloadRetry(server, sessionId, attempt + 1)),
        )
      }),
    )
  }

  private requireThread(
    server: CodexAppServerClient,
    sessionId: string,
    operation: string,
  ): Effect.Effect<CodexThread, ProviderError | ProviderProtocolError> {
    return this.readThreadWithOverloadRetry(server, sessionId).pipe(
      Effect.mapError((cause) => isMissingCodexThreadErrorCause(cause)
        ? this.providerError(operation, `Codex session ${sessionId} was not found`, cause)
        : this.mapTransportError(operation, cause)),
    )
  }

  private normalizeThread(
    thread: CodexThread,
    operation: string,
  ): Effect.Effect<readonly CodexMessage[], ProviderProtocolError> {
    return Effect.try({
      try: () => normalizeCodexThread(thread),
      catch: (cause) => this.protocolError(
        operation,
        `Codex returned an invalid transcript for session ${thread.id}`,
        cause,
      ),
    })
  }

  private sessionFromThread(
    thread: CodexThread,
    operation: string,
  ): Effect.Effect<AgentSession, ProviderProtocolError> {
    return Effect.try({
      try: () => toSession(thread),
      catch: (cause) => this.protocolError(
        operation,
        "Codex returned invalid session metadata",
        cause,
      ),
    })
  }

  private threadBelongsToProject(thread: CodexThread): Effect.Effect<boolean> {
    if (!isCanonicalPathCandidate(thread.cwd)) return Effect.succeed(false)
    if (thread.cwd === this.projectPath) return Effect.succeed(true)
    return Effect.tryPromise({
      try: () => Promise.resolve(this.canonicalizePath(thread.cwd)),
      catch: () => undefined,
    }).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: (path) => isCanonicalPathCandidate(path) && path === this.projectPath,
      }),
    )
  }

  private validateForkTarget(
    selected: CodexMessage,
    parentThread: CodexThread,
  ): Effect.Effect<void, ProviderProtocolError> {
    if (selected.role === "user") {
      return Effect.fail(this.protocolError(
        "branchFrom",
        "Codex can only branch from the final agent message of a completed turn, not a user message",
      ))
    }
    if (selected.role === "system") {
      return Effect.fail(this.protocolError(
        "branchFrom",
        "Codex can only branch from the final agent message of a completed turn, not a system item",
      ))
    }
    const turn = parentThread.turns.find((candidate) => candidate.id === selected.turnId)
    if (turn === undefined) {
      return Effect.fail(this.protocolError(
        "branchFrom",
        "The selected message's turn is no longer available",
      ))
    }
    if (turn.status !== "completed") {
      return Effect.fail(this.protocolError(
        "branchFrom",
        `Codex can only branch from a completed turn; this turn is ${turn.status}`,
      ))
    }
    if (selected.itemIndex !== turn.items.length - 1) {
      return Effect.fail(this.protocolError(
        "branchFrom",
        "Codex can only branch from the final agent item of a completed turn",
      ))
    }
    return Effect.void
  }

  private validateCopiedPrefix(
    childSessionId: string,
    parent: readonly CodexMessage[],
    child: readonly CodexMessage[],
  ): Effect.Effect<void, ProviderProtocolError> {
    if (child.length !== parent.length) {
      return Effect.fail(this.protocolError(
        "validateFork",
        `the copied prefix has ${child.length} items; expected exactly ${parent.length}`,
      ))
    }
    for (let index = 0; index < parent.length; index += 1) {
      if (!sameCopiedCodexMessage(parent[index]!, child[index]!)) {
        return Effect.fail(this.protocolError(
          "validateFork",
          `the copied prefix of ${childSessionId} does not exactly match the source payloads`,
        ))
      }
    }
    return Effect.void
  }

  private acquireObservedLaunch(
    kind: "new" | "resume",
    sessionId: string,
  ): PreparedTerminal["acquireLaunch"] {
    return Effect.gen({ self: this }, function*() {
      yield* this.validateSessionId(sessionId, "acquireLaunch")
      const observed = yield* this.observedServicesFactory(this.executable, sessionId).pipe(
        Effect.mapError((error) => this.mapTransportError("acquireLaunch", error)),
      )
      const transitions = yield* this.adaptTransitions(observed.transitions)
      const command: [string, ...string[]] = kind === "new"
        ? [
            this.executable,
            "--remote",
            observed.remoteUrl,
            "--remote-auth-token-env",
            TOKEN_ENVIRONMENT_VARIABLE,
            "--cd",
            this.projectPath,
          ]
        : [
            this.executable,
            "resume",
            "--remote",
            observed.remoteUrl,
            "--remote-auth-token-env",
            TOKEN_ENVIRONMENT_VARIABLE,
            sessionId,
          ]
      const launch: TerminalLaunch = {
        sessionId,
        command,
        cwd: this.projectPath,
        env: { [TOKEN_ENVIRONMENT_VARIABLE]: observed.bearerToken },
        observer: this.observerFactory(),
        transitions,
      }
      return {
        launch,
        close: observed.close().pipe(
          Effect.mapError((cause) => new ProviderCleanupError({
            providerId: this.id,
            operation: "closeLaunch",
            message: "Unable to clean up Codex terminal services",
            cause,
          })),
        ),
      }
    })
  }

  private adaptTransitions(
    source: PubSub.PubSub<CodexTuiProxyTransitionRequest>,
  ): Effect.Effect<PubSub.PubSub<TerminalTransitionRequest>, never, Scope.Scope> {
    return Effect.gen({ self: this }, function*() {
      const transitions = yield* Effect.acquireRelease(
        PubSub.bounded<TerminalTransitionRequest>(64),
        PubSub.shutdown,
      )
      const subscription = yield* PubSub.subscribe(source)
      yield* Effect.forkScoped(Effect.forever(
        PubSub.take(subscription).pipe(Effect.flatMap((request) => this.forwardTransition(
          transitions,
          request,
        ))),
      ))
      return transitions
    })
  }

  private forwardTransition(
    target: PubSub.PubSub<TerminalTransitionRequest>,
    request: CodexTuiProxyTransitionRequest,
  ): Effect.Effect<void> {
    const self = this
    const forwarded = Effect.gen(function*() {
      const acknowledgment = yield* Deferred.make<void, TerminalTransitionAcknowledgmentError>()
      const published = yield* PubSub.publish(target, {
        event: self.toTransition(request.transition),
        acknowledgment,
      })
      if (!published) {
        return yield* Effect.fail(self.providerError(
          "nativeSessionTransition",
          "Codex terminal transition channel was closed",
        ))
      }
      yield* Deferred.await(acknowledgment)
    })
    return forwarded.pipe(
      Effect.onExit((exit) => Exit.isSuccess(exit)
        ? Deferred.succeed(request.acknowledgment, undefined)
        : Deferred.fail(request.acknowledgment, new CodexTuiProxyError({
          operation: "publish-transition",
          message: "The Codex terminal transition was not acknowledged",
          cause: Cause.squash(exit.cause),
        }))),
      Effect.exit,
      Effect.asVoid,
    )
  }

  private toTransition(observed: CodexTuiProxyTransition): TerminalTransitionEvent {
    if (observed._tag === "TransitionFailed") {
      return {
        _tag: "TransitionFailed",
        error: this.providerError(
          "nativeSessionTransition",
          `Codex ${observed.operation} transition failed: ${observed.error.message}`,
          observed.error,
        ),
      }
    }
    try {
      const session = sessionFromTransition(observed)
      return {
        _tag: "SessionChanged",
        session,
        ...(observed.operation === "fork"
          ? { derivation: this.deriveNativeFork(observed) }
          : {}),
      }
    } catch (cause) {
      return {
        _tag: "TransitionFailed",
        error: this.protocolError(
          "nativeSessionTransition",
          "Codex reported invalid session transition metadata",
          cause,
        ),
      }
    }
  }

  private deriveNativeFork(
    observed: CodexThreadTransition,
  ): Effect.Effect<BranchDerivation | undefined, ProviderError | ProviderProtocolError> {
    const parentSessionId = observed.requestedThreadId ?? observed.previousThreadId
    return this.withServer((server) => Effect.gen({ self: this }, function*() {
      if (observed.forkPointTurnId === undefined) {
        return yield* Effect.fail(this.protocolError(
          "deriveNativeFork",
          `Fork ${observed.threadId} did not report its requested source turn`,
        ))
      }
      const [parentThread, childThread] = yield* Effect.all([
        this.requireThread(server, parentSessionId, "deriveNativeFork"),
        this.requireThread(server, observed.threadId, "deriveNativeFork"),
      ], { concurrency: 2 })
      const [parentInProject, childInProject] = yield* Effect.all([
        this.threadBelongsToProject(parentThread),
        this.threadBelongsToProject(childThread),
      ])
      if (!parentInProject || !childInProject) {
        return yield* Effect.fail(this.protocolError(
          "deriveNativeFork",
          `Fork ${observed.threadId} is outside the canonical project`,
        ))
      }
      const [parent, child] = yield* Effect.all([
        this.normalizeThread(parentThread, "deriveNativeFork"),
        this.normalizeThread(childThread, "deriveNativeFork"),
      ])
      const sourceIndex = parent.findLastIndex(
        (message) => message.turnId === observed.forkPointTurnId,
      )
      if (sourceIndex < 0) {
        return yield* Effect.fail(this.protocolError(
          "deriveNativeFork",
          `Fork ${observed.threadId} requested source turn ${observed.forkPointTurnId} is not present in its source`,
        ))
      }
      if (child.length !== sourceIndex + 1) {
        return yield* Effect.fail(this.protocolError(
          "deriveNativeFork",
          `Fork ${observed.threadId} copied ${child.length} items; expected exactly ${sourceIndex + 1} through requested source turn ${observed.forkPointTurnId}`,
        ))
      }
      for (let index = 0; index < child.length; index += 1) {
        if (!sameCopiedCodexMessage(parent[index]!, child[index]!)) {
          return yield* Effect.fail(this.protocolError(
            "deriveNativeFork",
            `Fork ${observed.threadId} copied history does not exactly match its source`,
          ))
        }
      }
      const source = parent[sourceIndex]!
      yield* this.validateForkTarget(source, parentThread).pipe(
        Effect.mapError((error) => new ProviderProtocolError({
          providerId: error.providerId,
          operation: "deriveNativeFork",
          message: error.message,
          ...(error.cause === undefined ? {} : { cause: error.cause }),
        })),
      )
      return {
        childSessionId: observed.threadId,
        parentSessionId,
        sourceMessageId: source.id,
        sharedMessages: child.map((message, index) => ({
          parentMessageId: parent[index]!.id,
          childMessageId: message.id,
        })),
      }
    }), "deriveNativeFork", true)
  }

  private validateSessionId(
    sessionId: string,
    operation: string,
  ): Effect.Effect<void, ProviderProtocolError> {
    return isValidSessionId(sessionId)
      ? Effect.void
      : Effect.fail(this.protocolError(
          operation,
          "Codex session IDs must be non-empty and cannot contain null bytes",
        ))
  }

  private transport<A, R>(
    effect: Effect.Effect<A, CodexAppServerError, R>,
    operation: string,
  ): Effect.Effect<A, ProviderError | ProviderProtocolError, R> {
    return effect.pipe(Effect.mapError((error) => this.mapTransportError(operation, error)))
  }

  private mapTransportError(
    operation: string,
    cause: unknown,
  ): ProviderError | ProviderProtocolError {
    if (cause instanceof ProviderError || cause instanceof ProviderProtocolError) return cause
    const message = `Codex ${operation} failed: ${errorMessage(cause)}`
    return cause instanceof CodexProtocolError
      ? this.protocolError(operation, message, cause)
      : this.providerError(operation, message, cause)
  }

  private providerError(operation: string, message: string, cause?: unknown): ProviderError {
    return new ProviderError({
      providerId: this.id,
      operation,
      message,
      ...(cause === undefined ? {} : { cause }),
    })
  }

  private protocolError(
    operation: string,
    message: string,
    cause?: unknown,
  ): ProviderProtocolError {
    return new ProviderProtocolError({
      providerId: this.id,
      operation,
      message,
      ...(cause === undefined ? {} : { cause }),
    })
  }
}

export function createCodexProvider(
  projectPath: string,
  dependencies: CodexProviderDependencies = {},
  options: CodexProviderOptions = {},
): Effect.Effect<CodexProvider, ProviderError | ProviderProtocolError> {
  return Effect.gen(function*() {
    const executable = yield* Effect.tryPromise({
      try: () => Promise.resolve(
        (dependencies.resolveExecutable ?? (() => Bun.which("codex")))(),
      ),
      catch: (cause) => new ProviderError({
        providerId: "codex",
        operation: "createProvider",
        message: "Could not locate the Codex executable",
        cause,
      }),
    })
    if (typeof executable !== "string" || executable.length === 0 || executable.includes("\0")) {
      return yield* Effect.fail(new ProviderError({
        providerId: "codex",
        operation: "createProvider",
        message: "Codex was not found on PATH",
      }))
    }
    const canonicalPath = yield* Effect.tryPromise({
      try: () => Promise.resolve((dependencies.canonicalize ?? realpath)(projectPath)),
      catch: (cause) => new ProviderError({
        providerId: "codex",
        operation: "createProvider",
        message: `Could not canonicalize Codex project path ${projectPath}`,
        cause,
      }),
    })
    if (!isCanonicalPathCandidate(canonicalPath)) {
      return yield* Effect.fail(new ProviderProtocolError({
        providerId: "codex",
        operation: "createProvider",
        message: "The canonical Codex project path is invalid",
      }))
    }
    return new CodexProvider(canonicalPath, executable, dependencies, options)
  })
}

export const makeCodexProvider = createCodexProvider

export function codexProviderLayer(
  projectPath: string,
  dependencies: CodexProviderDependencies = {},
  options: CodexProviderOptions = {},
): Layer.Layer<AgentProvider, ProviderError | ProviderProtocolError> {
  return Layer.effect(AgentProvider, createCodexProvider(projectPath, dependencies, options))
}

export const layer = codexProviderLayer
export const makeCodexProviderLayer = codexProviderLayer

export function normalizeCodexThread(thread: Pick<CodexThread, "turns">): readonly CodexMessage[] {
  if (!Array.isArray(thread.turns)) throw new Error("Codex transcript turns are not an array")
  const messages: CodexMessage[] = []
  const turnIds = new Set<string>()
  const itemIds = new Set<string>()
  for (const sourceTurn of thread.turns) {
    const candidateTurn: unknown = sourceTurn
    if (!isRecord(candidateTurn) || typeof candidateTurn.id !== "string" ||
      !isValidSessionId(candidateTurn.id) || turnIds.has(candidateTurn.id)) {
      throw new Error("Codex transcript turns do not have unique non-empty IDs")
    }
    if (!isTurnStatus(candidateTurn.status) || !Array.isArray(candidateTurn.items)) {
      throw new Error(`Codex turn ${candidateTurn.id} is invalid`)
    }
    const turn = candidateTurn as unknown as CodexTurn
    turnIds.add(turn.id)
    for (const [itemIndex, sourceItem] of turn.items.entries()) {
      const candidateItem: unknown = sourceItem
      if (!isRecord(candidateItem) || typeof candidateItem.id !== "string" ||
        !isValidSessionId(candidateItem.id) || itemIds.has(candidateItem.id) ||
        typeof candidateItem.type !== "string") {
        throw new Error("Codex transcript items do not have unique non-empty IDs and types")
      }
      const item = candidateItem as unknown as CodexThreadItem
      itemIds.add(item.id)
      const normalized = normalizeCodexItem(item)
      messages.push({
        id: item.id,
        ...normalized,
        ordinal: messages.length,
        rawItem: item,
        rawTurn: turn,
        copyIdentity: JSON.stringify(withoutItemId(item)) ?? "undefined",
        turnId: turn.id,
        turnStatus: turn.status,
        itemIndex,
        turnComplete: turn.status !== "inProgress",
      })
    }
  }
  return messages
}

export function formatCodexUserInput(content: readonly CodexUserInput[]): string {
  const parts = content.map((input) => {
    switch (input.type) {
      case "text":
        return typeof input.text === "string" ? input.text : "[text]"
      case "image":
        return "[image]"
      case "localImage":
        return "[localImage]"
      case "audio":
        return "[audio]"
      case "localAudio":
        return "[localAudio]"
      case "skill":
        return `[skill: ${typeof input.name === "string" ? input.name : "unknown"}]`
      case "mention":
        return `[mention: ${typeof input.name === "string" ? input.name : "unknown"}]`
      default:
        return `[${input.type || "input"}]`
    }
  })
  return normalizePreview(parts.join(" "))
}

export function sameCopiedCodexMessage(parent: CodexMessage, child: CodexMessage): boolean {
  return parent.role === child.role &&
    parent.visible === child.visible &&
    parent.turnStatus === child.turnStatus &&
    parent.itemIndex === child.itemIndex &&
    isDeepStrictEqual(withoutItemId(parent.rawItem), withoutItemId(child.rawItem))
}

export function makeObservedServices(
  executable: string,
  initialThreadId: string,
  dependencies: CodexObservedServicesDependencies = {},
): Effect.Effect<CodexObservedServices, CodexObservedServicesError, Scope.Scope> {
  return Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
    const sidecar = yield* restore((dependencies.sidecarFactory ?? makeCodexSidecar)(executable))
    const readiness = yield* Effect.exit(
      restore((dependencies.waitUntilReady ?? waitForSidecar)(sidecar).pipe(
        Effect.timeoutOrElse({
          duration: SIDECAR_START_TIMEOUT_MS,
          orElse: () => Effect.fail(new CodexSidecarError({
            operation: "connect",
            message: `Codex app-server did not become ready within ${SIDECAR_START_TIMEOUT_MS}ms`,
          })),
        }),
      )),
    )
    if (Exit.isFailure(readiness)) {
      const rollback = yield* Effect.exit(boundedObservedCleanup(sidecar.close()))
      if (Exit.isFailure(rollback)) {
        return yield* Effect.fail(new CodexSidecarError({
          operation: "acquire-rollback",
          message: "Codex sidecar readiness failed and rollback was incomplete",
          cause: new AggregateError([
            Cause.squash(readiness.cause),
            Cause.squash(rollback.cause),
          ]),
        }))
      }
      return yield* Effect.failCause(readiness.cause)
    }

    const proxyAcquisition = yield* Effect.exit(restore((dependencies.proxyFactory ?? makeCodexTuiProxy)({
      upstreamUrl: sidecar.remoteUrl,
      bearerToken: sidecar.bearerToken,
      initialThreadId,
    }).pipe(Effect.timeoutOrElse({
      duration: SIDECAR_START_TIMEOUT_MS,
      orElse: () => Effect.fail(new CodexTuiProxyError({
        operation: "listen",
        message: `Codex TUI proxy did not start within ${SIDECAR_START_TIMEOUT_MS}ms`,
      })),
    }))))
    if (Exit.isFailure(proxyAcquisition)) {
      const rollback = yield* Effect.exit(boundedObservedCleanup(sidecar.close()))
      if (Exit.isFailure(rollback)) {
        return yield* Effect.fail(new CodexSidecarError({
          operation: "acquire-rollback",
          message: "Codex TUI proxy acquisition failed and sidecar rollback was incomplete",
          cause: new AggregateError([
            Cause.squash(proxyAcquisition.cause),
            Cause.squash(rollback.cause),
          ]),
        }))
      }
      return yield* Effect.failCause(proxyAcquisition.cause)
    }
    const proxy = proxyAcquisition.value
    const close = () => Effect.gen(function*() {
      const failures: unknown[] = []
      yield* boundedObservedCleanup(proxy.close()).pipe(
        Effect.catch((error) => Effect.sync(() => failures.push(error))),
      )
      yield* boundedObservedCleanup(sidecar.close()).pipe(
        Effect.catch((error) => Effect.sync(() => failures.push(error))),
      )
      if (failures.length > 0) {
        return yield* Effect.fail(new CodexSidecarError({
          operation: "cleanup",
          message: "Unable to clean up Codex observed terminal services",
          cause: failures.length === 1 ? failures[0] : new AggregateError(failures),
        }))
      }
    })
    return {
      remoteUrl: proxy.remoteUrl,
      bearerToken: sidecar.bearerToken,
      transitions: proxy.transitions,
      close,
    }
  }))
}

function boundedObservedCleanup<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | CodexSidecarError> {
  return effect.pipe(Effect.timeoutOrElse({
    duration: OBSERVED_SERVICES_CLEANUP_TIMEOUT_MS,
    orElse: () => Effect.fail(new CodexSidecarError({
      operation: "cleanup",
      message: `Codex observed-services cleanup timed out after ${OBSERVED_SERVICES_CLEANUP_TIMEOUT_MS}ms`,
    })),
  }))
}

function waitForSidecar(
  sidecar: CodexSidecar,
): Effect.Effect<void, CodexAppServerError | CodexSidecarError> {
  return Effect.gen(function*() {
    const startedAt = yield* Clock.currentTimeMillis
    const deadline = startedAt + SIDECAR_START_TIMEOUT_MS
    let lastError: CodexAppServerError | undefined
    while (true) {
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) break
      if (sidecar.process.exitCode !== null) {
        const detail = yield* sidecar.stderr
        return yield* Effect.fail(new CodexSidecarError({
          operation: "connect",
          message: `Codex app-server exited before accepting connections${detail ? `: ${detail}` : ""}`,
        }))
      }
      const result = yield* Effect.matchEffect(
        Effect.scoped(connectCodexAppServerSidecar(sidecar.remoteUrl, {
          bearerToken: sidecar.bearerToken,
          connectTimeoutMs: Math.min(250, Math.max(1, deadline - now)),
          requestTimeoutMs: Math.min(250, Math.max(1, deadline - now)),
          shutdownTimeoutMs: 100,
        })),
        {
          onFailure: (error) => Effect.succeed({ _tag: "Failure" as const, error }),
          onSuccess: () => Effect.succeed({ _tag: "Success" as const }),
        },
      )
      if (result._tag === "Success") return
      lastError = result.error
      yield* Effect.sleep(SIDECAR_RETRY_DELAY_MS)
    }
    return yield* Effect.fail(lastError ?? new CodexSidecarError({
      operation: "connect",
      message: `Codex app-server did not accept connections within ${SIDECAR_START_TIMEOUT_MS}ms`,
    }))
  })
}

function normalizeCodexItem(
  item: CodexThreadItem,
): Pick<AgentMessage, "role" | "preview" | "visible"> {
  if (item.type === "userMessage") {
    const preview = formatCodexUserInput(Array.isArray(item.content) ? item.content : [])
    if (preview !== "[empty message]") return { role: "user", preview, visible: true }
  }
  if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
    return { role: "agent", preview: normalizePreview(item.text), visible: true }
  }
  return { role: "system", preview: `[${item.type || "unknown item"}]`, visible: false }
}

function withoutItemId(item: CodexThreadItem): Record<string, unknown> {
  const { id: _id, ...payload } = item
  return payload
}

function toSession(thread: CodexThread): AgentSession {
  if (!isValidSessionId(thread.id) || !Number.isFinite(thread.updatedAt)) {
    throw new Error("Codex session ID or timestamp is invalid")
  }
  const title = firstNonempty(thread.name, thread.preview) ?? "Untitled conversation"
  return {
    id: thread.id,
    title: normalizePreview(title),
    lastModified: thread.updatedAt * 1_000,
    ...(thread.gitInfo?.branch ? { gitBranch: thread.gitInfo.branch } : {}),
  }
}

function provisionalSessionFromThread(thread: CodexThread, now: number): AgentSession {
  const title = firstNonempty(thread.name, thread.preview) ?? "Untitled conversation"
  return {
    id: thread.id,
    title: normalizePreview(title),
    lastModified: Number.isFinite(thread.updatedAt) ? thread.updatedAt * 1_000 : now,
    ...(thread.gitInfo?.branch ? { gitBranch: thread.gitInfo.branch } : {}),
  }
}

function sessionFromTransition(transition: CodexThreadTransition): AgentSession {
  if (!isValidSessionId(transition.threadId) || !Number.isFinite(transition.updatedAt)) {
    throw new Error("Codex transition has an invalid thread ID or timestamp")
  }
  return {
    id: transition.threadId,
    title: normalizePreview(firstNonempty(transition.title) ?? "Untitled conversation"),
    lastModified: transition.updatedAt * 1_000,
    transient: true,
  }
}

function firstNonempty(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "[empty message]"
}

function isOverloadedCodexError(error: CodexAppServerError): boolean {
  return error instanceof CodexRpcError && error.code === -32001
}

function isMissingCodexThreadErrorCause(error: unknown): boolean {
  if (!(error instanceof CodexRpcError) || error.code !== -32600) return false
  if (isRecord(error.data)) {
    const appErrorCode = error.data.appErrorCode
    if (appErrorCode === "thread_not_found" || appErrorCode === "rollout_not_found") return true
  }
  return /no rollout found for (?:thread|conversation) id/iu.test(error.message)
}

function isValidSessionId(value: string): boolean {
  return value.length > 0 && !value.includes("\0")
}

function isCanonicalPathCandidate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value)
}

function isTurnStatus(value: unknown): value is CodexTurnStatus {
  return value === "completed" || value === "interrupted" || value === "failed" ||
    value === "inProgress"
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBranchOutcome(value: unknown): boolean {
  return isRecord(value) && (
    value._tag === "ValidatedBranch" ||
    value._tag === "CreatedIndependentSession" ||
    value._tag === "AmbiguousBranchMutation"
  )
}
