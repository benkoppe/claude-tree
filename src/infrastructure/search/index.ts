import { Database } from "bun:sqlite"

export interface SearchDocument { readonly id: string; readonly text: string }
export interface SearchRequest {
  readonly id: number
  readonly documents?: readonly SearchDocument[] | undefined
  readonly query: string
  readonly excerptId?: string | undefined
  readonly excerptLength?: number
}
export interface SearchResponse {
  readonly id: number
  readonly hits: readonly string[]
  readonly excerpt: string
  readonly error?: string
}

/** Ephemeral derived content only: never connected to the metadata database. */
export class ContentSearchIndex {
  private readonly db = new Database(":memory:")
  private documents: readonly SearchDocument[] = []
  private positions = new Map<string, number>()
  private cachedQuery: string | undefined
  private cachedHits: readonly string[] = []
  constructor() {
    this.db.exec("PRAGMA temp_store=MEMORY; CREATE VIRTUAL TABLE content USING fts5(text, tokenize='trigram')")
  }
  replace(documents: readonly SearchDocument[]): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM content")
      const insert = this.db.prepare("INSERT INTO content(rowid,text) VALUES (?,?)")
      documents.forEach((document, index) => insert.run(index + 1, document.text))
    })()
    this.documents = documents
    this.positions = new Map(documents.map((document, index) => [document.id, index]))
    this.cachedQuery = undefined
  }
  search(query: string, excerptId?: string, excerptLength = 800): Omit<SearchResponse, "id"> {
    const terms = query.trim().split(/\s+/u).filter(Boolean)
    if (!terms.length) return { hits: [], excerpt: "" }
    const indexed = terms.filter((term) => [...term].length >= 3)
    const expression = indexed.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ")
    const candidates = this.cachedQuery === query ? [] : expression
      ? this.db.query<{ rowid: number }, [string]>("SELECT rowid FROM content WHERE content MATCH ? ORDER BY rowid").all(expression).map((row) => row.rowid - 1)
      : this.documents.map((_, index) => index)
    const shortTerms = terms.filter((term) => [...term].length < 3).map((term) => term.toLowerCase())
    const normalized = terms.map((term) => term.toLowerCase())
    const hits = this.cachedQuery === query ? this.cachedHits : candidates.filter((index) => {
      if (!shortTerms.length) return true
      const text = this.documents[index]!.text.toLowerCase()
      return shortTerms.every((term) => text.includes(term))
    }).map((index) => this.documents[index]!.id)
    this.cachedQuery = query
    this.cachedHits = hits
    const selected = excerptId ?? hits[0]
    const position = selected ? this.positions.get(selected) ?? -1 : -1
    let excerpt = ""
    if (position >= 0 && hits.includes(selected!)) {
      const text = this.documents[position]!.text
      const length = Math.max(32, Math.min(800, excerptLength))
      const start = Math.max(0, text.toLowerCase().indexOf(normalized[0]!) - Math.min(120, Math.floor(length / 4)))
      excerpt = `${start ? "…" : ""}${text.slice(start, start + length)}${start + length < text.length ? "…" : ""}`
    }
    return { hits, excerpt: excerpt.replace(/\s+/gu, " ") }
  }
  close(): void { this.db.close() }
}
