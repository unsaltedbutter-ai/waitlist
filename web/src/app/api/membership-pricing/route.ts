import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { satsToUsdCents } from "@/lib/btc-price";

export async function GET() {
  const result = await query<{
    plan: string;
    period: string;
    price_sats: number;
  }>("SELECT plan, period, price_sats FROM membership_pricing ORDER BY plan, period");

  const pricing = await Promise.all(
    result.rows.map(async (row) => ({
      plan: row.plan,
      period: row.period,
      price_sats: row.price_sats,
      approx_usd_cents: await satsToUsdCents(row.price_sats),
    }))
  );

  return NextResponse.json({ pricing });
}
