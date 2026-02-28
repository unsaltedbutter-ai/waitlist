import { query } from "@/lib/db";
import { pushJobsReady } from "@/lib/nostr-push";
import { TERMINAL_STATUSES } from "@/lib/constants";
import { recordStatusChange } from "@/lib/job-history";
import { generateAlerts } from "@/lib/alert-generator";

export interface PruneResult {
  action_logs: number;
  job_status_history: number;
  operator_alerts: number;
  operator_audit_log: number;
}

export interface CronResult {
  jobs_created: number;
  nudged: number;
  skipped_debt: number;
  alerts_created: number;
  pruned: PruneResult;
}

/**
 * Find users whose active services have billing dates within 14 days.
 * A "billing date" comes from the most recent completed job for that user+service pair.
 * Only considers onboarded users with no debt and no existing non-terminal job.
 *
 * Returns rows of { user_id, service_id, billing_date } for cancel job creation.
 */
async function findUpcomingCancels(): Promise<
  { user_id: string; service_id: string; billing_date: string }[]
> {
  const terminalPlaceholders = TERMINAL_STATUSES.map(
    (_, i) => `$${i + 1}`
  ).join(", ");

  // Query rotation_queue.next_billing_date directly instead of scanning job history.
  // next_billing_date is maintained by the job status update route on every state change.
  const result = await query<{
    user_id: string;
    service_id: string;
    billing_date: string;
  }>(
    `SELECT rq.user_id, rq.service_id, rq.next_billing_date::text AS billing_date
     FROM rotation_queue rq
     JOIN users u ON u.id = rq.user_id
     WHERE u.debt_sats = 0
       AND u.onboarded_at IS NOT NULL
       AND rq.next_billing_date IS NOT NULL
       AND rq.next_billing_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '14 days')
       AND NOT EXISTS (
         SELECT 1 FROM jobs ej
         WHERE ej.user_id = rq.user_id
           AND ej.service_id = rq.service_id
           AND ej.status NOT IN (${terminalPlaceholders})
       )`,
    [...TERMINAL_STATUSES]
  );

  return result.rows;
}

/**
 * Find users whose current service's access_end_date is within 7 days,
 * meaning it is time to resume the next service in their rotation queue.
 *
 * The access_end_date comes from the most recent completed cancel job.
 * The resume target is the next service in the rotation queue (position 1).
 *
 * Returns rows of { user_id, service_id } for resume job creation.
 */
async function findUpcomingResumes(): Promise<
  { user_id: string; service_id: string }[]
> {
  const terminalPlaceholders = TERMINAL_STATUSES.map(
    (_, i) => `$${i + 1}`
  ).join(", ");

  // Find users with a recently completed cancel whose access_end_date is within 7 days.
  // The resume target is position 1 in their rotation queue.
  const result = await query<{
    user_id: string;
    service_id: string;
  }>(
    `WITH latest_cancel AS (
      SELECT DISTINCT ON (j.user_id)
        j.user_id,
        j.access_end_date
      FROM jobs j
      WHERE j.action = 'cancel'
        AND j.status IN (${terminalPlaceholders})
        AND j.access_end_date IS NOT NULL
      ORDER BY j.user_id, j.created_at DESC
    )
    SELECT rq.user_id, rq.service_id
    FROM latest_cancel lc
    JOIN users u ON u.id = lc.user_id
    JOIN rotation_queue rq ON rq.user_id = lc.user_id AND rq.position = 1
    WHERE u.debt_sats = 0
      AND u.onboarded_at IS NOT NULL
      AND lc.access_end_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '7 days')
      AND NOT EXISTS (
        SELECT 1 FROM jobs ej
        WHERE ej.user_id = rq.user_id
          AND ej.service_id = rq.service_id
          AND ej.status NOT IN (${terminalPlaceholders})
      )`,
    [...TERMINAL_STATUSES]
  );

  return result.rows;
}

/**
 * Find users who were skipped because of debt_sats > 0.
 * Used for reporting only (the count of users we skipped).
 * We count users (not user+service pairs) who have debt and would otherwise
 * qualify for a scheduled job.
 */
async function countDebtUsers(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT u.id)::text AS count
     FROM users u
     WHERE u.debt_sats > 0
       AND u.onboarded_at IS NOT NULL`
  );

  return parseInt(result.rows[0]?.count ?? "0", 10);
}

/**
 * Find pending jobs older than 1 hour that need a nudge notification.
 */
async function findStaleJobs(): Promise<string[]> {
  const result = await query<{ id: string }>(
    `SELECT id FROM jobs
     WHERE status = 'pending'
       AND created_at < NOW() - INTERVAL '1 hour'`
  );

  return result.rows.map((r) => r.id);
}

/**
 * Create a pending job and return its ID.
 */
async function createJob(
  userId: string,
  serviceId: string,
  action: "cancel" | "resume",
  billingDate?: string
): Promise<string | null> {
  const result = await query<{ id: string }>(
    `INSERT INTO jobs (user_id, service_id, action, trigger, status, billing_date)
     VALUES ($1, $2, $3, 'scheduled', 'pending', $4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId, serviceId, action, billingDate ?? null]
  );

  const jobId = result.rows[0]?.id ?? null;
  if (jobId) {
    await recordStatusChange(jobId, null, "pending", "cron");
  }

  return jobId;
}

