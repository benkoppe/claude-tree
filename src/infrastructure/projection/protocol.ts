import type { FamilyProjectionInput } from "../../application/forest-projection"
import type { ConversationForest } from "../../domain/conversation-graph"
import type { ConversationGraphLayout } from "../../domain/graph-layout"

export interface ProjectionRequest {
  readonly id: number
  readonly input: FamilyProjectionInput
  readonly visible: ReadonlySet<string>
}

export type ProjectionResponse =
  | { readonly _tag: "Projected"; readonly id: number; readonly forest: ConversationForest; readonly layouts: ReadonlyMap<string, ConversationGraphLayout> }
  | { readonly _tag: "Failed"; readonly id: number; readonly message: string }
