import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { createToken, needsOnboarding, verifyPassword } from "@/lib/auth";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

const limiter = createRateLimiter(10, 15 * 60 * 1000); // 10 attempts per 15 minutes

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

  let body: { email: string; password: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { email, password } = body;

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password required" },
      { status: 400 }
    );
  }

  if (password.length > 128) {
    return NextResponse.json(
      { error: "Password must be 128 characters or fewer" },
      { status: 400 }
    );
  }

  const result = await query(
    "SELECT id, password_hash FROM users WHERE email = $1",
    [email.toLowerCase()]
  );

  if (result.rows.length === 0) {
    return NextResponse.json(
      { error: "Invalid credentials" },
      { status: 401 }
    );
  }

  const user = result.rows[0];

  if (!user.password_hash) {
    return NextResponse.json(
      { error: "This account uses Nostr login" },
      { status: 400 }
    );
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return NextResponse.json(
      { error: "Invalid credentials" },
      { status: 401 }
    );
  }

  const token = await createToken(user.id);
  const onboarding = await needsOnboarding(user.id);

  return NextResponse.json({ token, userId: user.id, ...(onboarding && { needsOnboarding: true }) });
}
