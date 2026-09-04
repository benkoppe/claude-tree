import { randomUUID as nodeRandomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import {
  forkSession,
  getSessionMessages,
  importSessionToStore,
  listSessions,
  type SDKSessionInfo,
  type SessionMessage,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk"
import { Clock, Effect, Layer } from "effect"

import { ProviderError, ProviderProtocolError } from "../../../domain/errors"
import type {
  AgentMessage,
  AgentSession,
  AgentSessionSnapshot,
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
} from "../../../services/provider"
import { ClaudeTerminalObserver } from "./terminal-observer"

export interface ClaudeSdk {
  readonly listSessions: (options: {
    readonly dir: string
    readonly includeWorktrees: boolean
    readonly includeProgrammatic: boolean
  }) => Promise<readonly SDKSessionInfo[]>
  readonly getSessionMessages: (
    sessionId: string,
    options: { readonly dir: string },
  ) => Promise<readonly SessionMessage[] | null | undefined>
  readonly forkSession: (
    sessionId: string,
    options: { readonly dir: string; readonly upToMessageId: string },
  ) => Promise<{ readonly sessionId: string }>
  readonly importSessionToStore: (
    sessionId: string,
    store: SessionStore,
    options: { readonly dir: string; readonly includeSubagents: boolean },
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
  listSessions,
  getSessionMessages,
  forkSession,
  importSessionToStore,
}

const LOCAL_COMMAND_INVOCATION_PATTERN =
  /^<command-name>.*?<\/command-name>(?:\s*<command-message>.*?<\/command-message>)?(?:\s*<command-args>.*?<\/command-args>)?$/s
const LOCAL_COMMAND_OUTPUT_PATTERN =
  /^<local-command-(stdout|stderr|caveat)>.*<\/local-command-\1>$/s
const NO_RESPONSE_REQUESTED = "No response requested."
const DEFAULT_FORK_VALIDATION_RETRY_DELAYS_MS = [25, 50, 100, 200]
const DEFAULT_FORK_VALIDATION_TIMEOUT_MS = 5_000
const DEFAULT_SDK_OPERATION_TIMEOUT_MS = 10_000
const TRANSCRIPT_READ_CONCURRENCY = 8

interface ClaudeMessage extends AgentMessage {
  readonly sourceType: "user" | "assistant" | "system"
  readonly rawMessage: unknown
  readonly replayText?: string
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
  readonly requestedRecordIndex: number
}

interface OperationDeadline {
  readonly operation: string
  readonly expiresAt: number
  readonly timeoutMs: number
}

interface TimeoutBudget {
  readonly durationMs: number
  readonly error: ProviderError
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
  | { readonly _tag: "Invalid"; readonly transcript: TranscriptRead; readonly reason: string }

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
  private readonly operationTimeoutMs: number
  private readonly executableLookupTimeoutMs: number
  private readonly forkSessionTimeoutMs: number
  private readonly forkValidationTimeoutMs: number
  private readonly listSessionsTimeoutMs: number
  private readonly transcriptReadTimeoutMs: number
  private readonly provenanceImportTimeoutMs: number

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
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_SDK_OPERATION_TIMEOUT_MS
    this.executableLookupTimeoutMs =
      options.executableLookupTimeoutMs ?? DEFAULT_SDK_OPERATION_TIMEOUT_MS
    this.forkSessionTimeoutMs = options.forkSessionTimeoutMs ?? DEFAULT_SDK_OPERATION_TIMEOUT_MS
    this.forkValidationTimeoutMs =
      options.forkValidationTimeoutMs ?? DEFAULT_FORK_VALIDATION_TIMEOUT_MS
    this.listSessionsTimeoutMs =
      options.listSessionsTimeoutMs ?? DEFAULT_SDK_OPERATION_TIMEOUT_MS
    this.transcriptReadTimeoutMs =
      options.transcriptReadTimeoutMs ?? DEFAULT_SDK_OPERATION_TIMEOUT_MS
    this.provenanceImportTimeoutMs =
      options.provenanceImportTimeoutMs ?? DEFAULT_SDK_OPERATION_TIMEOUT_MS

    this.loadSessionSnapshot = Effect.gen({ self: this }, function*() {
      const deadline = yield* this.makeDeadline("loadSessionSnapshot", this.operationTimeoutMs)
      const sessions = yield* this.listSessionSummaries(deadline)
      const transcripts = yield* this.readTranscriptsWithin(
        sessions.map((session) => session.id),
        deadline,
      )
      return { sessions, transcripts }
    })

    this.prepareNewSession = this.prepareTransientSession()
  }

  readTranscripts(
    sessionIds: readonly string[],
  ): Effect.Effect<ReadonlyMap<string, TranscriptRead>, ProviderError | ProviderProtocolError> {
    return Effect.gen({ self: this }, function*() {
      const deadline = yield* this.makeDeadline("readTranscripts", this.operationTimeoutMs)
      return yield* this.readTranscriptsWithin(sessionIds, deadline)
    })
  }

  loadSessionSnapshotFor(
    sessionIds: readonly string[],
  ): Effect.Effect<AgentSessionSnapshot, ProviderError | ProviderProtocolError> {
    return Effect.gen({ self: this }, function*() {
      const deadline = yield* this.makeDeadline("loadSessionSnapshotFor", this.operationTimeoutMs)
      const sessions = yield* this.listSessionSummaries(deadline)
      const transcripts = yield* this.readTranscriptsWithin(sessionIds, deadline)
      return { sessions, transcripts }
    })
  }

  private readTranscriptsWithin(
    sessionIds: readonly string[],
    deadline: OperationDeadline,
  ): Effect.Effect<ReadonlyMap<string, TranscriptRead>> {
    return Effect.all(
      unique(sessionIds).map((sessionId) =>
        this.readClaudeTranscript(sessionId, "readTranscripts", deadline).pipe(
          Effect.match({
            onFailure: (error): readonly [string, TranscriptRead] => [
              sessionId,
              { _tag: "Unavailable", reason: error.message },
            ],
            onSuccess: (messages): readonly [string, TranscriptRead] => [
              sessionId,
              messages === undefined
                ? { _tag: "Missing" }
                : { _tag: "Available", messages },
            ],
          }),
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
  ): Effect.Effect<BranchOutcome, ProviderError | ProviderProtocolError> {
    let mutationMayHaveDispatched = false
    let mutationSourceMessageId = target.messageId
    const operation = Effect.gen({ self: this }, function*() {
      const deadline = yield* this.makeDeadline(
        "branchFrom",
        Math.min(this.operationTimeoutMs, this.forkValidationTimeoutMs),
      )
      const sourceTranscript = yield* this.requireTranscript(
        target.sessionId,
        "branchFrom",
        deadline,
      )
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

      const sourceRecords = yield* this.readConversationRecords(
        target.sessionId,
        "branchFrom",
        deadline,
      )
      const sourcePrefix = yield* this.validateSourcePrefix(
        target.sessionId,
        sourceTranscript.slice(0, forkIndex + 1),
        sourceRecords,
        forkMessage.id,
      )
      const parentTitle = this.sessionTitles.get(target.sessionId) ?? "Conversation"
      mutationSourceMessageId = forkMessage.id
      mutationMayHaveDispatched = true
      const forkResult = yield* this.forkSessionOnce(
        target.sessionId,
        forkMessage.id,
        deadline,
      )
      if (forkResult._tag === "AmbiguousBranchMutation") return forkResult

      const childId = forkResult.sessionId
      const now = yield* Clock.currentTimeMillis
      const childSession: AgentSession = {
        id: childId,
        title: `${parentTitle} (fork)`,
        lastModified: now,
      }
      const postCreate = this.prepareCreatedFork(
        childSession,
        target.sessionId,
        forkMessage.id,
        sourcePrefix,
        deadline,
        replayText,
      )
      return yield* postCreate.pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed({
            _tag: "CreatedIndependentSession" as const,
            session: childSession,
            transcript: { _tag: "Unavailable" as const, reason: error.message },
            reason: error.message,
            ...(isValidSessionId(childSession.id)
              ? { acquireLaunch: this.acquireLaunch("resume", childSession.id, replayText) }
              : {}),
          }),
          onSuccess: Effect.succeed,
        }),
      )
    })
    return operation.pipe(Effect.onInterrupt(() => mutationMayHaveDispatched
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
      const request = Effect.tryPromise({
        try: () => handledPromise(() => this.sdk.forkSession(parentSessionId, {
          dir: this.projectPath,
          upToMessageId: sourceMessageId,
        })),
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: (cause) => this.ambiguousBranchMutation(
            parentSessionId,
            sourceMessageId,
            `Claude forkSession failed after invocation: ${errorMessage(cause)}; Claude may have created a child session`,
          ),
          onSuccess: (value) => {
            if (
              !isRecord(value) ||
              typeof value.sessionId !== "string" ||
              !isValidSessionId(value.sessionId) ||
              value.sessionId === parentSessionId
            ) {
              const ambiguity = this.ambiguousBranchMutation(
                parentSessionId,
                sourceMessageId,
                "Claude returned an invalid or non-distinct child session ID after creating a fork",
              )
              this.branchMutationReconciliations.offer(ambiguity)
              return ambiguity
            }
            return { _tag: "Created" as const, sessionId: value.sessionId }
          },
        }),
      )
      const result = yield* request.pipe(
        Effect.timeoutOrElse({
          duration: budget.durationMs,
          orElse: () => Effect.succeed(this.ambiguousBranchMutation(
            parentSessionId,
            sourceMessageId,
            `${budget.error.message}; Claude may have created a child session`,
          )),
        }),
      )
      return result
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
  ): Effect.Effect<BranchOutcome, ProviderError | ProviderProtocolError> {
    return Effect.gen({ self: this }, function*() {
      yield* this.validateLaunchInput(session.id, replayText)
      const validation = yield* this.readAndValidateCreatedFork(
        session.id,
        parentSessionId,
        sourcePrefix,
        deadline,
      )
      const acquireLaunch = this.acquireLaunch("resume", session.id, replayText)
      if (validation._tag === "Invalid") {
        return {
          _tag: "CreatedIndependentSession",
          session,
          transcript: validation.transcript,
          reason: validation.reason,
          acquireLaunch,
        }
      }
      return {
        _tag: "ValidatedBranch",
        session,
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

      for (let attempt = 0; attempt <= this.retryDelays.length; attempt += 1) {
        if (attempt > 0) {
          const remaining = yield* this.remainingMillis(deadline)
          if (remaining <= 0) {
            lastReason = this.deadlineError(deadline).message
            break
          }
          yield* Effect.sleep(Math.min(this.retryDelays[attempt - 1] ?? 0, remaining))
        }

        const activeRead = yield* this.readClaudeTranscript(
          childSessionId,
          "validateFork",
          deadline,
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: "Failure" as const, error }),
            onSuccess: (messages) => ({ _tag: "Success" as const, messages }),
          }),
        )
        if (activeRead._tag === "Failure") {
          transcript = { _tag: "Unavailable", reason: activeRead.error.message }
          lastReason = `its transcript could not be read: ${activeRead.error.message}`
          if (activeRead.error._tag === "ProviderProtocolError") break
          continue
        }
        if (activeRead.messages === undefined) {
          transcript = { _tag: "Missing" }
          lastReason = "its transcript is not available yet"
          continue
        }
        transcript = { _tag: "Available", messages: activeRead.messages }

        const physicalRead = yield* this.readConversationRecords(
          childSessionId,
          "validateFork",
          deadline,
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: "Failure" as const, error }),
            onSuccess: (records) => ({ _tag: "Success" as const, records }),
          }),
        )
        if (physicalRead._tag === "Failure") {
          lastReason = `its copied-prefix provenance could not be read: ${physicalRead.error.message}`
          if (physicalRead.error._tag === "ProviderProtocolError") break
          continue
        }

        const validation = validateFork(
          parentSessionId,
          sourcePrefix,
          activeRead.messages,
          physicalRead.records,
        )
        if (validation._tag === "Valid") {
          return {
            _tag: "Valid",
            transcript,
            sharedMessages: validation.sharedMessages,
          }
        }
        lastReason = validation.reason
        if (validation._tag === "Invalid") break
      }

      return {
        _tag: "Invalid",
        transcript,
        reason: `Fork ${childSessionId} was created, but ${lastReason}`,
      }
    })
  }

  private validateSourcePrefix(
    sessionId: string,
    activePrefix: readonly ClaudeMessage[],
    physicalRecords: readonly ConversationRecord[],
    requestedMessageId: string,
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
      let previousIndex = -1
      for (const message of activePrefix) {
        const physicalIndex = physicalIndexById.get(message.id)
        const physical = physicalIndex === undefined ? undefined : records[physicalIndex]
        if (
          physicalIndex === undefined ||
          physicalIndex <= previousIndex ||
          physical === undefined ||
          sourceRole(physical.type) !== message.role ||
          !isDeepStrictEqual(physical.message, message.rawMessage)
        ) {
          return yield* Effect.fail(this.protocolError(
            "branchFrom",
            `Claude's active source transcript does not match its physical records for session ${sessionId}`,
          ))
        }
        previousIndex = physicalIndex
      }
      if (activePrefix.at(-1)?.id !== requestedMessageId || previousIndex !== requestedRecordIndex) {
        return yield* Effect.fail(this.protocolError(
          "branchFrom",
          "The selected Claude source boundary could not be validated exactly",
        ))
      }
      return { records, requestedRecordIndex }
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

  private requireTranscript(
    sessionId: string,
    operation: string,
    deadline: OperationDeadline,
  ): Effect.Effect<readonly ClaudeMessage[], ProviderError | ProviderProtocolError> {
    return this.readClaudeTranscript(sessionId, operation, deadline).pipe(
      Effect.flatMap((messages) => messages === undefined
        ? Effect.fail(this.providerError(operation, `Claude session ${sessionId} was not found`))
        : Effect.succeed(messages)),
    )
  }

  private readClaudeTranscript(
    sessionId: string,
    operation: string,
    deadline: OperationDeadline,
  ): Effect.Effect<readonly ClaudeMessage[] | undefined, ProviderError | ProviderProtocolError> {
    return this.callSdk(
      operation,
      () => this.sdk.getSessionMessages(sessionId, { dir: this.projectPath }),
      this.transcriptReadTimeoutMs,
      deadline,
    ).pipe(
      Effect.flatMap((messages) => {
        if (messages === null || messages === undefined) return Effect.succeed(undefined)
        return Effect.try({
          try: () => normalizeTranscript(sessionId, messages),
          catch: (cause) => this.protocolError(
            operation,
            `Claude returned an invalid transcript for session ${sessionId}`,
            cause,
          ),
        })
      }),
    )
  }

  private readConversationRecords(
    sessionId: string,
    operation: string,
    deadline: OperationDeadline,
  ): Effect.Effect<readonly ConversationRecord[], ProviderError | ProviderProtocolError> {
    const entries: SessionStoreEntry[] = []
    const store: SessionStore = {
      async append(key, batch) {
        if (key.sessionId === sessionId && key.subpath === undefined) entries.push(...batch)
      },
      async load() {
        return null
      },
    }
    return this.callSdk(
      operation,
      () => this.sdk.importSessionToStore(sessionId, store, {
        dir: this.projectPath,
        includeSubagents: false,
      }),
      this.provenanceImportTimeoutMs,
      deadline,
    ).pipe(
      Effect.flatMap(() => Effect.try({
        try: () => normalizeConversationRecords(entries),
        catch: (cause) => this.protocolError(
          operation,
          `Claude returned invalid physical transcript records for session ${sessionId}`,
          cause,
        ),
      })),
    )
  }

  private acquireLaunch(
    kind: "new" | "resume",
    sessionId: string,
    draft?: string,
  ): PreparedTerminal["acquireLaunch"] {
    return this.resolveLaunch(kind, sessionId, draft).pipe(
      Effect.map((launch) => ({ launch, close: Effect.void })),
    )
  }

  private resolveLaunch(
    kind: "new" | "resume",
    sessionId: string,
    draft?: string,
  ): Effect.Effect<TerminalLaunch, ProviderError | ProviderProtocolError> {
    return Effect.gen({ self: this }, function*() {
      yield* this.validateLaunchInput(sessionId, draft)
      const executable = yield* Effect.tryPromise({
        try: () => handledPromise(this.resolveExecutable),
        catch: (cause) => this.providerError(
          "acquireLaunch",
          "Could not locate the Claude Code executable",
          cause,
        ),
      }).pipe(Effect.timeoutOrElse({
        duration: this.executableLookupTimeoutMs,
        orElse: () => Effect.fail(this.timeoutError(
          "acquireLaunch",
          this.executableLookupTimeoutMs,
        )),
      }))
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
    timeoutMs: number,
    deadline: OperationDeadline,
  ): Effect.Effect<A, ProviderError> {
    return Effect.gen({ self: this }, function*() {
      const budget = yield* this.timeoutBudget(operation, timeoutMs, deadline)
      return yield* Effect.tryPromise({
        try: () => handledPromise(call),
        catch: (cause) => this.providerError(
          operation,
          `Claude ${operation} failed: ${errorMessage(cause)}`,
          cause,
        ),
      }).pipe(Effect.timeoutOrElse({
        duration: budget.durationMs,
        orElse: () => Effect.fail(budget.error),
      }))
    })
  }

  private makeDeadline(
    operation: string,
    timeoutMs: number,
  ): Effect.Effect<OperationDeadline> {
    return Clock.currentTimeMillis.pipe(Effect.map((now) => ({
      operation,
      timeoutMs,
      expiresAt: now + timeoutMs,
    })))
  }

  private remainingMillis(deadline: OperationDeadline): Effect.Effect<number> {
    return Clock.currentTimeMillis.pipe(
      Effect.map((now) => Math.max(0, deadline.expiresAt - now)),
    )
  }

  private timeoutBudget(
    operation: string,
    timeoutMs: number,
    deadline: OperationDeadline,
  ): Effect.Effect<TimeoutBudget, ProviderError> {
    return Effect.gen({ self: this }, function*() {
      const remaining = yield* this.remainingMillis(deadline)
      if (remaining <= 0) return yield* Effect.fail(this.deadlineError(deadline))
      return timeoutMs <= remaining
        ? { durationMs: timeoutMs, error: this.timeoutError(operation, timeoutMs) }
        : { durationMs: remaining, error: this.deadlineError(deadline) }
    })
  }

  private timeoutError(operation: string, timeoutMs: number): ProviderError {
    return this.providerError(
      operation,
      `Claude ${operation} timed out after ${timeoutMs}ms`,
    )
  }

  private deadlineError(deadline: OperationDeadline): ProviderError {
    return this.providerError(
      deadline.operation,
      `Claude ${deadline.operation} timed out after ${deadline.timeoutMs}ms`,
    )
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

function normalizeTranscript(
  sessionId: string,
  messages: readonly SessionMessage[],
): readonly ClaudeMessage[] {
  if (!Array.isArray(messages)) throw new Error("Transcript is not an array")
  let assistantDisplayGroupId: string | undefined
  const seenIds = new Set<string>()
  return messages.map((message, ordinal) => {
    const candidate: unknown = message
    if (!isRecord(candidate)) throw new Error(`Message ${ordinal} is not an object`)
    const sourceType = candidate.type
    if (sourceType !== "user" && sourceType !== "assistant" && sourceType !== "system") {
      throw new Error(`Message ${ordinal} has an unsupported role`)
    }
    if (
      typeof candidate.uuid !== "string" ||
      candidate.uuid.length === 0 ||
      seenIds.has(candidate.uuid)
    ) {
      throw new Error(`Message ${ordinal} has no unique ID`)
    }
    if (candidate.session_id !== sessionId) {
      throw new Error(`Message ${candidate.uuid} belongs to another session`)
    }
    seenIds.add(candidate.uuid)

    const normalizedSource: Pick<SessionMessage, "type" | "message"> = {
      type: sourceType,
      message: candidate.message,
    }

    const localCommandArtifact = isLocalCommandArtifact(normalizedSource)
    const visible = !localCommandArtifact && isVisibleMessage(normalizedSource)
    if (sourceType === "user" && visible) assistantDisplayGroupId = candidate.uuid
    const replayText = sourceType === "user" && !localCommandArtifact
      ? extractUserPromptText(candidate.message)
      : undefined
    const turnComplete = assistantTurnComplete(normalizedSource)
    const copyIdentity = JSON.stringify(candidate.message) ?? "undefined"
    return {
      id: candidate.uuid,
      role: sourceRole(sourceType),
      preview: formatMessage(candidate.message),
      ordinal,
      visible,
      sourceType,
      rawMessage: candidate.message,
      copyIdentity,
      ...(sourceType === "assistant" && assistantDisplayGroupId !== undefined
        ? { displayGroupId: assistantDisplayGroupId }
        : {}),
      ...(turnComplete === undefined ? {} : { turnComplete }),
      ...(replayText === undefined ? {} : { replayText }),
    }
  })
}

function normalizeConversationRecords(entries: readonly SessionStoreEntry[]): readonly ConversationRecord[] {
  const records: ConversationRecord[] = []
  const seenIds = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== "user" && entry.type !== "assistant") continue
    if (typeof entry.uuid !== "string" || entry.uuid.length === 0 || seenIds.has(entry.uuid)) {
      throw new Error("Physical conversation records do not have unique message IDs")
    }
    seenIds.add(entry.uuid)
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
  if (physicalChild.length < sourcePrefix.records.length) {
    return {
      _tag: "Short",
      reason: `its physical copied prefix is incomplete (expected ${sourcePrefix.records.length} records; found ${physicalChild.length})`,
    }
  }
  if (physicalChild.length > sourcePrefix.records.length) {
    return {
      _tag: "Invalid",
      reason: "its physical copied prefix continues beyond the requested source boundary",
    }
  }

  const parentIndexByChildId = new Map<string, number>()
  const sharedMessages: Array<{ parentMessageId: string; childMessageId: string }> = []
  for (const [index, parent] of sourcePrefix.records.entries()) {
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
    parentIndexByChildId.set(child.id, index)
    sharedMessages.push({ parentMessageId: parent.id, childMessageId: child.id })
  }

  let previousParentIndex = -1
  for (const child of activeChild) {
    const parentIndex = parentIndexByChildId.get(child.id)
    const physical = parentIndex === undefined ? undefined : physicalChild[parentIndex]
    if (
      parentIndex === undefined ||
      parentIndex <= previousParentIndex ||
      physical === undefined ||
      sourceRole(physical.type) !== child.role ||
      !isDeepStrictEqual(physical.message, child.rawMessage)
    ) {
      return {
        _tag: "Invalid",
        reason: "its active transcript is not an ordered subsequence of the physical copied prefix",
      }
    }
    previousParentIndex = parentIndex
  }
  if (previousParentIndex !== sourcePrefix.requestedRecordIndex) {
    return {
      _tag: "Short",
      reason: "its active transcript has not reached the requested source boundary",
    }
  }
  return { _tag: "Valid", sharedMessages }
}

export function formatMessage(message: unknown): string {
  if (typeof message === "string") return normalizePreview(message)
  if (!isRecord(message)) return "[unavailable message]"
  const content = message.content
  if (typeof content === "string") return normalizePreview(content)
  if (!Array.isArray(content)) return "[unavailable message]"

  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text)
    else if (block.type === "tool_use" && typeof block.name === "string") {
      parts.push(`[tool: ${block.name}]`)
    } else if (block.type === "tool_result") parts.push("[tool result]")
    else if (block.type === "thinking") parts.push("[thinking]")
  }
  return normalizePreview(parts.join(" ") || "[non-text message]")
}

export function extractUserPromptText(message: unknown): string | undefined {
  if (typeof message === "string") return message.trim().length > 0 ? message : undefined
  if (!isRecord(message)) return undefined
  const content = message.content
  if (typeof content === "string") return content.trim().length > 0 ? content : undefined
  if (!Array.isArray(content) || content.length === 0) return undefined

  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      return undefined
    }
    parts.push(block.text)
  }
  const text = parts.join("\n")
  return text.trim().length > 0 ? text : undefined
}

