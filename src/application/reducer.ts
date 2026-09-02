import type {
  AgentMessage,
  AgentSession,
  AgentSessionSnapshot,
  BranchDerivation,
  DraftPreview,
  MessageRef,
  NavigationState,
  NavigationTarget,
  TranscriptRead,
} from "../domain/model"
import type { BranchRelation, ConversationRemoval } from "../domain/persistence"
import type { AppCommand, AppEvent, ReduceResult, RefreshReason } from "./events"
import { replaceSessionIdInRef, selectFamilyRootSessionId, selectTranscriptRead } from "./selectors"
import type {
  ActiveRefresh,
  ApplicationModal,
  ApplicationState,
  ApplicationSurface,
  NavigatorSurface,
  PendingCompletion,
  PendingRemoval,
  RewindAnchor,
} from "./state"

export const MAX_COMPLETION_REFRESH_ATTEMPTS = 4

export function reduceApplicationState(state: ApplicationState, event: AppEvent): ReduceResult {
  if (state.shutdown === "stopped" || state.shutdown === "cleanup-incomplete") return unchanged(state)
  if (state.shutdown === "shutting-down" && !isShutdownEvent(event)) return unchanged(state)

  switch (event._tag) {
    case "RefreshRequested":
      return requestRefresh(state, event.reason, event.focusSessionId, event.sessionIds)
    case "RefreshSucceeded":
      return refreshSucceeded(state, event.generation, event.snapshot)
    case "RefreshFailed":
      return refreshFailed(state, event.generation, event.message)
    case "LocalSessionProjected":
      return projectLocalSession(state, event)
    case "PersistedBranchProjected": {
      const projected = projectLocalSession(state, {
        _tag: "LocalSessionProjected",
        session: event.session,
        ...(event.transcript === undefined ? {} : { transcript: event.transcript }),
        ...(event.temporary === undefined ? {} : { temporary: event.temporary }),
      })
      return changed(projected.state, {
        relations: [
          ...projected.state.relations.filter(
            (relation) => relation.childSessionId !== event.relation.childSessionId,
          ),
          event.relation,
        ],
      })
    }
    case "RelationStaged":
      return stageRelation(state, event.derivation)
    case "SessionIdentityAdoptionRequested":
      return requestSessionIdentityAdoption(
        state,
        event.temporarySessionId,
        event.session,
        event.derivation,
      )
    case "SessionIdentityAdopted":
      return adoptSessionIdentity(state, event.temporarySessionId, event.session, event.relation)
    case "SessionIdentityAdoptionFailed":
      return changed(state, {
        pendingIdentityAdoptions: withoutMap(state.pendingIdentityAdoptions, event.temporarySessionId),
        modal: { _tag: "Error", message: event.message },
      })
    case "RootsSelected":
      return navigate(state, { _tag: "Roots", selectedSessionId: event.sessionId })
    case "GraphSelected":
      return navigate(state, {
        _tag: "Graph",
        familySessionId: event.familySessionId,
        target: event.target,
      })
    case "TerminalShowRequested": {
      if (state.pendingTerminalShow) return unchanged(state)
      const returnTo = navigatorSurface(state.surface, event.sessionId, state)
      const terminals = new Map(state.terminals)
      const previous = terminals.get(event.sessionId)
      terminals.set(event.sessionId, { activity: previous?.activity ?? "idle", phase: "showing" })
      return changed(state, {
        surface: {
          _tag: "Terminal",
          sessionId: event.sessionId,
          returnTo,
        },
        terminals,
        pendingTerminalShow: {
          sessionId: event.sessionId,
          returnTo,
          reportFailure: event.reportFailure,
          ...(previous === undefined ? {} : { previous }),
        },
      }, [{ _tag: "ShowTerminal", sessionId: event.sessionId }])
    }
    case "TerminalShowSucceeded":
      return terminalShowSucceeded(state, event.sessionId)
    case "TerminalShowFailed":
      return terminalShowFailed(state, event.sessionId, event.message)
    case "TransientTerminalShowRolledBack":
      return rollbackTransientTerminalShow(state, event.sessionId, event.restoreTo)
    case "TerminalSessionTransitioned":
      return terminalSessionTransitioned(
        state,
        event.previousSessionId,
        event.session,
        event.wasVisible,
        event.relation,
      )
    case "TerminalReturned":
      return terminalReturned(state, event.sessionId, event.draft)
    case "TerminalExited":
      return terminalExited(state, event.sessionId, event.cleanupIncomplete ?? false)
    case "TerminalActivityChanged":
      return terminalActivityChanged(state, event.sessionId, event.activity, event.wasVisible)
    case "TerminalDraftObserved":
      return observeDraft(state, event.sessionId, event.draft)
    case "CompletionRefreshDue": {
      const pending = state.pendingCompletions.get(event.sessionId)
      if (!pending || pending.version !== event.version) return unchanged(state)
      if (state.refresh.active) {
        return {
          state,
          commands: [scheduleCompletion(event.sessionId, pending)],
        }
      }
      return requestRefresh(state, "completion", event.sessionId, new Set([event.sessionId]))
    }
    case "CompletionRefreshFailed":
      return completionRefreshFailed(state, event.sessionId, event.version, event.message)
    case "TerminalStopped":
      return intentionalTerminalStopped(state, event.sessionId)
    case "TerminalStopRequested": {
      const terminal = state.terminals.get(event.sessionId)
      if (!terminal || terminal.phase === "showing") return unchanged(state)
      if (terminal.phase !== "running") {
        return { state, commands: [{ _tag: "StopSession", sessionId: event.sessionId }] }
      }
      return changed(state, {
        terminals: new Map(state.terminals).set(event.sessionId, {
          ...terminal,
          phase: "stopping",
        }),
      }, [{ _tag: "StopSession", sessionId: event.sessionId }])
    }
    case "TerminalStopFailed":
      return changed(state, {
        terminals: updateMapValue(state.terminals, event.sessionId, (terminal) =>
          terminal ? { ...terminal, phase: "cleanup-incomplete" } : terminal),
        pendingRemovals: cancelRemovalsWaitingFor(state.pendingRemovals, event.sessionId),
        modal: { _tag: "Error", message: event.message },
      })
    case "RemovalRequested":
      return requestRemoval(state, event.requestId, event.removal, event.affectedSessionIds)
    case "RemovalPersisted":
      return removalPersisted(state, event.requestId)
    case "RemovalFailed":
      return changed(state, {
        pendingRemovals: withoutMap(state.pendingRemovals, event.requestId),
        modal: { _tag: "Error", message: event.message },
      })
    case "RelationPersisted": {
      const staged = state.pendingRelations.get(event.derivation.childSessionId)
      if (!staged || !sameDerivation(staged, event.derivation)) return unchanged(state)
      const relation = relationFromDerivation(event.derivation, event.createdAt)
      return changed(state, {
        relations: [...state.relations.filter((item) => item.childSessionId !== relation.childSessionId), relation],
        pendingRelations: withoutMap(state.pendingRelations, event.derivation.childSessionId),
      })
    }
    case "RelationPersistenceFailed": {
      const staged = state.pendingRelations.get(event.derivation.childSessionId)
      if (!staged || !sameDerivation(staged, event.derivation)) return unchanged(state)
      return changed(state, {
        pendingRelations: withoutMap(state.pendingRelations, event.derivation.childSessionId),
        modal: { _tag: "Error", message: event.message },
      })
    }
    case "ModalOpened":
      return changed(state, { modal: event.modal })
    case "ModalClosed":
      return changed(state, { modal: null })
    case "UnviewedCleared":
      return changed(state, { unviewedSessionIds: without(state.unviewedSessionIds, event.sessionId) })
    case "ShutdownRequested":
      return state.shutdown === "running"
        ? {
            state: {
              ...state,
              shutdown: "shutting-down",
              modal: null,
              pendingTerminalShow: null,
              pendingCompletions: new Map(),
              refresh: { ...state.refresh, active: null },
            },
            commands: [{ _tag: "Shutdown" }],
          }
        : unchanged(state)
    case "ShutdownCompleted":
      return changed(state, {
        shutdown: "stopped",
        terminals: new Map(),
        pendingTerminalShow: null,
        drafts: new Map(),
        rewindAnchors: new Map(),
        unviewedSessionIds: new Set(),
      })
    case "ShutdownFailed":
      return changed(state, {
        shutdown: "cleanup-incomplete",
        terminals: new Map([...state.terminals].map(([sessionId, terminal]) => [
          sessionId,
          { ...terminal, phase: "cleanup-incomplete" as const },
        ])),
        modal: { _tag: "Error", message: event.message },
      })
    case "CommandFailed":
      return changed(state, { modal: { _tag: "Error", message: event.message } })
  }
}

