import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";
import { npubToHex } from "@/lib/nostr";
import { generateInviteCode, isAtCapacity } from "@/lib/capacity";

export const POST = withAgentAuth(async (_req: NextRequest, { body }) => {
  let parsed: { npub_hex?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { npub_hex: rawNpub } = parsed;
  if (!rawNpub || typeof rawNpub !== "string") {
    return NextResponse.json({ error: "Missing npub_hex" }, { status: 400 });
  }

  let npubHex: string;
  try {
    npubHex = npubToHex(rawNpub);
  } catch {
    return NextResponse.json({ error: "Invalid npub_hex" }, { status: 400 });
  }

  try {
    // Check if already in waitlist
    const existing = await query<{
      id: string;
      invited: boolean;
      invite_code: string | null;
    }>(
      "SELECT id, invited, invite_code FROM waitlist WHERE nostr_npub = $1",
      [npubHex]
    );

    // Already invited: return existing invite
    if (existing.rows.length > 0 && existing.rows[0].invited) {
      return NextResponse.json({
        status: "already_invited",
        invite_code: existing.rows[0].invite_code,
      });
    }

    // Check capacity before granting a new invite
    if (await isAtCapacity()) {
      // At capacity: just add to waitlist if not already there
      if (existing.rows.length === 0) {
        await query("INSERT INTO waitlist (nostr_npub) VALUES ($1)", [npubHex]);
      }
      return NextResponse.json({ status: "at_capacity", invite_code: null });
    }

    const code = generateInviteCode();

    if (existing.rows.length === 0) {
      // New: insert with invite already granted
      await query(
        `INSERT INTO waitlist (nostr_npub, invited, invited_at, invite_code)
         VALUES ($1, TRUE, NOW(), $2)`,
        [npubHex, code]
      );
    } else {
      // Existing waitlist entry: upgrade to invited
      await query(
        `UPDATE waitlist
         SET invited = TRUE, invited_at = NOW(), invite_code = $1
         WHERE nostr_npub = $2`,
        [code, npubHex]
      );
    }

    return NextResponse.json({ status: "invited", invite_code: code });
  } catch (err) {
    console.error("Agent auto-invite error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
});
