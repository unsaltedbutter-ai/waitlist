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

/**
 * Valid job actions for on-demand requests.
 */
export const VALID_ACTIONS = ["cancel", "resume"] as const;
export type ValidAction = (typeof VALID_ACTIONS)[number];

/**
 * Statuses that count as successfully completed (paid).
 * Used in queries that look for the last completed action.
 */
export const COMPLETED_STATUSES = ["completed_paid", "completed_eventual"] as const;

/**
 * Tailwind classes for cancel/resume action buttons (outline style).
 */
export const ACTION_STYLES = {
  cancel: "text-amber-400 border-amber-700/50 bg-amber-900/20 hover:bg-amber-900/40",
  resume: "text-blue-400 border-blue-700/50 bg-blue-900/20 hover:bg-blue-900/40",
} as const;
