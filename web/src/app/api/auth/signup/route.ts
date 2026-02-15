import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { createToken, hashPassword } from "@/lib/auth";
import {
  validateInviteCode,
  consumeInviteCode,
  isAtCapacity,
  getActiveUserCount,
  generateReferralCodes,
} from "@/lib/capacity";

export async function POST(req: NextRequest) {
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

  // Require invite code
  if (!inviteCode) {
    return NextResponse.json(
      { error: "Invite code required" },
      { status: 403 }
    );
  }

  // Validate invite code
  const codeResult = await validateInviteCode(inviteCode);
  if (!codeResult.valid || !codeResult.codeRow) {
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

  const result = await query(
    `INSERT INTO users (email, password_hash, status, membership_type, referred_by_code_id)
     VALUES ($1, $2, 'active', 'monthly', $3)
     RETURNING id`,
    [email.toLowerCase(), passwordHash, codeResult.codeRow.id]
  );

  const userId = result.rows[0].id;

  // Mark code as used
  await consumeInviteCode(codeResult.codeRow.id, userId);

  // Generate referral codes for the new user
  const activeCount = await getActiveUserCount();
  await generateReferralCodes(userId, activeCount);

  const token = await createToken(userId);

  return NextResponse.json({ token, userId }, { status: 201 });
}
