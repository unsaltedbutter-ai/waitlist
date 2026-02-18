import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export const GET = withAuth(async (_req: NextRequest, { userId }) => {
  const [userResult, jobsResult] = await Promise.all([
    query<{ debt_sats: number }>(
      "SELECT debt_sats FROM users WHERE id = $1",
      [userId]
    ),
    query<{
      id: string;
      service_name: string;
      action: string;
      amount_sats: number;
      status_updated_at: string;
    }>(
      `SELECT j.id, ss.display_name AS service_name, j.action, j.amount_sats, j.status_updated_at
       FROM jobs j
       JOIN streaming_services ss ON ss.id = j.service_id
       WHERE j.user_id = $1 AND j.status = 'completed_reneged'
       ORDER BY j.status_updated_at DESC`,
      [userId]
    ),
  ]);

  if (userResult.rows.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({
    debt_sats: userResult.rows[0].debt_sats,
    reneged_jobs: jobsResult.rows,
  });
});
