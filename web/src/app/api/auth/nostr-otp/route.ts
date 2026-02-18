import { NextRequest, NextResponse } from "next/server";
import { query, transaction } from "@/lib/db";
import { createToken, needsOnboarding } from "@/lib/auth";
import { isAtCapacity } from "@/lib/capacity";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

const limiter = createRateLimiter(5, 15 * 60 * 1000); // 5 attempts per 15 minutes

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

  let body: { code?: string; inviteCode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { code, inviteCode } = body;

  // Validate code format: 6 digits, optional hyphen, 6 digits
  if (!code || !/^\d{6}-?\d{6}$/.test(code)) {
    return NextResponse.json(
      { error: "Code must be 12 digits (XXXXXX-XXXXXX)" },
      { status: 400 }
    );
  }

  // Strip hyphen for DB lookup
  const rawCode = code.replace("-", "");

  // Cleanup expired OTPs
  await query("DELETE FROM nostr_otp WHERE expires_at < NOW()");

  // Atomic lookup + consume
  const otpResult = await query<{ npub_hex: string }>(
    "DELETE FROM nostr_otp WHERE code = $1 AND expires_at > NOW() RETURNING npub_hex",
    [rawCode]
  );

  if (otpResult.rows.length === 0) {
    return NextResponse.json(
      { error: "Invalid or expired code" },
      { status: 401 }
    );
  }

  const npubHex = otpResult.rows[0].npub_hex;

  // Check if user already exists
  const existing = await query<{ id: string }>(
    "SELECT id FROM users WHERE nostr_npub = $1",
    [npubHex]
  );

  if (existing.rows.length > 0) {
    // Existing user: login
    const userId = existing.rows[0].id;
    await query("UPDATE users SET updated_at = NOW() WHERE id = $1", [userId]);
    const token = await createToken(userId);
    const onboarding = await needsOnboarding(userId);
    return NextResponse.json({ token, userId, ...(onboarding && { needsOnboarding: true }) });
  }

  // New user: check for invite (auto-lookup by npub, fallback to explicit code)
  // Track which waitlist row to redeem
  let waitlistId: string | null = null;

  const inviteCheck = await query<{ id: string }>(
    "SELECT id FROM waitlist WHERE nostr_npub = $1 AND invited = TRUE AND redeemed_at IS NULL",
    [npubHex]
  );

  if (inviteCheck.rows.length > 0) {
    waitlistId = inviteCheck.rows[0].id;
  } else {
    // Fallback: check explicit invite code (e.g. email waitlist entry with separate npub)
    if (!inviteCode) {
      return NextResponse.json(
        { error: "No invite found for this npub" },
        { status: 403 }
      );
    }
    const codeCheck = await query<{ id: string }>(
      "SELECT id FROM waitlist WHERE invite_code = $1 AND invited = TRUE AND redeemed_at IS NULL",
      [inviteCode]
    );
    if (codeCheck.rows.length === 0) {
      return NextResponse.json(
        { error: "Invalid or expired invite code" },
        { status: 403 }
      );
    }
    waitlistId = codeCheck.rows[0].id;
  }

  // Check capacity
  if (await isAtCapacity()) {
    return NextResponse.json({ error: "At capacity" }, { status: 403 });
  }

  // Create user and redeem invite in a single transaction
  const userId = await transaction(async (txQuery) => {
    const result = await txQuery<{ id: string }>(
      `INSERT INTO users (nostr_npub, status)
       VALUES ($1, 'auto_paused')
       RETURNING id`,
      [npubHex]
    );
    await txQuery(
      "UPDATE waitlist SET redeemed_at = NOW() WHERE id = $1",
      [waitlistId]
    );
    return result.rows[0].id;
  });

  const token = await createToken(userId);

  return NextResponse.json({ token, userId, isNew: true }, { status: 201 });
}
