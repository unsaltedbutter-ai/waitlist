import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export const POST = withAuth(async (_req: NextRequest, { userId }) => {
  const userResult = await query<{ status: string }>(
    "SELECT status FROM users WHERE id = $1",
    [userId]
  );

  if (userResult.rows.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { status } = userResult.rows[0];

  if (status !== "active" && status !== "auto_paused") {
    return NextResponse.json(
      { error: "Can only pause from active or auto_paused state" },
      { status: 409 }
    );
  }

  await query(
    "UPDATE users SET status = 'paused', paused_at = NOW(), updated_at = NOW() WHERE id = $1",
    [userId]
  );

  return NextResponse.json({ ok: true });
});
