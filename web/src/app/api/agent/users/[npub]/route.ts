import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";
import { TERMINAL_STATUSES, COMPLETED_STATUSES } from "@/lib/constants";
import { getUserByNpub } from "@/lib/queries";

export const GET = withAgentAuth(async (_req: NextRequest, { params }) => {
  const npub = params?.npub;

  if (!npub) {
    return NextResponse.json({ error: "Missing npub" }, { status: 400 });
  }

  try {
    const user = await getUserByNpub(npub);

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Get user's services (from streaming_credentials joined with streaming_services)
    const servicesResult = await query<{
      service_id: string;
      display_name: string;
    }>(
      `SELECT sc.service_id, ss.display_name
       FROM streaming_credentials sc
       JOIN streaming_services ss ON ss.id = sc.service_id
       WHERE sc.user_id = $1
       ORDER BY sc.service_id`,
      [user.id]
    );

    // Get queue order with service state from latest completed job
    const terminalParams = TERMINAL_STATUSES.map((_, i) => `$${i + 2}`).join(", ");
    const completedPlaceholders = COMPLETED_STATUSES.map(
      (_, i) => `$${TERMINAL_STATUSES.length + 2 + i}`
    ).join(", ");

    const queueResult = await query<{
      service_id: string;
      position: number;
      plan_id: string | null;
      next_billing_date: string | null;
      last_access_end_date: string | null;
      last_completed_action: string | null;
      access_end_date_approximate: boolean | null;
    }>(
      `SELECT rq.service_id, rq.position, rq.plan_id,
              rq.next_billing_date::text AS next_billing_date,
              lj.last_access_end_date, lj.last_completed_action,
              lj.access_end_date_approximate
       FROM rotation_queue rq
       LEFT JOIN LATERAL (
         SELECT j.access_end_date::text AS last_access_end_date,
                j.action AS last_completed_action,
                j.access_end_date_approximate
         FROM jobs j
         WHERE j.user_id = rq.user_id AND j.service_id = rq.service_id
           AND j.status IN (${completedPlaceholders})
         ORDER BY j.created_at DESC
         LIMIT 1
       ) lj ON TRUE
       WHERE rq.user_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM jobs j2
           WHERE j2.user_id = rq.user_id AND j2.service_id = rq.service_id
             AND j2.status NOT IN (${terminalParams})
         )
       ORDER BY rq.position`,
      [user.id, ...TERMINAL_STATUSES, ...COMPLETED_STATUSES]
    );

    // Get active (non-terminal) jobs
    const activeJobPlaceholders = TERMINAL_STATUSES.map((_, i) => `$${i + 2}`).join(", ");
    const activeJobsResult = await query<{
      id: string;
      service_id: string;
      action: string;
      status: string;
      invoice_id: string | null;
      amount_sats: number | null;
    }>(
      `SELECT id, service_id, action, status, invoice_id, amount_sats
       FROM jobs
       WHERE user_id = $1 AND status NOT IN (${activeJobPlaceholders})
       ORDER BY created_at DESC`,
      [user.id, ...TERMINAL_STATUSES]
    );

    return NextResponse.json({
      user: {
        id: user.id,
        nostr_npub: user.nostr_npub,
        debt_sats: user.debt_sats,
        onboarded_at: user.onboarded_at,
        created_at: user.created_at,
      },
      services: servicesResult.rows.map((r) => ({
        service_id: r.service_id,
        display_name: r.display_name,
      })),
      queue: queueResult.rows.map((r) => ({
        service_id: r.service_id,
        position: r.position,
        plan_id: r.plan_id,
        next_billing_date: r.next_billing_date,
        last_access_end_date: r.last_access_end_date,
        last_completed_action: r.last_completed_action,
        access_end_date_approximate: r.access_end_date_approximate,
      })),
      active_jobs: activeJobsResult.rows.map((r) => ({
        id: r.id,
        service_id: r.service_id,
        action: r.action,
        status: r.status,
        invoice_id: r.invoice_id,
        amount_sats: r.amount_sats,
      })),
    });
  } catch (err) {
    console.error("Agent user lookup error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