function isVisibleMessage(message: Pick<SessionMessage, "type" | "message">): boolean {
  if (message.type !== "user" && message.type !== "assistant") return false
  if (typeof message.message === "string") return message.message.trim().length > 0
  if (!isRecord(message.message)) return false
  const content = message.message.content
  if (typeof content === "string") return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some(
    (block) => isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim().length > 0,
  )
}

function isLocalCommandArtifact(message: Pick<SessionMessage, "type" | "message">): boolean {
  const text = extractUserPromptText(message.message)?.trim()
  if (!text) return false
  if (message.type === "assistant") {
    return isRecord(message.message) &&
      message.message.model === "<synthetic>" &&
      text === NO_RESPONSE_REQUESTED
  }
  return message.type === "user" &&
    (LOCAL_COMMAND_INVOCATION_PATTERN.test(text) || LOCAL_COMMAND_OUTPUT_PATTERN.test(text))
}

function assistantTurnComplete(
  message: Pick<SessionMessage, "type" | "message">,
): boolean | undefined {
  if (message.type !== "assistant" || !isRecord(message.message)) return undefined
  const stopReason = message.message.stop_reason
  if (stopReason === null) return false
  if (typeof stopReason !== "string") return undefined
  return stopReason !== "tool_use" && stopReason !== "pause_turn"
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

function sourceRole(type: "user" | "assistant" | "system"): AgentMessage["role"] {
  return type === "assistant" ? "agent" : type
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "[empty message]"
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
