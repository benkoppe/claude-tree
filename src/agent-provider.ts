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
}

export interface MessageRef {
  sessionId: string
  messageId: string
}

export interface DraftPreview {
  text: string
  exact: boolean
}

export type AgentActivity = "working" | "idle"

export interface TerminalObserver {
  observeOutput(data: Uint8Array): readonly AgentActivity[]
  observeScreen(screen: EmbeddedTerminalScreen): AgentActivity | undefined
  observeDraft(screen: EmbeddedTerminalScreen): string | undefined
}

export interface TerminalLaunch {
  sessionId: string
  command: string[]
  cwd: string
  env?: Record<string, string>
  observer: TerminalObserver
  initialDraft?: DraftPreview
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
  readonly compatibilityWarning?: string | undefined

  loadSessionSnapshot?(): Promise<AgentSessionSnapshot>
  listSessions(): Promise<AgentSession[]>
  readTranscripts(sessionIds: readonly string[]): Promise<Map<string, AgentMessage[] | null>>
  prepareNewSession(): Promise<PreparedSession>
  prepareResume(session: AgentSession): Promise<TerminalLaunch>
  branchFrom?(target: MessageRef): Promise<PreparedBranch>
}

export class NullTerminalObserver implements TerminalObserver {
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
