import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";
import crypto from "crypto";

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
    // Retry up to 5 times in case of rare code collision
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = crypto.randomInt(0, 1_000_000_000_000).toString().padStart(12, "0");

      const result = await query(
        `INSERT INTO nostr_otp (npub_hex, code, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '5 minutes')
         ON CONFLICT (npub_hex) DO UPDATE
           SET code = EXCLUDED.code,
               expires_at = EXCLUDED.expires_at,
               created_at = NOW()
         RETURNING code`,
        [npub_hex, code]
      );

      if (result.rows.length > 0) {
        return NextResponse.json({ code: result.rows[0].code });
      }
    }

    return NextResponse.json(
      { error: "Failed to generate OTP" },
      { status: 500 }
    );
  } catch (err) {
    console.error("Agent OTP creation error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
});
