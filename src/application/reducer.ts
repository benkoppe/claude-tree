import type {
  AgentMessage,
  AgentSession,
  AgentSessionSnapshot,
  DraftPreview,
  NavigationState,
  NavigationTarget,
  TranscriptRead,
} from "../domain/model"
import type {
  BranchRelation,
  ConversationRemoval,
  IdentityTransitionKind,
} from "../domain/persistence"
import { replaceSessionIdInProjectState } from "../services/provider-state-repository"
import { selectFamilyRootSessionId, selectTranscriptRead } from "./selectors"
import type {
  ActiveRefresh,
  ApplicationModal,
  ApplicationState,
  ApplicationSurface,
  NavigatorSurface,
  PendingCompletion,
  RewindAnchor,
  TerminalState,
} from "./state"

export const MAX_COMPLETION_REFRESH_ATTEMPTS = 4

export type StateEvent =
  | { readonly _tag: "RefreshStarted"; readonly refresh: ActiveRefresh; readonly replaceAll?: boolean }
  | { readonly _tag: "RefreshSucceeded"; readonly key: string; readonly generation: number; readonly snapshot: AgentSessionSnapshot }
  | { readonly _tag: "RefreshFailed"; readonly key: string; readonly generation: number; readonly message: string }
  | { readonly _tag: "RefreshSuperseded"; readonly key: string; readonly generation: number }
  | { readonly _tag: "LocalSessionProjected"; readonly session: AgentSession; readonly transcript?: TranscriptRead; readonly temporary?: boolean }
  | { readonly _tag: "PersistedBranchProjected"; readonly session: AgentSession; readonly relation: BranchRelation; readonly transcript?: TranscriptRead }
  | { readonly _tag: "TransientSessionRolledBack"; readonly sessionId: string; readonly restoreTo: NavigatorSurface }
  | { readonly _tag: "Navigated"; readonly surface: ApplicationSurface }
  | { readonly _tag: "TerminalShowStarted"; readonly sessionId: string }
  | { readonly _tag: "TerminalShown"; readonly sessionId: string; readonly ownerId: string; readonly returnTo: NavigatorSurface }
  | { readonly _tag: "TerminalShowFailed"; readonly sessionId: string; readonly restoreTo: NavigatorSurface; readonly message?: string }
  | { readonly _tag: "TerminalReturned"; readonly sessionId: string; readonly draft?: DraftPreview }
  | { readonly _tag: "TerminalActivityObserved"; readonly sessionId: string; readonly ownerId: string; readonly activity: "working" | "blocked" | "idle"; readonly wasVisible: boolean }
  | { readonly _tag: "TerminalDraftObserved"; readonly sessionId: string; readonly draft?: DraftPreview }
  | { readonly _tag: "TerminalStopping"; readonly sessionId: string }
  | { readonly _tag: "TerminalStopped"; readonly sessionId: string; readonly cleanupIncomplete?: boolean }
  | { readonly _tag: "CompletionAttemptAdvanced"; readonly sessionId: string; readonly message?: string }
  | { readonly _tag: "SessionIdentityAdopted"; readonly previousSessionId: string; readonly session: AgentSession; readonly replacePrevious: boolean; readonly relation?: BranchRelation }
  | { readonly _tag: "RemovalPersisted"; readonly removal: ConversationRemoval; readonly stoppedSessionIds: readonly string[] }
  | { readonly _tag: "ModalOpened"; readonly modal: ApplicationModal }
  | { readonly _tag: "ModalClosed" }
  | { readonly _tag: "ShutdownStarted" }
  | { readonly _tag: "ShutdownCompleted" }
  | { readonly _tag: "ShutdownFailed"; readonly message: string }

