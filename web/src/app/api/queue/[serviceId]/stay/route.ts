import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export const POST = withAuth(async (_req: NextRequest, { userId, params }) => {
  const serviceId = params?.serviceId;
  if (!serviceId) {
    return NextResponse.json({ error: "Missing serviceId" }, { status: 400 });
  }

  // Verify user has this service in queue with an active or lapsing subscription
  const sub = await query(
    `SELECT s.id FROM subscriptions s
     WHERE s.user_id = $1 AND s.service_id = $2 AND s.status IN ('active', 'lapsing')`,
    [userId, serviceId]
  );

  if (sub.rows.length === 0) {
    return NextResponse.json(
      { error: "No active subscription for this service" },
      { status: 404 }
    );
  }

  // Set extend_current flag — scheduler will buy another gift card instead of advancing queue
  const result = await query(
    `UPDATE rotation_queue
     SET extend_current = TRUE
     WHERE user_id = $1 AND service_id = $2
     RETURNING id, extend_current`,
    [userId, serviceId]
  );

  if (result.rows.length === 0) {
    return NextResponse.json(
      { error: "Service not in your queue" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true, extendCurrent: true });
});
