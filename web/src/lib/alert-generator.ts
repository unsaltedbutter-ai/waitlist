import { query } from "@/lib/db";
import { findStuckJobs } from "@/lib/stuck-jobs";
import { getActiveUserCount, getUserCap } from "@/lib/capacity";

export interface AlertResult {
  created: number;
  stuck_jobs: number;
  capacity_warning: boolean;
  debt_warning: boolean;
}

/**
 * Generate operator alerts for stuck jobs, capacity warnings, and debt warnings.
 *
 * Deduplication: does not create an alert for a stuck job if an unacknowledged
 * alert already exists for that job_id with the same alert_type.
 */
export async function generateAlerts(): Promise<AlertResult> {
  let created = 0;
  let stuckJobCount = 0;
  let capacityWarning = false;
  let debtWarning = false;

  // 1. Stuck job alerts
  const stuckJobs = await findStuckJobs();
  stuckJobCount = stuckJobs.length;

  for (const job of stuckJobs) {
    // Dedup: check for existing unacknowledged alert for this job
    const existing = await query<{ id: string }>(
      `SELECT id FROM operator_alerts
       WHERE related_job_id = $1
         AND alert_type = 'stuck_job'
         AND acknowledged = FALSE
       LIMIT 1`,
      [job.id]
    );

    if (existing.rows.length > 0) continue;

    await query(
      `INSERT INTO operator_alerts (alert_type, severity, title, message, related_job_id, related_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "stuck_job",
        "critical",
        `Stuck job: ${job.status} for ${job.stuck_minutes}m`,
        `Job ${job.id} has been in "${job.status}" for ${job.stuck_minutes} minutes (service: ${job.service_id}).`,
        job.id,
        job.user_id,
      ]
    );
    created++;
  }

  // 2. Capacity warning (> 90% of 5000 cap)
  const activeUsers = await getActiveUserCount();
  const cap = getUserCap();
  if (activeUsers > cap * 0.9) {
    // Dedup: check for existing unacknowledged capacity warning
    const existing = await query<{ id: string }>(
      `SELECT id FROM operator_alerts
       WHERE alert_type = 'capacity_warning'
         AND acknowledged = FALSE
       LIMIT 1`
    );

    if (existing.rows.length === 0) {
      await query(
        `INSERT INTO operator_alerts (alert_type, severity, title, message)
         VALUES ($1, $2, $3, $4)`,
        [
          "capacity_warning",
          "warning",
          `Capacity at ${Math.round((activeUsers / cap) * 100)}%`,
          `${activeUsers} of ${cap} user slots filled. Consider pausing waitlist invites.`,
        ]
      );
      created++;
      capacityWarning = true;
    }
  }

  // 3. Outstanding debt warning (> 100,000 sats total across all users)
  const debtResult = await query<{ total_debt: string }>(
    "SELECT COALESCE(SUM(debt_sats), 0)::text AS total_debt FROM users WHERE debt_sats > 0"
  );
  const totalDebt = parseInt(debtResult.rows[0]?.total_debt ?? "0", 10);

  if (totalDebt > 100_000) {
    // Dedup: check for existing unacknowledged debt warning
    const existing = await query<{ id: string }>(
      `SELECT id FROM operator_alerts
       WHERE alert_type = 'debt_warning'
         AND acknowledged = FALSE
       LIMIT 1`
    );

    if (existing.rows.length === 0) {
      await query(
        `INSERT INTO operator_alerts (alert_type, severity, title, message)
         VALUES ($1, $2, $3, $4)`,
        [
          "debt_warning",
          "warning",
          `Outstanding debt: ${totalDebt.toLocaleString()} sats`,
          `Total outstanding user debt is ${totalDebt.toLocaleString()} sats (threshold: 100,000).`,
        ]
      );
      created++;
      debtWarning = true;
    }
  }

  return {
    created,
    stuck_jobs: stuckJobCount,
    capacity_warning: capacityWarning,
    debt_warning: debtWarning,
  };
}
