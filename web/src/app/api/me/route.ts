import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export const GET = withAuth(async (_req: NextRequest, { userId }) => {
  const result = await query(
    `SELECT id, email, nostr_npub, status, paused_at, onboarded_at, created_at
     FROM users WHERE id = $1`,
    [userId]
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json(result.rows[0]);
});
