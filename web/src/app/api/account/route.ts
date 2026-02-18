import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export const GET = withAuth(async (_req: NextRequest, { userId }) => {
  try {
    const result = await query<{
      nostr_npub: string;
      debt_sats: number;
      onboarded_at: string | null;
      created_at: string;
    }>(
      "SELECT nostr_npub, debt_sats, onboarded_at, created_at FROM users WHERE id = $1",
      [userId]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const user = result.rows[0];
    return NextResponse.json({
      nostrNpub: user.nostr_npub,
      debtSats: user.debt_sats,
      onboardedAt: user.onboarded_at,
      createdAt: user.created_at,
    });
  } catch (err) {
    console.error("Account GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});

export const DELETE = withAuth(async (_req: NextRequest, { userId }) => {
  try {
    // Verify user exists and check debt before deleting
    const userResult = await query<{ id: string; debt_sats: number }>(
      "SELECT id, debt_sats FROM users WHERE id = $1",
      [userId]
    );

    if (userResult.rows.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const debtSats = userResult.rows[0].debt_sats;
    if (debtSats > 0) {
      return NextResponse.json(
        {
          error: `Outstanding balance of ${debtSats} sats must be paid before account deletion`,
          debt_sats: debtSats,
        },
        { status: 402 }
      );
    }

    // CASCADE delete: wipes credentials, queue, consents, jobs, transactions, action_logs
    await query("DELETE FROM users WHERE id = $1", [userId]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Account DELETE error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
