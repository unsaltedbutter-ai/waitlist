import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export async function GET() {
  try {
    const res = await query(
      "SELECT value FROM operator_settings WHERE key = 'action_price_sats'"
    );
    const raw = res.rows[0]?.value;
    const parsed = Number(raw);
    return NextResponse.json({
      action_price_sats: Number.isFinite(parsed) && parsed > 0 ? parsed : 3000,
    });
  } catch {
    return NextResponse.json({ action_price_sats: 3000 });
  }
}
