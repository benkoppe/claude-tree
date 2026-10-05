// Time determines signal escalation, not whether resource finalization succeeded.
export const PROCESS_TERMINATION_GRACE_PERIOD_MS = 1_000

export const HISTORY_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const
export const HISTORY_CONFIRMATION_DELAY_MS = 100
export const MAX_HISTORY_CONFIRMATION_READS = 3
