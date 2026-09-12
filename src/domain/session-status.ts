/** `idle` is an inactive session; `live` has an idle terminal owner. */
export type SessionStatus = "blocked" | "unviewed" | "working" | "live" | "idle"

export const SESSION_STATUS_PRIORITY: Readonly<Record<SessionStatus, number>> = {
  idle: 0,
  live: 1,
  unviewed: 2,
  working: 3,
  blocked: 4,
}
