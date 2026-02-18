import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";

export const GET = withAgentAuth(async (_req: NextRequest) => {
  try {
    const result = await query<{
      id: string;
      nostr_npub: string;
      invite_code: string;
    }>(
      `SELECT id, nostr_npub, invite_code
       FROM waitlist
       WHERE invite_dm_pending = TRUE
         AND nostr_npub IS NOT NULL
         AND invite_code IS NOT NULL`
    );

    return NextResponse.json({
      pending: result.rows.map((r) => ({
        id: r.id,
        nostr_npub: r.nostr_npub,
        invite_code: r.invite_code,
      })),
    });
  } catch (err) {
    console.error("Agent pending invites error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
});
