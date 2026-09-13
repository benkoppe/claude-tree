import type { NavigationState } from "../../domain/model"
import type { ProviderStateRepositoryOptions } from "../../services/provider-state-repository"

export type NavigationWorkerOptions = ProviderStateRepositoryOptions & { readonly instanceId: string }

export type NavigationWorkerRequest =
  | { readonly _tag: "Save"; readonly id: number; readonly navigation: NavigationState }
  | { readonly _tag: "Close" }

export type NavigationWorkerResponse =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Saved"; readonly id: number }
  | { readonly _tag: "Failed"; readonly id: number | null; readonly operation: string; readonly path: string; readonly message: string }
