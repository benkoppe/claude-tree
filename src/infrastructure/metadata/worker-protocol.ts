import type { NavigationState } from "../../domain/model"
import type { BranchRelation, ConversationRemoval, ProjectState, ProviderState } from "../../domain/persistence"
import type { ProviderStateRepositoryOptions, ReplaceSessionIdentityOptions } from "../../services/provider-state-repository"

export type MetadataWorkerOptions = ProviderStateRepositoryOptions & { readonly instanceId: string }
export type MetadataCommand =
  | { readonly _tag: "Load" }
  | { readonly _tag: "SaveNavigation"; readonly navigation: NavigationState; readonly revision: number }
  | { readonly _tag: "SaveRelation"; readonly relation: BranchRelation }
  | { readonly _tag: "RemoveRelation"; readonly relation: BranchRelation }
  | { readonly _tag: "CommitRemoval"; readonly removal: ConversationRemoval }
  | { readonly _tag: "ReplaceIdentity"; readonly previous: string; readonly actual: string; readonly options: ReplaceSessionIdentityOptions }
  | { readonly _tag: "CompareMetadata"; readonly before: ProjectState; readonly after: ProjectState }
export type MetadataRequest = { readonly _tag: "Command"; readonly id: number; readonly command: MetadataCommand } | { readonly _tag: "Close" }
export interface MetadataLocation { readonly projectId: string; readonly scopeId: string; readonly projectPath: string; readonly statePath: string; readonly instanceId: string }
export type MetadataResponse =
  | { readonly _tag: "Ready"; readonly location: MetadataLocation }
  | { readonly _tag: "Completed"; readonly id: number; readonly value: ProviderState | ProjectState | BranchRelation | ConversationRemoval | undefined }
  | { readonly _tag: "Failed"; readonly id: number | null; readonly message: string; readonly removed?: { readonly providerId: string; readonly sessionId: string } }
  | { readonly _tag: "Closed" }
