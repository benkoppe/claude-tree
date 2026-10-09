import { Worker } from "node:worker_threads"
import { workerEntry } from "../worker-entry"
import type { SearchRequest, SearchResponse } from "./index"

/** One active request and one latest replacement keep typeahead work bounded. */
export class SearchClient {
  private readonly worker: Worker
  private active: { request: SearchRequest; resolve: (value: SearchResponse) => void; reject: (error: Error) => void } | undefined
  private queued: typeof this.active
  private failure: Error | undefined
  private closing: Promise<void> | undefined
  constructor(createWorker: () => Worker = () => new Worker(workerEntry(new URL("./worker.ts", import.meta.url), "src/infrastructure/search/worker.ts"))) {
    this.worker = createWorker()
    this.worker.on("message", (response: SearchResponse) => {
      const active = this.active
      if (!active || response.id !== active.request.id) return
      this.active = undefined
      active.resolve(response)
      const queued = this.queued
      this.queued = undefined
      if (queued) this.send(queued)
    })
    this.worker.on("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))))
    this.worker.on("exit", (code) => this.fail(new Error(`Search worker exited (${code})`)))
  }
  request(request: SearchRequest): Promise<SearchResponse> {
    return new Promise((resolve, reject) => {
      if (this.failure || this.closing) { reject(this.failure ?? new Error("Search is closed")); return }
      const next = { request, resolve, reject }
      if (!this.active) this.send(next)
      else {
        if (!request.documents && this.queued?.request.documents) next.request = { ...request, documents: this.queued.request.documents }
        this.queued?.resolve({ id: this.queued.request.id, hits: [], excerpt: "" })
        this.queued = next
      }
    })
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.fail(new Error("Search is closed"))
      this.closing = this.worker.terminate().then(() => {})
    }
    return this.closing
  }
  private send(next: NonNullable<typeof this.active>): void {
    this.active = next
    try { this.worker.postMessage(next.request) } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
  }
  private fail(error: Error): void {
    this.failure ??= error
    this.active?.reject(this.failure)
    this.queued?.reject(this.failure)
    this.active = this.queued = undefined
  }
}
