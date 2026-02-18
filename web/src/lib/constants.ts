/**
 * Job statuses that represent a completed or closed job.
 * Used to filter out "active" (non-terminal) jobs in queries.
 */
export const TERMINAL_STATUSES = [
  "completed_paid",
  "completed_eventual",
  "completed_reneged",
  "user_skip",
  "user_abandon",
  "implied_skip",
  "failed",
] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/**
 * Validates a UUID v4 string (case-insensitive).
 */
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
