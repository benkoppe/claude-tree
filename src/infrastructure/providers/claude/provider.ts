import { randomUUID as nodeRandomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import {
  forkSession,
  getSessionMessages,
  getSessionInfo,
  importSessionToStore,
  listSessions,
  type SDKSessionInfo,
  type SessionMessage,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk"
import { Clock, Effect, Layer } from "effect"
import { optionalOperationTimeout, withOperationTimeout } from "../../../services/operation-deadline"

import { ProviderError, ProviderProtocolError } from "../../../domain/errors"
import type {
  AgentSession,
  AgentSessionSnapshot,
  MessageRef,
  TerminalObserver,
  TranscriptRead,
} from "../../../domain/model"
import {
  AgentProvider,
  SESSION_SNAPSHOT_BATCH_SIZE,
  type AgentProviderApi,
  type AmbiguousBranchMutation,
  type BranchOutcome,
  type BranchCreated,
  type BranchVerificationReceipt,
  type CreatedIndependentSession,
  type ValidatedBranch,
  makeBranchMutationReconciliationSignal,
  type PreparedTerminal,
  type TerminalLaunch,
} from "../../../services/provider"
import { ClaudeTerminalObserver } from "./terminal-observer"
import { makeClaudeLifecycleHooks } from "./lifecycle-hooks"
import { NavigationHistoryError, projectNavigationHistoryFromEvidence } from "./navigation-history"
import { RecordEvidence } from "./record-evidence"
import { markCompactionSummaries, normalizeTranscript, normalizePreview, sourceRole, type ClaudeMessage } from "./transcript"
export { formatMessage, extractUserPromptText } from "./transcript"
import { safeHistoryFailure, type HistoryTrace, type HistoryStage, type HistoryFailure } from "../../../diagnostics/history-trace"

export interface ClaudeSdk {
  readonly getSessionInfo: (sessionId: string, options: { readonly dir: string }) => Promise<SDKSessionInfo | undefined>
  readonly listSessions: (options: {
    readonly dir: string
    readonly includeWorktrees: boolean
    readonly includeProgrammatic: boolean
  }) => Promise<readonly SDKSessionInfo[]>
  readonly getSessionMessages: (
    sessionId: string,
    options: { readonly dir: string; readonly sessionStore?: SessionStore; readonly includeSystemMessages?: boolean },
  ) => Promise<readonly SessionMessage[] | null | undefined>
  readonly forkSession: (
    sessionId: string,
    options: { readonly dir: string; readonly upToMessageId: string },
  ) => Promise<{ readonly sessionId: string }>
  readonly importSessionToStore: (
    sessionId: string,
    store: SessionStore,
    options: { readonly dir?: string; readonly includeSubagents: boolean },
  ) => Promise<void>
}

export interface ClaudeProviderDependencies {
  readonly sdk?: ClaudeSdk
  readonly resolveExecutable?: () => string | null | PromiseLike<string | null>
  readonly observerFactory?: () => TerminalObserver
  readonly randomUUID?: () => string
}

export interface ClaudeProviderOptions {
  readonly operationTimeoutMs?: number
  readonly executableLookupTimeoutMs?: number
  readonly forkSessionTimeoutMs?: number
  readonly forkValidationRetryDelaysMs?: readonly number[]
  readonly forkValidationTimeoutMs?: number
  readonly listSessionsTimeoutMs?: number
  readonly transcriptReadTimeoutMs?: number
  readonly provenanceImportTimeoutMs?: number
}

const defaultSdk: ClaudeSdk = {
  getSessionInfo,
  listSessions,
  getSessionMessages,
  forkSession,
  importSessionToStore,
}

const DEFAULT_FORK_VALIDATION_RETRY_DELAYS_MS = [25, 50, 100, 200]
const TRANSCRIPT_READ_CONCURRENCY = 8


interface ClaudeActiveContext {
  readonly messages: readonly ClaudeMessage[]
  readonly systemIds: readonly string[]
  /** SDK-selected system tail anchors compaction even when no user/agent is visible. */
  readonly systemAnchorId?: string
}

interface ConversationRecord {
  readonly id: string
  readonly type: "user" | "assistant"
  readonly message: unknown
  readonly forkedFrom?: {
    readonly sessionId: string
    readonly messageUuid: string
  }
}

interface SourcePrefix {
  readonly records: readonly ConversationRecord[]
  readonly activeMessageIds: readonly string[]
  readonly historyMessageIds: readonly string[]
}

interface OperationDeadline {
  readonly operation: string
  readonly expiresAt: number | undefined
  readonly timeoutMs: number | undefined
}

interface TimeoutBudget {
  readonly durationMs: number | undefined
  readonly error: () => ProviderError
}

type ForkValidation =
  | {
      readonly _tag: "Valid"
      readonly sharedMessages: readonly {
        readonly parentMessageId: string
        readonly childMessageId: string
      }[]
    }
  | { readonly _tag: "Short"; readonly reason: string }
  | { readonly _tag: "Invalid"; readonly reason: string }

type ForkReadResult =
  | {
      readonly _tag: "Valid"
      readonly transcript: TranscriptRead
      readonly sharedMessages: readonly {
        readonly parentMessageId: string
        readonly childMessageId: string
      }[]
    }
  | { readonly _tag: "NotValidated"; readonly transcript: TranscriptRead; readonly reason: string;
      readonly status: "pending" | "unavailable" | "contradicted";
      readonly reasonCode: "missing" | "incomplete" | "read-failed" | "unsupported" | "copy-mismatch" | "deadline" }

export class ClaudeProvider implements AgentProviderApi {
  readonly id = "claude"
  readonly displayName = "Claude Code"
  readonly capabilities = {
    historicalBranching: true,
    exactMessageForks: true,
    completedTurnForks: false,
    userMessageReplay: true,
    temporarySessionIds: true,
    nativeSessionSwitching: false,
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

  private readonly sdk: ClaudeSdk
  private readonly resolveExecutable: () => string | null | PromiseLike<string | null>
  private readonly observerFactory: () => TerminalObserver
  private readonly makeUuid: () => string
  private readonly branchMutationReconciliations = makeBranchMutationReconciliationSignal()
  private sessionTitles: ReadonlyMap<string, string> = new Map()
  private readonly retryDelays: readonly number[]
  private readonly operationTimeoutMs: number | undefined
  private readonly executableLookupTimeoutMs: number | undefined
  private readonly forkSessionTimeoutMs: number | undefined
  private readonly forkValidationTimeoutMs: number | undefined
  private readonly listSessionsTimeoutMs: number | undefined
  private readonly transcriptReadTimeoutMs: number | undefined
  private readonly provenanceImportTimeoutMs: number | undefined
  private readonly timeoutErrors = new WeakSet<object>()

  constructor(
    private readonly projectPath: string,
    dependencies: ClaudeProviderDependencies = {},
    options: ClaudeProviderOptions = {},
  ) {
    this.sdk = dependencies.sdk ?? defaultSdk
    this.resolveExecutable = dependencies.resolveExecutable ?? (() => Bun.which("claude"))
    this.observerFactory = dependencies.observerFactory ?? (() => new ClaudeTerminalObserver())
    this.makeUuid = dependencies.randomUUID ?? nodeRandomUUID
    this.takeBranchMutationReconciliation = this.branchMutationReconciliations.take
    this.retryDelays =
      options.forkValidationRetryDelaysMs ?? DEFAULT_FORK_VALIDATION_RETRY_DELAYS_MS
    this.operationTimeoutMs = optionalOperationTimeout(options.operationTimeoutMs)
    this.executableLookupTimeoutMs = optionalOperationTimeout(options.executableLookupTimeoutMs)
    this.forkSessionTimeoutMs = optionalOperationTimeout(options.forkSessionTimeoutMs)
    this.forkValidationTimeoutMs = optionalOperationTimeout(options.forkValidationTimeoutMs)
    this.listSessionsTimeoutMs = optionalOperationTimeout(options.listSessionsTimeoutMs)
    this.transcriptReadTimeoutMs = optionalOperationTimeout(options.transcriptReadTimeoutMs)
    this.provenanceImportTimeoutMs = optionalOperationTimeout(options.provenanceImportTimeoutMs)

    this.loadSessionSnapshot = this.loadSessionSnapshotProgressively(() => Effect.void)

    this.prepareNewSession = this.prepareTransientSession()
  }

  loadSessionSnapshotProgressively(publish: (snapshot: AgentSessionSnapshot) => Effect.Effect<void>) {
    return Effect.gen({ self: this }, function*() {
      const deadline = yield* this.makeDeadline("loadSessionSnapshot", this.operationTimeoutMs)
      const sessions = yield* this.listSessionSummaries(deadline)
      yield* publish({ sessions, transcripts: new Map() })
      const transcripts = yield* this.readTranscriptsWithin(
        sessions.map((session) => session.id),
        deadline,
        (transcripts) => publish({ sessions: [], transcripts }),
      )
      return { sessions, transcripts }
    })

  }

  observeSessionSummaries(sessions: readonly AgentSession[]): void {
    this.sessionTitles = new Map([...this.sessionTitles, ...sessions.map((session) => [session.id, session.title] as const)])
  }

  readTranscripts(
    sessionIds: readonly string[],
    trace?: HistoryTrace,
  ): Effect.Effect<ReadonlyMap<string, TranscriptRead>, ProviderError | ProviderProtocolError> {
    return Effect.gen({ self: this }, function*() {
      const deadline = yield* this.makeDeadline("readTranscripts", this.operationTimeoutMs)
      return yield* this.readTranscriptsWithin(sessionIds, deadline, undefined, trace)
    })
  }

  loadSessionSnapshotFor(
    sessionIds: readonly string[],
  ): Effect.Effect<AgentSessionSnapshot, ProviderError | ProviderProtocolError> {
    return Effect.gen({ self: this }, function*() {
      const deadline = yield* this.makeDeadline("loadSessionSnapshotFor", this.operationTimeoutMs)
      const summaries = yield* Effect.forEach(unique(sessionIds), (id) => this.callSdk(
        "getSessionInfo", () => this.sdk.getSessionInfo(id, { dir: this.projectPath }), this.listSessionsTimeoutMs, deadline,
      ).pipe(Effect.flatMap((info) => Effect.try({
        try: () => {
          if (info === undefined) return undefined
          if (info.sessionId !== id) throw new Error("Session metadata belongs to another session")
          return toSessionSummary(info)
        },
        catch: (cause) => this.protocolError("getSessionInfo", "Claude returned invalid session metadata", cause),
      }))), { concurrency: TRANSCRIPT_READ_CONCURRENCY })
      const sessions = summaries.filter((session): session is AgentSession => session !== undefined)
      this.sessionTitles = new Map([...this.sessionTitles, ...sessions.map((session) => [session.id, session.title] as const)])
      const transcripts = yield* this.readTranscriptsWithin(sessionIds, deadline)
      return { sessions, transcripts }
    })
  }

  private readTranscriptsWithin(
    sessionIds: readonly string[],
    deadline: OperationDeadline,
    publish?: (transcripts: ReadonlyMap<string, TranscriptRead>) => Effect.Effect<void>,
    trace?: HistoryTrace,
  ): Effect.Effect<ReadonlyMap<string, TranscriptRead>> {
    const pending = new Map<string, TranscriptRead>()
    return Effect.all(
      unique(sessionIds).map((sessionId) =>
        Effect.gen({ self: this }, function*() {
          const readDeadline = publish ? yield* this.makeDeadline("readTranscripts", this.operationTimeoutMs) : deadline
          const context = yield* this.traced(trace, "active-context", sessionId,
            this.readActiveContext(sessionId, "readTranscripts", readDeadline), (context) => context?.messages.length ?? 0)
          if (context === undefined) return { _tag: "Missing" as const }
          if (context.messages.length === 0 && context.systemAnchorId === undefined) {
            const info = yield* this.traced(trace, "session-info", sessionId, this.callSdk("getSessionInfo", () => this.sdk.getSessionInfo(sessionId, { dir: this.projectPath }),
              this.listSessionsTimeoutMs, readDeadline))
            if (info === undefined) return { _tag: "Missing" as const }
          }
          const entries = yield* this.traced(trace, "session-records", sessionId,
            this.readSessionEntries(sessionId, "readTranscripts", readDeadline), (entries) => entries.length)
          const evidence = new RecordEvidence(entries, new Map([[sessionId, entries]]), trace)
          const sdkContext = this.contextSnapshot(context, entries, evidence)
          const navigation = yield* this.traced(trace, "navigation-history", sessionId,
            this.readNavigationHistory(sessionId, context, entries, "readTranscripts", readDeadline, trace, evidence), (messages) => messages.length).pipe(Effect.result)
          if (navigation._tag === "Success") return { _tag: "Available" as const, messages: navigation.success, context: sdkContext }
          const error = navigation.failure
          const gap = error.cause
          if (!(gap instanceof NavigationHistoryError) || gap.kind !== "history-gap") return yield* Effect.fail(error)
          yield* Effect.try({
            try: () => this.validateContextSnapshot(sessionId, context, evidence),
            catch: (cause) => this.protocolError("readTranscripts", "SDK context does not match the imported session records", cause),
          }).pipe(Effect.tapError(() => Effect.sync(() => trace?.fail("validation", "active-record-mismatch", sessionId))))
          return { _tag: "Available" as const, messages: sdkContext.messages, context: sdkContext,
            coverage: { _tag: "Limited" as const, boundaryId: gap.recordId, reason: "historical-parent-unproven" as const } }
        }).pipe(
          Effect.match({
            onFailure: (error): readonly [string, TranscriptRead] => [
              sessionId,
              { _tag: "Unavailable", reason: error.message },
            ],
            onSuccess: (read): readonly [string, TranscriptRead] => [sessionId, read],
          }),
          Effect.tap(([id, read]) => Effect.suspend(() => {
            if (!publish) return Effect.void
            pending.set(id, read)
            if (pending.size < SESSION_SNAPSHOT_BATCH_SIZE) return Effect.void
            const batch = new Map(pending)
            pending.clear()
            return publish(batch)
          })),
        ),
      ),
      { concurrency: TRANSCRIPT_READ_CONCURRENCY },
    ).pipe(Effect.map((entries) => new Map(entries)))
  }

  prepareResume(
    session: AgentSession,
  ): Effect.Effect<PreparedTerminal, ProviderError | ProviderProtocolError> {
    return this.validateLaunchInput(session.id, undefined).pipe(
      Effect.map(() => ({
        session,
        acquireLaunch: this.acquireLaunch("resume", session.id),
      })),
    )
  }

  branchFrom(
    target: MessageRef,
    created?: BranchCreated,
  ): Effect.Effect<BranchOutcome, ProviderError | ProviderProtocolError> {
    let mutationMayHaveDispatched = false
    let mutationSourceMessageId = target.messageId
    let knownChild: BranchVerificationReceipt | undefined
    const operation = Effect.gen({ self: this }, function*() {
      const deadline = yield* this.makeDeadline(
        "branchFrom",
        this.operationTimeoutMs,
      )
      const sourceEntries = yield* this.readSessionEntries(target.sessionId, "branchFrom", deadline)
      const activeContext = yield* this.requireActiveContext(
        target.sessionId,
        "branchFrom",
        deadline,
      )
      const activeTranscript = activeContext.messages
      const sourceTranscript = yield* this.readNavigationHistory(target.sessionId, activeContext, sourceEntries, "branchFrom", deadline)
      const selectedIndex = sourceTranscript.findIndex((message) => message.id === target.messageId)
      const selected = sourceTranscript[selectedIndex]
      if (selected === undefined) {
        return yield* Effect.fail(this.providerError(
          "branchFrom",
          "The selected historical message is no longer available",
        ))
      }

      let forkIndex = selectedIndex
      let replayText: string | undefined
      if (selected.role === "user") {
        replayText = selected.replayText
        if (replayText === undefined) {
          return yield* Effect.fail(this.protocolError(
            "branchFrom",
            "This user message contains content that Claude Code cannot prefill exactly",
          ))
        }
        forkIndex = -1
        for (let index = selectedIndex - 1; index >= 0; index -= 1) {
          if (sourceTranscript[index]?.role === "agent") {
            forkIndex = index
            break
          }
        }
      }

      yield* this.validateLaunchInput("pending", replayText, false)
      if (forkIndex < 0) {
        const prepared = yield* this.prepareTransientSession(replayText)
        return {
          _tag: "ValidatedBranch" as const,
          ...prepared,
          derivation: {
            childSessionId: prepared.session.id,
            parentSessionId: target.sessionId,
            sourceMessageId: selected.id,
            sharedMessages: [],
          },
        }
      }

      const forkMessage = sourceTranscript[forkIndex]
      if (forkMessage === undefined || forkMessage.sourceType === "system") {
        return yield* Effect.fail(this.protocolError(
          "branchFrom",
          "Claude can only fork user or assistant conversation records",
        ))
      }

      const sourceRecords = yield* this.normalizeRecords(sourceEntries, "branchFrom", target.sessionId)
      const activeForkIndex = activeTranscript.findIndex((message) => message.id === forkMessage.id)
      const sourceIndex = sourceEntries.findIndex((entry) => entry.uuid === forkMessage.id && (entry.type === "user" || entry.type === "assistant"))
      const entryIndexes = new Map(sourceEntries.flatMap((entry, index) =>
        typeof entry.uuid === "string" && (entry.type === "user" || entry.type === "assistant" || entry.type === "system")
          ? [[entry.uuid, index] as const] : []))
      const contextBeyondBoundary = (activeContext.systemAnchorId !== undefined &&
        (entryIndexes.get(activeContext.systemAnchorId) ?? -1) > sourceIndex) ||
        activeTranscript.slice(0, activeForkIndex + 1).some((message) => (entryIndexes.get(message.id) ?? -1) > sourceIndex)
      const activePrefix = activeForkIndex >= 0 && !contextBeyondBoundary
        ? activeTranscript.slice(0, activeForkIndex + 1)
        : yield* this.readStoredTranscript(target.sessionId, sourceEntries.slice(0, sourceIndex + 1), "branchFrom", deadline)
      const sourcePrefix = yield* this.validateSourcePrefix(
        target.sessionId,
        activePrefix,
        sourceRecords,
        forkMessage.id,
        sourceTranscript,
      )
      const parentTitle = this.sessionTitles.get(target.sessionId) ?? "Conversation"
      mutationSourceMessageId = forkMessage.id
      const forkResult = yield* Effect.uninterruptible(this.forkSessionOnce(
        target.sessionId,
        forkMessage.id,
        deadline,
        () => { mutationMayHaveDispatched = true },
      ).pipe(Effect.flatMap((forkResult) => Effect.gen({ self: this }, function*() {
        if (forkResult._tag === "AmbiguousBranchMutation") return forkResult

        const childId = forkResult.sessionId
        const now = yield* Clock.currentTimeMillis
        const childSession: AgentSession = {
          id: childId,
          title: `${parentTitle} (fork)`,
          lastModified: now,
        }
        const receipt: BranchVerificationReceipt = {
          session: childSession,
          verify: Effect.suspend(() => this.makeDeadline("validateFork", this.forkValidationTimeoutMs).pipe(
            Effect.flatMap((validationDeadline) => this.prepareCreatedFork(childSession, target.sessionId,
              forkMessage.id, sourcePrefix, validationDeadline, replayText, receipt)))),
        }
        knownChild = receipt
        if (created) yield* created(receipt)
        return { _tag: "Created" as const, receipt }
      }))))
      if (forkResult._tag === "AmbiguousBranchMutation") return forkResult
      const childSession = forkResult.receipt.session
      const postCreate = this.prepareCreatedFork(childSession, target.sessionId, forkMessage.id,
        sourcePrefix, deadline, replayText, forkResult.receipt)
      return yield* postCreate.pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed({
            _tag: "CreatedIndependentSession" as const,
            session: childSession,
            transcript: { _tag: "Unavailable" as const, reason: error.message },
            reason: error.message,
            verification: { status: "unavailable" as const, reasonCode: "read-failed" as const, receipt: forkResult.receipt },
          }),
          onSuccess: Effect.succeed,
        }),
      )
    })
    return operation.pipe(Effect.onInterrupt(() => mutationMayHaveDispatched && !knownChild
      ? Effect.sync(() => this.branchMutationReconciliations.offer(
          this.ambiguousBranchMutation(
            target.sessionId,
            mutationSourceMessageId,
            "Claude forkSession was interrupted after invocation; Claude may have created a child session",
          ),
        ))
      : Effect.void))
  }

  private forkSessionOnce(
    parentSessionId: string,
    sourceMessageId: string,
    deadline: OperationDeadline,
    dispatched: () => void,
  ): Effect.Effect<
    | { readonly _tag: "Created"; readonly sessionId: string }
    | AmbiguousBranchMutation,
    ProviderError | ProviderProtocolError
  > {
    return Effect.gen({ self: this }, function*() {
      const budget = yield* this.timeoutBudget(
        "forkSession",
        this.forkSessionTimeoutMs,
        deadline,
      )
      let settled: { readonly _tag: "Created"; readonly sessionId: string } | AmbiguousBranchMutation | undefined
      const decode = (value: unknown) => {
        if (!isRecord(value) || typeof value.sessionId !== "string" ||
          !isValidSessionId(value.sessionId) || value.sessionId === parentSessionId) {
          const ambiguity = this.ambiguousBranchMutation(parentSessionId, sourceMessageId,
            "Claude returned an invalid or non-distinct child session ID after creating a fork")
          this.branchMutationReconciliations.offer(ambiguity)
          return ambiguity
        }
        return { _tag: "Created" as const, sessionId: value.sessionId }
      }
      const request = Effect.promise(() => handledPromise(() => {
        dispatched()
        return this.sdk.forkSession(parentSessionId, { dir: this.projectPath, upToMessageId: sourceMessageId })
      }).then((value) => {
        settled = decode(value)
        return settled
      }, (cause) => {
        settled = this.ambiguousBranchMutation(parentSessionId, sourceMessageId,
          `Claude forkSession failed after invocation: ${errorMessage(cause)}; Claude may have created a child session`)
        return settled
      }))
      const result = yield* withOperationTimeout(Effect.uninterruptible(request), budget.durationMs,
          () => Effect.succeed(settled ?? this.ambiguousBranchMutation(
            parentSessionId,
            sourceMessageId,
            `${budget.error().message}; Claude may have created a child session`,
          )),
      )
      // Timeout fallback can be chosen before native settlement finishes. Prefer
      // the actual response retained while the interrupted child was finalizing.
      return settled ?? result
    })
  }

  private ambiguousBranchMutation(
    parentSessionId: string,
    sourceMessageId: string,
    reason: string,
  ): AmbiguousBranchMutation {
    return {
      _tag: "AmbiguousBranchMutation",
      providerId: this.id,
      parentSessionId,
      sourceMessageId,
      reason,
      reconciliation: "full-snapshot",
    }
  }

  private prepareTransientSession(
    draft?: string,
  ): Effect.Effect<PreparedTerminal, ProviderError | ProviderProtocolError> {
    return Effect.gen({ self: this }, function*() {
      yield* this.validateLaunchInput("pending", draft, false)
      const sessionId = yield* Effect.try({
        try: this.makeUuid,
        catch: (cause) => this.providerError(
          "prepareNewSession",
          "Could not allocate a Claude session ID",
          cause,
        ),
      })
      yield* this.validateLaunchInput(sessionId, draft)
      const now = yield* Clock.currentTimeMillis
      const session: AgentSession = {
        id: sessionId,
        title: "New conversation",
        lastModified: now,
        transient: true,
      }
      return {
        session,
        acquireLaunch: this.acquireLaunch("new", sessionId, draft),
      }
    })
  }

  private prepareCreatedFork(
    session: AgentSession,
    parentSessionId: string,
    sourceMessageId: string,
    sourcePrefix: SourcePrefix,
    deadline: OperationDeadline,
    replayText?: string,
    receipt?: BranchVerificationReceipt,
  ): Effect.Effect<ValidatedBranch | CreatedIndependentSession, ProviderError | ProviderProtocolError> {
    return Effect.gen({ self: this }, function*() {
      yield* this.validateLaunchInput(session.id, replayText)
      const validationDeadline = yield* this.makeDeadline("validateFork", this.forkValidationTimeoutMs)
      const effectiveDeadline = validationDeadline.expiresAt !== undefined &&
        (deadline.expiresAt === undefined || validationDeadline.expiresAt < deadline.expiresAt)
        ? validationDeadline : deadline
      const validation = yield* this.readAndValidateCreatedFork(
        session.id,
        parentSessionId,
        sourcePrefix,
        effectiveDeadline,
      )
      const acquireLaunch = this.acquireLaunch("resume", session.id, replayText)
      if (validation._tag === "NotValidated") {
        return {
          _tag: "CreatedIndependentSession",
          session,
          transcript: validation.transcript,
          reason: validation.reason,
          verification: { status: validation.status, reasonCode: validation.reasonCode, ...(receipt ? { receipt } : {}) },
        }
      }
      return {
        _tag: "ValidatedBranch",
        session,
        transcript: validation.transcript,
        acquireLaunch,
        derivation: {
          childSessionId: session.id,
          parentSessionId,
          sourceMessageId,
          sharedMessages: validation.sharedMessages,
        },
      }
    })
  }

  private readAndValidateCreatedFork(
    childSessionId: string,
    parentSessionId: string,
    sourcePrefix: SourcePrefix,
    deadline: OperationDeadline,
  ): Effect.Effect<ForkReadResult> {
    return Effect.gen({ self: this }, function*() {
      let transcript: TranscriptRead = {
        _tag: "Unavailable",
        reason: "The created Claude transcript has not been read",
      }
      let lastReason = "its copied prefix was not yet complete"
      let status: "pending" | "unavailable" | "contradicted" = "pending"
      let reasonCode: "missing" | "incomplete" | "read-failed" | "unsupported" | "copy-mismatch" | "deadline" = "incomplete"

      for (let attempt = 0; attempt <= this.retryDelays.length ||
        (deadline.expiresAt !== undefined && status === "pending"); attempt += 1) {
        if (attempt > 0) {
          const remaining = yield* this.remainingMillis(deadline)
          if (remaining <= 0) {
            lastReason = this.deadlineError(deadline).message
            status = "unavailable"
            reasonCode = "deadline"
            break
          }
          const delay = this.retryDelays[Math.min(attempt - 1, this.retryDelays.length - 1)] ?? DEFAULT_FORK_VALIDATION_RETRY_DELAYS_MS[0]!
          yield* Effect.sleep(Math.min(Math.max(deadline.expiresAt === undefined ? 0 : 1, delay), remaining))
        }

        const activeRead = yield* this.readActiveContext(
          childSessionId,
          "validateFork",
          deadline,
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: "Failure" as const, error }),
            onSuccess: (context) => ({ _tag: "Success" as const, context }),
          }),
        )
        if (activeRead._tag === "Failure") {
          transcript = { _tag: "Unavailable", reason: activeRead.error.message }
          lastReason = `its transcript could not be read: ${activeRead.error.message}`
          const failure = this.failureCode(activeRead.error, childSessionId)
          const missing = failure === "source-not-found"
          status = missing ? "pending" : "unavailable"
          reasonCode = missing ? "missing" : failure === "timeout" ? "deadline" : activeRead.error._tag === "ProviderProtocolError" ? "unsupported" : "read-failed"
          if (activeRead.error._tag === "ProviderProtocolError" && !missing) break
          continue
        }
        if (activeRead.context === undefined) {
          transcript = { _tag: "Missing" }
          lastReason = "its transcript is not available yet"
          status = "pending"
          reasonCode = "missing"
          continue
        }
        transcript = { _tag: "Available", messages: activeRead.context.messages }

        const physicalRead = yield* this.readSessionEntries(
          childSessionId,
          "validateFork",
          deadline,
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: "Failure" as const, error }),
            onSuccess: (entries) => ({ _tag: "Success" as const, entries }),
          }),
        )
        if (physicalRead._tag === "Failure") {
          lastReason = `its copied-prefix provenance could not be read: ${physicalRead.error.message}`
          const failure = this.failureCode(physicalRead.error, childSessionId)
          const missing = failure === "source-not-found"
          status = missing ? "pending" : "unavailable"
          reasonCode = missing ? "missing" : failure === "timeout" ? "deadline" : physicalRead.error._tag === "ProviderProtocolError" ? "unsupported" : "read-failed"
          if (physicalRead.error._tag === "ProviderProtocolError" && !missing) break
          continue
        }

        const validation = validateFork(
          parentSessionId,
          sourcePrefix,
          activeRead.context.messages,
          yield* this.normalizeRecords(physicalRead.entries, "validateFork", childSessionId),
        )
        if (validation._tag === "Valid") {
          return {
            _tag: "Valid" as const,
            transcript: { _tag: "Available" as const, context: this.contextSnapshot(activeRead.context, physicalRead.entries), messages: yield* this.readNavigationHistory(
              childSessionId, activeRead.context, physicalRead.entries, "validateFork", deadline,
            ) },
            sharedMessages: validation.sharedMessages,
          }
        }
        lastReason = validation.reason
        status = validation._tag === "Invalid" ? "contradicted" : "pending"
        reasonCode = validation._tag === "Invalid" ? "copy-mismatch" : "incomplete"
        if (validation._tag === "Invalid") break
      }

      return {
        _tag: "NotValidated" as const,
        transcript,
        reason: `Fork ${childSessionId} was created, but ${lastReason}`,
        status, reasonCode,
      }
    }).pipe(Effect.catch((error) => Effect.succeed({
      _tag: "NotValidated" as const,
      transcript: { _tag: "Unavailable" as const, reason: error.message },
      reason: `Fork ${childSessionId} was created, but its history could not be validated: ${error.message}`,
      status: "unavailable" as const,
      reasonCode: this.failureCode(error, childSessionId) === "timeout" ? "deadline" as const
        : error._tag === "ProviderProtocolError" ? "unsupported" as const : "read-failed" as const,
    })))
  }

  private validateSourcePrefix(
    sessionId: string,
    activePrefix: readonly ClaudeMessage[],
    physicalRecords: readonly ConversationRecord[],
    requestedMessageId: string,
    history: readonly ClaudeMessage[],
  ): Effect.Effect<SourcePrefix, ProviderProtocolError> {
    return Effect.gen({ self: this }, function*() {
      const requestedRecordIndex = physicalRecords.findIndex((record) => record.id === requestedMessageId)
      if (requestedRecordIndex < 0) {
        return yield* Effect.fail(this.protocolError(
          "branchFrom",
          "The selected Claude message is absent from the physical source transcript",
        ))
      }
      const records = physicalRecords.slice(0, requestedRecordIndex + 1)
      const physicalIndexById = new Map(records.map((record, index) => [record.id, index]))
      const historyPrefix = history.slice(0, history.findIndex((message) => message.id === requestedMessageId) + 1)
      const historyIds = new Set(historyPrefix.map((message) => message.id))
      for (const message of activePrefix) {
        if (!historyIds.has(message.id)) return yield* Effect.fail(this.protocolError("branchFrom",
          `Selected fork prefix contains record ${message.id} outside the validated navigation history`))
        const physicalIndex = physicalIndexById.get(message.id)
        const physical = physicalIndex === undefined ? undefined : records[physicalIndex]
        if (
          physicalIndex === undefined ||
          physical === undefined ||
          sourceRole(physical.type) !== message.role ||
          !isDeepStrictEqual(physical.message, message.rawMessage)
        ) {
          return yield* Effect.fail(this.protocolError(
            "branchFrom",
            `Claude's active source transcript does not match its physical records for session ${sessionId}`,
          ))
        }
      }
      if (activePrefix.at(-1)?.id !== requestedMessageId) {
        return yield* Effect.fail(this.protocolError(
          "branchFrom",
          "The selected Claude source boundary could not be validated exactly",
        ))
      }
      return {
        records,
        activeMessageIds: activePrefix
          .filter((message) => physicalIndexById.get(message.id)! <= requestedRecordIndex)
          .map((message) => message.id),
        historyMessageIds: historyPrefix
          .filter((message) => (physicalIndexById.get(message.id) ?? Infinity) <= requestedRecordIndex)
          .map((message) => message.id),
      }
    })
  }

  private listSessionSummaries(deadline: OperationDeadline): Effect.Effect<
    readonly AgentSession[],
    ProviderError | ProviderProtocolError
  > {
    return this.callSdk(
      "listSessions",
      () => this.sdk.listSessions({
        dir: this.projectPath,
        includeWorktrees: false,
        includeProgrammatic: true,
      }),
      this.listSessionsTimeoutMs,
      deadline,
    ).pipe(
      Effect.flatMap((sessions) => Effect.try({
        try: () => {
          if (!Array.isArray(sessions)) throw new Error("Claude returned a non-array session list")
          return sessions.map(toSessionSummary)
        },
        catch: (cause) => this.protocolError(
          "listSessions",
          "Claude returned invalid session metadata",
          cause,
        ),
      })),
      Effect.tap((sessions) => Effect.sync(() => {
        this.sessionTitles = new Map(sessions.map((session) => [session.id, session.title]))
      })),
    )
  }

  private requireActiveContext(
    sessionId: string,
    operation: string,
    deadline: OperationDeadline,
  ): Effect.Effect<ClaudeActiveContext, ProviderError | ProviderProtocolError> {
    return this.readActiveContext(sessionId, operation, deadline).pipe(
      Effect.flatMap((context) => context === undefined
        ? Effect.fail(this.providerError(operation, `Claude session ${sessionId} was not found`))
        : Effect.succeed(context)),
    )
  }

  private readActiveContext(
    sessionId: string,
    operation: string,
    deadline: OperationDeadline,
  ): Effect.Effect<ClaudeActiveContext | undefined, ProviderError | ProviderProtocolError> {
    return this.callSdk(
      operation,
      () => this.sdk.getSessionMessages(sessionId, { dir: this.projectPath, includeSystemMessages: true }),
      this.transcriptReadTimeoutMs,
      deadline,
    ).pipe(
      Effect.flatMap((messages) => {
        if (messages === null || messages === undefined) return Effect.succeed(undefined)
        return Effect.try({
          try: () => {
            if (!Array.isArray(messages)) throw new Error("Transcript is not an array")
            const systemAnchor = messages.findLast((message) => message.type === "system")
            if (systemAnchor && (typeof systemAnchor.uuid !== "string" || systemAnchor.uuid.length === 0)) {
              throw new Error("SDK-selected system record has no UUID")
            }
            return {
              messages: normalizeTranscript(sessionId, messages.filter((message) => message.type !== "system")),
              systemIds: messages.filter((message) => message.type === "system").map((message) => message.uuid),
              ...(systemAnchor ? { systemAnchorId: systemAnchor.uuid } : {}),
            }
          },
          catch: (cause) => this.protocolError(
            operation,
            `Claude returned an invalid transcript for session ${sessionId}`,
            cause,
          ),
        })
      }),
    )
  }

  private normalizeRecords(
    entries: readonly SessionStoreEntry[],
    operation: string,
    sessionId: string,
  ): Effect.Effect<readonly ConversationRecord[], ProviderError | ProviderProtocolError> {
    return Effect.try({
      try: () => normalizeConversationRecords(entries),
      catch: (cause) => this.protocolError(
        operation,
        `Claude returned invalid physical transcript records for session ${sessionId}`,
        cause,
      ),
    })
  }

  private contextSnapshot(context: ClaudeActiveContext, entries: readonly SessionStoreEntry[], evidence = new RecordEvidence(entries)): NonNullable<Extract<TranscriptRead, { _tag: "Available" }>["context"]> {
    const records = evidence.current.effective
    const boundaryId = context.systemIds.findLast((id) => {
      const record = records.get(id)
      return record?.type === "system" && record.subtype === "compact_boundary"
    }) ?? null
    return { messages: markCompactionSummaries(context.messages, [...records.values()]), boundaryId }
  }

  private validateContextSnapshot(sessionId: string, context: ClaudeActiveContext, evidence: RecordEvidence): void {
    const records = evidence.current.effective
    for (const message of context.messages) {
      const record = records.get(message.id)
      if (!record || record.type !== message.sourceType || !isDeepStrictEqual(record.message, message.rawMessage)) {
        throw new Error(`SDK context record ${message.id} does not match the imported session ${sessionId}`)
      }
    }
    if (context.systemIds.some((id) => records.get(id)?.type !== "system")) throw new Error("SDK-selected system evidence is missing")
  }

  private readNavigationHistory(
    sessionId: string,
    context: ClaudeActiveContext,
    entries: readonly SessionStoreEntry[],
    operation: string,
    deadline: OperationDeadline,
    trace?: HistoryTrace,
    evidence = new RecordEvidence(entries, new Map([[sessionId, entries]]), trace),
  ): Effect.Effect<readonly ClaudeMessage[], ProviderError | ProviderProtocolError> {
    return Effect.gen({ self: this }, function*() {
      const active = context.messages
      const projection = yield* this.projectNavigationHistoryWithProvenance(sessionId, entries, [
        ...active.map((message) => message.id), ...(context.systemAnchorId ? [context.systemAnchorId] : []),
      ], operation, deadline, evidence, trace)
      if (!projection.changed) return markCompactionSummaries(active, projection.sourceRecords)
      const messages = yield* this.traced(trace, "sdk-reconstruction", sessionId,
        this.readStoredTranscript(sessionId, projection.records, operation, deadline, context.systemAnchorId, trace), (messages) => messages.length)
      return yield* Effect.try({
        try: () => {
          const activeIds = new Set(active.map((message) => message.id))
          const normalized = markCompactionSummaries(messages, projection.sourceRecords)
          const historyById = new Map(normalized.map((message) => [message.id, message]))
          const mismatch = active.find((message) => historyById.get(message.id)?.copyIdentity !== message.copyIdentity ||
            historyById.get(message.id)?.role !== message.role)
          if (mismatch) {
            trace?.fail("validation", "active-record-mismatch", sessionId, mismatch.id)
            throw new Error(`Compaction history does not preserve active record ${mismatch.id} with its exact role and payload`)
          }
          return normalized.map((message) => activeIds.has(message.id) ? message : { ...message, historical: true as const })
        },
        catch: (cause) => this.protocolError(operation, `Claude compaction history could not be validated for session ${sessionId}: ${errorMessage(cause)}`, cause),
      })
    })
  }

  private projectNavigationHistoryWithProvenance(
    sessionId: string,
    entries: readonly SessionStoreEntry[],
    selectedIds: readonly string[],
    operation: string,
    deadline: OperationDeadline,
    evidence: RecordEvidence,
    trace?: HistoryTrace,
  ): Effect.Effect<ReturnType<typeof projectNavigationHistoryFromEvidence>, ProviderError | ProviderProtocolError> {
    return Effect.gen({ self: this }, function*() {
      const ancestors = new Map<string, readonly SessionStoreEntry[]>([[sessionId, entries]])
      let attemptNumber = 0
      while (true) {
        trace?.projection(++attemptNumber, "started", { selected: selectedIds.length })
        const attempt = yield* Effect.try({
          try: () => projectNavigationHistoryFromEvidence(evidence.withSnapshots(ancestors), selectedIds, trace),
          catch: (cause) => cause,
        }).pipe(Effect.match({
          onSuccess: (projection) => ({ _tag: "Projected" as const, projection }),
          onFailure: (cause) => ({ _tag: "Failed" as const, cause }),
        }))
        if (attempt._tag === "Projected") {
          trace?.projection(attemptNumber, "succeeded", { changed: attempt.projection.changed })
          return attempt.projection
        }
        const cause = attempt.cause
        trace?.projection(attemptNumber, "failed", { code: this.failureCode(cause),
          ...(cause instanceof NavigationHistoryError ? { recordId: cause.recordId,
            ...(cause.parentId && entries.some((entry) => entry.uuid === cause.parentId) ? { relatedRecordId: cause.parentId } : {}),
          } : {}) })
        if (cause instanceof NavigationHistoryError && cause.kind === "missing-preservation-source" &&
          cause.sourceSessionId && !ancestors.has(cause.sourceSessionId)) {
          const source = yield* this.traced(trace, "ancestor-records", cause.sourceSessionId,
            this.readSessionEntries(cause.sourceSessionId, operation, deadline, "provider"), (records) => records.length).pipe(
            Effect.mapError((error) => this.protocolError(operation,
              `Compaction preservation for session ${sessionId} requires source session ${cause.sourceSessionId}: ${error.message}`, error)),
          )
          ancestors.set(cause.sourceSessionId, source)
          continue
        }
        return yield* Effect.fail(this.protocolError(operation,
          `Claude has invalid navigation ancestry for session ${sessionId}: ${errorMessage(cause)}`, cause))
      }
    })
  }

  private readStoredTranscript(
    sessionId: string,
    entries: readonly SessionStoreEntry[],
    operation: string,
    deadline: OperationDeadline,
    systemAnchorId?: string,
    trace?: HistoryTrace,
  ): Effect.Effect<readonly ClaudeMessage[], ProviderError | ProviderProtocolError> {
    const sessionStore = this.snapshotStore(sessionId, entries)
    return this.callSdk(operation, () => getSessionMessages(sessionId, { dir: this.projectPath, sessionStore,
      ...(systemAnchorId === undefined ? {} : { includeSystemMessages: true }),
    }),
      this.transcriptReadTimeoutMs, deadline).pipe(Effect.flatMap((messages) => Effect.try({
        try: () => {
          if (systemAnchorId !== undefined && !messages.some((message) => message.type === "system" && message.uuid === systemAnchorId)) {
            trace?.fail("validation", "system-anchor-missing", sessionId, systemAnchorId)
            throw new Error(`Navigation history does not preserve SDK-selected system record ${systemAnchorId}`)
          }
          return normalizeTranscript(sessionId, systemAnchorId === undefined ? messages : messages.filter((message) => message.type !== "system"))
        },
        catch: (cause) => this.protocolError(operation, `Claude returned invalid stored history for session ${sessionId}: ${errorMessage(cause)}`, cause),
      })))
  }

  private snapshotStore(sessionId: string, entries: readonly SessionStoreEntry[]): SessionStore {
    return {
      async append() { throw new Error("Navigation history is read-only") },
      async load(key) { return key.sessionId === sessionId && key.subpath === undefined ? [...entries] : null },
    }
  }

  private readSessionEntries(
    sessionId: string,
    operation: string,
    deadline: OperationDeadline,
    lookup: "project" | "provider" = "project",
  ): Effect.Effect<readonly SessionStoreEntry[], ProviderError | ProviderProtocolError> {
    const entries: SessionStoreEntry[] = []
    const store: SessionStore = {
      async append(key, batch) {
        if (key.sessionId === sessionId && key.subpath === undefined) {
          for (const entry of batch) entries.push(entry)
        }
      },
      async load() {
        return null
      },
    }
    return this.callSdk(
      operation,
      () => this.sdk.importSessionToStore(sessionId, store, {
        ...(lookup === "project" ? { dir: this.projectPath } : {}),
        includeSubagents: false,
      }),
      this.provenanceImportTimeoutMs,
      deadline,
    ).pipe(Effect.as(entries))
  }

  private acquireLaunch(
    kind: "new" | "resume",
    sessionId: string,
    draft?: string,
  ): PreparedTerminal["acquireLaunch"] {
    return Effect.gen({ self: this }, function*() {
      const launch = yield* this.resolveLaunch(kind, sessionId, draft)
      const hooks = yield* makeClaudeLifecycleHooks(sessionId)
      if (hooks === undefined) return { launch, close: Effect.void }
      return {
        launch: {
          ...launch,
          command: [...launch.command, "--settings", hooks.settings] as [string, ...string[]],
          env: hooks.env,
          activityHints: hooks.activityHints,
        },
        close: hooks.close,
      }
    })
  }

  private resolveLaunch(
    kind: "new" | "resume",
    sessionId: string,
    draft?: string,
  ): Effect.Effect<TerminalLaunch, ProviderError | ProviderProtocolError> {
    return Effect.gen({ self: this }, function*() {
      yield* this.validateLaunchInput(sessionId, draft)
      const executable = yield* withOperationTimeout(Effect.tryPromise({
        try: () => handledPromise(this.resolveExecutable),
        catch: (cause) => this.providerError(
          "acquireLaunch",
          "Could not locate the Claude Code executable",
          cause,
        ),
      }), this.executableLookupTimeoutMs,
        () => Effect.fail(this.timeoutError(
          "acquireLaunch",
          this.executableLookupTimeoutMs!,
        )),
      )
      if (typeof executable !== "string" || executable.length === 0 || executable.includes("\0")) {
        return yield* Effect.fail(this.providerError(
          "acquireLaunch",
          "Claude Code was not found on PATH",
        ))
      }
      const observer = yield* Effect.try({
        try: this.observerFactory,
        catch: (cause) => this.providerError(
          "acquireLaunch",
          "Could not create a Claude terminal observer",
          cause,
        ),
      })
      const command: [string, ...string[]] = kind === "new"
        ? [executable, "--session-id", sessionId]
        : [executable, "--resume", sessionId]
      if (draft !== undefined) command.push(`--prefill=${draft}`)
      const launch: TerminalLaunch = {
        sessionId,
        command,
        cwd: this.projectPath,
        observer,
        ...(draft === undefined ? {} : { initialDraft: { text: draft, exact: true } }),
      }
      return launch
    })
  }

  private validateLaunchInput(
    sessionId: string,
    draft: string | undefined,
    validateSession = true,
  ): Effect.Effect<void, ProviderProtocolError> {
    if (validateSession && !isValidSessionId(sessionId)) {
      return Effect.fail(this.protocolError(
        "prepareLaunch",
        "Claude session IDs must be non-empty and cannot contain null bytes",
      ))
    }
    if (draft?.includes("\0")) {
      return Effect.fail(this.protocolError(
        "prepareLaunch",
        "Claude prompt prefill cannot contain a null byte",
      ))
    }
    if (draft !== undefined && !isExactUtf8Text(draft)) {
      return Effect.fail(this.protocolError(
        "prepareLaunch",
        "Claude prompt prefill must be exactly representable as UTF-8 text",
      ))
    }
    return Effect.void
  }

  private callSdk<A>(
    operation: string,
    call: () => PromiseLike<A>,
    timeoutMs: number | undefined,
    deadline: OperationDeadline,
  ): Effect.Effect<A, ProviderError> {
    return Effect.gen({ self: this }, function*() {
      const budget = yield* this.timeoutBudget(operation, timeoutMs, deadline)
      return yield* withOperationTimeout(Effect.tryPromise({
        try: () => handledPromise(call),
        catch: (cause) => this.providerError(
          operation,
          `Claude ${operation} failed: ${errorMessage(cause)}`,
          cause,
        ),
      }), budget.durationMs, () => Effect.fail(budget.error()))
    })
  }

  private makeDeadline(
    operation: string,
    timeoutMs: number | undefined,
  ): Effect.Effect<OperationDeadline> {
    return Clock.currentTimeMillis.pipe(Effect.map((now) => ({
      operation,
      timeoutMs,
      expiresAt: timeoutMs === undefined ? undefined : now + timeoutMs,
    })))
  }

  private remainingMillis(deadline: OperationDeadline): Effect.Effect<number> {
    return Clock.currentTimeMillis.pipe(
      Effect.map((now) => deadline.expiresAt === undefined ? Infinity : Math.max(0, deadline.expiresAt - now)),
    )
  }

  private timeoutBudget(
    operation: string,
    timeoutMs: number | undefined,
    deadline: OperationDeadline,
  ): Effect.Effect<TimeoutBudget, ProviderError> {
    return Effect.gen({ self: this }, function*() {
      const remaining = yield* this.remainingMillis(deadline)
      if (remaining <= 0) return yield* Effect.fail(this.deadlineError(deadline))
      return timeoutMs !== undefined && timeoutMs <= remaining
        ? { durationMs: timeoutMs, error: () => this.timeoutError(operation, timeoutMs) }
        : {
            durationMs: deadline.expiresAt === undefined ? undefined : remaining,
            error: () => this.deadlineError(deadline),
          }
    })
  }

  private timeoutError(operation: string, timeoutMs: number): ProviderError {
    const error = this.providerError(
      operation,
      `Claude ${operation} timed out after ${timeoutMs}ms`,
    )
    this.timeoutErrors.add(error)
    return error
  }

  private deadlineError(deadline: OperationDeadline): ProviderError {
    return this.timeoutError(deadline.operation, deadline.timeoutMs!)
  }

  private failureCode(cause: unknown, sessionId?: string): HistoryFailure {
    let code: HistoryFailure = "unexpected-failure"
    try {
      for (let depth = 0; depth < 8; depth++) {
        if (cause instanceof NavigationHistoryError) return safeHistoryFailure(cause.kind)
        if (typeof cause === "object" && cause !== null && this.timeoutErrors.has(cause)) return "timeout"
        if (typeof cause === "object" && cause !== null) {
          const errno = Object.getOwnPropertyDescriptor(cause, "code")?.value
          if (errno === "EACCES" || errno === "EPERM") return "permission-denied"
          if (errno === "ENOENT") return "source-not-found"
          const message = Object.getOwnPropertyDescriptor(cause, "message")?.value
          if (sessionId !== undefined && message === `Session ${sessionId} not found`) return "source-not-found"
        }
        if (!(cause instanceof ProviderError) && !(cause instanceof ProviderProtocolError)) return code
        code = cause instanceof ProviderProtocolError ? "protocol-error" : "sdk-request-failed"
        if (cause.cause === undefined) return code
        cause = cause.cause
      }
    } catch { return code }
    return code
  }

  private traced<A, E>(trace: HistoryTrace | undefined, stage: HistoryStage, sessionId: string,
    effect: Effect.Effect<A, E>, size?: (value: A) => number): Effect.Effect<A, E> {
    if (!trace) return effect
    return Effect.sync(() => trace.stage(stage, sessionId, "started")).pipe(Effect.andThen(effect),
      Effect.tap((value) => Effect.sync(() => trace.stage(stage, sessionId, "succeeded", size?.(value)))),
      Effect.tapError((error) => Effect.sync(() => trace.stage(stage, sessionId, "failed", undefined, this.failureCode(error, sessionId)))))
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

export function makeClaudeProvider(
  projectPath: string,
  dependencies: ClaudeProviderDependencies = {},
  options: ClaudeProviderOptions = {},
): AgentProviderApi {
  return new ClaudeProvider(projectPath, dependencies, options)
}

export function claudeProviderLayer(
  projectPath: string,
  dependencies: ClaudeProviderDependencies = {},
  options: ClaudeProviderOptions = {},
): Layer.Layer<AgentProvider> {
  return Layer.succeed(AgentProvider, makeClaudeProvider(projectPath, dependencies, options))
}

export const layer = claudeProviderLayer
export const makeClaudeProviderLayer = claudeProviderLayer

function normalizeConversationRecords(entries: readonly SessionStoreEntry[]): readonly ConversationRecord[] {
  const records: ConversationRecord[] = []
  const identities = new Map<string, SessionStoreEntry>()
  for (const entry of entries) {
    if (entry.type !== "user" && entry.type !== "assistant") continue
    if (typeof entry.uuid !== "string" || entry.uuid.length === 0) {
      throw new Error("Physical conversation record has no message ID")
    }
    const previous = identities.get(entry.uuid)
    if (previous && (previous.type !== entry.type || !isDeepStrictEqual(previous.message, entry.message))) {
      throw new Error(`Physical conversation record ${entry.uuid} has contradictory repeated payloads`)
    }
    identities.set(entry.uuid, entry)
    const provenance = entry.forkedFrom
    let forkedFrom: ConversationRecord["forkedFrom"]
    if (provenance !== undefined) {
      if (
        !isRecord(provenance) ||
        typeof provenance.sessionId !== "string" ||
        typeof provenance.messageUuid !== "string"
      ) {
        throw new Error(`Physical record ${entry.uuid} has invalid fork provenance`)
      }
      forkedFrom = {
        sessionId: provenance.sessionId,
        messageUuid: provenance.messageUuid,
      }
    }
    records.push({
      id: entry.uuid,
      type: entry.type,
      message: entry.message,
      ...(forkedFrom === undefined ? {} : { forkedFrom }),
    })
  }
  return records
}

function validateFork(
  parentSessionId: string,
  sourcePrefix: SourcePrefix,
  activeChild: readonly ClaudeMessage[],
  physicalChild: readonly ConversationRecord[],
): ForkValidation {
  if (physicalChild.length > sourcePrefix.records.length) {
    return {
      _tag: "Invalid",
      reason: "its physical copied prefix continues beyond the requested source boundary",
    }
  }

  const childByParentId = new Map<string, ConversationRecord>()
  const parentByChildId = new Map<string, string>()
  for (const [index, parent] of sourcePrefix.records.slice(0, physicalChild.length).entries()) {
    const child = physicalChild[index]
    if (child === undefined) {
      return { _tag: "Short", reason: "its physical copied prefix is incomplete" }
    }
    if (
      child.forkedFrom?.sessionId !== parentSessionId ||
      child.forkedFrom.messageUuid !== parent.id ||
      child.type !== parent.type ||
      !isDeepStrictEqual(child.message, parent.message)
    ) {
      return {
        _tag: "Invalid",
        reason: "its physical copied prefix does not exactly match the source role, payload, and provenance",
      }
    }
    if (childByParentId.has(parent.id) && childByParentId.get(parent.id)!.id !== child.id) {
      return { _tag: "Invalid", reason: "a repeated source record maps to contradictory child identities" }
    }
    if (parentByChildId.has(child.id) && parentByChildId.get(child.id) !== parent.id) {
      return { _tag: "Invalid", reason: "distinct source records map to the same child identity" }
    }
    childByParentId.set(parent.id, child)
    parentByChildId.set(child.id, parent.id)
  }

  const incomplete = physicalChild.length < sourcePrefix.records.length

  // Physical copy order proves integrity; SDK reconstruction defines graph order.
  let orders = [sourcePrefix.activeMessageIds, sourcePrefix.historyMessageIds].map((ids) => ({
    indexes: new Map(ids.flatMap((id, index) => {
      const copied = childByParentId.get(id)
      return copied ? [[copied.id, index] as const] : []
    })),
    length: ids.length,
    previous: -1,
  }))
  const physicalByChildId = new Map(physicalChild.map((record) => [record.id, record]))

  for (const child of activeChild) {
    const physical = physicalByChildId.get(child.id)
    if (physical === undefined && incomplete) continue
    if (
      physical === undefined ||
      sourceRole(physical.type) !== child.role ||
      !isDeepStrictEqual(physical.message, child.rawMessage)
    ) {
      return {
        _tag: "Invalid",
        reason: "its active transcript is not an ordered subsequence of the source conversation",
      }
    }
    // A fork can omit context-only compaction rewiring. Accept one complete
    // evidenced ordering, never a hybrid of context and navigation order.
    orders = orders.filter((order) => {
      const index = order.indexes.get(child.id)
      if (index === undefined || index <= order.previous) return false
      order.previous = index
      return true
    })
    if (orders.length === 0) return { _tag: "Invalid", reason: "its active transcript is not an ordered subsequence of the source conversation" }
  }
  if (incomplete) return {
    _tag: "Short",
    reason: `its physical copied prefix is incomplete (expected ${sourcePrefix.records.length} records; found ${physicalChild.length})`,
  }
  if (!orders.some((order) => order.previous === order.length - 1)) {
    return {
      _tag: "Short",
      reason: "its active transcript has not reached the requested source boundary",
    }
  }
  return { _tag: "Valid", sharedMessages: sourcePrefix.historyMessageIds.map((parentMessageId) => ({
    parentMessageId, childMessageId: childByParentId.get(parentMessageId)!.id,
  })) }
}

function toSessionSummary(session: SDKSessionInfo): AgentSession {
  if (
    !isRecord(session) ||
    typeof session.sessionId !== "string" ||
    !isValidSessionId(session.sessionId) ||
    typeof session.lastModified !== "number" ||
    !Number.isFinite(session.lastModified)
  ) {
    throw new Error("Invalid Claude session metadata")
  }
  const candidateTitle = typeof session.customTitle === "string" && session.customTitle.length > 0
    ? session.customTitle
    : typeof session.summary === "string" && session.summary.length > 0
      ? session.summary
      : typeof session.firstPrompt === "string" && session.firstPrompt.length > 0
        ? session.firstPrompt
        : "Untitled conversation"
  return {
    id: session.sessionId,
    title: normalizePreview(candidateTitle),
    lastModified: session.lastModified,
    ...(typeof session.gitBranch === "string" && session.gitBranch.length > 0
      ? { gitBranch: session.gitBranch }
      : {}),
  }
}

function isValidSessionId(value: string): boolean {
  return value.length > 0 && !value.includes("\0")
}

function isExactUtf8Text(value: string): boolean {
  return new TextDecoder().decode(new TextEncoder().encode(value)) === value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}

function handledPromise<A>(call: () => A | PromiseLike<A>): Promise<A> {
  let result: A | PromiseLike<A>
  try {
    result = call()
  } catch (cause) {
    result = Promise.reject(cause)
  }
  const promise = Promise.resolve(result)
  void promise.catch(() => undefined)
  return promise
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
