import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";
import { getRequiredBalance } from "@/lib/margin-call";
import { notifyOrchestrator } from "@/lib/orchestrator-notify";

export const POST = withAuth(async (_req: NextRequest, { userId }) => {
  const userResult = await query<{ status: string; onboarded_at: string | null }>(
    "SELECT status, onboarded_at FROM users WHERE id = $1",
    [userId]
  );

  if (userResult.rows.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { status, onboarded_at } = userResult.rows[0];

  if (status !== "paused" && status !== "auto_paused") {
    return NextResponse.json(
      { error: "Can only unpause from paused or auto_paused state" },
      { status: 409 }
    );
  }

  if (status === "auto_paused" && !onboarded_at) {
    return NextResponse.json(
      { error: "Complete onboarding first" },
      { status: 409 }
    );
  }

  // Get next service from rotation queue
  const nextService = await query<{ service_id: string }>(
    "SELECT service_id FROM rotation_queue WHERE user_id = $1 ORDER BY position LIMIT 1",
    [userId]
  );

  if (nextService.rows.length === 0) {
    return NextResponse.json(
      { error: "No services in your rotation queue" },
      { status: 400 }
    );
  }

  // Check balance against requirements
  const required = await getRequiredBalance(nextService.rows[0].service_id);

  const balanceResult = await query<{ credit_sats: string }>(
    "SELECT COALESCE(credit_sats, 0) AS credit_sats FROM service_credits WHERE user_id = $1",
    [userId]
  );
  const creditSats = balanceResult.rows.length > 0
    ? Number(balanceResult.rows[0].credit_sats)
    : 0;

  if (creditSats < required.totalSats) {
    // Insufficient balance: set to auto_paused
    await query(
      "UPDATE users SET status = 'auto_paused', updated_at = NOW() WHERE id = $1",
      [userId]
    );

    return NextResponse.json(
      {
        shortfall_sats: required.totalSats - creditSats,
        platform_fee_sats: required.platformFeeSats,
        gift_card_cost_sats: required.giftCardCostSats,
      },
      { status: 402 }
    );
  }

  // Sufficient balance: activate
  await query(
    "UPDATE users SET status = 'active', paused_at = NULL, updated_at = NOW() WHERE id = $1",
    [userId]
  );

  // Check if user has no current active subscription, then notify orchestrator
  const activeSub = await query(
    "SELECT id FROM subscriptions WHERE user_id = $1 AND status IN ('active', 'signup_scheduled', 'lapsing') LIMIT 1",
    [userId]
  );

  if (activeSub.rows.length === 0) {
    await notifyOrchestrator(userId);
  }

  return NextResponse.json({ ok: true });
});
