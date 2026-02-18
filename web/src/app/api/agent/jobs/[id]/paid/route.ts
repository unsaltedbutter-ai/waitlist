import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { transaction } from "@/lib/db";
import { UUID_REGEX } from "@/lib/constants";

export const POST = withAgentAuth(async (_req: NextRequest, { body, params }) => {
  const jobId = params?.id;
  if (!jobId) {
    return NextResponse.json({ error: "Missing job ID" }, { status: 400 });
  }

  if (!UUID_REGEX.test(jobId)) {
    return NextResponse.json({ error: "Invalid job ID format" }, { status: 400 });
  }

  let parsed: { zap_event_id?: string };
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Everything inside the transaction with FOR UPDATE lock
  const result = await transaction(async (txQuery) => {
    const jobResult = await txQuery<{
      id: string;
      user_id: string;
      service_id: string;
      action: string;
      trigger: string;
      status: string;
      amount_sats: number | null;
      invoice_id: string | null;
      billing_date: string | null;
      access_end_date: string | null;
      outreach_count: number;
      next_outreach_at: string | null;
      created_at: string;
      status_updated_at: string;
    }>("SELECT * FROM jobs WHERE id = $1 FOR UPDATE", [jobId]);

    if (jobResult.rows.length === 0) {
      return { error: "not_found" as const };
    }

    const job = jobResult.rows[0];

    // Already paid: no double-decrement
    if (job.status === "completed_paid" || job.status === "completed_eventual") {
      return { error: "already_paid" as const };
    }

    // Determine target status based on current state
    let targetStatus: string;
    if (job.status === "completed_reneged") {
      targetStatus = "completed_eventual";
    } else if (job.invoice_id) {
      targetStatus = "completed_paid";
    } else {
      return { error: "not_payable" as const };
    }

    // Determine transaction target status
    const txnStatus = targetStatus === "completed_eventual" ? "eventual" : "paid";

    // Update job status
    const updateResult = await txQuery<{
      id: string;
      user_id: string;
      service_id: string;
      action: string;
      trigger: string;
      status: string;
      amount_sats: number | null;
      invoice_id: string | null;
      billing_date: string | null;
      access_end_date: string | null;
      outreach_count: number;
      next_outreach_at: string | null;
      created_at: string;
      status_updated_at: string;
    }>(
      `UPDATE jobs SET status = $2, status_updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [jobId, targetStatus]
    );

    // Update transaction row
    await txQuery(
      `UPDATE transactions SET status = $2, paid_at = NOW()
       WHERE job_id = $1`,
      [jobId, txnStatus]
    );

    // Decrement user's debt_sats if the job had amount_sats
    if (job.amount_sats && job.amount_sats > 0) {
      await txQuery(
        `UPDATE users SET debt_sats = GREATEST(0, debt_sats - $2), updated_at = NOW()
         WHERE id = $1`,
        [job.user_id, job.amount_sats]
      );
    }

    return { job: updateResult.rows[0] };
  });

  if (result.error === "not_found") {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (result.error === "already_paid") {
    return NextResponse.json({ error: "Already paid" }, { status: 409 });
  }
  if (result.error === "not_payable") {
    return NextResponse.json(
      { error: "Job is not in a payable state" },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true, job: result.job });
});
