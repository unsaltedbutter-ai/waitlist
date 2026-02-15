import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export const POST = withAuth(async (_req: NextRequest, { userId, params }) => {
  const serviceId = params?.serviceId;
  if (!serviceId) {
    return NextResponse.json({ error: "Missing serviceId" }, { status: 400 });
  }

  // Verify user has this service with an active or cancel_scheduled subscription
  const sub = await query(
    `SELECT s.id FROM subscriptions s
     WHERE s.user_id = $1 AND s.service_id = $2 AND s.status IN ('active', 'cancel_scheduled')`,
    [userId, serviceId]
  );

  if (sub.rows.length === 0) {
    return NextResponse.json(
      { error: "No active subscription for this service" },
      { status: 404 }
    );
  }

  // "Stay" means: buy another gift card for the current service instead of advancing.
  // This is handled by the orchestrator at lock-in time.
  // For now, we record the intent by keeping the service at its current queue position
  // and the orchestrator will purchase a gift card for the same service.
  // TODO: Implement stay logic with rotation_slots once orchestrator is built.

  return NextResponse.json({ success: true });
});
