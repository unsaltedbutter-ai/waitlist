import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query, transaction } from "@/lib/db";
import { UUID_REGEX } from "@/lib/constants";
import { parseJsonBody } from "@/lib/parse-json-body";
import { decrypt, hashEmail } from "@/lib/crypto";

export const POST = withAgentAuth(async (_req: NextRequest, { body }) => {
  const { data: parsed, error } = parseJsonBody<{ job_ids: string[] }>(body);
  if (error) return error;

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
  for (const id of job_ids) {
    if (!UUID_REGEX.test(id)) {
      return NextResponse.json(
        { error: `Invalid UUID: ${id}` },
        { status: 400 }
      );
    }
  }

  try {
    // Pre-check: find which pending jobs have blocked emails
    const pendingJobs = await query<{
      id: string;
      user_id: string;
      service_id: string;
    }>(
      "SELECT id, user_id, service_id FROM jobs WHERE id = ANY($1) AND status = 'pending'",
      [job_ids]
    );

    const blockedIds: string[] = [];
    const cleanIds: string[] = [];

    for (const job of pendingJobs.rows) {
      const credResult = await query<{ email_enc: Buffer }>(
        "SELECT email_enc FROM streaming_credentials WHERE user_id = $1 AND service_id = $2",
        [job.user_id, job.service_id]
      );

      if (credResult.rows.length > 0) {
        const email = decrypt(credResult.rows[0].email_enc);
        const hash = hashEmail(email);
        const reneged = await query<{ total_debt_sats: number }>(
          "SELECT total_debt_sats FROM reneged_emails WHERE email_hash = $1 AND total_debt_sats > 0",
          [hash]
        );
        if (reneged.rows.length > 0) {
          blockedIds.push(job.id);
          continue;
        }
      }
      cleanIds.push(job.id);
    }

    let claimed: Record<string, unknown>[] = [];
    if (cleanIds.length > 0) {
      const result = await transaction(async (txQuery) => {
        const updateResult = await txQuery<{
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
          [cleanIds]
        );
        return updateResult.rows;
      });
      claimed = result;
    }

    return NextResponse.json({
      claimed,
      blocked: blockedIds.length > 0 ? blockedIds : undefined,
    });
  } catch (err) {
    console.error("Agent jobs claim error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
