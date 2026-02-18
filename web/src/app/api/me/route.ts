import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export const GET = withAuth(async (_req: NextRequest, { userId }) => {
  const [userResult, jobsResult] = await Promise.all([
    query(
      `SELECT id, nostr_npub, debt_sats, onboarded_at, created_at, updated_at
       FROM users WHERE id = $1`,
      [userId]
    ),
    query(
      `SELECT j.id, ss.display_name AS service_name, j.action AS flow_type,
              j.status, j.status_updated_at AS completed_at, j.created_at
       FROM jobs j
       JOIN streaming_services ss ON ss.id = j.service_id
       WHERE j.user_id = $1
       ORDER BY j.created_at DESC
       LIMIT 10`,
      [userId]
    ),
  ]);

  if (userResult.rows.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...userResult.rows[0],
    recent_jobs: jobsResult.rows,
  });
});
