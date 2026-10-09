import { parentPort } from "node:worker_threads"

import { buildConversationForest } from "../../domain/conversation-graph"
import { DEFAULT_GRAPH_VIEWPORT_WIDTH, layoutConversationGraph } from "../../domain/graph-layout"
import { errorSummary } from "../../error-format"
import type { ProjectionRequest, ProjectionResponse } from "./protocol"

parentPort!.on("message", ({ id, input, visible }: ProjectionRequest) => {
  let response: ProjectionResponse
  try {
    const forest = buildConversationForest(input.sessions, input.transcripts, input.relations, input.removals, input.provisionalBranches)
    const layouts = new Map(forest.graphs.map((graph) => [graph.rootSessionId, layoutConversationGraph(graph, DEFAULT_GRAPH_VIEWPORT_WIDTH, visible)]))
    response = { _tag: "Projected", id, forest, layouts }
  } catch (cause) {
    response = { _tag: "Failed", id, message: errorSummary(cause) }
  }
  parentPort!.postMessage(response)
})
