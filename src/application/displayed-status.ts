import type { SessionStatus } from "../domain/session-status"
import type { ApplicationViewModel } from "./view-model"

export interface DisplayedStatus {
  readonly activity: SessionStatus
  readonly destination: string
}

export function projectDisplayedStatus(viewModel: ApplicationViewModel): DisplayedStatus {
  const surface = viewModel.surface
  return {
    activity: surface._tag === "Roots" ? "idle" : surface.status,
    destination: surface._tag === "Roots" ? `roots:${surface.selectedSessionId ?? ""}`
      : surface._tag === "Graph" ? `graph:${surface.familySessionId}` : `terminal:${surface.sessionId}`,
  }
}
