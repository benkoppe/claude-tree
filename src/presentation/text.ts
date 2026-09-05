const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function displayWidth(value: string): number {
  return Bun.stringWidth(value)
}

export function graphemes(value: string): string[] {
  return [...segmenter.segment(value)].map((part) => part.segment)
}

export function truncateToWidth(value: string, width: number): string {
  const safeWidth = Math.max(0, width)
  if (displayWidth(value) <= safeWidth) return value
  if (safeWidth === 0) return ""

  const ellipsis = "…"
  const contentWidth = safeWidth - displayWidth(ellipsis)
  if (contentWidth <= 0) return ellipsis

  let result = ""
  let used = 0
  for (const grapheme of graphemes(value)) {
    const graphemeWidth = displayWidth(grapheme)
    if (used + graphemeWidth > contentWidth) break
    result += grapheme
    used += graphemeWidth
  }
  return result + ellipsis
}
