import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";
import { getRequiredBalance } from "@/lib/margin-call";

export const GET = withAuth(async (_req: NextRequest, { userId }) => {
  // First service in the user's rotation queue
  const nextService = await query<{ service_id: string; display_name: string }>(
    `SELECT rq.service_id, ss.display_name
     FROM rotation_queue rq
     JOIN streaming_services ss ON ss.id = rq.service_id
     WHERE rq.user_id = $1
     ORDER BY rq.position
     LIMIT 1`,
    [userId]
  );

  if (nextService.rows.length === 0) {
    return NextResponse.json({
      platform_fee_sats: 0,
      gift_card_cost_sats: 0,
      total_sats: 0,
      credit_sats: 0,
      shortfall_sats: 0,
      next_service_name: null,
    });
  }

  const { service_id, display_name } = nextService.rows[0];
  const required = await getRequiredBalance(service_id);

  const balanceResult = await query<{ credit_sats: string }>(
    "SELECT COALESCE(credit_sats, 0) AS credit_sats FROM service_credits WHERE user_id = $1",
    [userId]
  );
  const creditSats =
    balanceResult.rows.length > 0
      ? Number(balanceResult.rows[0].credit_sats)
      : 0;

  const shortfall = Math.max(0, required.totalSats - creditSats);

  return NextResponse.json({
    platform_fee_sats: required.platformFeeSats,
    gift_card_cost_sats: required.giftCardCostSats,
    total_sats: required.totalSats,
    credit_sats: creditSats,
    shortfall_sats: shortfall,
    next_service_name: display_name,
  });
});
