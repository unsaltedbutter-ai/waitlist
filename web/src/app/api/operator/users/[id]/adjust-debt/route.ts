import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

export const POST = withOperator(
  async (req: NextRequest, { params }: { userId: string; params?: Record<string, string> }) => {
    const id = params?.id;
    if (!id) {
      return NextResponse.json({ error: "Missing user id" }, { status: 400 });
    }

    let body: { debt_sats?: number; reason?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { debt_sats, reason } = body;

    if (typeof debt_sats !== "number" || debt_sats < 0 || !Number.isInteger(debt_sats)) {
      return NextResponse.json(
        { error: "debt_sats must be a non-negative integer" },
        { status: 400 }
      );
    }

    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      return NextResponse.json({ error: "reason is required" }, { status: 400 });
    }

    // Verify user exists
    const userResult = await query<{ id: string; debt_sats: number }>(
      "SELECT id, debt_sats FROM users WHERE id = $1",
      [id]
    );

    if (userResult.rows.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const previousDebt = userResult.rows[0].debt_sats;

    // Update debt
    const updateResult = await query<{
      id: string;
      nostr_npub: string;
      debt_sats: number;
      onboarded_at: string | null;
      created_at: string;
    }>(
      `UPDATE users SET debt_sats = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, nostr_npub, debt_sats, onboarded_at, created_at`,
      [debt_sats, id]
    );

    // Write audit log
    await query(
      `INSERT INTO operator_audit_log (action, target_type, target_id, detail)
       VALUES ($1, $2, $3, $4)`,
      [
        "adjust_debt",
        "user",
        id,
        JSON.stringify({ previous_debt_sats: previousDebt, new_debt_sats: debt_sats, reason: reason.trim() }),
      ]
    );

    return NextResponse.json({ user: updateResult.rows[0] });
  }
);
