import { parentPort } from "node:worker_threads"
import { ContentSearchIndex, type SearchRequest, type SearchResponse } from "./index"

const index = new ContentSearchIndex()
parentPort!.on("message", (request: SearchRequest) => {
  let response: SearchResponse
  try {
    if (request.documents) index.replace(request.documents)
    response = { id: request.id, ...index.search(request.query, request.excerptId, request.excerptLength) }
  } catch (error) {
    response = { id: request.id, hits: [], excerpt: "", error: String(error) }
  }
  parentPort!.postMessage(response)
})
