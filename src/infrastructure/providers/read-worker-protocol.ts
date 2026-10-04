import type { AgentSessionSnapshot } from "../../domain/model"

export interface ProviderReadWorkerOptions {
  readonly providerId: "claude" | "codex"
  readonly projectPath: string
}

export type ProviderReadRequest =
  | { readonly _tag: "Read"; readonly id: number; readonly sessionIds?: readonly string[]; readonly transcriptsOnly?: boolean }
  | { readonly _tag: "Acknowledged"; readonly id: number; readonly sequence: number }
  | { readonly _tag: "Cancel"; readonly id: number }
  | { readonly _tag: "Close" }

export type ProviderReadResponse =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Progress"; readonly id: number; readonly sequence: number; readonly snapshot: AgentSessionSnapshot }
  | { readonly _tag: "Completed"; readonly id: number }
  | { readonly _tag: "Failed"; readonly id: number; readonly message: string }
  | { readonly _tag: "Closed" }
