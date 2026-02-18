import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

const TERMINAL_STATUSES = new Set([
  "completed_paid",
  "completed_eventual",
  "completed_reneged",
  "user_skip",
  "user_abandon",
  "implied_skip",
]);

export const POST = withOperator(
  async (req: NextRequest, { params }: { userId: string; params?: Record<string, string> }) => {
    const id = params?.id;
    if (!id) {
      return NextResponse.json({ error: "Missing job id" }, { status: 400 });
    }

    let body: { status?: string; reason?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { status, reason } = body;

    if (!status || typeof status !== "string" || !TERMINAL_STATUSES.has(status)) {
      return NextResponse.json(
        {
          error: `status must be one of: ${[...TERMINAL_STATUSES].join(", ")}`,
        },
        { status: 400 }
      );
    }

    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      return NextResponse.json({ error: "reason is required" }, { status: 400 });
    }

    // Verify job exists
    const jobResult = await query<{ id: string; status: string }>(
      "SELECT id, status FROM jobs WHERE id = $1",
      [id]
    );

    if (jobResult.rows.length === 0) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const previousStatus = jobResult.rows[0].status;

    // Update job status
    const updateResult = await query<{
      id: string;
      user_id: string;
      service_id: string;
      action: string;
      status: string;
      status_updated_at: string;
    }>(
      `UPDATE jobs SET status = $1, status_updated_at = NOW() WHERE id = $2
       RETURNING id, user_id, service_id, action, status, status_updated_at`,
      [status, id]
    );

    // Write audit log
    await query(
      `INSERT INTO operator_audit_log (action, target_type, target_id, detail)
       VALUES ($1, $2, $3, $4)`,
      [
        "force_job_status",
        "job",
        id,
        JSON.stringify({ previous_status: previousStatus, new_status: status, reason: reason.trim() }),
      ]
    );

    return NextResponse.json({ job: updateResult.rows[0] });
  }
);
