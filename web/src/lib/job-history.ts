import { query } from "@/lib/db";
import type { QueryResult, QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
) => Promise<QueryResult<T>>;

/**
 * Record a job status transition in the job_status_history table.
 *
 * @param jobId      The job UUID
 * @param fromStatus Previous status (null for initial creation)
 * @param toStatus   New status
 * @param changedBy  Who initiated the change (e.g. 'system', 'agent', 'cron')
 * @param queryFn    Optional query function (use txQuery inside transactions)
 */
export async function recordStatusChange(
  jobId: string,
  fromStatus: string | null,
  toStatus: string,
  changedBy: string = "system",
  queryFn: QueryFn = query
): Promise<void> {
  await queryFn(
    "INSERT INTO job_status_history (job_id, from_status, to_status, changed_by) VALUES ($1, $2, $3, $4)",
    [jobId, fromStatus, toStatus, changedBy]
  );
}
