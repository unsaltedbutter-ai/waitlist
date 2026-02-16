import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { createToken } from "@/lib/auth";
import { isAtCapacity } from "@/lib/capacity";

// In-memory rate limiter: IP -> { count, resetAt }
const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// Periodic cleanup of stale rate limit entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetAt) {
      rateLimits.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref?.();

export async function POST(req: NextRequest) {
  // Rate limit by IP
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Too many attempts. Wait a few minutes." },
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
    return NextResponse.json({ token, userId });
  }

  // New user: require invite code
  if (!inviteCode) {
    return NextResponse.json(
      { error: "Invite code required" },
      { status: 403 }
    );
  }

  // Validate invite code
  const codeCheck = await query<{ id: string }>(
    "SELECT id FROM waitlist WHERE invite_code = $1 AND invited = TRUE",
    [inviteCode]
  );
  if (codeCheck.rows.length === 0) {
    return NextResponse.json(
      { error: "Invalid or expired invite code" },
      { status: 403 }
    );
  }

  // Check capacity
  if (await isAtCapacity()) {
    return NextResponse.json({ error: "At capacity" }, { status: 403 });
  }

  // Create new user
  const result = await query<{ id: string }>(
    `INSERT INTO users (nostr_npub, status, membership_plan, billing_period)
     VALUES ($1, 'active', 'solo', 'monthly')
     RETURNING id`,
    [npubHex]
  );

  const userId = result.rows[0].id;
  const token = await createToken(userId);

  return NextResponse.json({ token, userId, isNew: true }, { status: 201 });
}
