import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";
import { getActiveUserCount, getUserCap } from "@/lib/capacity";

export const GET = withOperator(async (_req: NextRequest) => {
  const [waitlistResult, activeUsers] = await Promise.all([
    query<{
      id: string;
      email: string | null;
      nostr_npub: string | null;
      current_services: string[] | null;
      invited: boolean;
      invited_at: string | null;
      created_at: string;
    }>(
      `SELECT id, email, nostr_npub, current_services, invited, invited_at, created_at
       FROM waitlist
       ORDER BY created_at ASC`
    ),
    getActiveUserCount(),
  ]);

  const cap = getUserCap();

  return NextResponse.json({
    entries: waitlistResult.rows,
    capacity: {
      activeUsers,
      cap,
      availableSlots: Math.max(0, cap - activeUsers),
    },
  });
});
