import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";

/**
 * Wrap a route handler to require operator auth.
 * Authenticates via JWT, then checks userId matches OPERATOR_USER_ID env var.
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

    const operatorId = process.env.OPERATOR_USER_ID;
    if (!operatorId || userId !== operatorId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const params = await segmentData.params;
    return handler(req, { userId, params });
  };
}
