/**
 * Abuse-prevention thresholds, configurable via environment variables.
 *
 * Each threshold has a sensible default that applies when the env var
 * is not set. All values are read once at module load (not per-request).
 */

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Consecutive credential failures before blocking job submission for that service. */
export const CREDENTIAL_STRIKE_LIMIT = intEnv("CREDENTIAL_STRIKE_LIMIT", 3);

/** Cooldown (seconds) imposed after 2+ credential failures (before hitting the hard block). */
export const CREDENTIAL_COOLDOWN_SECS = intEnv("CREDENTIAL_COOLDOWN_SECS", 3600);

/** Maximum on-demand job submissions per user within the rate window. */
export const ONDEMAND_RATE_LIMIT = intEnv("ONDEMAND_RATE_LIMIT", 5);

/** Rate window (seconds) for on-demand job submission. */
export const ONDEMAND_RATE_WINDOW_SECS = intEnv("ONDEMAND_RATE_WINDOW_SECS", 3600);

/** Consecutive user_abandon events before imposing a cooldown. */
export const USER_ABANDON_LIMIT = intEnv("USER_ABANDON_LIMIT", 3);

/** Cooldown (seconds) after hitting the abandon limit. */
export const USER_ABANDON_COOLDOWN_SECS = intEnv("USER_ABANDON_COOLDOWN_SECS", 86400);

/** Number of credential failures that triggers an operator alert. */
export const CREDENTIAL_ALERT_THRESHOLD = intEnv("CREDENTIAL_ALERT_THRESHOLD", 3);
