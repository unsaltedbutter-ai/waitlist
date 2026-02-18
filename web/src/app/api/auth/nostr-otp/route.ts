import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import {
  loginExistingUser,
  createUserWithInvite,
  lookupInviteByNpub,
} from "@/lib/auth-login";

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

  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { code } = body;

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

  // Existing user: login
  const loginResult = await loginExistingUser(npubHex);
  if (loginResult) {
    return NextResponse.json(loginResult.body, { status: loginResult.status });
  }

  // New user: lookup invite by npub (waitlist row must exist with matching hex)
  const waitlistId = await lookupInviteByNpub(npubHex);

  if (!waitlistId) {
    return NextResponse.json(
      { error: "No invite found for this npub" },
      { status: 403 }
    );
  }

  const result = await createUserWithInvite(npubHex, waitlistId);
  return NextResponse.json(
    { ...result.body, isNew: true },
    { status: result.status }
  );
}