export function reduceApplicationState(state: ApplicationState, event: StateEvent): ApplicationState {
  if (state.shutdown === "stopped" || state.shutdown === "cleanup-incomplete") return state
  if (state.shutdown === "shutting-down" && !isShutdownEvent(event)) return state

  switch (event._tag) {
    case "RefreshStarted": {
      const active = event.replaceAll ? new Map<string, ActiveRefresh>() : new Map(state.refresh.active)
      active.set(event.refresh.key, event.refresh)
      return {
        ...state,
        refresh: {
          generation: Math.max(state.refresh.generation, event.refresh.generation),
          active,
          initialPending: state.refresh.initialPending,
        },
      }
    }
    case "RefreshSuperseded":
      return removeRefresh(state, event.key, event.generation)
    case "RefreshFailed": {
      const active = state.refresh.active.get(event.key)
      if (!active || active.generation !== event.generation) return state
      const next = removeRefresh(state, event.key, event.generation)
      if (active.completionVersion !== undefined) {
        return advanceCompletion(next, [...active.sessionIds][0] ?? "", event.message)
      }
      if (active.reason === "ambiguity") {
        const ambiguity = active.ambiguityReason ?? "Provider branch mutation outcome is ambiguous"
        return {
          ...next,
          refresh: { ...next.refresh, initialPending: false },
          modal: {
            _tag: "Error",
            message: `${ambiguity}; reconciliation failed: ${event.message}`,
          },
        }
      }
      return {
        ...next,
        refresh: { ...next.refresh, initialPending: false },
        modal: { _tag: "Error", message: event.message },
      }
    }
    case "RefreshSucceeded":
      return refreshSucceeded(state, event.key, event.generation, event.snapshot)
    case "LocalSessionProjected":
      return projectLocalSession(state, event.session, event.transcript, event.temporary)
    case "PersistedBranchProjected": {
      const projected = projectLocalSession(state, event.session, event.transcript, event.session.transient)
      return {
        ...projected,
        relations: upsertRelation(projected.relations, event.relation),
      }
    }
    case "TransientSessionRolledBack":
      return rollbackTransient(state, event.sessionId, event.restoreTo)
    case "Navigated":
      return { ...state, surface: event.surface }
    case "TerminalShowStarted":
      return {
        ...state,
        terminals: new Map(state.terminals).set(event.sessionId, {
          activity: state.terminals.get(event.sessionId)?.activity ?? "idle",
          phase: "showing",
        }),
      }
    case "TerminalShown":
      return terminalShown(state, event.sessionId, event.ownerId, event.returnTo)
    case "TerminalShowFailed": {
      const terminals = new Map(state.terminals)
      if (terminals.get(event.sessionId)?.phase === "showing") terminals.delete(event.sessionId)
      return {
        ...state,
        terminals,
        surface: event.restoreTo,
        ...(event.message === undefined ? {} : { modal: { _tag: "Error", message: event.message } as const }),
      }
    }
    case "TerminalReturned":
      return terminalReturned(state, event.sessionId, event.draft)
    case "TerminalActivityObserved":
      return terminalActivity(state, event)
    case "TerminalDraftObserved":
      return observeDraft(state, event.sessionId, event.draft)
    case "TerminalStopping": {
      const terminal = state.terminals.get(event.sessionId)
      return terminal
        ? { ...state, terminals: new Map(state.terminals).set(event.sessionId, { ...terminal, phase: "stopping" }) }
        : state
    }
    case "TerminalStopped":
      return terminalStopped(state, event.sessionId, event.cleanupIncomplete ?? false)
    case "CompletionAttemptAdvanced":
      return advanceCompletion(state, event.sessionId, event.message)
    case "SessionIdentityAdopted":
      return adoptSessionIdentity(
        state,
        event.previousSessionId,
        event.session,
        event.replacePrevious,
        event.relation,
      )
    case "RemovalPersisted": {
      let next = state
      for (const sessionId of event.stoppedSessionIds) next = terminalStopped(next, sessionId, false)
      return { ...next, removals: [...next.removals, event.removal], modal: null }
    }
    case "ModalOpened":
      return { ...state, modal: event.modal }
    case "ModalClosed":
      return { ...state, modal: null }
    case "ShutdownStarted":
      return {
        ...state,
        shutdown: "shutting-down",
        modal: null,
        pendingCompletions: new Map(),
        refresh: { ...state.refresh, active: new Map() },
      }
    case "ShutdownCompleted":
      return {
        ...state,
        shutdown: "stopped",
        terminals: new Map(),
        drafts: new Map(),
        rewindAnchors: new Map(),
        pendingCompletions: new Map(),
        unviewedSessionIds: new Set(),
      }
    case "ShutdownFailed":
      return {
        ...state,
        shutdown: "cleanup-incomplete",
        terminals: new Map([...state.terminals].map(([sessionId, terminal]) => [
          sessionId,
          { ...terminal, phase: "cleanup-incomplete" as const },
        ])),
        modal: { _tag: "Error", message: event.message },
      }
  }
}

