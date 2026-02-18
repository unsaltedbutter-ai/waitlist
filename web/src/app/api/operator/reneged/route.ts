import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

interface RenegedRow {
  email_hash: string;
  total_debt_sats: number;
  created_at: string;
}

export const GET = withOperator(async (_req: NextRequest) => {
  try {
    const result = await query<RenegedRow>(
      `SELECT email_hash, total_debt_sats, created_at
       FROM reneged_emails
       ORDER BY created_at DESC`
    );

    return NextResponse.json({ entries: result.rows });
  } catch (err) {
    console.error("Reneged list fetch error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
});
