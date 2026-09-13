import type { MessageRef, NavigationState } from "./model"

export interface BranchRelation {
  readonly childSessionId: string
  readonly parentSessionId: string
  readonly sourceMessageId: string
  readonly sharedMessages: readonly {
    readonly parentMessageId: string
    readonly childMessageId: string
  }[]
  readonly createdAt: string
}

export type ConversationRemovalTarget =
  | { readonly kind: "message"; readonly aliases: readonly MessageRef[] }
  | {
      readonly kind: "endpoint"
      readonly sessionId: string
      readonly afterMessageId: string | null
    }

export type ConversationRemoval =
  | {
      readonly kind: "tree"
      readonly rootSessionId: string
      readonly memberSessionIds: readonly string[]
      readonly createdAt: string
    }
  | {
      readonly kind: "subtree"
      readonly target: ConversationRemovalTarget
      readonly createdAt: string
    }

export interface ProjectState {
  readonly relations: readonly BranchRelation[]
  readonly removals: readonly ConversationRemoval[]
  readonly navigation?: NavigationState
}

export type TerminalOwnerStatus =
  | "reserved"
  | "running"
  | "stopping"
  | "cleanup-incomplete"

export interface TerminalOwner {
  readonly instanceId: string
  readonly sessionId: string
  readonly ownerToken: string
  readonly lastMutationToken?: string
  readonly ownerPid: number
  readonly status: TerminalOwnerStatus
  readonly processGroupId?: number
  readonly reservedAt: string
  readonly updatedAt: string
}

export type IdentityTransitionKind = "temporary-adoption" | "native-fork"

export interface InstanceNavigation {
  readonly instanceId: string
  readonly navigation: NavigationState
}

export interface PendingIdentityAdoption {
  readonly adoptionToken: string
  readonly kind: IdentityTransitionKind
  readonly instanceId: string
  readonly ownerToken: string
  readonly ownerPid: number
  readonly processGroupId: number
  readonly previousSessionId: string
  readonly sessionId: string
  readonly createdAt: string
  readonly relation?: BranchRelation
}

export interface ProviderState {
  readonly relations: readonly BranchRelation[]
  readonly removals: readonly ConversationRemoval[]
  readonly navigations: readonly InstanceNavigation[]
  readonly terminalOwners: readonly TerminalOwner[]
  readonly pendingIdentityAdoptions: readonly PendingIdentityAdoption[]
}

export const EMPTY_PROJECT_STATE: ProjectState = {
  relations: [],
  removals: [],
}
