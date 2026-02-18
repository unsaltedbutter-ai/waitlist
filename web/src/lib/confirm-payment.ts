import { transaction } from "@/lib/db";

interface JobRow {
  id: string;
  user_id: string;
  service_id: string;
  action: string;
  trigger: string;
  status: string;
  amount_sats: number | null;
  invoice_id: string | null;
  email_hash: string | null;
  billing_date: string | null;
  access_end_date: string | null;
  outreach_count: number;
  next_outreach_at: string | null;
  created_at: string;
  status_updated_at: string;
}

export interface ConfirmPaymentResult {
  success: boolean;
  job?: JobRow;
  error?: string;
  status?: number;
}

export async function confirmJobPayment(
  jobId: string,
  _opts?: { zapEventId?: string }
): Promise<ConfirmPaymentResult> {
  const result = await transaction(async (txQuery) => {
    const jobResult = await txQuery<JobRow>(
      "SELECT * FROM jobs WHERE id = $1 FOR UPDATE",
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      return { error: "not_found" as const };
    }

    const job = jobResult.rows[0];

    if (job.status === "completed_paid" || job.status === "completed_eventual") {
      return { error: "already_paid" as const };
    }

    let targetStatus: string;
    if (job.status === "completed_reneged") {
      targetStatus = "completed_eventual";
    } else if (job.invoice_id) {
      targetStatus = "completed_paid";
    } else {
      return { error: "not_payable" as const };
    }

    const txnStatus = targetStatus === "completed_eventual" ? "eventual" : "paid";

    const updateResult = await txQuery<JobRow>(
      `UPDATE jobs SET status = $2, status_updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [jobId, targetStatus]
    );

    await txQuery(
      `UPDATE transactions SET status = $2, paid_at = NOW()
       WHERE job_id = $1`,
      [jobId, txnStatus]
    );

    if (job.amount_sats && job.amount_sats > 0) {
      await txQuery(
        `UPDATE users SET debt_sats = GREATEST(0, debt_sats - $2), updated_at = NOW()
         WHERE id = $1`,
        [job.user_id, job.amount_sats]
      );
    }

    if (job.amount_sats && job.amount_sats > 0) {
      await txQuery(
        `INSERT INTO revenue_ledger (service_id, action, amount_sats, payment_status, job_completed_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [job.service_id, job.action, job.amount_sats, txnStatus]
      );
    }

    if (job.email_hash && job.amount_sats && job.amount_sats > 0) {
      await txQuery(
        `UPDATE reneged_emails
         SET total_debt_sats = GREATEST(0, total_debt_sats - $2),
             last_seen_at = NOW()
         WHERE email_hash = $1`,
        [job.email_hash, job.amount_sats]
      );
      await txQuery(
        "DELETE FROM reneged_emails WHERE email_hash = $1 AND total_debt_sats <= 0",
        [job.email_hash]
      );
    }

    return { job: updateResult.rows[0] };
  });

  if (result.error === "not_found") {
    return { success: false, error: "Job not found", status: 404 };
  }
  if (result.error === "already_paid") {
    return { success: false, error: "Already paid", status: 409 };
  }
  if (result.error === "not_payable") {
    return { success: false, error: "Job is not in a payable state", status: 400 };
  }

  return { success: true, job: result.job };
}
