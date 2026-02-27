import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { query } from "@/lib/db";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import { npubToHex } from "@/lib/nostr";
import { isAtCapacity, generateInviteCode } from "@/lib/capacity";
import { pushAutoInvite } from "@/lib/nostr-push";

const limiter = createRateLimiter(5, 15 * 60 * 1000); // 5 attempts per 15 minutes

/**
 * Generate a 12-digit OTP, hash it, and upsert into nostr_otp with 15-min expiry.
 * Returns the plaintext code (for sending via push, never in HTTP response).
 */
async function generateOtp(npubHex: string): Promise<string> {
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
      [npubHex, codeHash]
    );

    if (result.rows.length > 0) {
      return code;
    }
  }
  throw new Error("Failed to generate OTP after 5 attempts");
}

/**
 * Upgrade or insert a waitlist entry as invited, generate OTP, push auto_invite.
 * Returns the invite code.
 */
async function autoInvite(npubHex: string, existingId?: string): Promise<string> {
  const inviteCode = generateInviteCode();

  if (existingId) {
    await query(
      `UPDATE waitlist
       SET invited = TRUE, invited_at = NOW(), invite_code = $1, invite_dm_pending = TRUE
       WHERE id = $2`,
      [inviteCode, existingId]
    );
  } else {
    await query(
      `INSERT INTO waitlist (nostr_npub, invited, invited_at, invite_code, invite_dm_pending)
       VALUES ($1, TRUE, NOW(), $2, TRUE)`,
      [npubHex, inviteCode]
    );
  }

  const otpCode = await generateOtp(npubHex);
  await pushAutoInvite(npubHex, otpCode);

  return inviteCode;
}

export async function POST(req: NextRequest) {
  // Rate limit by IP
  const ip = getClientIp(req);
  const { allowed } = limiter.check(ip);

  if (!allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429 }
    );
  }

  let body: {
    nostrNpub: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { nostrNpub } = body;

  if (!nostrNpub) {
    return NextResponse.json(
      { error: "nostrNpub is required" },
      { status: 400 }
    );
  }

  // Validate and normalize npub to hex
  let npubHex: string;
  try {
    npubHex = npubToHex(nostrNpub);
  } catch {
    return NextResponse.json(
      { error: "Invalid npub format" },
      { status: 400 }
    );
  }

  try {
    // Check for existing waitlist entry
    const existing = await query<{
      id: string;
      invited: boolean;
      redeemed_at: string | null;
    }>(
      "SELECT id, invited, redeemed_at FROM waitlist WHERE nostr_npub = $1",
      [npubHex]
    );

    if (existing.rows.length > 0) {
      const entry = existing.rows[0];

      // Already redeemed (has an account)
      if (entry.redeemed_at) {
        return NextResponse.json(
          { error: "You already have an account." },
          { status: 409 }
        );
      }

      // Already invited
      if (entry.invited) {
        return NextResponse.json(
          { error: "You've already been invited. Check your Nostr DMs or DM 'login' to the bot." },
          { status: 409 }
        );
      }

      // Existing but not invited: check capacity
      if (await isAtCapacity()) {
        return NextResponse.json(
          { error: "You're already on the list." },
          { status: 409 }
        );
      }

      // Below capacity: upgrade to invited
      await autoInvite(npubHex, entry.id);
      return NextResponse.json({ autoInvited: true }, { status: 201 });
    }

    // No existing entry
    if (await isAtCapacity()) {
      // At capacity: just add to waitlist
      await query(
        "INSERT INTO waitlist (nostr_npub) VALUES ($1)",
        [npubHex]
      );
      return NextResponse.json({ autoInvited: false }, { status: 201 });
    }

    // Below capacity: auto-invite
    await autoInvite(npubHex);
    return NextResponse.json({ autoInvited: true }, { status: 201 });
  } catch (err) {
    console.error("Waitlist POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