export function navigationForSurface(surface: ApplicationSurface): NavigationState {
  if (surface._tag === "Roots") return { view: "roots", selectedSessionId: surface.selectedSessionId }
  if (surface._tag === "Graph") {
    return { view: "graph", familySessionId: surface.familySessionId, target: surface.target }
  }
  return { view: "terminal", sessionId: surface.sessionId }
}

function refreshSucceeded(
  state: ApplicationState,
  key: string,
  generation: number,
  snapshot: AgentSessionSnapshot,
): ApplicationState {
  const active = state.refresh.active.get(key)
  if (!active || active.generation !== generation) return state
  const incomingSessions = new Map(snapshot.sessions.map((session) => [session.id, session]))
  const sessions = active.mode === "full"
    ? preserveOwnedSessions(state, incomingSessions)
    : new Map([...state.provider.sessions, ...incomingSessions])
  const transcripts = active.mode === "full"
    ? preserveOwnedTranscripts(state, snapshot.transcripts)
    : new Map([...state.provider.transcripts, ...snapshot.transcripts])
  const localSessions = new Map(state.local.sessions)
  const localTranscripts = new Map(state.local.transcripts)
  const temporarySessionIds = new Set(state.local.temporarySessionIds)
  const rewindAnchors = new Map(state.rewindAnchors)
  const pendingCompletions = new Map(state.pendingCompletions)
  const unviewedSessionIds = new Set(state.unviewedSessionIds)

  for (const [sessionId, incoming] of snapshot.transcripts) {
    const completion = pendingCompletions.get(sessionId)
    const completionReady = completion !== undefined && incoming._tag === "Available" &&
      completionTranscriptReady(completion.baseline, incoming.messages, rewindAnchors.get(sessionId))
    if (completionReady) {
      pendingCompletions.delete(sessionId)
      if (completion.markUnviewed) unviewedSessionIds.add(sessionId)
    } else if (completion) {
      transcripts.set(sessionId, { _tag: "Available", messages: completion.baseline })
      continue
    } else if (incoming._tag === "Available") {
      const previous = selectTranscriptRead(state, sessionId)
      const terminal = state.terminals.get(sessionId)
      const anchor = rewindAnchors.get(sessionId)
      if (previous?._tag === "Available" && (terminal?.activity === "working" || terminal?.activity === "blocked")) {
        transcripts.set(sessionId, {
          _tag: "Available",
          messages: stableTranscriptWhileNonIdle(previous.messages, incoming.messages),
        })
      } else if (previous?._tag === "Available" && incoming.messages.length < previous.messages.length && !anchor) {
        transcripts.set(sessionId, previous)
      }
    }

    if (incoming._tag !== "Available") continue
    const anchor = rewindAnchors.get(sessionId)
    if (anchor && !incoming.messages.some((message) => message.id === anchor.targetMessageId)) {
      rewindAnchors.delete(sessionId)
    }
    localTranscripts.delete(sessionId)
    const session = sessions.get(sessionId)
    if (session && !session.transient) {
      localSessions.delete(sessionId)
      temporarySessionIds.delete(sessionId)
    }
  }

  for (const [sessionId, completion] of pendingCompletions) {
    transcripts.set(sessionId, { _tag: "Available", messages: completion.baseline })
  }

  let completionExhausted = false
  if (active.completionVersion !== undefined) {
    for (const sessionId of active.sessionIds) {
      const completion = pendingCompletions.get(sessionId)
      if (!completion || completion.version !== active.completionVersion) continue
      const advanced = advanceCompletionValue(completion)
      if (advanced) pendingCompletions.set(sessionId, advanced)
      else {
        pendingCompletions.delete(sessionId)
        completionExhausted = true
      }
    }
  }

  const without = removeRefresh(state, key, generation)
  return {
    ...without,
    provider: { sessions, transcripts },
    local: { sessions: localSessions, transcripts: localTranscripts, temporarySessionIds },
    rewindAnchors,
    pendingCompletions,
    unviewedSessionIds,
    refresh: { ...without.refresh, initialPending: false },
    ...(completionExhausted
      ? { modal: { _tag: "Error", message: "Completed response did not become available" } as const }
      : {}),
  }
}

