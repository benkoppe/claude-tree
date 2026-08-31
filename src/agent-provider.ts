import type { EmbeddedTerminalScreen } from "@opentui/core"

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
  observeOutput(data: Uint8Array): AgentActivity | undefined
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
}

export interface PreparedSession {
  session: AgentSession
  launch: TerminalLaunch
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

export interface AgentProvider {
  readonly id: string
  readonly displayName: string

  listSessions(): Promise<AgentSession[]>
  readTranscript(sessionId: string): Promise<AgentMessage[]>
  prepareNewSession(): Promise<PreparedSession>
  prepareResume(session: AgentSession): Promise<TerminalLaunch>
  branchFrom?(target: MessageRef): Promise<PreparedBranch>
}

export class NullTerminalObserver implements TerminalObserver {
  observeOutput(): undefined {
    return undefined
  }

  observeScreen(): undefined {
    return undefined
  }

  observeDraft(): undefined {
    return undefined
  }
}
