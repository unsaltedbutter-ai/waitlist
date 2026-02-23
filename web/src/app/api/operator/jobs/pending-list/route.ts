import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

const NON_TERMINAL_STATUSES = [
  "pending",
  "dispatched",
  "outreach_sent",
  "snoozed",
  "active",
  "awaiting_otp",
];

export const GET = withOperator(async (_req: NextRequest) => {
  const placeholders = NON_TERMINAL_STATUSES.map(
    (_, i) => `$${i + 1}`
  ).join(", ");

  const result = await query<{
    id: string;
    service_id: string;
    action: string;
    trigger: string;
    status: string;
    status_updated_at: string;
    created_at: string;
    nostr_npub: string;
  }>(
    `SELECT j.id, j.service_id, j.action, j.trigger, j.status, j.status_updated_at,
            j.created_at, u.nostr_npub
     FROM jobs j
     JOIN users u ON u.id = j.user_id
     WHERE j.status IN (${placeholders})
     ORDER BY j.created_at ASC`,
    NON_TERMINAL_STATUSES
  );

  return NextResponse.json({ jobs: result.rows });
});
