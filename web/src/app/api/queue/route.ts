import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query, transaction } from "@/lib/db";
import { TERMINAL_STATUSES, COMPLETED_STATUSES } from "@/lib/constants";

export const GET = withAuth(async (_req: NextRequest, { userId }) => {
  try {
    // Build parameterized NOT IN clause for terminal statuses.
    // $1 = userId, $2..$N = terminal statuses
    const terminalParams = TERMINAL_STATUSES.map((_, i) => `$${i + 2}`).join(", ");
    const completedPlaceholders = COMPLETED_STATUSES.map(
      (_, i) => `$${TERMINAL_STATUSES.length + 2 + i}`
    ).join(", ");

    const result = await query(
      `SELECT rq.service_id, ss.display_name AS service_name, rq.position,
              rq.plan_id, sp.display_name AS plan_name, sp.monthly_price_cents AS plan_price_cents,
              aj.active_job_id, aj.active_job_action, aj.active_job_status,
              lj.last_access_end_date, lj.last_completed_action
       FROM rotation_queue rq
       JOIN streaming_services ss ON ss.id = rq.service_id
       LEFT JOIN service_plans sp ON sp.id = rq.plan_id
       LEFT JOIN LATERAL (
         SELECT j.id AS active_job_id, j.action AS active_job_action, j.status AS active_job_status
         FROM jobs j
         WHERE j.user_id = rq.user_id AND j.service_id = rq.service_id
           AND j.status NOT IN (${terminalParams})
         ORDER BY j.created_at DESC
         LIMIT 1
       ) aj ON TRUE
       LEFT JOIN LATERAL (
         SELECT j.access_end_date AS last_access_end_date, j.action AS last_completed_action
         FROM jobs j
         WHERE j.user_id = rq.user_id AND j.service_id = rq.service_id
           AND j.status IN (${completedPlaceholders})
           AND j.access_end_date IS NOT NULL
         ORDER BY j.created_at DESC
         LIMIT 1
       ) lj ON TRUE
       WHERE rq.user_id = $1
       ORDER BY rq.position`,
      [userId, ...TERMINAL_STATUSES, ...COMPLETED_STATUSES]
    );

    return NextResponse.json({ queue: result.rows });
  } catch (err) {
    console.error("Queue GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});

export const PUT = withAuth(async (req: NextRequest, { userId }) => {
  let body: { order: string[]; plans?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { order, plans } = body;
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

  try {
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

    // If no plans provided (dashboard reorder), preserve existing plan_ids
    let planMap: Record<string, string | null> = {};
    if (plans) {
      planMap = plans;
    } else {
      const existing = await query<{ service_id: string; plan_id: string | null }>(
        "SELECT service_id, plan_id FROM rotation_queue WHERE user_id = $1",
        [userId]
      );
      for (const row of existing.rows) {
        if (row.plan_id) {
          planMap[row.service_id] = row.plan_id;
        }
      }
    }

    await transaction(async (txQuery) => {
      await txQuery("DELETE FROM rotation_queue WHERE user_id = $1", [userId]);
      for (let i = 0; i < order.length; i++) {
        const planId = planMap[order[i]] ?? null;
        await txQuery(
          "INSERT INTO rotation_queue (user_id, service_id, position, plan_id) VALUES ($1, $2, $3, $4)",
          [userId, order[i], i + 1, planId]
        );
      }
      // Set onboarded_at on first queue save (completes onboarding)
      await txQuery(
        "UPDATE users SET onboarded_at = NOW(), updated_at = NOW() WHERE id = $1 AND onboarded_at IS NULL",
        [userId]
      );
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Queue PUT error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
