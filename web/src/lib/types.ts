/**
 * Enriched queue item returned by GET /api/queue.
 * Includes active job state and last completed job metadata.
 */
export interface EnrichedQueueItem {
  service_id: string;
  service_name: string;
  position: number;
  plan_id: string | null;
  plan_name: string | null;
  plan_price_cents: number | null;
  active_job_id: string | null;
  active_job_action: "cancel" | "resume" | null;
  active_job_status: string | null;
  last_access_end_date: string | null;
  last_completed_action: "cancel" | "resume" | null;
}
