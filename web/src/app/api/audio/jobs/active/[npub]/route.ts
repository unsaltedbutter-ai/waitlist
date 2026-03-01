import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";

/**
 * GET /api/audio/jobs/active/[npub]
 *
 * HMAC-authenticated. Check if a user has an in-flight audio job.
 * Returns { has_active: boolean, job_id?: string }
 */
export const GET = withAgentAuth(
  async (req: NextRequest, { params }: { body: string; params?: Record<string, string> }) => {
    const npub = params?.npub;
    if (!npub) {
      return NextResponse.json({ error: "Missing npub" }, { status: 400 });
    }

    const result = await query<{ id: string; status: string }>(
      `SELECT id, status FROM audio_jobs
       WHERE requester_npub = $1
         AND status NOT IN ('completed', 'failed', 'refunded')
       ORDER BY created_at DESC
       LIMIT 1`,
      [npub]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ has_active: false });
    }

    return NextResponse.json({
      has_active: true,
      job_id: result.rows[0].id,
      status: result.rows[0].status,
    });
  }
);
