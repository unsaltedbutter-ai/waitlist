import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";

export const GET = withAgentAuth(async (_req: NextRequest) => {
  try {
    const result = await query<{
      id: string;
      user_id: string;
      service_id: string;
      action: string;
      trigger: string;
      billing_date: string | null;
      created_at: string;
    }>(
      `SELECT id, user_id, service_id, action, trigger, billing_date, created_at
       FROM jobs
       WHERE status = 'pending'
       ORDER BY created_at ASC`
    );

    return NextResponse.json({ jobs: result.rows });
  } catch (err) {
    console.error("Agent pending jobs error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
