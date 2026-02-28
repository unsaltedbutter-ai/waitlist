import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { parseJsonBody } from "@/lib/parse-json-body";
import { query } from "@/lib/db";
import { CREDENTIAL_ALERT_THRESHOLD } from "@/lib/abuse-thresholds";

interface ActionLogBody {
  success: boolean;
  duration_seconds: number;
  step_count: number;
  inference_count: number;
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
        otp_required, error_code, error_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        jobId,
        job.user_id,
        job.service_id,
        job.action,
        data.success,
        data.duration_seconds ?? null,
        data.step_count ?? null,
        data.inference_count ?? null,
        data.otp_required ?? false,
        data.error_code ?? null,
        data.error_message ?? null,
      ]
    );

    // Increment credential failure counter when login fails
    if (data.error_code === "credential_invalid") {
      await query(
        `UPDATE streaming_credentials
         SET credential_failures = credential_failures + 1,
             last_failure_at = NOW()
         WHERE user_id = $1 AND service_id = $2`,
        [job.user_id, job.service_id]
      );

      // Alert operator after threshold
      const credCheck = await query<{ credential_failures: number }>(
        "SELECT credential_failures FROM streaming_credentials WHERE user_id = $1 AND service_id = $2",
        [job.user_id, job.service_id]
      );
      if (
        credCheck.rows.length > 0 &&
        credCheck.rows[0].credential_failures >= CREDENTIAL_ALERT_THRESHOLD
      ) {
        await query(
          `INSERT INTO operator_alerts (alert_type, severity, title, message, related_user_id)
           VALUES ('credential_abuse', 'warning', 'Repeated credential failures', $1, $2)`,
          [
            `User has ${credCheck.rows[0].credential_failures} consecutive credential failures for ${job.service_id}`,
            job.user_id,
          ]
        );
      }
    }

    return NextResponse.json({ ok: true }, { status: 201 });
  }
);