const RETENTION_DAYS = 180;

/**
 * Delete rows older than 180 days from audit/log tables.
 * Runs as part of the daily cron to prevent unbounded table growth.
 *
 * Tables pruned:
 *   - action_logs (agent execution audit trail)
 *   - job_status_history (status transition log)
 *   - operator_alerts (all alerts older than 180 days, regardless of ack status)
 *   - operator_audit_log (manual operator actions)
 *
 * Not pruned:
 *   - system_heartbeats (upsert, one row per component)
 *   - revenue_ledger (append-only financial record, never deleted)
 */
async function pruneOldRecords(): Promise<PruneResult> {
  const interval = `${RETENTION_DAYS} days`;

  const [actionLogs, jobHistory, alerts, auditLog] = await Promise.all([
    query(`DELETE FROM action_logs WHERE created_at < NOW() - $1::interval`, [interval]),
    query(`DELETE FROM job_status_history WHERE created_at < NOW() - $1::interval`, [interval]),
    query(`DELETE FROM operator_alerts WHERE created_at < NOW() - $1::interval`, [interval]),
    query(`DELETE FROM operator_audit_log WHERE created_at < NOW() - $1::interval`, [interval]),
  ]);

  return {
    action_logs: actionLogs.rowCount ?? 0,
    job_status_history: jobHistory.rowCount ?? 0,
    operator_alerts: alerts.rowCount ?? 0,
    operator_audit_log: auditLog.rowCount ?? 0,
  };
}

/**
 * Run the daily cron job.
 *
 * 1. Scan for upcoming billing dates (cancels within 14 days, resumes within 7 days)
 * 2. Create pending jobs (idempotent: skips if non-terminal job exists)
 * 3. Push notification for new jobs
 * 4. Nudge stale pending jobs (> 1 hour old)
 * 5. Skip users with debt
 * 6. Generate operator alerts
 * 7. Prune audit/log tables older than 180 days
 */
export async function runDailyCron(): Promise<CronResult> {
  const createdJobIds: string[] = [];

  // 1. Find and create cancel jobs
  const cancelCandidates = await findUpcomingCancels();
  for (const candidate of cancelCandidates) {
    const jobId = await createJob(
      candidate.user_id,
      candidate.service_id,
      "cancel",
      candidate.billing_date
    );
    if (jobId) createdJobIds.push(jobId);
  }

  // 2. Find and create resume jobs
  const resumeCandidates = await findUpcomingResumes();
  for (const candidate of resumeCandidates) {
    const jobId = await createJob(
      candidate.user_id,
      candidate.service_id,
      "resume"
    );
    if (jobId) createdJobIds.push(jobId);
  }

  // 3. Push notification for newly created jobs
  if (createdJobIds.length > 0) {
    console.log(`[cron-daily] Created ${createdJobIds.length} job(s): ${createdJobIds.join(", ")}, pushing to orchestrator`);
    await pushJobsReady(createdJobIds);
  }

  // 4. Nudge stale pending jobs
  const staleJobIds = await findStaleJobs();
  if (staleJobIds.length > 0) {
    console.log(`[cron-daily] Nudging ${staleJobIds.length} stale job(s): ${staleJobIds.join(", ")}`);
    await pushJobsReady(staleJobIds);
  }

  // 5. Count users skipped due to debt (for reporting)
  const skippedDebt = await countDebtUsers();

  // 6. Generate operator alerts (stuck jobs, capacity, debt)
  const alertsResult = await generateAlerts();

  // 7. Prune old audit/log rows (180-day retention)
  const pruned = await pruneOldRecords();
  const totalPruned = pruned.action_logs + pruned.job_status_history + pruned.operator_alerts + pruned.operator_audit_log;
  if (totalPruned > 0) {
    console.log(`[cron-daily] Pruned ${totalPruned} old rows: action_logs=${pruned.action_logs}, job_status_history=${pruned.job_status_history}, operator_alerts=${pruned.operator_alerts}, operator_audit_log=${pruned.operator_audit_log}`);
  }

  return {
    jobs_created: createdJobIds.length,
    nudged: staleJobIds.length,
    skipped_debt: skippedDebt,
    alerts_created: alertsResult.created,
    pruned,
  };
}
