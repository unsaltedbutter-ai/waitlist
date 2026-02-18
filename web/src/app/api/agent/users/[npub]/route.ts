import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";
import { TERMINAL_STATUSES } from "@/lib/constants";
import { getUserByNpub } from "@/lib/queries";

export const GET = withAgentAuth(async (_req: NextRequest, { params }) => {
  const npub = params?.npub;

  if (!npub) {
    return NextResponse.json({ error: "Missing npub" }, { status: 400 });
  }

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

  // Get queue order
  const queueResult = await query<{
    service_id: string;
    position: number;
    plan_id: string | null;
  }>(
    `SELECT service_id, position, plan_id
     FROM rotation_queue
     WHERE user_id = $1
     ORDER BY position`,
    [user.id]
  );

  // Get active (non-terminal) jobs
  const placeholders = TERMINAL_STATUSES.map((_, i) => `$${i + 2}`).join(", ");
  const activeJobsResult = await query<{
    id: string;
    service_id: string;
    action: string;
    status: string;
  }>(
    `SELECT id, service_id, action, status
     FROM jobs
     WHERE user_id = $1 AND status NOT IN (${placeholders})
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
    })),
    active_jobs: activeJobsResult.rows.map((r) => ({
      id: r.id,
      service_id: r.service_id,
      action: r.action,
      status: r.status,
    })),
  });
});
