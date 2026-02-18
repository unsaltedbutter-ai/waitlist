import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";

/**
 * Resolve the operator's user ID from the OPERATOR_USER_ID env var.
 * Must be a UUID (Nostr-only auth, no email column in schema).
 */
function resolveOperatorId(): string | null {
  return process.env.OPERATOR_USER_ID ?? null;
}

/**
 * Wrap a route handler to require operator auth.
 * Authenticates via JWT, then checks userId matches OPERATOR_USER_ID env var.
 * OPERATOR_USER_ID must be a UUID.
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

    const operatorId = resolveOperatorId();
    if (!operatorId || userId !== operatorId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const params = await segmentData.params;
    return handler(req, { userId, params });
  };
}
