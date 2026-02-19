import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export const GET = withOperator(async () => {
  const result = await query(
    `SELECT sp.*, ss.display_name AS service_display_name
     FROM service_plans sp
     JOIN streaming_services ss ON ss.id = sp.service_id
     ORDER BY sp.service_id, sp.display_order`
  );

  return NextResponse.json({ plans: result.rows });
});

export const POST = withOperator(async (req: NextRequest) => {
  let body: {
    service_id?: string;
    display_name?: string;
    monthly_price_cents?: number;
    has_ads?: boolean;
    is_bundle?: boolean;
    bundle_services?: string[];
    display_order?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { service_id, display_name, monthly_price_cents, has_ads, is_bundle, bundle_services, display_order } = body;

  if (!service_id || typeof service_id !== "string") {
    return NextResponse.json({ error: "service_id is required" }, { status: 400 });
  }

  if (!display_name || typeof display_name !== "string" || !display_name.trim()) {
    return NextResponse.json({ error: "display_name is required" }, { status: 400 });
  }

  if (typeof monthly_price_cents !== "number" || !Number.isInteger(monthly_price_cents) || monthly_price_cents < 0) {
    return NextResponse.json({ error: "monthly_price_cents must be a non-negative integer" }, { status: 400 });
  }

  // Verify service exists
  const serviceCheck = await query("SELECT id FROM streaming_services WHERE id = $1", [service_id]);
  if (serviceCheck.rows.length === 0) {
    return NextResponse.json({ error: "service_id does not exist" }, { status: 400 });
  }

  const id = service_id + "_" + slugify(display_name);

  // Check for duplicate
  const existing = await query("SELECT id FROM service_plans WHERE id = $1", [id]);
  if (existing.rows.length > 0) {
    return NextResponse.json({ error: "Plan already exists with this id" }, { status: 409 });
  }

  const result = await query(
    `INSERT INTO service_plans (id, service_id, display_name, monthly_price_cents, has_ads, is_bundle, bundle_services, display_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      service_id,
      display_name.trim(),
      monthly_price_cents,
      has_ads ?? false,
      is_bundle ?? false,
      bundle_services ?? null,
      display_order ?? 0,
    ]
  );

  await query(
    `INSERT INTO operator_audit_log (action, target_type, target_id, detail)
     VALUES ($1, $2, $3, $4)`,
    ["create_plan", "service_plan", id, JSON.stringify({ service_id, display_name: display_name.trim() })]
  );

  return NextResponse.json({ plan: result.rows[0] }, { status: 201 });
});
