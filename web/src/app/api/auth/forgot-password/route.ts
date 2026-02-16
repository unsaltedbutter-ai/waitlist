import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { query } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

const ipLimiter = createRateLimiter(3, 15 * 60 * 1000); // 3 per 15 min per IP
const emailLimiter = createRateLimiter(1, 5 * 60 * 1000); // 1 per 5 min per email

const GENERIC_MESSAGE =
  "If an account with that email exists, a reset link has been sent.";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://unsaltedbutter.ai";

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!ipLimiter.check(ip).allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429 }
    );
  }

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  // Rate limit per email (checked after validation, before DB work)
  if (!emailLimiter.check(email).allowed) {
    // Still return generic message to prevent enumeration
    return NextResponse.json({ message: GENERIC_MESSAGE });
  }

  // Look up user (email auth only, must have a password_hash)
  const result = await query<{ id: string }>(
    "SELECT id FROM users WHERE email = $1 AND password_hash IS NOT NULL",
    [email]
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ message: GENERIC_MESSAGE });
  }

  const userId = result.rows[0].id;

  // Delete any existing tokens for this user
  await query("DELETE FROM password_reset_tokens WHERE user_id = $1", [userId]);

  // Generate token: 32 random bytes, hex-encoded
  const tokenBytes = randomBytes(32);
  const tokenHex = tokenBytes.toString("hex");
  const tokenHash = createHash("sha256").update(tokenBytes).digest();

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await query(
    "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, tokenHash, expiresAt.toISOString()]
  );

  const resetLink = `${BASE_URL}/reset-password?token=${tokenHex}`;

  await sendEmail({
    to: email,
    subject: "Reset your password",
    text: [
      "You requested a password reset for your UnsaltedButter account.",
      "",
      `Reset your password: ${resetLink}`,
      "",
      "This link expires in 1 hour.",
      "",
      "If you didn't request this, ignore this email.",
    ].join("\n"),
  });

  return NextResponse.json({ message: GENERIC_MESSAGE });
}