function requestRefresh(
  state: ApplicationState,
  reason: RefreshReason,
  focusSessionId?: string,
  sessionIds?: ReadonlySet<string>,
): ReduceResult {
  const requestedSessionIds = reason === "stop" && state.refresh.active?.reason === "stop"
    ? new Set([...(state.refresh.active.sessionIds ?? []), ...(sessionIds ?? [])])
    : sessionIds
  const generation = state.refresh.generation + 1
  const mode = reason === "initial" || reason === "manual" ? "full" : "incremental"
  const completionVersions = new Map<string, number>()
  for (const [sessionId, completion] of state.pendingCompletions) {
    if (!requestedSessionIds || requestedSessionIds.has(sessionId)) {
      completionVersions.set(sessionId, completion.version)
    }
  }
  const active: ActiveRefresh = {
    generation,
    reason,
    mode,
    completionVersions,
    ...(focusSessionId === undefined ? {} : { focusSessionId }),
    ...(requestedSessionIds === undefined ? {} : { sessionIds: new Set(requestedSessionIds) }),
  }
  const command: AppCommand = {
    _tag: "RefreshProvider",
    generation,
    mode,
    reason,
    ...(focusSessionId === undefined ? {} : { focusSessionId }),
    ...(requestedSessionIds === undefined ? {} : { sessionIds: new Set(requestedSessionIds) }),
  }
  const commands: AppCommand[] = []
  for (const [sessionId, version] of state.refresh.active?.completionVersions ?? []) {
    if (completionVersions.get(sessionId) === version) continue
    const pending = state.pendingCompletions.get(sessionId)
    if (pending?.version === version) commands.push(scheduleCompletion(sessionId, pending))
  }
  commands.push(command)
  return {
    state: { ...state, refresh: { ...state.refresh, generation, active } },
    commands,
  }
}

function refreshFailed(
  state: ApplicationState,
  generation: number,
  message: string,
): ReduceResult {
  const active = state.refresh.active
  if (!active || active.generation !== generation || generation !== state.refresh.generation) {
    return unchanged(state)
  }
  const retried = retryCompletions(state.pendingCompletions, active.completionVersions)
  const completionOnly = active.reason === "completion" && active.completionVersions.size > 0
  return {
    state: {
      ...state,
      pendingCompletions: retried.pending,
      refresh: { ...state.refresh, active: null, initialPending: false },
      ...(completionOnly && retried.failures.length === 0
        ? {}
        : {
            modal: {
              _tag: "Error",
              message: retried.failures[0] ?? message,
            } as const,
          }),
    },
    commands: retried.commands,
  }
}

