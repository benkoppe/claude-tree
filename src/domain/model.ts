export interface AgentSession {
  readonly id: string
  readonly title: string
  readonly lastModified: number
  readonly gitBranch?: string
  readonly transient?: boolean
}

export type MessageRole = "user" | "agent" | "system"

export interface AgentMessage {
  readonly id: string
  readonly role: MessageRole
  readonly preview: string
  readonly ordinal: number
  readonly visible: boolean
  readonly displayGroupId?: string
  readonly turnComplete?: boolean
  readonly copyIdentity?: string
}

export interface MessageRef {
  readonly sessionId: string
  readonly messageId: string
}

export interface DraftPreview {
  readonly text: string
  readonly exact: boolean
  readonly rewind?: boolean
  readonly rewindTarget?: string
  readonly submitted?: boolean
}

export type AgentActivity = "working" | "blocked" | "idle"

export interface TerminalScreen {
  readonly lines: readonly string[]
  readonly cursor: {
    readonly x: number
    readonly y: number
    readonly visible: boolean
  }
}

export interface TerminalObserver {
  observeInput?(data: Uint8Array): void
  observeOutput(data: Uint8Array): readonly AgentActivity[]
  observeScreen(screen: TerminalScreen): AgentActivity | undefined
  observeDraft(screen: TerminalScreen): DraftPreview | undefined
}

export interface SharedMessage {
  readonly parentMessageId: string
  readonly childMessageId: string
}

export interface BranchDerivation {
  readonly childSessionId: string
  readonly parentSessionId: string
  readonly sourceMessageId: string
  readonly sharedMessages: readonly SharedMessage[]
}

export interface AgentSessionSnapshot {
  readonly sessions: readonly AgentSession[]
  readonly transcripts: ReadonlyMap<string, TranscriptRead>
}

export type TranscriptRead =
  | { readonly _tag: "Available"; readonly messages: readonly AgentMessage[] }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unavailable"; readonly reason: string }

export type NavigationTarget =
  | {
      readonly kind: "message"
      readonly preferred: MessageRef
      readonly aliases: readonly MessageRef[]
    }
  | { readonly kind: "endpoint"; readonly sessionId: string }

export type NavigationState =
  | { readonly view: "roots"; readonly selectedSessionId: string | null }
  | {
      readonly view: "graph"
      readonly familySessionId: string
      readonly target: NavigationTarget
    }
  | { readonly view: "terminal"; readonly sessionId: string }

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
