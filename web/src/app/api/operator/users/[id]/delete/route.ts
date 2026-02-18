import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

export const POST = withOperator(
  async (req: NextRequest, { params }: { userId: string; params?: Record<string, string> }) => {
    const id = params?.id;
    if (!id) {
      return NextResponse.json({ error: "Missing user id" }, { status: 400 });
    }

    let body: { reason?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { reason } = body;

    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      return NextResponse.json({ error: "reason is required" }, { status: 400 });
    }

    // Verify user exists and check debt
    const userResult = await query<{ id: string; nostr_npub: string; debt_sats: number }>(
      "SELECT id, nostr_npub, debt_sats FROM users WHERE id = $1",
      [id]
    );

    if (userResult.rows.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const { nostr_npub, debt_sats } = userResult.rows[0];

    if (debt_sats > 0) {
      return NextResponse.json(
        {
          error: `Outstanding balance of ${debt_sats} sats must be paid before account deletion`,
          debt_sats,
        },
        { status: 402 }
      );
    }

    // CASCADE delete: wipes credentials, queue, consents, jobs, transactions, action_logs
    await query("DELETE FROM users WHERE id = $1", [id]);

    // Clean up waitlist row
    await query("DELETE FROM waitlist WHERE nostr_npub = $1", [nostr_npub]);

    // Write audit log (after deletion, so target_id is the now-deleted user)
    await query(
      `INSERT INTO operator_audit_log (action, target_type, target_id, detail)
       VALUES ($1, $2, $3, $4)`,
      [
        "delete_user",
        "user",
        id,
        JSON.stringify({ nostr_npub, reason: reason.trim() }),
      ]
    );

    return NextResponse.json({ ok: true });
  }
);