function projectLocalSession(
  state: ApplicationState,
  session: AgentSession,
  transcript?: TranscriptRead,
  temporary?: boolean,
): ApplicationState {
  const sessions = new Map(state.local.sessions).set(session.id, session)
  const transcripts = new Map(state.local.transcripts)
  transcripts.set(session.id, transcript ?? transcripts.get(session.id) ?? { _tag: "Available", messages: [] })
  const temporarySessionIds = new Set(state.local.temporarySessionIds)
  if (temporary ?? session.transient) temporarySessionIds.add(session.id)
  return { ...state, local: { sessions, transcripts, temporarySessionIds } }
}

function terminalShown(
  state: ApplicationState,
  sessionId: string,
  ownerId: string,
  returnTo: NavigatorSurface,
): ApplicationState {
  const previous = state.terminals.get(sessionId)
  const pendingCompletions = new Map(state.pendingCompletions)
  const completion = pendingCompletions.get(sessionId)
  if (completion) pendingCompletions.set(sessionId, { ...completion, markUnviewed: false })
  return {
    ...state,
    surface: { _tag: "Terminal", sessionId, returnTo },
    terminals: new Map(state.terminals).set(sessionId, {
      ownerId,
      activity: previous?.activity ?? "idle",
      phase: "running",
    }),
    pendingCompletions,
    unviewedSessionIds: without(state.unviewedSessionIds, sessionId),
  }
}

function terminalReturned(state: ApplicationState, sessionId: string, draft?: DraftPreview): ApplicationState {
  const observed = draft === undefined ? state : observeDraft(state, sessionId, draft)
  const surface: NavigatorSurface = {
    _tag: "Graph",
    familySessionId: selectFamilyRootSessionId(observed, sessionId),
    target: { kind: "endpoint", sessionId },
  }
  return { ...observed, surface }
}

function terminalActivity(
  state: ApplicationState,
  event: Extract<StateEvent, { readonly _tag: "TerminalActivityObserved" }>,
): ApplicationState {
  const existing = state.terminals.get(event.sessionId)
  if (!existing || existing.ownerId !== event.ownerId) return state
  const terminals = new Map(state.terminals).set(event.sessionId, { ...existing, activity: event.activity })
  const rewindAnchors = new Map(state.rewindAnchors)
  if (event.activity === "working") {
    const anchor = rewindAnchors.get(event.sessionId)
    if (anchor) rewindAnchors.set(event.sessionId, { ...anchor, submitted: true })
  }
  if (event.activity !== "idle") {
    return {
      ...state,
      terminals,
      rewindAnchors,
      pendingCompletions: withoutMap(state.pendingCompletions, event.sessionId),
    }
  }
  const version = state.nextCompletionVersion + 1
  const read = selectTranscriptRead(state, event.sessionId)
  return {
    ...state,
    terminals,
    rewindAnchors,
    pendingCompletions: new Map(state.pendingCompletions).set(event.sessionId, {
      ownerId: event.ownerId,
      version,
      baseline: read?._tag === "Available" ? read.messages : [],
      markUnviewed: !event.wasVisible,
      attempt: 0,
    }),
    nextCompletionVersion: version,
  }
}

function observeDraft(state: ApplicationState, sessionId: string, draft?: DraftPreview): ApplicationState {
  const drafts = new Map(state.drafts)
  const rewindAnchors = new Map(state.rewindAnchors)
  if (draft) drafts.set(sessionId, draft)
  else drafts.delete(sessionId)
  if (draft?.rewind) {
    const read = selectTranscriptRead(state, sessionId)
    const targetText = normalizeDraftText(draft.rewindTarget ?? draft.text)
    const matches = read?._tag === "Available"
      ? read.messages.filter((message) =>
          message.role === "user" && message.visible && normalizeDraftText(message.preview) === targetText)
      : []
    if (matches.length === 1) {
      rewindAnchors.set(sessionId, {
        targetMessageId: matches[0]!.id,
        submitted: draft.submitted ?? false,
      })
    } else rewindAnchors.delete(sessionId)
  }
  return { ...state, drafts, rewindAnchors }
}

