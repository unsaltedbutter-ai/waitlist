import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { transaction } from "@/lib/db";

export const POST = withAgentAuth(async (_req: NextRequest, { body }) => {
  let parsed: { job_ids: string[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { job_ids } = parsed;
  if (!Array.isArray(job_ids) || job_ids.length === 0) {
    return NextResponse.json(
      { error: "job_ids must be a non-empty array" },
      { status: 400 }
    );
  }

  if (job_ids.length > 100) {
    return NextResponse.json(
      { error: "job_ids cannot exceed 100 items" },
      { status: 400 }
    );
  }

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const id of job_ids) {
    if (!uuidRegex.test(id)) {
      return NextResponse.json(
        { error: `Invalid UUID: ${id}` },
        { status: 400 }
      );
    }
  }

  const claimed = await transaction(async (txQuery) => {
    // Atomically claim only pending jobs
    const result = await txQuery<{
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
      nostr_npub: string;
    }>(
      `UPDATE jobs
       SET status = 'dispatched', status_updated_at = NOW()
       WHERE id = ANY($1) AND status = 'pending'
       RETURNING jobs.*,
         (SELECT nostr_npub FROM users WHERE users.id = jobs.user_id) AS nostr_npub`,
      [job_ids]
    );

    return result.rows;
  });

  return NextResponse.json({ claimed });
});
