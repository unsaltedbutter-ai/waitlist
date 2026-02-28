import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { parseJsonBody } from "@/lib/parse-json-body";
import { query } from "@/lib/db";

interface ActionLogBody {
  success: boolean;
  duration_seconds: number;
  step_count: number;
  inference_count: number;
  playbook_version: number;
  otp_required: boolean;
  error_code: string | null;
  error_message: string | null;
}

export const POST = withAgentAuth(
  async (_req: NextRequest, { body, params }) => {
    const jobId = params?.id;
    if (!jobId) {
      return NextResponse.json({ error: "Missing job ID" }, { status: 400 });
    }

    const { data, error } = parseJsonBody<ActionLogBody>(body);
    if (error) return error;

    // Look up the job to get user_id, service_id, action (for flow_type)
    const jobResult = await query(
      "SELECT user_id, service_id, action FROM jobs WHERE id = $1",
      [jobId]
    );
    if (jobResult.rows.length === 0) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const job = jobResult.rows[0];

    await query(
      `INSERT INTO action_logs (
        job_id, user_id, service_id, flow_type, success,
        duration_seconds, step_count, inference_count,
        playbook_version, otp_required, error_code, error_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        jobId,
        job.user_id,
        job.service_id,
        job.action,
        data.success,
        data.duration_seconds ?? null,
        data.step_count ?? null,
        data.inference_count ?? null,
        data.playbook_version ?? null,
        data.otp_required ?? false,
        data.error_code ?? null,
        data.error_message ?? null,
      ]
    );

    return NextResponse.json({ ok: true }, { status: 201 });
  }
);