function terminalStopped(state: ApplicationState, sessionId: string, cleanupIncomplete: boolean): ApplicationState {
  const terminal = state.terminals.get(sessionId)
  const wasVisible = state.surface._tag === "Terminal" && state.surface.sessionId === sessionId
  const terminals = new Map(state.terminals)
  if (cleanupIncomplete) {
    terminals.set(sessionId, {
      ...(terminal?.ownerId === undefined ? {} : { ownerId: terminal.ownerId }),
      activity: terminal?.activity ?? "idle",
      phase: "cleanup-incomplete",
    })
  } else terminals.delete(sessionId)
  return {
    ...state,
    terminals,
    surface: wasVisible ? state.surface.returnTo : state.surface,
    drafts: withoutMap(state.drafts, sessionId),
    rewindAnchors: withoutMap(state.rewindAnchors, sessionId),
    pendingCompletions: withoutMap(state.pendingCompletions, sessionId),
    unviewedSessionIds: without(state.unviewedSessionIds, sessionId),
  }
}

function rollbackTransient(
  state: ApplicationState,
  sessionId: string,
  restoreTo: NavigatorSurface,
): ApplicationState {
  if (!state.local.temporarySessionIds.has(sessionId)) return state
  return {
    ...state,
    local: {
      sessions: withoutMap(state.local.sessions, sessionId),
      transcripts: withoutMap(state.local.transcripts, sessionId),
      temporarySessionIds: without(state.local.temporarySessionIds, sessionId),
    },
    relations: state.relations.filter((relation) => relation.childSessionId !== sessionId),
    surface: restoreTo,
    terminals: withoutMap(state.terminals, sessionId),
    drafts: withoutMap(state.drafts, sessionId),
    rewindAnchors: withoutMap(state.rewindAnchors, sessionId),
    pendingCompletions: withoutMap(state.pendingCompletions, sessionId),
    unviewedSessionIds: without(state.unviewedSessionIds, sessionId),
  }
}

function adoptSessionIdentity(
  state: ApplicationState,
  previousSessionId: string,
  session: AgentSession,
  replacePrevious: boolean,
  relation?: BranchRelation,
): ApplicationState {
  if (previousSessionId === session.id) return state
  const sessionId = session.id
  if (!replacePrevious) {
    const replacement = { kind: "native-fork" as const, ...(relation === undefined ? {} : { relation }) }
    const metadata = replaceSessionIdInProjectState({
      relations: state.relations,
      removals: state.removals,
      navigation: navigationForSurface(state.surface),
    }, previousSessionId, sessionId, replacement)
    const localSessions = new Map(state.local.sessions).set(sessionId, session)
    const localTranscripts = new Map(state.local.transcripts)
    if (!localTranscripts.has(sessionId) && !state.provider.transcripts.has(sessionId)) {
      localTranscripts.set(sessionId, { _tag: "Available", messages: [] })
    }
    return {
      ...state,
      local: {
        sessions: localSessions,
        transcripts: localTranscripts,
        temporarySessionIds: session.transient
          ? new Set(state.local.temporarySessionIds).add(sessionId)
          : state.local.temporarySessionIds,
      },
      relations: relation === undefined ? metadata.relations : upsertRelation(metadata.relations, relation),
      removals: metadata.removals,
      surface: replaceSessionIdInSurface(
        state.surface,
        previousSessionId,
        sessionId,
        replacement,
      ),
      terminals: migrateMapKey(state.terminals, previousSessionId, sessionId),
      drafts: migrateMapKey(state.drafts, previousSessionId, sessionId),
      rewindAnchors: migrateMapKey(state.rewindAnchors, previousSessionId, sessionId),
      pendingCompletions: migrateMapKey(state.pendingCompletions, previousSessionId, sessionId),
      unviewedSessionIds: migrateSet(state.unviewedSessionIds, previousSessionId, sessionId),
    }
  }
  const metadata = replaceSessionIdInProjectState({
    relations: state.relations,
    removals: state.removals,
    navigation: navigationForSurface(state.surface),
  }, previousSessionId, sessionId, {
    kind: "temporary-adoption",
    ...(relation === undefined ? {} : { relation }),
  })
  const localSessions = migrateMapKey(state.local.sessions, previousSessionId, sessionId)
  localSessions.set(sessionId, session)
  const surface = replaceSessionIdInSurface(state.surface, previousSessionId, sessionId, {
    kind: "temporary-adoption",
    ...(relation === undefined ? {} : { relation }),
  })
  const active = new Map<string, ActiveRefresh>()
  for (const [key, refresh] of state.refresh.active) {
    active.set(key, {
      ...refresh,
      sessionIds: migrateSet(refresh.sessionIds, previousSessionId, sessionId),
    })
  }
  return {
    ...state,
    provider: {
      sessions: migrateMapKey(state.provider.sessions, previousSessionId, sessionId),
      transcripts: migrateMapKey(state.provider.transcripts, previousSessionId, sessionId),
    },
    local: {
      sessions: localSessions,
      transcripts: migrateMapKey(state.local.transcripts, previousSessionId, sessionId),
      temporarySessionIds: without(state.local.temporarySessionIds, previousSessionId),
    },
    relations: relation === undefined ? metadata.relations : upsertRelation(metadata.relations, relation),
    removals: metadata.removals,
    surface,
    modal: replaceSessionIdInModal(state.modal, previousSessionId, sessionId),
    terminals: migrateMapKey(state.terminals, previousSessionId, sessionId),
    drafts: migrateMapKey(state.drafts, previousSessionId, sessionId),
    rewindAnchors: migrateMapKey(state.rewindAnchors, previousSessionId, sessionId),
    pendingCompletions: migrateMapKey(state.pendingCompletions, previousSessionId, sessionId),
    unviewedSessionIds: migrateSet(state.unviewedSessionIds, previousSessionId, sessionId),
    refresh: { ...state.refresh, active },
  }
}

