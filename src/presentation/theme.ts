import { RGBA } from "@opentui/core"

const primary = RGBA.fromHex("#7dd3fc")

export const presentationTheme = {
  background: RGBA.fromHex("#0b1020"),
  element: RGBA.fromHex("#1e293b"),
  sessionElement: RGBA.fromHex("#12313a"),
  selected: primary,
  selectedText: RGBA.fromHex("#082f49"),
  selectedSuccess: RGBA.fromHex("#14532d"),
  selectedWarning: RGBA.fromHex("#713f12"),
  selectedDanger: RGBA.fromHex("#7f1d1d"),
  selectedMuted: RGBA.fromHex("#334155"),
  text: RGBA.fromHex("#e2e8f0"),
  textMuted: RGBA.fromHex("#94a3b8"),
  separator: RGBA.fromHex("#334155"),
  connector: RGBA.fromHex("#64748b"),
  primary,
  secondary: RGBA.fromHex("#93c5fd"),
  accent: RGBA.fromHex("#c4b5fd"),
  info: RGBA.fromHex("#67e8f9"),
  success: RGBA.fromHex("#4ade80"),
  warning: RGBA.fromHex("#fbbf24"),
  danger: RGBA.fromHex("#f87171"),
  claude: RGBA.fromHex("#d97757"),
  codex: RGBA.fromHex("#8fa3b8"),
} as const
