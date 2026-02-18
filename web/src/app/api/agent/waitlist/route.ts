import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";

export const POST = withAgentAuth(async (_req: NextRequest, { body }) => {
  let parsed: { npub_hex?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { npub_hex } = parsed;
  if (!npub_hex || typeof npub_hex !== "string") {
    return NextResponse.json({ error: "Missing npub_hex" }, { status: 400 });
  }

  try {
    const existing = await query<{ invited: boolean; invite_code: string | null }>(
      "SELECT invited, invite_code FROM waitlist WHERE nostr_npub = $1",
      [npub_hex]
    );

    if (existing.rows.length === 0) {
      await query("INSERT INTO waitlist (nostr_npub) VALUES ($1)", [npub_hex]);
      return NextResponse.json({ status: "added", invite_code: null });
    }

    const row = existing.rows[0];
    if (row.invited) {
      return NextResponse.json({
        status: "already_invited",
        invite_code: row.invite_code,
      });
    }

    return NextResponse.json({ status: "already_waitlisted", invite_code: null });
  } catch (err) {
    console.error("Agent waitlist error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
});
