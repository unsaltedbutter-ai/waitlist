import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

export const GET = withOperator(async (req: NextRequest) => {
  const url = new URL(req.url);
  const search = url.searchParams.get("search")?.trim() ?? "";

  if (search) {
    const result = await query<{
      id: string;
      nostr_npub: string;
      debt_sats: number;
      onboarded_at: string | null;
      created_at: string;
      queue_count: string;
      job_count: string;
    }>(
      `SELECT
         u.id,
         u.nostr_npub,
         u.debt_sats,
         u.onboarded_at,
         u.created_at,
         (SELECT COUNT(*)::int FROM rotation_queue rq WHERE rq.user_id = u.id) AS queue_count,
         (SELECT COUNT(*)::int FROM jobs j WHERE j.user_id = u.id) AS job_count
       FROM users u
       WHERE LOWER(u.nostr_npub) LIKE LOWER($1)
       ORDER BY u.created_at DESC
       LIMIT 50`,
      [`%${search}%`]
    );

    return NextResponse.json({ users: result.rows });
  }

  const result = await query<{
    id: string;
    nostr_npub: string;
    debt_sats: number;
    onboarded_at: string | null;
    created_at: string;
    queue_count: string;
    job_count: string;
  }>(
    `SELECT
       u.id,
       u.nostr_npub,
       u.debt_sats,
       u.onboarded_at,
       u.created_at,
       (SELECT COUNT(*)::int FROM rotation_queue rq WHERE rq.user_id = u.id) AS queue_count,
       (SELECT COUNT(*)::int FROM jobs j WHERE j.user_id = u.id) AS job_count
     FROM users u
     ORDER BY u.created_at DESC
     LIMIT 50`
  );

  return NextResponse.json({ users: result.rows });
});
