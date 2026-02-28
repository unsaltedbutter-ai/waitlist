import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";
import { UUID_REGEX } from "@/lib/constants";

export const GET = withOperator(async (_req: NextRequest, { params }) => {
  const jobId = params?.id;
  if (!jobId) {
    return NextResponse.json({ error: "Missing job ID" }, { status: 400 });
  }

  if (!UUID_REGEX.test(jobId)) {
    return NextResponse.json({ error: "Invalid job ID format" }, { status: 400 });
  }

  // 1. Fetch the job
  const jobResult = await query<{
    id: string;
    user_id: string;
    service_id: string;
    action: string;
    trigger: string;
    status: string;
    status_updated_at: string;
    billing_date: string | null;
    access_end_date: string | null;
    outreach_count: number;
    next_outreach_at: string | null;
    amount_sats: number | null;
    invoice_id: string | null;
    created_at: string;
  }>(
    "SELECT * FROM jobs WHERE id = $1",
    [jobId]
  );

  if (jobResult.rows.length === 0) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const job = jobResult.rows[0];

  // 2. Fetch user summary (npub + id)
  const userResult = await query<{
    id: string;
    nostr_npub: string;
  }>(
    "SELECT id, nostr_npub FROM users WHERE id = $1",
    [job.user_id]
  );

  const user = userResult.rows[0] ?? null;

  // 3. Fetch action_logs for this job
  const logsResult = await query<{
    id: string;
    flow_type: string;
    success: boolean;
    duration_seconds: number | null;
    step_count: number | null;
    inference_count: number | null;
    otp_required: boolean;
    error_code: string | null;
    error_message: string | null;
    created_at: string;
  }>(
    `SELECT id, flow_type, success, duration_seconds, step_count,
            inference_count, otp_required, error_code,
            error_message, created_at
     FROM action_logs
     WHERE job_id = $1
     ORDER BY created_at ASC`,
    [jobId]
  );

  // 4. Fetch transaction record for this job
  const txResult = await query<{
    id: string;
    amount_sats: number;
    status: string;
    created_at: string;
    paid_at: string | null;
  }>(
    "SELECT id, amount_sats, status, created_at, paid_at FROM transactions WHERE job_id = $1",
    [jobId]
  );

  // 5. Fetch status history
  const historyResult = await query<{
    id: string;
    from_status: string | null;
    to_status: string;
    changed_by: string;
    created_at: string;
  }>(
    `SELECT id, from_status, to_status, changed_by, created_at
     FROM job_status_history
     WHERE job_id = $1
     ORDER BY created_at ASC`,
    [jobId]
  );

  return NextResponse.json({
    job,
    user,
    action_logs: logsResult.rows,
    transaction: txResult.rows[0] ?? null,
    status_history: historyResult.rows,
  });
});