function refreshSucceeded(
  state: ApplicationState,
  generation: number,
  snapshot: AgentSessionSnapshot,
): ReduceResult {
  const active = state.refresh.active
  if (!active || active.generation !== generation || generation !== state.refresh.generation) {
    return unchanged(state)
  }

  const incomingSessions = new Map(snapshot.sessions.map((session) => [session.id, session]))
  const sessions = active.mode === "full"
    ? preserveOwnedSessions(state, incomingSessions)
    : new Map([...state.provider.sessions, ...incomingSessions])
  const transcripts = active.mode === "full"
    ? preserveOwnedTranscripts(state, snapshot.transcripts)
    : new Map([...state.provider.transcripts, ...snapshot.transcripts])
  const pendingCompletions = new Map(state.pendingCompletions)
  const unviewedSessionIds = new Set(state.unviewedSessionIds)
  const rewindAnchors = new Map(state.rewindAnchors)
  const localSessions = new Map(state.local.sessions)
  const localTranscripts = new Map(state.local.transcripts)
  const temporarySessionIds = new Set(state.local.temporarySessionIds)
  const commands: AppCommand[] = []
  let completionFailure: string | undefined

  for (const [sessionId, version] of active.completionVersions) {
    const pending = pendingCompletions.get(sessionId)
    if (!pending || pending.version !== version) continue
    const incoming = snapshot.transcripts.get(sessionId)
    if (incoming?._tag === "Available" && completionTranscriptReady(pending.baseline, incoming.messages, rewindAnchors.get(sessionId))) {
      pendingCompletions.delete(sessionId)
      if (pending.markUnviewed) unviewedSessionIds.add(sessionId)
      const anchor = rewindAnchors.get(sessionId)
      if (anchor && !incoming.messages.some((message) => message.id === anchor.targetMessageId)) {
        rewindAnchors.delete(sessionId)
      }
      continue
    }

    transcripts.set(sessionId, { _tag: "Available", messages: pending.baseline })
    const attempt = pending.attempt + 1
    if (attempt >= MAX_COMPLETION_REFRESH_ATTEMPTS) {
      pendingCompletions.delete(sessionId)
      completionFailure = "Completed response did not become available"
      continue
    }
    pendingCompletions.set(sessionId, { ...pending, attempt })
    commands.push({
      _tag: "ScheduleCompletionRefresh",
      sessionId,
      version,
      attempt,
    })
  }

  for (const [sessionId, incoming] of snapshot.transcripts) {
    if (active.completionVersions.has(sessionId) || incoming._tag !== "Available") continue
    const previous = selectTranscriptRead(state, sessionId)
    if (previous?._tag !== "Available") continue
    const terminal = state.terminals.get(sessionId)
    const anchor = rewindAnchors.get(sessionId)
    if (terminal?.activity === "working" || terminal?.activity === "blocked") {
      transcripts.set(sessionId, {
        _tag: "Available",
        messages: stableTranscriptWhileNonIdle(previous.messages, incoming.messages),
      })
    } else if (incoming.messages.length < previous.messages.length && !anchor) {
      transcripts.set(sessionId, previous)
    } else if (anchor && !incoming.messages.some((message) => message.id === anchor.targetMessageId)) {
      rewindAnchors.delete(sessionId)
    }
  }

  for (const [sessionId, transcript] of snapshot.transcripts) {
    if (transcript._tag !== "Available") continue
    localTranscripts.delete(sessionId)
    const session = sessions.get(sessionId)
    if (!session || session.transient) continue
    localSessions.delete(sessionId)
    temporarySessionIds.delete(sessionId)
  }

  return {
    state: {
      ...state,
      provider: { sessions, transcripts },
      local: {
        sessions: localSessions,
        transcripts: localTranscripts,
        temporarySessionIds,
      },
      pendingCompletions,
      unviewedSessionIds,
      rewindAnchors,
      refresh: { generation, active: null, initialPending: false },
      ...(completionFailure ? { modal: { _tag: "Error", message: completionFailure } } : {}),
    },
    commands,
  }
}

function projectLocalSession(
  state: ApplicationState,
  event: Extract<AppEvent, { readonly _tag: "LocalSessionProjected" }>,
): ReduceResult {
  const sessions = new Map(state.local.sessions).set(event.session.id, event.session)
  const transcripts = new Map(state.local.transcripts)
  if (event.transcript) transcripts.set(event.session.id, event.transcript)
  else if (!transcripts.has(event.session.id)) transcripts.set(event.session.id, { _tag: "Available", messages: [] })
  const temporarySessionIds = new Set(state.local.temporarySessionIds)
  if (event.temporary ?? event.session.transient) temporarySessionIds.add(event.session.id)
  const projected: ApplicationState = {
    ...state,
    local: { sessions, transcripts, temporarySessionIds },
  }
  if (!event.derivation) return changed(state, { local: projected.local })
  const staged = stageRelation(projected, event.derivation)
  return {
    state: {
      ...staged.state,
    },
    commands: staged.commands,
  }
}

function stageRelation(state: ApplicationState, derivation: BranchDerivation): ReduceResult {
  const existing = state.pendingRelations.get(derivation.childSessionId)
  if (existing && sameDerivation(existing, derivation)) return unchanged(state)
  return changed(state, {
    pendingRelations: new Map(state.pendingRelations).set(derivation.childSessionId, derivation),
  }, [{ _tag: "PersistRelation", derivation }])
}

function terminalSessionTransitioned(
  state: ApplicationState,
  previousSessionId: string,
  session: AgentSession,
  _wasVisible: boolean,
  relation?: BranchRelation,
): ReduceResult {
  if (previousSessionId === session.id) return unchanged(state)
  const sessionId = session.id
  const localSessions = new Map(state.local.sessions).set(sessionId, session)
  const localTranscripts = new Map(state.local.transcripts)
  if (!localTranscripts.has(sessionId) && !state.provider.transcripts.has(sessionId)) {
    localTranscripts.set(sessionId, { _tag: "Available", messages: [] })
  }
  const surface = replaceSessionIdInSurface(state.surface, previousSessionId, sessionId)
  const commands = surface === state.surface ? [] : [persistNavigation(surface)]
  return {
    state: {
      ...state,
      local: {
        sessions: localSessions,
        transcripts: localTranscripts,
        temporarySessionIds: session.transient
          ? new Set(state.local.temporarySessionIds).add(sessionId)
          : state.local.temporarySessionIds,
      },
      relations: relation === undefined
        ? state.relations
        : [
            ...state.relations.filter((item) => item.childSessionId !== relation.childSessionId),
            relation,
          ],
      surface,
      terminals: migrateMapKey(state.terminals, previousSessionId, sessionId),
      pendingTerminalShow: replaceSessionIdInPendingTerminalShow(
        state.pendingTerminalShow,
        previousSessionId,
        sessionId,
      ),
      drafts: migrateMapKey(state.drafts, previousSessionId, sessionId),
      rewindAnchors: migrateMapKey(state.rewindAnchors, previousSessionId, sessionId),
      pendingCompletions: migrateMapKey(
        state.pendingCompletions,
        previousSessionId,
        sessionId,
      ),
      unviewedSessionIds: migrateSet(
        state.unviewedSessionIds,
        previousSessionId,
        sessionId,
      ),
    },
    commands,
  }
}

