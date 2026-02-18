import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

export const GET = withOperator(async (_req: NextRequest) => {
  const result = await query<{
    month: string;
    platform_fee_revenue: string;
    credit_deposits: string;
    gift_card_purchases: string;
    refunds: string;
  }>(`
    SELECT
      to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
      COALESCE(SUM(amount_sats) FILTER (WHERE type = 'platform_fee'), 0)::bigint AS platform_fee_revenue,
      COALESCE(SUM(amount_sats) FILTER (WHERE type IN ('prepayment', 'zap_topup')), 0)::bigint AS credit_deposits,
      COALESCE(SUM(ABS(amount_sats)) FILTER (WHERE type = 'gift_card_purchase'), 0)::bigint AS gift_card_purchases,
      COALESCE(SUM(ABS(amount_sats)) FILTER (WHERE type = 'refund'), 0)::bigint AS refunds
    FROM credit_transactions
    GROUP BY date_trunc('month', created_at)
    ORDER BY date_trunc('month', created_at) DESC
  `);

  const months = result.rows.map((r) => {
    const platform_fee_revenue = Number(r.platform_fee_revenue);
    const credit_deposits = Number(r.credit_deposits);
    const gift_card_purchases = Number(r.gift_card_purchases);
    const refunds = Number(r.refunds);
    return {
      month: r.month,
      platform_fee_revenue,
      credit_deposits,
      gift_card_purchases,
      refunds,
      net_flow: platform_fee_revenue + credit_deposits - gift_card_purchases - refunds,
    };
  });

  return NextResponse.json({ months });
});
