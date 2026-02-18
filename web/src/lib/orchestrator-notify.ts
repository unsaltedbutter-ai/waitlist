import { query } from "@/lib/db";

/**
 * Notify the orchestrator that a user needs their first rotation started.
 *
 * Creates an agent_jobs entry with flow_type='signup' so the daily batch
 * pull picks it up. No-ops if the user has no queue or already has a
 * pending/in_progress signup job.
 */
export async function notifyOrchestrator(userId: string): Promise<void> {
  // 1. Find the user's first service in rotation_queue (position 1)
  const queueResult = await query<{ service_id: string }>(
    `SELECT service_id FROM rotation_queue
     WHERE user_id = $1 AND position = 1`,
    [userId]
  );

  if (queueResult.rows.length === 0) {
    // Nothing in queue, nothing to rotate to
    return;
  }

  const serviceId = queueResult.rows[0].service_id;

  // 2. Check for existing pending or in_progress signup job
  const existingJob = await query<{ id: string }>(
    `SELECT id FROM agent_jobs
     WHERE user_id = $1
       AND flow_type = 'signup'
       AND status IN ('pending', 'claimed', 'in_progress')
     LIMIT 1`,
    [userId]
  );

  if (existingJob.rows.length > 0) {
    // Already has a signup job queued or running, skip
    return;
  }

  // 3. Insert the signup job for the orchestrator to pick up
  await query(
    `INSERT INTO agent_jobs (user_id, service_id, slot_number, flow_type, scheduled_for, status)
     VALUES ($1, $2, 1, 'signup', CURRENT_DATE, 'pending')`,
    [userId, serviceId]
  );
}