function advanceCompletion(state: ApplicationState, sessionId: string, message?: string): ApplicationState {
  const completion = state.pendingCompletions.get(sessionId)
  if (!completion) return state
  const next = advanceCompletionValue(completion)
  const pendingCompletions = new Map(state.pendingCompletions)
  if (next) pendingCompletions.set(sessionId, next)
  else pendingCompletions.delete(sessionId)
  return {
    ...state,
    pendingCompletions,
    ...(next || message === undefined
      ? {}
      : { modal: { _tag: "Error", message: "Completed response did not become available" } as const }),
  }
}

function advanceCompletionValue(completion: PendingCompletion): PendingCompletion | undefined {
  const attempt = completion.attempt + 1
  return attempt >= MAX_COMPLETION_REFRESH_ATTEMPTS ? undefined : { ...completion, attempt }
}

function removeRefresh(state: ApplicationState, key: string, generation: number): ApplicationState {
  const active = state.refresh.active.get(key)
  if (!active || active.generation !== generation) return state
  const next = new Map(state.refresh.active)
  next.delete(key)
  return { ...state, refresh: { ...state.refresh, active: next } }
}

function completionTranscriptReady(
  previous: readonly AgentMessage[],
  refreshed: readonly AgentMessage[],
  rewindAnchor?: RewindAnchor,
): boolean {
  if (sameTranscript(previous, refreshed)) return false
  if (!rewindAnchor?.submitted && !isTranscriptPrefix(previous, refreshed)) return false
  if (rewindAnchor?.submitted) {
    const targetIndex = previous.findIndex((message) => message.id === rewindAnchor.targetMessageId)
    if (
      targetIndex >= 0 && refreshed.length <= targetIndex &&
      refreshed.every((message, index) => samePersistedContent(previous[index], message))
    ) return false
  }
  const lastVisibleUserIndex = refreshed.findLastIndex((message) => message.role === "user" && message.visible)
  const afterUser = refreshed.slice(lastVisibleUserIndex + 1)
  const signals = refreshed.slice(Math.max(0, lastVisibleUserIndex)).filter((message) => message.turnComplete !== undefined)
  return signals.at(-1)?.turnComplete ?? afterUser.some((message) => message.role === "agent")
}

function stableTranscriptWhileNonIdle(
  previous: readonly AgentMessage[],
  refreshed: readonly AgentMessage[],
): readonly AgentMessage[] {
  if (!isTranscriptPrefix(previous, refreshed)) return previous
  let lastNewVisibleUserIndex = -1
  for (let index = previous.length; index < refreshed.length; index += 1) {
    if (refreshed[index]?.role === "user" && refreshed[index]?.visible) lastNewVisibleUserIndex = index
  }
  return lastNewVisibleUserIndex < 0 ? previous : refreshed.slice(0, lastNewVisibleUserIndex + 1)
}

function isTranscriptPrefix(prefix: readonly AgentMessage[], transcript: readonly AgentMessage[]): boolean {
  return prefix.length <= transcript.length && prefix.every((message, index) => sameMessage(message, transcript[index]))
}

function sameTranscript(left: readonly AgentMessage[], right: readonly AgentMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => sameMessage(message, right[index]))
}

