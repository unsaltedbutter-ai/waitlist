import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export async function GET() {
  const result = await query<{ value: string }>(
    "SELECT value FROM platform_config WHERE key = 'platform_fee_sats'"
  );

  const platformFeeSats = result.rows.length > 0
    ? parseInt(result.rows[0].value, 10)
    : 4400;

  return NextResponse.json({ platform_fee_sats: platformFeeSats });
}
