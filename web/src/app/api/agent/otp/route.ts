import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";
import { npubToHex } from "@/lib/nostr";
import crypto from "crypto";

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

  let npub_hex: string;
  try {
    npub_hex = npubToHex(rawNpub);
  } catch {
    return NextResponse.json({ error: "Invalid npub_hex" }, { status: 400 });
  }

  try {
    // Retry up to 5 times in case of rare hash collision
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = crypto.randomInt(0, 1_000_000_000_000).toString().padStart(12, "0");
      const codeHash = crypto.createHash("sha256").update(code).digest("hex");

      const result = await query(
        `INSERT INTO nostr_otp (npub_hex, code_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '15 minutes')
         ON CONFLICT (npub_hex) DO UPDATE
           SET code_hash = EXCLUDED.code_hash,
               expires_at = EXCLUDED.expires_at,
               created_at = NOW()
         RETURNING npub_hex`,
        [npub_hex, codeHash]
      );

      if (result.rows.length > 0) {
        return NextResponse.json({ code });
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
