import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query, transaction } from "@/lib/db";
import { UUID_REGEX } from "@/lib/constants";
import { parseJsonBody } from "@/lib/parse-json-body";
import { decrypt, hashEmail } from "@/lib/crypto";
import { recordStatusChange } from "@/lib/job-history";

// Valid status transitions: from -> [allowed targets]
const VALID_TRANSITIONS: Record<string, string[]> = {
  dispatched: ["outreach_sent", "active", "implied_skip", "failed"],
  outreach_sent: ["snoozed", "active", "user_skip", "failed"],
  snoozed: ["dispatched", "failed"],
  active: ["awaiting_otp", "completed_paid", "completed_eventual", "completed_reneged", "failed"],
  awaiting_otp: ["active", "user_abandon", "completed_paid", "completed_eventual", "completed_reneged", "failed"],
};

export const PATCH = withAgentAuth(async (_req: NextRequest, { body, params }) => {
  const jobId = params?.id;
  if (!jobId) {
    return NextResponse.json({ error: "Missing job ID" }, { status: 400 });
  }

  if (!UUID_REGEX.test(jobId)) {
    return NextResponse.json({ error: "Invalid job ID format" }, { status: 400 });
  }

  const { data: parsed, error } = parseJsonBody<{
    status: string;
    next_outreach_at?: string;
    outreach_count?: number;
    access_end_date?: string;
    amount_sats?: number;
    billing_date?: string;
  }>(body);
  if (error) return error;

  const { status: newStatus } = parsed;
  if (!newStatus) {
    return NextResponse.json({ error: "Missing status" }, { status: 400 });
  }

  if (parsed.amount_sats !== undefined) {
    if (!Number.isInteger(parsed.amount_sats) || parsed.amount_sats <= 0) {
      return NextResponse.json({ error: "amount_sats must be a positive integer" }, { status: 400 });
    }
  }

  try {
    // Look up current job to validate transition
    const jobResult = await query<{
      id: string;
      status: string;
    }>("SELECT id, status FROM jobs WHERE id = $1", [jobId]);

    if (jobResult.rows.length === 0) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const currentStatus = jobResult.rows[0].status;

    // Validate transition
    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(newStatus)) {
      return NextResponse.json(
        { error: `Invalid transition from ${currentStatus} to ${newStatus}` },
        { status: 400 }
      );
    }

    // Build SET clause dynamically
    const setClauses: string[] = ["status = $2", "status_updated_at = NOW()"];
    const values: unknown[] = [jobId, newStatus];
    let paramIdx = 3;

    if (parsed.next_outreach_at !== undefined) {
      setClauses.push(`next_outreach_at = $${paramIdx}`);
      values.push(parsed.next_outreach_at);
      paramIdx++;
    }

    if (parsed.outreach_count !== undefined) {
      setClauses.push(`outreach_count = $${paramIdx}`);
      values.push(parsed.outreach_count);
      paramIdx++;
    }

    if (parsed.access_end_date !== undefined) {
      setClauses.push(`access_end_date = $${paramIdx}`);
      values.push(parsed.access_end_date);
      paramIdx++;
    }

    if (parsed.amount_sats !== undefined) {
      setClauses.push(`amount_sats = $${paramIdx}`);
      values.push(parsed.amount_sats);
      paramIdx++;
    }

    if (parsed.billing_date !== undefined) {
      setClauses.push(`billing_date = $${paramIdx}`);
      values.push(parsed.billing_date);
      paramIdx++;
    }

    // Atomic update: only succeeds if status still matches what we read
    const statusParamIdx = paramIdx;
    values.push(currentStatus);

    const updateResult = await query<{
      id: string;
      user_id: string;
      service_id: string;
      action: string;
      trigger: string;
      status: string;
      billing_date: string | null;
      access_end_date: string | null;
      outreach_count: number;
      next_outreach_at: string | null;
      amount_sats: number | null;
      invoice_id: string | null;
      created_at: string;
      status_updated_at: string;
    }>(
      `UPDATE jobs SET ${setClauses.join(", ")} WHERE id = $1 AND status = $${statusParamIdx} RETURNING *`,
      values
    );

    if (updateResult.rows.length === 0) {
      // Status changed concurrently between our SELECT and UPDATE
      const check = await query("SELECT status FROM jobs WHERE id = $1", [jobId]);
      if (check.rows.length === 0) {
        return NextResponse.json({ error: "Job not found" }, { status: 404 });
      }
      return NextResponse.json(
        { error: "Job status changed concurrently, retry" },
        { status: 409 }
      );
    }

    const updatedJob = updateResult.rows[0];

    // Record the status transition in the history table
    await recordStatusChange(jobId, currentStatus, newStatus, "agent");

    // Update rotation_queue.next_billing_date based on completed status + action
    const completedStatuses = ["completed_paid", "completed_eventual", "completed_reneged"];
    const skipStatuses = ["user_skip", "implied_skip"];

    if (completedStatuses.includes(newStatus)) {
      if (updatedJob.action === "cancel") {
        // Cancel complete: clear billing date (service is now cancelled)
        await query(
          "UPDATE rotation_queue SET next_billing_date = NULL WHERE user_id = $1 AND service_id = $2",
          [updatedJob.user_id, updatedJob.service_id]
        );
        // Fallback: if access_end_date is still NULL, default to cancel date + 14 days
        if (!updatedJob.access_end_date) {
          await query(
            "UPDATE jobs SET access_end_date = (CURRENT_DATE + INTERVAL '14 days')::date, access_end_date_approximate = true WHERE id = $1",
            [jobId]
          );
        }
      } else if (updatedJob.action === "resume") {
        // Resume complete: next billing in 30 days
        await query(
          "UPDATE rotation_queue SET next_billing_date = CURRENT_DATE + 30 WHERE user_id = $1 AND service_id = $2",
          [updatedJob.user_id, updatedJob.service_id]
        );
      }
    } else if (skipStatuses.includes(newStatus) && updatedJob.action === "cancel") {
      // Skip on a cancel job: advance billing date by 30 days from current billing date
      await query(
        "UPDATE rotation_queue SET next_billing_date = next_billing_date + 30 WHERE user_id = $1 AND service_id = $2",
        [updatedJob.user_id, updatedJob.service_id]
      );
    }

    if (newStatus === "completed_reneged" && updatedJob.amount_sats) {
      await transaction(async (txQuery) => {
        const credResult = await txQuery<{ email_enc: Buffer }>(
          "SELECT email_enc FROM streaming_credentials WHERE user_id = $1 AND service_id = $2",
          [updatedJob.user_id, updatedJob.service_id]
        );

        if (credResult.rows.length > 0) {
          const email = decrypt(credResult.rows[0].email_enc);
          const hash = hashEmail(email);

          await txQuery(
            "UPDATE jobs SET email_hash = $2 WHERE id = $1",
            [updatedJob.id, hash]
          );

          await txQuery(
            `UPDATE users SET debt_sats = debt_sats + $2, updated_at = NOW()
             WHERE id = $1`,
            [updatedJob.user_id, updatedJob.amount_sats]
          );

          await txQuery(
            `INSERT INTO reneged_emails (email_hash, total_debt_sats, last_seen_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (email_hash) DO UPDATE
             SET total_debt_sats = reneged_emails.total_debt_sats + $2,
                 last_seen_at = NOW()`,
            [hash, updatedJob.amount_sats]
          );
        }
      });
    }

    return NextResponse.json({ job: updatedJob });
  } catch (err) {
    console.error("Agent job status update error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
