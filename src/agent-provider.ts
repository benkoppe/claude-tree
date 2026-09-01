import type { EmbeddedTerminalScreen, RGBA } from "@opentui/core"

export interface AgentSession {
  id: string
  title: string
  lastModified: number
  gitBranch?: string
  transient?: boolean
}

export interface AgentMessage {
  id: string
  role: "user" | "agent" | "system"
  preview: string
  ordinal: number
  visible: boolean
  displayGroupId?: string
  turnComplete?: boolean
  copyIdentity?: string
}

export interface MessageRef {
  sessionId: string
  messageId: string
}

export interface DraftPreview {
  text: string
  exact: boolean
  rewind?: boolean
  rewindTarget?: string
  submitted?: boolean
}

export type AgentActivity = "working" | "blocked" | "idle"

export interface TerminalObserver {
  observeInput?(data: Uint8Array): void
  observeOutput(data: Uint8Array): readonly AgentActivity[]
  observeScreen(screen: EmbeddedTerminalScreen): AgentActivity | undefined
  observeDraft(screen: EmbeddedTerminalScreen): DraftPreview | undefined
}

export interface TerminalSessionTransition {
  session: AgentSession
  derivation?: Promise<BranchDerivation | undefined>
}

export interface TerminalSessionTransitionSource {
  subscribe(
    onTransition: (transition: TerminalSessionTransition) => void,
    onError: (error: Error) => void,
  ): () => void
}

export interface TerminalLaunch {
  sessionId: string
  command: string[]
  cwd: string
  env?: Record<string, string>
  observer: TerminalObserver
  initialDraft?: DraftPreview
  sessionTransitions?: TerminalSessionTransitionSource
  cleanup?: () => Promise<void>
}

export interface PreparedSession {
  session: AgentSession
  launch: TerminalLaunch
  startedSession?: Promise<AgentSession>
}

export interface SharedMessage {
  parentMessageId: string
  childMessageId: string
}

export interface BranchDerivation {
  childSessionId: string
  parentSessionId: string
  sourceMessageId: string
  sharedMessages: SharedMessage[]
}

export interface PreparedBranch extends PreparedSession {
  derivation: BranchDerivation
  providerSessionCreated: boolean
}

export class BranchCreatedError extends Error {
  constructor(
    readonly session: AgentSession,
    readonly transcript: AgentMessage[],
    readonly transcriptAvailable: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "BranchCreatedError"
  }
}

export interface AgentNavigatorIdentity {
  label: string
  color: RGBA
}

export interface AgentSessionSnapshot {
  sessions: AgentSession[]
  transcripts: Map<string, AgentMessage[] | null>
}

export interface AgentProvider {
  readonly id: string
  readonly displayName: string
  readonly navigatorIdentity: AgentNavigatorIdentity

  loadSessionSnapshot?(): Promise<AgentSessionSnapshot>
  listSessions(): Promise<AgentSession[]>
  readTranscripts(sessionIds: readonly string[]): Promise<Map<string, AgentMessage[] | null>>
  prepareNewSession(): Promise<PreparedSession>
  prepareResume(session: AgentSession): Promise<TerminalLaunch>
  branchFrom?(target: MessageRef): Promise<PreparedBranch>
}

export class NullTerminalObserver implements TerminalObserver {
  observeInput(): void {}
  observeOutput(): readonly AgentActivity[] {
    return []
  }

  observeScreen(): undefined {
    return undefined
  }

  observeDraft(): undefined {
    return undefined
  }
}
