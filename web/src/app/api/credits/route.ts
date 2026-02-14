import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";
import { satsToUsdCents } from "@/lib/btc-price";

export const GET = withAuth(async (_req: NextRequest, { userId }) => {
  // Get or create credit record
  const credits = await query(
    `INSERT INTO service_credits (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
     RETURNING credit_sats`,
    [userId]
  );

  const creditSats = Number(credits.rows[0].credit_sats);
  const creditUsdCents = await satsToUsdCents(creditSats);

  const txns = await query(
    `SELECT id, type, amount_sats, balance_after_sats, description, created_at
     FROM credit_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [userId]
  );

  return NextResponse.json({
    credit_sats: creditSats,
    credit_usd_cents: creditUsdCents,
    recent_transactions: txns.rows,
  });
});
