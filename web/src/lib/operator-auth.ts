import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import { query } from "@/lib/db";

/**
 * Resolve the operator's user ID from the OPERATOR_USER_ID env var.
 * Supports both UUID and email address formats.
 */
let _cachedOperatorId: string | null = null;
let _cachedOperatorSource: string | null = null;

async function resolveOperatorId(): Promise<string | null> {
  const raw = process.env.OPERATOR_USER_ID;
  if (!raw) return null;

  // If it hasn't changed since last resolve, return cached
  if (_cachedOperatorSource === raw && _cachedOperatorId) {
    return _cachedOperatorId;
  }

  // If it looks like an email, look up the user ID
  if (raw.includes("@")) {
    const result = await query<{ id: string }>(
      "SELECT id FROM users WHERE email = $1",
      [raw.toLowerCase()]
    );
    if (result.rows.length === 0) return null;
    _cachedOperatorId = result.rows[0].id;
    _cachedOperatorSource = raw;
    return _cachedOperatorId;
  }

  // Otherwise treat as UUID
  _cachedOperatorId = raw;
  _cachedOperatorSource = raw;
  return raw;
}

/**
 * Wrap a route handler to require operator auth.
 * Authenticates via JWT, then checks userId matches OPERATOR_USER_ID env var.
 * OPERATOR_USER_ID can be a UUID or an email address.
 */
export function withOperator(
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

    const operatorId = await resolveOperatorId();
    if (!operatorId || userId !== operatorId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const params = await segmentData.params;
    return handler(req, { userId, params });
  };
}