function terminalReturned(
  state: ApplicationState,
  sessionId: string,
  draft?: DraftPreview,
): ReduceResult {
  const observed = draft === undefined ? state : observeDraft(state, sessionId, draft).state
  const target: NavigationTarget = { kind: "endpoint", sessionId }
  const surface: NavigatorSurface = {
    _tag: "Graph",
    familySessionId: selectFamilyRootSessionId(observed, sessionId),
    target,
  }
  const revealed = { ...observed, surface }
  const refresh = requestRefresh(revealed, "terminal-return", sessionId, new Set([sessionId]))
  return {
    state: refresh.state,
    commands: [persistNavigation(surface), ...refresh.commands],
  }
}

function terminalShowSucceeded(state: ApplicationState, sessionId: string): ReduceResult {
  const pending = state.pendingTerminalShow
  if (!pending || pending.sessionId !== sessionId) return unchanged(state)
  const terminals = new Map(state.terminals)
  const terminal = terminals.get(sessionId)
  terminals.set(sessionId, { activity: terminal?.activity ?? "idle", phase: "running" })
  const surface: ApplicationSurface = {
    _tag: "Terminal",
    sessionId,
    returnTo: pending.returnTo,
  }
  const pendingCompletions = updateMapValue(state.pendingCompletions, sessionId, (completion) =>
    completion ? { ...completion, markUnviewed: false } : completion)
  return changed(state, {
    surface,
    terminals,
    pendingTerminalShow: null,
    pendingCompletions,
    unviewedSessionIds: without(state.unviewedSessionIds, sessionId),
  }, [persistNavigation(surface)])
}

function terminalShowFailed(
  state: ApplicationState,
  sessionId: string,
  message: string,
): ReduceResult {
  const pending = state.pendingTerminalShow
  if (!pending || pending.sessionId !== sessionId) return unchanged(state)
  const terminals = new Map(state.terminals)
  if (pending.previous) terminals.set(sessionId, pending.previous)
  else terminals.delete(sessionId)
  return changed(state, {
    surface: pending.returnTo,
    terminals,
    pendingTerminalShow: null,
    ...(pending.reportFailure ? { modal: { _tag: "Error" as const, message } } : {}),
  })
}

function rollbackTransientTerminalShow(
  state: ApplicationState,
  sessionId: string,
  restoreTo: NavigatorSurface,
): ReduceResult {
  if (!state.local.temporarySessionIds.has(sessionId)) return unchanged(state)
  return changed(state, {
    local: {
      sessions: withoutMap(state.local.sessions, sessionId),
      transcripts: withoutMap(state.local.transcripts, sessionId),
      temporarySessionIds: without(state.local.temporarySessionIds, sessionId),
    },
    relations: state.relations.filter((relation) => relation.childSessionId !== sessionId),
    surface: restoreTo,
    terminals: withoutMap(state.terminals, sessionId),
    pendingTerminalShow: state.pendingTerminalShow?.sessionId === sessionId
      ? null
      : state.pendingTerminalShow,
    drafts: withoutMap(state.drafts, sessionId),
    rewindAnchors: withoutMap(state.rewindAnchors, sessionId),
    pendingCompletions: withoutMap(state.pendingCompletions, sessionId),
    unviewedSessionIds: without(state.unviewedSessionIds, sessionId),
    pendingRelations: withoutMap(state.pendingRelations, sessionId),
    pendingIdentityAdoptions: withoutMap(state.pendingIdentityAdoptions, sessionId),
  }, [persistNavigation(restoreTo)])
}

function terminalExited(
  state: ApplicationState,
  sessionId: string,
  cleanupIncomplete: boolean,
): ReduceResult {
  const wasVisible = state.surface._tag === "Terminal" && state.surface.sessionId === sessionId
  const returnTo = wasVisible ? state.surface.returnTo : undefined
  const stopped = cleanupIncomplete
    ? terminalCleanupIncomplete(state, sessionId)
    : terminalStopped(state, sessionId)
  const returned = returnTo ? { ...stopped.state, surface: returnTo } : stopped.state
  const refresh = requestRefresh(
    returned,
    "stop",
    returnTo ? sessionId : undefined,
    new Set([sessionId]),
  )
  return {
    state: refresh.state,
    commands: [
      ...stopped.commands,
      ...(returnTo ? [persistNavigation(returnTo)] : []),
      ...refresh.commands,
    ],
  }
}

function terminalCleanupIncomplete(state: ApplicationState, sessionId: string): ReduceResult {
  const terminal = state.terminals.get(sessionId)
  return changed(state, {
    terminals: new Map(state.terminals).set(sessionId, {
      activity: terminal?.activity ?? "idle",
      phase: "cleanup-incomplete",
    }),
    drafts: withoutMap(state.drafts, sessionId),
    rewindAnchors: withoutMap(state.rewindAnchors, sessionId),
    pendingCompletions: withoutMap(state.pendingCompletions, sessionId),
    unviewedSessionIds: without(state.unviewedSessionIds, sessionId),
    pendingTerminalShow: state.pendingTerminalShow?.sessionId === sessionId
      ? null
      : state.pendingTerminalShow,
  })
}