function sameMessage(left: AgentMessage, right: AgentMessage | undefined): boolean {
  return right !== undefined && left.id === right.id && left.role === right.role &&
    left.preview === right.preview && left.ordinal === right.ordinal && left.visible === right.visible &&
    left.displayGroupId === right.displayGroupId && left.turnComplete === right.turnComplete &&
    left.copyIdentity === right.copyIdentity
}

function samePersistedContent(left: AgentMessage | undefined, right: AgentMessage): boolean {
  return left !== undefined && left.role === right.role && left.preview === right.preview &&
    (left.copyIdentity === undefined || right.copyIdentity === undefined || left.copyIdentity === right.copyIdentity)
}

function preserveOwnedSessions(
  state: ApplicationState,
  incoming: ReadonlyMap<string, AgentSession>,
): Map<string, AgentSession> {
  const sessions = new Map(incoming)
  for (const sessionId of state.terminals.keys()) {
    const session = state.local.sessions.get(sessionId) ?? state.provider.sessions.get(sessionId)
    if (!sessions.has(sessionId) && session) sessions.set(sessionId, session)
  }
  return sessions
}

function preserveOwnedTranscripts(
  state: ApplicationState,
  incoming: ReadonlyMap<string, TranscriptRead>,
): Map<string, TranscriptRead> {
  const transcripts = new Map(incoming)
  for (const sessionId of state.terminals.keys()) {
    const transcript = selectTranscriptRead(state, sessionId)
    if (!transcripts.has(sessionId) && transcript) transcripts.set(sessionId, transcript)
  }
  return transcripts
}

function replaceSessionIdInSurface(
  surface: ApplicationSurface,
  previousSessionId: string,
  sessionId: string,
  options: { readonly kind: IdentityTransitionKind; readonly relation?: BranchRelation },
): ApplicationSurface {
  if (surface._tag === "Terminal") {
    return {
      ...surface,
      sessionId: surface.sessionId === previousSessionId ? sessionId : surface.sessionId,
      returnTo: replaceNavigatorSurface(surface.returnTo, previousSessionId, sessionId, options),
    }
  }
  return replaceNavigatorSurface(surface, previousSessionId, sessionId, options)
}

function replaceNavigatorSurface(
  surface: NavigatorSurface,
  previousSessionId: string,
  sessionId: string,
  options: { readonly kind: IdentityTransitionKind; readonly relation?: BranchRelation },
): NavigatorSurface {
  const navigation = replaceSessionIdInProjectState({
    relations: [],
    removals: [],
    navigation: navigationForSurface(surface),
  }, previousSessionId, sessionId, options).navigation
  if (navigation?.view === "roots") {
    return { _tag: "Roots", selectedSessionId: navigation.selectedSessionId }
  }
  if (navigation?.view === "graph") {
    return {
      _tag: "Graph",
      familySessionId: navigation.familySessionId,
      target: navigation.target,
    }
  }
  return surface
}

function replaceSessionIdInModal(
  modal: ApplicationModal | null,
  previousSessionId: string,
  sessionId: string,
): ApplicationModal | null {
  if (modal?._tag === "ConfirmStop") {
    return { ...modal, sessionId: modal.sessionId === previousSessionId ? sessionId : modal.sessionId }
  }
  if (modal?._tag === "ConfirmRemoval") {
    return {
      ...modal,
      affectedSessionIds: modal.affectedSessionIds.map((id) => id === previousSessionId ? sessionId : id),
    }
  }
  return modal
}

function upsertRelation(relations: readonly BranchRelation[], relation: BranchRelation): readonly BranchRelation[] {
  return [...relations.filter((item) => item.childSessionId !== relation.childSessionId), relation]
}

function migrateMapKey<V>(source: ReadonlyMap<string, V>, previous: string, next: string): Map<string, V> {
  const migrated = new Map(source)
  const value = migrated.get(previous)
  migrated.delete(previous)
  if (value !== undefined && !migrated.has(next)) migrated.set(next, value)
  return migrated
}

function migrateSet(source: ReadonlySet<string>, previous: string, next: string): Set<string> {
  const migrated = new Set(source)
  if (migrated.delete(previous)) migrated.add(next)
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

function normalizeDraftText(text: string): string {
  return text.replace(/\s+/gu, " ").trim()
}

function isShutdownEvent(event: StateEvent): boolean {
  return event._tag === "ShutdownCompleted" || event._tag === "ShutdownFailed"
}
