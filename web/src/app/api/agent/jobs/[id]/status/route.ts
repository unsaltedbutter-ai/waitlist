import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";
import { UUID_REGEX } from "@/lib/constants";

// Valid status transitions: from -> [allowed targets]
const VALID_TRANSITIONS: Record<string, string[]> = {
  dispatched: ["outreach_sent", "active", "implied_skip"],
  outreach_sent: ["snoozed", "active", "user_skip"],
  snoozed: ["dispatched"],
  active: ["awaiting_otp", "completed_paid", "completed_eventual", "completed_reneged"],
  awaiting_otp: ["active", "user_abandon", "completed_paid", "completed_eventual", "completed_reneged"],
};

export const PATCH = withAgentAuth(async (_req: NextRequest, { body, params }) => {
  const jobId = params?.id;
  if (!jobId) {
    return NextResponse.json({ error: "Missing job ID" }, { status: 400 });
  }

  if (!UUID_REGEX.test(jobId)) {
    return NextResponse.json({ error: "Invalid job ID format" }, { status: 400 });
  }

  let parsed: {
    status: string;
    next_outreach_at?: string;
    outreach_count?: number;
    access_end_date?: string;
    amount_sats?: number;
    billing_date?: string;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { status: newStatus } = parsed;
  if (!newStatus) {
    return NextResponse.json({ error: "Missing status" }, { status: 400 });
  }

  if (parsed.amount_sats !== undefined) {
    if (!Number.isInteger(parsed.amount_sats) || parsed.amount_sats <= 0) {
      return NextResponse.json({ error: "amount_sats must be a positive integer" }, { status: 400 });
    }
  }

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

  return NextResponse.json({ job: updateResult.rows[0] });
});
