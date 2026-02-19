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
      plan_id: string | null;
      plan_display_name: string | null;
    }>(
      `SELECT j.id, j.user_id, j.service_id, j.action, j.trigger,
              j.billing_date, j.created_at,
              rq.plan_id, sp.display_name AS plan_display_name
       FROM jobs j
       LEFT JOIN rotation_queue rq
         ON rq.user_id = j.user_id AND rq.service_id = j.service_id
       LEFT JOIN service_plans sp ON sp.id = rq.plan_id
       WHERE j.status = 'pending'
       ORDER BY j.created_at ASC`
    );

    return NextResponse.json({ jobs: result.rows });
  } catch (err) {
    console.error("Agent pending jobs error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
