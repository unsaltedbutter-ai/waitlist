import { NextRequest, NextResponse } from "next/server";
import { query, transaction } from "@/lib/db";
import { createToken, hashPassword } from "@/lib/auth";
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

  let body: { email: string; password: string; inviteCode: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { email, password, inviteCode } = body;

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password required" },
      { status: 400 }
    );
  }

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { error: "Invalid email format" },
      { status: 400 }
    );
  }

  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }

  if (password.length > 128) {
    return NextResponse.json(
      { error: "Password must be 128 characters or fewer" },
      { status: 400 }
    );
  }

  // Require invite code
  if (!inviteCode) {
    return NextResponse.json(
      { error: "Invite code required" },
      { status: 403 }
    );
  }

  // Validate invite code against waitlist (must not already be redeemed)
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

  // Check capacity
  if (await isAtCapacity()) {
    return NextResponse.json(
      { error: "At capacity" },
      { status: 403 }
    );
  }

  // Check for existing user
  const existing = await query("SELECT id FROM users WHERE email = $1", [
    email.toLowerCase(),
  ]);
  if (existing.rows.length > 0) {
    return NextResponse.json(
      { error: "Email already registered" },
      { status: 409 }
    );
  }

  const passwordHash = await hashPassword(password);

  // Create user and redeem invite code in a single transaction
  const userId = await transaction(async (txQuery) => {
    const result = await txQuery<{ id: string }>(
      `INSERT INTO users (email, password_hash, status)
       VALUES ($1, $2, 'auto_paused')
       RETURNING id`,
      [email.toLowerCase(), passwordHash]
    );
    await txQuery(
      "UPDATE waitlist SET redeemed_at = NOW() WHERE invite_code = $1",
      [inviteCode]
    );
    return result.rows[0].id;
  });

  const token = await createToken(userId);

  return NextResponse.json({ token, userId }, { status: 201 });
}
