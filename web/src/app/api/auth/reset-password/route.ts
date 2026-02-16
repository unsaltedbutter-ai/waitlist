import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { query } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

const limiter = createRateLimiter(5, 15 * 60 * 1000); // 5 per 15 min per IP

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!limiter.check(ip).allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429 }
    );
  }

  let body: { token?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { token, password } = body;

  if (!token || !password) {
    return NextResponse.json(
      { error: "Token and password are required" },
      { status: 400 }
    );
  }

  // Validate token format (64 hex chars = 32 bytes)
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return NextResponse.json(
      { error: "Invalid or expired reset link" },
      { status: 400 }
    );
  }

  // Validate password
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

  // Hash the incoming token and look it up
  const tokenBytes = Buffer.from(token, "hex");
  const tokenHash = createHash("sha256").update(tokenBytes).digest();

  const result = await query<{
    id: string;
    user_id: string;
    token_hash: Buffer;
    expires_at: Date;
  }>(
    "SELECT id, user_id, token_hash, expires_at FROM password_reset_tokens WHERE token_hash = $1",
    [tokenHash]
  );

  if (result.rows.length === 0) {
    return NextResponse.json(
      { error: "Invalid or expired reset link" },
      { status: 400 }
    );
  }

  const row = result.rows[0];

  // Constant-time comparison (defense in depth, query already matched by hash)
  if (!timingSafeEqual(Buffer.from(row.token_hash), tokenHash)) {
    return NextResponse.json(
      { error: "Invalid or expired reset link" },
      { status: 400 }
    );
  }

  // Check expiry
  if (new Date(row.expires_at) < new Date()) {
    // Clean up expired token
    await query("DELETE FROM password_reset_tokens WHERE id = $1", [row.id]);
    return NextResponse.json(
      { error: "Invalid or expired reset link" },
      { status: 400 }
    );
  }

  // Update password
  const newHash = await hashPassword(password);
  await query("UPDATE users SET password_hash = $1 WHERE id = $2", [
    newHash,
    row.user_id,
  ]);

  // Delete all tokens for this user (single-use + invalidate any others)
  await query("DELETE FROM password_reset_tokens WHERE user_id = $1", [
    row.user_id,
  ]);

  // Send confirmation email
  const userResult = await query<{ email: string }>(
    "SELECT email FROM users WHERE id = $1",
    [row.user_id]
  );
  if (userResult.rows.length > 0 && userResult.rows[0].email) {
    await sendEmail({
      to: userResult.rows[0].email,
      subject: "Your password was changed",
      text: [
        "Your UnsaltedButter password was just changed.",
        "",
        "If this wasn't you, contact support immediately.",
      ].join("\n"),
    }).catch(() => {
      // Non-critical: don't fail the reset if confirmation email fails
    });
  }

  return NextResponse.json({
    message: "Password reset. Sign in with your new password.",
  });
}