function terminalActivityChanged(
  state: ApplicationState,
  sessionId: string,
  activity: "working" | "blocked" | "idle",
  wasVisible: boolean,
): ReduceResult {
  const terminals = new Map(state.terminals)
  terminals.set(sessionId, {
    activity,
    phase: terminals.get(sessionId)?.phase ?? "running",
  })
  const rewindAnchors = new Map(state.rewindAnchors)
  if (activity === "working") {
    const anchor = rewindAnchors.get(sessionId)
    if (anchor) rewindAnchors.set(sessionId, { ...anchor, submitted: true })
  }
  if (activity !== "idle") {
    return changed(state, {
      terminals,
      rewindAnchors,
      pendingCompletions: withoutMap(state.pendingCompletions, sessionId),
    })
  }

  const nextCompletionVersion = state.nextCompletionVersion + 1
  const read = selectTranscriptRead(state, sessionId)
  const completion: PendingCompletion = {
    version: nextCompletionVersion,
    baseline: read?._tag === "Available" ? read.messages : [],
    markUnviewed: !wasVisible,
    attempt: 0,
  }
  return {
    state: {
      ...state,
      terminals,
      rewindAnchors,
      pendingCompletions: new Map(state.pendingCompletions).set(sessionId, completion),
      nextCompletionVersion,
    },
    commands: [{
      _tag: "ScheduleCompletionRefresh",
      sessionId,
      version: nextCompletionVersion,
      attempt: 0,
    }],
  }
}

function observeDraft(
  state: ApplicationState,
  sessionId: string,
  draft: DraftPreview | undefined,
): ReduceResult {
  const drafts = new Map(state.drafts)
  const rewindAnchors = new Map(state.rewindAnchors)
  if (draft) drafts.set(sessionId, draft)
  else drafts.delete(sessionId)
  if (draft?.rewind) {
    const read = selectTranscriptRead(state, sessionId)
    const targetText = normalizeDraftText(draft.rewindTarget ?? draft.text)
    const matches = read?._tag === "Available"
      ? read.messages.filter(
          (message) =>
            message.role === "user" &&
            message.visible &&
            normalizeDraftText(message.preview) === targetText,
        )
      : []
    if (matches.length === 1) {
      rewindAnchors.set(sessionId, {
        targetMessageId: matches[0]!.id,
        submitted: draft.submitted ?? false,
      })
    } else {
      rewindAnchors.delete(sessionId)
    }
  }
  return changed(state, { drafts, rewindAnchors })
}

function requestRemoval(
  state: ApplicationState,
  requestId: string,
  removal: ConversationRemoval,
  affectedSessionIds: readonly string[],
): ReduceResult {
  const waitingForSessionIds = new Set(
    affectedSessionIds.filter((sessionId) => state.terminals.has(sessionId)),
  )
  const pendingRemovals = new Map(state.pendingRemovals).set(requestId, {
    removal,
    waitingForSessionIds,
  })
  if (waitingForSessionIds.size === 0) {
    return {
      state: { ...state, modal: null, pendingRemovals },
      commands: [{ _tag: "PersistRemoval", requestId, removal }],
    }
  }
  const terminals = new Map(state.terminals)
  const commands: AppCommand[] = []
  for (const sessionId of waitingForSessionIds) {
    const terminal = terminals.get(sessionId)
    if (terminal) terminals.set(sessionId, { ...terminal, phase: "stopping" })
    commands.push({ _tag: "StopSession", sessionId })
  }
  return {
    state: { ...state, modal: null, terminals, pendingRemovals },
    commands,
  }
}

function terminalStopped(state: ApplicationState, sessionId: string): ReduceResult {
  const pendingRemovals = new Map(state.pendingRemovals)
  const commands: AppCommand[] = []
  for (const [requestId, pending] of pendingRemovals) {
    if (!pending.waitingForSessionIds.has(sessionId)) continue
    const waitingForSessionIds = without(pending.waitingForSessionIds, sessionId)
    const nextPending = { ...pending, waitingForSessionIds }
    pendingRemovals.set(requestId, nextPending)
    if (waitingForSessionIds.size === 0) {
      commands.push({ _tag: "PersistRemoval", requestId, removal: pending.removal })
    }
  }
  return {
    state: {
      ...state,
      terminals: withoutMap(state.terminals, sessionId),
      drafts: withoutMap(state.drafts, sessionId),
      rewindAnchors: withoutMap(state.rewindAnchors, sessionId),
      pendingCompletions: withoutMap(state.pendingCompletions, sessionId),
      unviewedSessionIds: without(state.unviewedSessionIds, sessionId),
      pendingTerminalShow: state.pendingTerminalShow?.sessionId === sessionId
        ? null
        : state.pendingTerminalShow,
      pendingRemovals,
    },
    commands,
  }
}

function cancelRemovalsWaitingFor(
  pendingRemovals: ReadonlyMap<string, PendingRemoval>,
  sessionId: string,
): Map<string, PendingRemoval> {
  return new Map(
    [...pendingRemovals].filter(([, pending]) => !pending.waitingForSessionIds.has(sessionId)),
  )
}

function intentionalTerminalStopped(state: ApplicationState, sessionId: string): ReduceResult {
  if (!state.terminals.has(sessionId)) return unchanged(state)
  const stopped = terminalStopped(state, sessionId)
  const refresh = requestRefresh(stopped.state, "stop", sessionId, new Set([sessionId]))
  return {
    state: refresh.state,
    commands: [...stopped.commands, ...refresh.commands],
  }
}

function removalPersisted(state: ApplicationState, requestId: string): ReduceResult {
  const pending = state.pendingRemovals.get(requestId)
  if (!pending || pending.waitingForSessionIds.size > 0) return unchanged(state)
  return changed(state, {
    removals: [...state.removals, pending.removal],
    pendingRemovals: withoutMap(state.pendingRemovals, requestId),
  })
}

function requestSessionIdentityAdoption(
  state: ApplicationState,
  temporarySessionId: string,
  session: AgentSession,
  requestedDerivation?: BranchDerivation,
): ReduceResult {
  if (temporarySessionId === session.id || state.pendingIdentityAdoptions.has(temporarySessionId)) {
    return unchanged(state)
  }
  const derivation = requestedDerivation ?? state.pendingRelations.get(temporarySessionId)
  return changed(state, {
    pendingIdentityAdoptions: new Map(state.pendingIdentityAdoptions).set(
      temporarySessionId,
      { session },
    ),
  }, [{
    _tag: "AdoptSessionIdentity",
    temporarySessionId,
    session,
    ...(derivation === undefined ? {} : { derivation }),
  }])
}

