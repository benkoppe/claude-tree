import type { SessionStatus } from "../domain/session-status"
import { PROGRAM_NAME } from "../program"

export interface ProgramStatusReporterApi {
  readonly report: (activity: SessionStatus) => void
  readonly shutdown: () => void
}

const OSC_PROGRAM_STATUS = "\x1b]7501;"
const STRING_TERMINATOR = "\x1b\\"
export const CLEAR_PROGRAM_STATUS = `${OSC_PROGRAM_STATUS}state=clear${STRING_TERMINATOR}`

const STATUS_RECORDS: Readonly<Record<SessionStatus, {
  readonly state: "idle" | "working" | "blocked" | "done"
  readonly message?: string
}>> = {
  idle: { state: "idle" },
  live: { state: "idle", message: "Live" },
  working: { state: "working", message: "Working" },
  blocked: { state: "blocked", message: "Needs user" },
  unviewed: { state: "done", message: "New updates" },
}

export function encodeProgramStatus(activity: SessionStatus): string {
  const record = STATUS_RECORDS[activity]
  const message = record.message === undefined ? "" : `:msg=${Buffer.from(record.message, "utf8").toString("base64")}`
  return `${OSC_PROGRAM_STATUS}state=${record.state}:app=${PROGRAM_NAME}${message}${STRING_TERMINATOR}`
}

export function makeProgramStatusReporter(
  write: (sequence: string) => void,
): ProgramStatusReporterApi {
  let lastActivity: SessionStatus | undefined
  let stopped = false
  return {
    report(activity) {
      if (stopped || activity === lastActivity) return
      try {
        write(encodeProgramStatus(activity))
        lastActivity = activity
      } catch {}
    },
    shutdown() {
      if (stopped) return
      stopped = true
      try { write(CLEAR_PROGRAM_STATUS) } catch {}
    },
  }
}
