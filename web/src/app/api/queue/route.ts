import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query, transaction } from "@/lib/db";

export const GET = withAuth(async (_req: NextRequest, { userId }) => {
  const result = await query(
    `SELECT rq.service_id, ss.display_name AS service_name, rq.position,
            s.status AS subscription_status, s.subscription_end_date
     FROM rotation_queue rq
     JOIN streaming_services ss ON ss.id = rq.service_id
     LEFT JOIN subscriptions s ON s.user_id = rq.user_id AND s.service_id = rq.service_id
       AND s.status IN ('active', 'signup_scheduled', 'cancel_scheduled')
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

  // Validate all service IDs exist in streaming_services
  const services = await query<{ id: string }>(
    "SELECT id FROM streaming_services WHERE id = ANY($1)",
    [order]
  );
  const validIds = new Set(services.rows.map((r) => r.id));
  const unknowns = order.filter((id) => !validIds.has(id));
  if (unknowns.length > 0) {
    return NextResponse.json(
      { error: `Unknown services: ${unknowns.join(", ")}` },
      { status: 400 }
    );
  }

  // Validate credentials exist for every service in the order
  const creds = await query<{ service_id: string }>(
    "SELECT service_id FROM streaming_credentials WHERE user_id = $1",
    [userId]
  );
  const credIds = new Set(creds.rows.map((r) => r.service_id));
  const noCreds = order.filter((id) => !credIds.has(id));
  if (noCreds.length > 0) {
    return NextResponse.json(
      { error: `No credentials for: ${noCreds.join(", ")}` },
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