function adoptSessionIdentity(
  state: ApplicationState,
  previousSessionId: string,
  session: AgentSession,
  relation?: BranchRelation,
): ReduceResult {
  if (previousSessionId === session.id) return unchanged(state)
  const pendingAdoption = state.pendingIdentityAdoptions.get(previousSessionId)
  if (!pendingAdoption || pendingAdoption.session.id !== session.id) return unchanged(state)
  const sessionId = session.id
  const providerSessions = migrateMapKey(state.provider.sessions, previousSessionId, sessionId)
  if (state.provider.sessions.has(previousSessionId) || state.provider.sessions.has(sessionId)) {
    providerSessions.set(sessionId, session)
  }
  const localSessions = migrateMapKey(state.local.sessions, previousSessionId, sessionId)
  localSessions.set(sessionId, session)
  const pendingRemovals = new Map<string, PendingRemoval>()
  for (const [requestId, pending] of state.pendingRemovals) {
    pendingRemovals.set(requestId, {
      removal: replaceSessionIdInRemoval(pending.removal, previousSessionId, sessionId),
      waitingForSessionIds: migrateSet(pending.waitingForSessionIds, previousSessionId, sessionId),
    })
  }
  const migratedActive = state.refresh.active
    ? {
        ...state.refresh.active,
        ...(state.refresh.active.focusSessionId === undefined
          ? {}
          : {
              focusSessionId: state.refresh.active.focusSessionId === previousSessionId
                ? sessionId
                : state.refresh.active.focusSessionId,
            }),
        ...(state.refresh.active.sessionIds === undefined
          ? {}
          : { sessionIds: migrateSet(state.refresh.active.sessionIds, previousSessionId, sessionId) }),
        completionVersions: migrateMapKey(
          state.refresh.active.completionVersions,
          previousSessionId,
          sessionId,
        ),
      }
    : null
  const generation = migratedActive ? state.refresh.generation + 1 : state.refresh.generation
  const active = migratedActive ? { ...migratedActive, generation } : null
  const commands: AppCommand[] = []
  if (active) {
    commands.push({
      _tag: "RefreshProvider",
      generation,
      mode: active.mode,
      reason: active.reason,
      ...(active.focusSessionId === undefined ? {} : { focusSessionId: active.focusSessionId }),
      ...(active.sessionIds === undefined ? {} : { sessionIds: active.sessionIds }),
    })
  }
  const surface = replaceSessionIdInSurface(state.surface, previousSessionId, sessionId)
  if (surface !== state.surface) commands.unshift(persistNavigation(surface))
  return {
    state: {
      ...state,
      provider: {
        sessions: providerSessions,
        transcripts: migrateMapKey(state.provider.transcripts, previousSessionId, sessionId),
      },
      local: {
        sessions: localSessions,
        transcripts: migrateMapKey(state.local.transcripts, previousSessionId, sessionId),
        temporarySessionIds: without(state.local.temporarySessionIds, previousSessionId),
      },
      relations: relation === undefined
        ? state.relations.map((item) =>
            replaceSessionIdInRelation(item, previousSessionId, sessionId))
        : [
            ...state.relations
              .map((item) => replaceSessionIdInRelation(item, previousSessionId, sessionId))
              .filter((item) => item.childSessionId !== relation.childSessionId),
            relation,
          ],
      removals: state.removals.map((removal) =>
        replaceSessionIdInRemoval(removal, previousSessionId, sessionId)),
      surface,
      modal: replaceSessionIdInModal(state.modal, previousSessionId, sessionId),
      terminals: migrateMapKey(state.terminals, previousSessionId, sessionId),
      pendingTerminalShow: replaceSessionIdInPendingTerminalShow(
        state.pendingTerminalShow,
        previousSessionId,
        sessionId,
      ),
      drafts: migrateMapKey(state.drafts, previousSessionId, sessionId),
      rewindAnchors: migrateMapKey(state.rewindAnchors, previousSessionId, sessionId),
      pendingCompletions: migrateMapKey(state.pendingCompletions, previousSessionId, sessionId),
      unviewedSessionIds: migrateSet(state.unviewedSessionIds, previousSessionId, sessionId),
      pendingRemovals,
      pendingRelations: migrateDerivationMap(
        state.pendingRelations,
        previousSessionId,
        sessionId,
      ),
      pendingIdentityAdoptions: withoutMap(state.pendingIdentityAdoptions, previousSessionId),
      refresh: {
        ...state.refresh,
        generation,
        active,
      },
    },
    commands,
  }
}

function completionTranscriptReady(
  previous: readonly AgentMessage[],
  refreshed: readonly AgentMessage[],
  rewindAnchor?: RewindAnchor,
): boolean {
  if (sameTranscript(previous, refreshed)) return false
  if (rewindAnchor?.submitted) {
    const targetIndex = previous.findIndex((message) => message.id === rewindAnchor.targetMessageId)
    if (
      targetIndex >= 0 &&
      refreshed.length <= targetIndex &&
      refreshed.every((message, index) => samePersistedContent(previous[index], message))
    ) return false
  }
  const lastVisibleUserIndex = refreshed.findLastIndex(
    (message) => message.role === "user" && message.visible,
  )
  const afterUser = refreshed.slice(lastVisibleUserIndex + 1)
  const completionSignals = refreshed
    .slice(Math.max(0, lastVisibleUserIndex))
    .filter((message) => message.turnComplete !== undefined)
  return completionSignals.at(-1)?.turnComplete ?? afterUser.some((message) => message.role === "agent")
}

function stableTranscriptWhileNonIdle(
  previous: readonly AgentMessage[],
  refreshed: readonly AgentMessage[],
): readonly AgentMessage[] {
  if (!isTranscriptPrefix(previous, refreshed)) return previous
  let lastNewVisibleUserIndex = -1
  for (let index = previous.length; index < refreshed.length; index += 1) {
    const message = refreshed[index]
    if (message?.role === "user" && message.visible) lastNewVisibleUserIndex = index
  }
  return lastNewVisibleUserIndex < 0 ? previous : refreshed.slice(0, lastNewVisibleUserIndex + 1)
}

