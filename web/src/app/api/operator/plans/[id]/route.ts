import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

export const PATCH = withOperator(
  async (req: NextRequest, { params }: { userId: string; params?: Record<string, string> }) => {
    const id = params?.id;
    if (!id) {
      return NextResponse.json({ error: "Missing plan id" }, { status: 400 });
    }

    let body: {
      display_name?: string;
      monthly_price_cents?: number;
      has_ads?: boolean;
      is_bundle?: boolean;
      bundle_services?: string[];
      display_order?: number;
      active?: boolean;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Build dynamic SET clause
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (body.display_name !== undefined) {
      sets.push(`display_name = $${idx++}`);
      values.push(body.display_name);
    }
    if (body.monthly_price_cents !== undefined) {
      if (typeof body.monthly_price_cents !== "number" || !Number.isInteger(body.monthly_price_cents) || body.monthly_price_cents < 0) {
        return NextResponse.json({ error: "monthly_price_cents must be a non-negative integer" }, { status: 400 });
      }
      sets.push(`monthly_price_cents = $${idx++}`);
      values.push(body.monthly_price_cents);
    }
    if (body.has_ads !== undefined) {
      sets.push(`has_ads = $${idx++}`);
      values.push(body.has_ads);
    }
    if (body.is_bundle !== undefined) {
      sets.push(`is_bundle = $${idx++}`);
      values.push(body.is_bundle);
    }
    if (body.bundle_services !== undefined) {
      sets.push(`bundle_services = $${idx++}`);
      values.push(body.bundle_services);
    }
    if (body.display_order !== undefined) {
      sets.push(`display_order = $${idx++}`);
      values.push(body.display_order);
    }
    if (body.active !== undefined) {
      sets.push(`active = $${idx++}`);
      values.push(body.active);
    }

    if (sets.length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    values.push(id);

    const result = await query(
      `UPDATE service_plans SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    await query(
      `INSERT INTO operator_audit_log (action, target_type, target_id, detail)
       VALUES ($1, $2, $3, $4)`,
      ["update_plan", "service_plan", id, JSON.stringify(body)]
    );

    return NextResponse.json({ plan: result.rows[0] });
  }
);
