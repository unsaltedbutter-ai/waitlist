import { query } from "@/lib/db";
import { checkEmailBlocklist } from "@/lib/reneged";
import { VALID_ACTIONS } from "@/lib/constants";
import {
  CREDENTIAL_STRIKE_LIMIT,
  CREDENTIAL_COOLDOWN_SECS,
  USER_ABANDON_LIMIT,
  USER_ABANDON_COOLDOWN_SECS,
} from "@/lib/abuse-thresholds";

interface OnDemandSuccess {
  ok: true;
  job_id: string;
  queue_position: number;
}

interface OnDemandError {
  ok: false;
  status: number;
  error: string;
  debt_sats?: number;
}

export type OnDemandResult = OnDemandSuccess | OnDemandError;

/**
 * Shared business logic for creating an on-demand cancel/resume job.
 * Both the user-facing and agent-facing routes delegate to this function.
 *
 * Validates inputs, checks debt, verifies service and credentials,
 * checks email blocklist, then inserts the job.
 *
 * Does NOT catch exceptions: callers are responsible for try/catch.
 */
export async function createOnDemandJob(
  userId: string,
  serviceId: string,
  action: string
): Promise<OnDemandResult> {
  // 1. Validate types
  if (!serviceId || typeof serviceId !== "string") {
    return { ok: false, status: 400, error: "Missing required field: serviceId" };
  }
  if (!action || typeof action !== "string") {
    return { ok: false, status: 400, error: "Missing required field: action" };
  }

  // 2. Validate action
  if (!VALID_ACTIONS.includes(action as any)) {
    return {
      ok: false,
      status: 400,
      error: `Invalid action: must be one of ${VALID_ACTIONS.join(", ")}`,
    };
  }

  // 3. Check user debt + abandon cooldown
  const userResult = await query<{
    debt_sats: number;
    abandon_count: number;
    last_abandon_at: string | null;
  }>(
    "SELECT debt_sats, abandon_count, last_abandon_at FROM users WHERE id = $1",
    [userId]
  );
  if (userResult.rows.length === 0) {
    return { ok: false, status: 404, error: "User not found" };
  }
  const user = userResult.rows[0];
  if (user.debt_sats > 0) {
    return {
      ok: false,
      status: 403,
      error: "Outstanding debt",
      debt_sats: user.debt_sats,
    };
  }

  // 3b. Check abandon cooldown
  if (user.abandon_count >= USER_ABANDON_LIMIT && user.last_abandon_at) {
    const cooldownEnd =
      new Date(user.last_abandon_at).getTime() +
      USER_ABANDON_COOLDOWN_SECS * 1000;
    if (Date.now() < cooldownEnd) {
      return {
        ok: false,
        status: 429,
        error: "Too many abandoned jobs. Please try again later.",
      };
    }
  }

  // 4. Verify service exists in streaming_services
  const serviceResult = await query<{ id: string }>(
    "SELECT id FROM streaming_services WHERE id = $1",
    [serviceId]
  );
  if (serviceResult.rows.length === 0) {
    return { ok: false, status: 400, error: `Invalid service: ${serviceId}` };
  }

  // 5. Verify credentials exist + check credential strikes
  const credResult = await query<{
    id: string;
    credential_failures: number;
    last_failure_at: string | null;
  }>(
    "SELECT id, credential_failures, last_failure_at FROM streaming_credentials WHERE user_id = $1 AND service_id = $2",
    [userId, serviceId]
  );
  if (credResult.rows.length === 0) {
    return { ok: false, status: 400, error: "No credentials for this service" };
  }

  // 5b. Check credential failure strikes
  const cred = credResult.rows[0];
  if (cred.credential_failures >= CREDENTIAL_STRIKE_LIMIT) {
    return {
      ok: false,
      status: 429,
      error: "Credentials blocked after repeated failures. Please update your credentials and try again.",
    };
  }
  if (cred.credential_failures >= 2 && cred.last_failure_at) {
    const cooldownEnd =
      new Date(cred.last_failure_at).getTime() +
      CREDENTIAL_COOLDOWN_SECS * 1000;
    if (Date.now() < cooldownEnd) {
      return {
        ok: false,
        status: 429,
        error: "Please wait before retrying. Update your credentials on the dashboard first.",
      };
    }
  }

  // 6. Check email blocklist (catches npub-hopping with same email)
  const blocklist = await checkEmailBlocklist(userId, serviceId);
  if (blocklist.blocked) {
    return {
      ok: false,
      status: 403,
      error: "Email blocked due to outstanding debt",
      debt_sats: blocklist.debt_sats,
    };
  }

  // 7. Insert job (partial unique index prevents duplicates)
  const jobResult = await query<{ id: string }>(
    `INSERT INTO jobs (user_id, service_id, action, trigger, status)
     VALUES ($1, $2, $3, 'on_demand', 'pending')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId, serviceId, action]
  );
  if (jobResult.rows.length === 0) {
    return {
      ok: false,
      status: 409,
      error: "A job is already in progress for this service",
    };
  }

  // 8. Count pending jobs ahead in the queue (including this one)
  const queueResult = await query<{ count: string }>(
    "SELECT count(*) FROM jobs WHERE status = 'pending'",
    []
  );
  const queuePosition = parseInt(queueResult.rows[0].count, 10);

  return { ok: true, job_id: jobResult.rows[0].id, queue_position: queuePosition };
}
