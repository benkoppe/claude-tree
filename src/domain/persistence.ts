import type { MessageRef, NavigationState } from "./model"

export interface BranchRelation {
  readonly childSessionId: string
  readonly parentSessionId: string
  readonly sourceMessageId: string
  readonly continuationMessageId?: string
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

export type IdentityTransitionKind = "temporary-adoption" | "native-fork"

export interface InstanceNavigation {
  readonly instanceId: string
  readonly navigation: NavigationState
}

export interface ProviderState {
  readonly relations: readonly BranchRelation[]
  readonly removals: readonly ConversationRemoval[]
  readonly navigations: readonly InstanceNavigation[]
}

export const EMPTY_PROJECT_STATE: ProjectState = {
  relations: [],
  removals: [],
}
