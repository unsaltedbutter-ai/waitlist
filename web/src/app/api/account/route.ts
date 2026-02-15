import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { transaction } from "@/lib/db";

export const DELETE = withAuth(async (_req: NextRequest, { userId }) => {
  await transaction(async (txQuery) => {
    // 1. Snapshot user contact info
    const userResult = await txQuery<{
      email: string | null;
      nostr_npub: string | null;
    }>("SELECT email, nostr_npub FROM users WHERE id = $1", [userId]);

    if (userResult.rows.length === 0) {
      throw new Error("User not found");
    }

    const { email, nostr_npub } = userResult.rows[0];
    const contact = email ?? nostr_npub;

    if (!contact) {
      throw new Error("No contact info found");
    }

    // 2. Snapshot credit balance
    const creditResult = await txQuery<{ credit_sats: string }>(
      "SELECT credit_sats FROM service_credits WHERE user_id = $1",
      [userId]
    );

    const amountSats =
      creditResult.rows.length > 0
        ? parseInt(creditResult.rows[0].credit_sats, 10)
        : 0;

    // 3. Create refund record (even if 0 sats — operator should know someone left)
    await txQuery(
      "INSERT INTO pending_refunds (contact, amount_sats) VALUES ($1, $2)",
      [contact, amountSats]
    );

    // 4. CASCADE delete user — wipes credentials, queue, subscriptions,
    //    consents, credits, transactions, prepayments, jobs, action_logs,
    //    referral_codes, zap_receipts
    await txQuery("DELETE FROM users WHERE id = $1", [userId]);
  });

  return NextResponse.json({ ok: true });
});