function isTranscriptPrefix(
  prefix: readonly AgentMessage[],
  transcript: readonly AgentMessage[],
): boolean {
  return prefix.length <= transcript.length &&
    prefix.every((message, index) => sameMessage(message, transcript[index]))
}

function sameTranscript(left: readonly AgentMessage[], right: readonly AgentMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => sameMessage(message, right[index]))
}

function sameMessage(left: AgentMessage, right: AgentMessage | undefined): boolean {
  return right !== undefined &&
    left.id === right.id &&
    left.role === right.role &&
    left.preview === right.preview &&
    left.ordinal === right.ordinal &&
    left.visible === right.visible &&
    left.displayGroupId === right.displayGroupId &&
    left.turnComplete === right.turnComplete &&
    left.copyIdentity === right.copyIdentity
}

function samePersistedContent(left: AgentMessage | undefined, right: AgentMessage): boolean {
  if (!left || left.role !== right.role || left.preview !== right.preview) return false
  return left.copyIdentity === undefined || right.copyIdentity === undefined || left.copyIdentity === right.copyIdentity
}

function relationFromDerivation(
  derivation: Extract<AppEvent, { readonly _tag: "RelationPersisted" }>['derivation'],
  createdAt: string,
): BranchRelation {
  return { ...derivation, createdAt }
}

function navigatorSurface(
  surface: ApplicationSurface,
  sessionId: string,
  state: ApplicationState,
): NavigatorSurface {
  if (surface._tag === "Terminal") return surface.returnTo
  if (surface._tag === "Graph") return surface
  return {
    _tag: "Graph",
    familySessionId: selectFamilyRootSessionId(state, sessionId),
    target: { kind: "endpoint", sessionId },
  }
}

function replaceSessionIdInRelation(
  relation: BranchRelation,
  previousSessionId: string,
  sessionId: string,
): BranchRelation {
  return {
    ...relation,
    childSessionId: relation.childSessionId === previousSessionId ? sessionId : relation.childSessionId,
    parentSessionId: relation.parentSessionId === previousSessionId ? sessionId : relation.parentSessionId,
  }
}

function replaceSessionIdInRemoval(
  removal: ConversationRemoval,
  previousSessionId: string,
  sessionId: string,
): ConversationRemoval {
  if (removal.kind === "tree") {
    return {
      ...removal,
      rootSessionId: removal.rootSessionId === previousSessionId ? sessionId : removal.rootSessionId,
      memberSessionIds: removal.memberSessionIds.map((id) => id === previousSessionId ? sessionId : id),
    }
  }
  if (removal.target.kind === "message") {
    return {
      ...removal,
      target: {
        ...removal.target,
        aliases: removal.target.aliases.map((ref) =>
          replaceSessionIdInRef(ref, previousSessionId, sessionId)),
      },
    }
  }
  return {
    ...removal,
    target: {
      ...removal.target,
      sessionId: removal.target.sessionId === previousSessionId ? sessionId : removal.target.sessionId,
    },
  }
}

function replaceSessionIdInSurface(
  surface: ApplicationSurface,
  previousSessionId: string,
  sessionId: string,
): ApplicationSurface {
  if (surface._tag === "Roots") {
    return {
      ...surface,
      selectedSessionId: surface.selectedSessionId === previousSessionId ? sessionId : surface.selectedSessionId,
    }
  }
  if (surface._tag === "Terminal") {
    return {
      ...surface,
      sessionId: surface.sessionId === previousSessionId ? sessionId : surface.sessionId,
      returnTo: replaceSessionIdInSurface(surface.returnTo, previousSessionId, sessionId) as NavigatorSurface,
    }
  }
  return {
    ...surface,
    familySessionId: surface.familySessionId === previousSessionId ? sessionId : surface.familySessionId,
    target: replaceSessionIdInTarget(surface.target, previousSessionId, sessionId),
  }
}

function replaceSessionIdInTarget(
  target: NavigationTarget,
  previousSessionId: string,
  sessionId: string,
): NavigationTarget {
  if (target.kind === "endpoint") {
    return {
      ...target,
      sessionId: target.sessionId === previousSessionId ? sessionId : target.sessionId,
    }
  }
  return {
    ...target,
    preferred: replaceSessionIdInRef(target.preferred, previousSessionId, sessionId),
    aliases: target.aliases.map((ref) => replaceSessionIdInRef(ref, previousSessionId, sessionId)),
  }
}

function replaceSessionIdInModal(
  modal: ApplicationModal | null,
  previousSessionId: string,
  sessionId: string,
): ApplicationModal | null {
  if (modal?._tag === "ConfirmStop") {
    return {
      ...modal,
      sessionId: modal.sessionId === previousSessionId ? sessionId : modal.sessionId,
    }
  }
  if (modal?._tag === "ConfirmRemoval") {
    return {
      ...modal,
      removal: replaceSessionIdInRemoval(modal.removal, previousSessionId, sessionId),
      affectedSessionIds: modal.affectedSessionIds.map((id) => id === previousSessionId ? sessionId : id),
    }
  }
  return modal
}

function replaceSessionIdInPendingTerminalShow(
  pending: ApplicationState["pendingTerminalShow"],
  previousSessionId: string,
  sessionId: string,
): ApplicationState["pendingTerminalShow"] {
  if (!pending) return null
  return {
    ...pending,
    sessionId: pending.sessionId === previousSessionId ? sessionId : pending.sessionId,
    returnTo: replaceSessionIdInSurface(
      pending.returnTo,
      previousSessionId,
      sessionId,
    ) as NavigatorSurface,
  }
}

function migrateMapKey<V>(
  source: ReadonlyMap<string, V>,
  previousSessionId: string,
  sessionId: string,
): Map<string, V> {
  const migrated = new Map(source)
  const value = migrated.get(previousSessionId)
  migrated.delete(previousSessionId)
  if (value !== undefined && !migrated.has(sessionId)) migrated.set(sessionId, value)
  return migrated
}

