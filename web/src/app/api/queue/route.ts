import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query, transaction } from "@/lib/db";

export const GET = withAuth(async (_req: NextRequest, { userId }) => {
  const result = await query(
    `SELECT rq.service_id, ss.display_name AS service_name, rq.position, rq.never_rotate,
            s.status AS subscription_status, s.estimated_lapse_at
     FROM rotation_queue rq
     JOIN streaming_services ss ON ss.id = rq.service_id
     LEFT JOIN subscriptions s ON s.user_id = rq.user_id AND s.service_id = rq.service_id
       AND s.status IN ('active', 'signup_scheduled', 'lapsing')
     WHERE rq.user_id = $1
     ORDER BY rq.position`,
    [userId]
  );

  return NextResponse.json({ queue: result.rows });
});

export const PUT = withAuth(async (req: NextRequest, { userId }) => {
  let body: { order: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { order } = body;
  if (!Array.isArray(order) || order.length === 0) {
    return NextResponse.json(
      { error: "order must be a non-empty array of serviceIds" },
      { status: 400 }
    );
  }

  // Check for duplicates
  if (new Set(order).size !== order.length) {
    return NextResponse.json(
      { error: "Duplicate serviceIds in order" },
      { status: 400 }
    );
  }

  // Verify all serviceIds belong to this user's queue
  const existing = await query(
    "SELECT service_id FROM rotation_queue WHERE user_id = $1",
    [userId]
  );
  const existingIds = new Set(existing.rows.map((r) => r.service_id));

  for (const id of order) {
    if (!existingIds.has(id)) {
      return NextResponse.json(
        { error: `Service ${id} not in your queue` },
        { status: 400 }
      );
    }
  }
  if (order.length !== existingIds.size) {
    return NextResponse.json(
      { error: "Order must include all services in queue" },
      { status: 400 }
    );
  }

  await transaction(async (txQuery) => {
    await txQuery("DELETE FROM rotation_queue WHERE user_id = $1", [userId]);
    for (let i = 0; i < order.length; i++) {
      await txQuery(
        "INSERT INTO rotation_queue (user_id, service_id, position) VALUES ($1, $2, $3)",
        [userId, order[i], i + 1]
      );
    }
  });

  return NextResponse.json({ success: true });
});
