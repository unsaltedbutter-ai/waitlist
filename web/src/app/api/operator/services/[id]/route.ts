import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

export const PATCH = withOperator(
  async (req: NextRequest, { params }: { userId: string; params?: Record<string, string> }) => {
    const id = params?.id;
    if (!id) {
      return NextResponse.json({ error: "Missing service id" }, { status: 400 });
    }

    let body: {
      display_name?: string;
      signup_url?: string;
      cancel_url?: string;
      logo_url?: string;
      notes?: string;
      supported?: boolean;
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
    if (body.signup_url !== undefined) {
      sets.push(`signup_url = $${idx++}`);
      values.push(body.signup_url);
    }
    if (body.cancel_url !== undefined) {
      sets.push(`cancel_url = $${idx++}`);
      values.push(body.cancel_url || null);
    }
    if (body.logo_url !== undefined) {
      sets.push(`logo_url = $${idx++}`);
      values.push(body.logo_url || null);
    }
    if (body.notes !== undefined) {
      sets.push(`notes = $${idx++}`);
      values.push(body.notes || null);
    }
    if (body.supported !== undefined) {
      sets.push(`supported = $${idx++}`);
      values.push(body.supported);
    }

    if (sets.length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    sets.push(`updated_at = NOW()`);
    values.push(id);

    const result = await query(
      `UPDATE streaming_services SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 });
    }

    await query(
      `INSERT INTO operator_audit_log (action, target_type, target_id, detail)
       VALUES ($1, $2, $3, $4)`,
      ["update_service", "streaming_service", id, JSON.stringify(body)]
    );

    return NextResponse.json({ service: result.rows[0] });
  }
);
