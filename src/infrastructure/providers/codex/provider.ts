import { randomUUID as nodeRandomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"

import { Clock, Effect, Layer, PubSub, Scope } from "effect"

import { ProviderError, ProviderProtocolError } from "../../../domain/errors"
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
  type BranchOutcome,
  type PreparedTerminal,
  type TerminalLaunch,
  type TerminalTransitionEvent,
} from "../../../services/provider"
import {
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
  type CodexThreadTransition,
  type CodexTuiProxyTransition,
  type CodexTuiProxyError,
} from "./tui-proxy"

const TRANSCRIPT_READ_CONCURRENCY = 16
const OVERLOAD_RETRY_DELAYS_MS = [25, 50, 100, 200]
const SIDECAR_START_TIMEOUT_MS = 5_000
const SIDECAR_RETRY_DELAY_MS = 10
const TOKEN_ENVIRONMENT_VARIABLE = "CLAUDE_TREE_CODEX_TOKEN"

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
  readonly transitions: PubSub.PubSub<CodexTuiProxyTransition>
}

export type CodexObservedServicesError =
  | CodexAppServerError
  | CodexSidecarError
  | CodexTuiProxyError

export type CodexObservedServicesFactory = (
  executable: string,
  initialThreadId: string,
) => Effect.Effect<CodexObservedServices, CodexObservedServicesError, Scope.Scope>

export interface CodexProviderRuntimeDependencies {
  readonly appServerFactory?: CodexAppServerFactory
  readonly observedServicesFactory?: CodexObservedServicesFactory
  readonly observerFactory?: () => TerminalObserver
  readonly randomUUID?: () => string
}

export interface CodexProviderDependencies extends CodexProviderRuntimeDependencies {
  readonly resolveExecutable?: () => string | null | PromiseLike<string | null>
  readonly canonicalize?: (path: string) => string | PromiseLike<string>
}

export interface CodexProviderOptions {
  readonly transcriptReadConcurrency?: number
  readonly overloadRetryDelaysMs?: readonly number[]
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

  private readonly appServerFactory: CodexAppServerFactory
  private readonly observedServicesFactory: CodexObservedServicesFactory
  private readonly observerFactory: () => TerminalObserver
  private readonly makeUuid: () => string
  private readonly readConcurrency: number
  private readonly overloadRetryDelays: readonly number[]

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
    this.readConcurrency = positiveInteger(
      options.transcriptReadConcurrency,
      TRANSCRIPT_READ_CONCURRENCY,
    )
    this.overloadRetryDelays = options.overloadRetryDelaysMs ?? OVERLOAD_RETRY_DELAYS_MS

    this.loadSessionSnapshot = this.withServer((server) => Effect.gen({ self: this }, function*() {
      const sessions = yield* this.listSessionsFrom(server)
      const transcripts = yield* this.readTranscriptsFrom(
        server,
        sessions.map((session) => session.id),
      )
      return { sessions, transcripts }
    }), "loadSessionSnapshot")

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
    )
  }

  loadSessionSnapshotFor(
    sessionIds: readonly string[],
  ): Effect.Effect<AgentSessionSnapshot, ProviderError | ProviderProtocolError> {
    return this.withServer((server) => Effect.gen({ self: this }, function*() {
      const sessions = yield* this.listSessionsFrom(server)
      const transcripts = yield* this.readTranscriptsFrom(server, sessionIds)
      return { sessions, transcripts }
    }), "loadSessionSnapshotFor")
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
    return this.withServer((server) => Effect.gen({ self: this }, function*() {
      yield* this.validateSessionId(target.sessionId, "branchFrom")
      const parentThread = yield* this.requireThread(server, target.sessionId, "branchFrom")
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
      const childThread = yield* this.transport(
        server.forkThread(target.sessionId, selected.turnId, this.projectPath),
        "branchFrom",
      )
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
  }

  private withServer<A>(
    use: (
      server: CodexAppServerClient,
    ) => Effect.Effect<A, ProviderError | ProviderProtocolError>,
    operation: string,
  ): Effect.Effect<A, ProviderError | ProviderProtocolError> {
    return Effect.scoped(
      this.appServerFactory().pipe(
        Effect.mapError((error) => this.mapTransportError(operation, error)),
        Effect.flatMap(use),
      ),
    )
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
        const page = yield* this.transport(
          server.listThreads({ ...filters, ...(cursor === undefined ? {} : { cursor }) }),
          "listSessions",
        )
        for (const thread of page.data) {
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
  ): Effect.Effect<ReadonlyMap<string, TranscriptRead>> {
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
      return launch
    })
  }

  private adaptTransitions(
    source: PubSub.PubSub<CodexTuiProxyTransition>,
  ): Effect.Effect<PubSub.PubSub<TerminalTransitionEvent>, never, Scope.Scope> {
    return Effect.gen({ self: this }, function*() {
      const transitions = yield* Effect.acquireRelease(
        PubSub.bounded<TerminalTransitionEvent>(64),
        PubSub.shutdown,
      )
      const subscription = yield* PubSub.subscribe(source)
      yield* Effect.forkScoped(Effect.forever(
        PubSub.take(subscription).pipe(
          Effect.flatMap((observed) => PubSub.publish(transitions, this.toTransition(observed))),
        ),
      ))
      return transitions
    })
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
    }), "deriveNativeFork")
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
    if (typeof canonicalPath !== "string" || canonicalPath.length === 0 || canonicalPath.includes("\0")) {
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
): Effect.Effect<CodexObservedServices, CodexObservedServicesError, Scope.Scope> {
  return Effect.gen(function*() {
    const sidecar = yield* makeCodexSidecar(executable)
    yield* waitForSidecar(sidecar)
    const proxy = yield* makeCodexTuiProxy({
      upstreamUrl: sidecar.remoteUrl,
      bearerToken: sidecar.bearerToken,
      initialThreadId,
    })
    return {
      remoteUrl: proxy.remoteUrl,
      bearerToken: sidecar.bearerToken,
      transitions: proxy.transitions,
    }
  })
}

function waitForSidecar(
  sidecar: CodexSidecar,
): Effect.Effect<void, CodexAppServerError | CodexSidecarError> {
  return Effect.gen(function*() {
    const deadline = performance.now() + SIDECAR_START_TIMEOUT_MS
    let lastError: CodexAppServerError | undefined
    while (performance.now() < deadline) {
      if (sidecar.process.exitCode !== null) {
        const detail = yield* Effect.promise(() => sidecar.stderr)
        return yield* Effect.fail(new CodexSidecarError({
          operation: "connect",
          message: `Codex app-server exited before accepting connections${detail ? `: ${detail}` : ""}`,
        }))
      }
      const result = yield* Effect.matchEffect(
        Effect.scoped(connectCodexAppServerSidecar(sidecar.remoteUrl, {
          bearerToken: sidecar.bearerToken,
          connectTimeoutMs: Math.min(250, Math.max(1, deadline - performance.now())),
          requestTimeoutMs: Math.min(250, Math.max(1, deadline - performance.now())),
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

function isTurnStatus(value: unknown): value is CodexTurnStatus {
  return value === "completed" || value === "interrupted" || value === "failed" ||
    value === "inProgress"
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
