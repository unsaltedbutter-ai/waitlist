import { query } from "@/lib/db";

export interface StuckJob {
  id: string;
  service_id: string;
  user_id: string;
  status: string;
  status_updated_at: string;
  stuck_minutes: number;
}

/**
 * Stuck thresholds per non-terminal status (in minutes).
 * Jobs that have been in these statuses longer than the threshold
 * are considered stuck (agent may have crashed or gone offline).
 */
const STUCK_THRESHOLDS: Record<string, number> = {
  dispatched: 120,       // 2 hours
  active: 30,            // 30 minutes
  awaiting_otp: 20,      // 20 minutes
  outreach_sent: 4320,   // 72 hours (3 days)
};

/**
 * Find jobs stuck in non-terminal states beyond their expected thresholds.
 *
 * Uses status_updated_at (already on the jobs table) to calculate
 * how long a job has been in its current status.
 */
export async function findStuckJobs(): Promise<StuckJob[]> {
  // Build a UNION query for each status with its threshold
  const conditions = Object.entries(STUCK_THRESHOLDS).map(
    ([status, minutes], i) => {
      const statusParam = `$${i * 2 + 1}`;
      const minutesParam = `$${i * 2 + 2}`;
      return `SELECT id, service_id, user_id, status, status_updated_at,
        EXTRACT(EPOCH FROM (NOW() - status_updated_at))::int / 60 AS stuck_minutes
       FROM jobs
       WHERE status = ${statusParam}
         AND status_updated_at < NOW() - (${minutesParam} || ' minutes')::interval`;
    }
  );

  const params = Object.entries(STUCK_THRESHOLDS).flatMap(
    ([status, minutes]) => [status, String(minutes)]
  );

  const sql = conditions.join("\nUNION ALL\n") + "\nORDER BY stuck_minutes DESC";

  const result = await query<{
    id: string;
    service_id: string;
    user_id: string;
    status: string;
    status_updated_at: string;
    stuck_minutes: string;
  }>(sql, params);

  return result.rows.map((row) => ({
    id: row.id,
    service_id: row.service_id,
    user_id: row.user_id,
    status: row.status,
    status_updated_at: row.status_updated_at,
    stuck_minutes: parseInt(row.stuck_minutes, 10),
  }));
}

/** Exported for testing. */
export { STUCK_THRESHOLDS };
