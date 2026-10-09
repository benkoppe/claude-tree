import type { GraphNodeViewModel, RootViewModel, SurfaceViewModel } from "../application/view-model"
import type { SearchDocument } from "../infrastructure/search/index"

export function searchScope(surface: SurfaceViewModel): string | null {
  return surface._tag === "Graph" ? `graph:${surface.familySessionId}` : surface._tag === "Roots" ? "roots" : null
}

export function sameSearchDocuments(left: readonly SearchDocument[], right: readonly SearchDocument[]): boolean {
  return left.length === right.length && left.every((document, index) => document.id === right[index]!.id && document.text === right[index]!.text)
}

export function searchDocuments(surface: SurfaceViewModel): readonly SearchDocument[] {
  if (surface._tag === "Roots") return surface.roots.map((root) => ({ id: root.sessionId, text: root.title }))
  if (surface._tag !== "Graph") return []
  const nodes = surface.unselectedNodes ?? surface.nodes
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const roots = nodes.filter((node) => !node.parentIds.some((id) => byId.has(id)))
  const stack = roots.map((node) => node.id).reverse()
  const visited = new Set<string>(), documents: SearchDocument[] = []
  while (stack.length) {
    const id = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    const node = byId.get(id)
    if (!node) continue
    documents.push({ id, text: node._tag === "Message" ? node.text ?? node.preview : "" })
    stack.push(...[...node.childIds].reverse())
  }
  return documents
}

export function cursorRelativeHit(hits: readonly string[], documents: readonly SearchDocument[], anchor: string | null): number {
  const start = documents.findIndex((document) => document.id === anchor)
  const positions = new Map(documents.map((document, index) => [document.id, index]))
  const index = hits.findIndex((id) => (positions.get(id) ?? -1) >= start)
  return Math.max(0, index)
}

export function retainedSearchNodeId(previous: readonly GraphNodeViewModel[], next: readonly GraphNodeViewModel[], id: string | null): string | null {
  if (!id || next.some((node) => node.id === id)) return id
  const old = previous.find((node) => node.id === id)
  if (!old) return null
  return next.find((node) => {
    if (old.target.kind === "endpoint") return node.target.kind === "endpoint" && node.target.sessionId === old.target.sessionId
    if (node.target.kind !== "message") return false
    const aliases = node.target.aliases
    return old.target.aliases.some((alias) => aliases.some((candidate) => candidate.sessionId === alias.sessionId && candidate.messageId === alias.messageId))
  })?.id ?? null
}

export function retainedSearchRootId(previous: readonly RootViewModel[], next: readonly RootViewModel[], id: string | null): string | null {
  if (!id) return null
  const direct = next.find((root) => root.sessionId === id || root.memberSessionIds.includes(id))
  if (direct) return direct.sessionId
  const old = previous.find((root) => root.sessionId === id || root.memberSessionIds.includes(id))
  if (!old) return null
  const members = new Set([old.sessionId, ...old.memberSessionIds])
  const candidates = next.filter((root) => members.has(root.sessionId) || root.memberSessionIds.some((member) => members.has(member)))
  return candidates.length === 1 ? candidates[0]!.sessionId : null
}