function migrateSet(
  source: ReadonlySet<string>,
  previousSessionId: string,
  sessionId: string,
): Set<string> {
  const migrated = new Set(source)
  if (migrated.delete(previousSessionId)) migrated.add(sessionId)
  return migrated
}

function without<T>(source: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(source)
  next.delete(value)
  return next
}

function withoutMap<K, V>(source: ReadonlyMap<K, V>, key: K): Map<K, V> {
  const next = new Map(source)
  next.delete(key)
  return next
}

function updateMapValue<V>(
  source: ReadonlyMap<string, V>,
  key: string,
  update: (value: V | undefined) => V | undefined,
): Map<string, V> {
  const next = new Map(source)
  const value = update(next.get(key))
  if (value === undefined) next.delete(key)
  else next.set(key, value)
  return next
}

function normalizeDraftText(text: string): string {
  return text.replace(/\s+/gu, " ").trim()
}

function preserveOwnedSessions(
  state: ApplicationState,
  incoming: ReadonlyMap<string, AgentSession>,
): Map<string, AgentSession> {
  const sessions = new Map(incoming)
  for (const sessionId of state.terminals.keys()) {
    if (sessions.has(sessionId)) continue
    const session = state.local.sessions.get(sessionId) ?? state.provider.sessions.get(sessionId)
    if (session) sessions.set(sessionId, session)
  }
  return sessions
}

function preserveOwnedTranscripts(
  state: ApplicationState,
  incoming: ReadonlyMap<string, TranscriptRead>,
): Map<string, TranscriptRead> {
  const transcripts = new Map(incoming)
  for (const sessionId of state.terminals.keys()) {
    if (transcripts.has(sessionId)) continue
    const transcript = selectTranscriptRead(state, sessionId)
    if (transcript) transcripts.set(sessionId, transcript)
  }
  return transcripts
}

function retryCompletions(
  source: ReadonlyMap<string, PendingCompletion>,
  versions: ReadonlyMap<string, number>,
): {
  readonly pending: ReadonlyMap<string, PendingCompletion>
  readonly commands: readonly AppCommand[]
  readonly failures: readonly string[]
} {
  const pending = new Map(source)
  const commands: AppCommand[] = []
  const failures: string[] = []
  for (const [sessionId, version] of versions) {
    const completion = pending.get(sessionId)
    if (!completion || completion.version !== version) continue
    const attempt = completion.attempt + 1
    if (attempt >= MAX_COMPLETION_REFRESH_ATTEMPTS) {
      pending.delete(sessionId)
      failures.push("Completed response did not become available")
      continue
    }
    const next = { ...completion, attempt }
    pending.set(sessionId, next)
    commands.push(scheduleCompletion(sessionId, next))
  }
  return { pending, commands, failures }
}

function completionRefreshFailed(
  state: ApplicationState,
  sessionId: string,
  version: number,
  message: string,
): ReduceResult {
  const completion = state.pendingCompletions.get(sessionId)
  if (!completion || completion.version !== version) return unchanged(state)
  const retried = retryCompletions(state.pendingCompletions, new Map([[sessionId, version]]))
  return {
    state: {
      ...state,
      pendingCompletions: retried.pending,
      ...(retried.failures.length === 0
        ? {}
        : { modal: { _tag: "Error", message: retried.failures[0] ?? message } as const }),
    },
    commands: retried.commands,
  }
}

function scheduleCompletion(sessionId: string, completion: PendingCompletion): AppCommand {
  return {
    _tag: "ScheduleCompletionRefresh",
    sessionId,
    version: completion.version,
    attempt: completion.attempt,
  }
}

function navigate(state: ApplicationState, surface: NavigatorSurface): ReduceResult {
  return changed(state, { surface }, [persistNavigation(surface)])
}

function persistNavigation(surface: ApplicationSurface): AppCommand {
  return { _tag: "PersistNavigation", navigation: navigationForSurface(surface) }
}

function navigationForSurface(surface: ApplicationSurface): NavigationState {
  if (surface._tag === "Roots") {
    return { view: "roots", selectedSessionId: surface.selectedSessionId }
  }
  if (surface._tag === "Graph") {
    return {
      view: "graph",
      familySessionId: surface.familySessionId,
      target: surface.target,
    }
  }
  return { view: "terminal", sessionId: surface.sessionId }
}

function sameDerivation(left: BranchDerivation, right: BranchDerivation): boolean {
  return left.childSessionId === right.childSessionId &&
    left.parentSessionId === right.parentSessionId &&
    left.sourceMessageId === right.sourceMessageId &&
    left.sharedMessages.length === right.sharedMessages.length &&
    left.sharedMessages.every((message, index) => {
      const candidate = right.sharedMessages[index]
      return candidate?.parentMessageId === message.parentMessageId &&
        candidate.childMessageId === message.childMessageId
    })
}

function migrateDerivationMap(
  source: ReadonlyMap<string, BranchDerivation>,
  previousSessionId: string,
  sessionId: string,
): Map<string, BranchDerivation> {
  const migrated = new Map<string, BranchDerivation>()
  for (const [key, derivation] of source) {
    migrated.set(key === previousSessionId ? sessionId : key, {
      ...derivation,
      childSessionId: derivation.childSessionId === previousSessionId
        ? sessionId
        : derivation.childSessionId,
      parentSessionId: derivation.parentSessionId === previousSessionId
        ? sessionId
        : derivation.parentSessionId,
    })
  }
  return migrated
}

function isShutdownEvent(event: AppEvent): boolean {
  return event._tag === "ShutdownCompleted" || event._tag === "ShutdownFailed"
}

function changed(
  state: ApplicationState,
  change: Partial<ApplicationState>,
  commands: readonly AppCommand[] = [],
): ReduceResult {
  return { state: { ...state, ...change }, commands }
}

function unchanged(state: ApplicationState): ReduceResult {
  return { state, commands: [] }
}
