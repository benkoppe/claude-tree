import { parentPort } from "node:worker_threads"

import { buildConversationForest } from "../../domain/conversation-graph"
import { layoutConversationGraph } from "../../domain/graph-layout"
import { errorSummary } from "../../error-format"
import type { ProjectionRequest, ProjectionResponse } from "./protocol"

parentPort!.on("message", ({ id, input, visible }: ProjectionRequest) => {
  let response: ProjectionResponse
  try {
    const forest = buildConversationForest(input.sessions, input.transcripts, input.relations, input.removals)
    const layouts = new Map(forest.graphs.map((graph) => [graph.rootSessionId, layoutConversationGraph(graph, 80, visible)]))
    response = { _tag: "Projected", id, forest, layouts }
  } catch (cause) {
    response = { _tag: "Failed", id, message: errorSummary(cause) }
  }
  parentPort!.postMessage(response)
})
