import { SignJWT, jwtVerify } from "jose";
import { hash, compare } from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

const BCRYPT_COST = 12;

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not set");
  return new TextEncoder().encode(secret);
}

export async function createToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(getJwtSecret());
}

export async function verifyToken(
  token: string
): Promise<{ userId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (!payload.sub) return null;
    return { userId: payload.sub };
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, BCRYPT_COST);
}

export async function verifyPassword(
  password: string,
  hashed: string
): Promise<boolean> {
  return compare(password, hashed);
}

/** True if user has never completed a membership payment (hasn't finished onboarding). */
export async function needsOnboarding(userId: string): Promise<boolean> {
  const result = await query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM membership_payments WHERE user_id = $1 AND status = 'paid'",
    [userId]
  );
  return result.rows[0].count === "0";
}

/** Extract userId from Authorization header. Returns null if invalid. */
export async function authenticateRequest(
  req: NextRequest
): Promise<string | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const result = await verifyToken(token);
  return result?.userId ?? null;
}

/** Wrap a route handler to require auth. Injects userId into the handler. */
export function withAuth(
  handler: (
    req: NextRequest,
    ctx: { userId: string; params?: Record<string, string> }
  ) => Promise<NextResponse>
) {
  return async (
    req: NextRequest,
    segmentData: { params: Promise<Record<string, string>> }
  ) => {
    const userId = await authenticateRequest(req);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const params = await segmentData.params;
    return handler(req, { userId, params });
  };
}
