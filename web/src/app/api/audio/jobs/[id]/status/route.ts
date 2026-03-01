import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";

const VALID_STATUSES = [
  "pending_payment",
  "paid",
  "synthesizing",
  "completed",
  "failed",
  "refunded",
];

/**
 * PATCH /api/audio/jobs/[id]/status
 *
 * HMAC-authenticated. Update audio job status.
 * Body: { status: string, error_message?: string }
 */
export const PATCH = withAgentAuth(
  async (req: NextRequest, { body, params }: { body: string; params?: Record<string, string> }) => {
    const jobId = params?.id;
    if (!jobId) {
      return NextResponse.json({ error: "Missing job id" }, { status: 400 });
    }

    let data: { status: string; error_message?: string };
    try {
      data = JSON.parse(body);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!VALID_STATUSES.includes(data.status)) {
      return NextResponse.json(
        { error: `Invalid status: ${data.status}` },
        { status: 400 }
      );
    }

    const result = await query<{
      id: string;
      status: string;
      audio_cache_id: string;
      requester_npub: string;
    }>(
      `UPDATE audio_jobs
       SET status = $2, error_message = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING id, status, audio_cache_id, requester_npub`,
      [jobId, data.status, data.error_message ?? null]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    return NextResponse.json({ job: result.rows[0] });
  }
);
