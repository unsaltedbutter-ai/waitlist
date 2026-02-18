import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;

export const GET = withOperator(async (req: NextRequest) => {
  const url = new URL(req.url);
  const daysParam = url.searchParams.get("days");

  let days = DEFAULT_DAYS;
  if (daysParam !== null) {
    days = Number(daysParam);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return NextResponse.json(
        { error: `Invalid days. Must be an integer between 1 and ${MAX_DAYS}` },
        { status: 400 }
      );
    }
  }

  const startDate = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000
  );
  const startStr = startDate.toISOString().slice(0, 10);

  // Get daily revenue from the append-only ledger (survives user deletion)
  const result = await query<{
    date: string;
    total_sats: string;
    job_count: string;
    paid_sats: string;
    eventual_sats: string;
  }>(
    `SELECT
       DATE(recorded_at)::text AS date,
       COALESCE(SUM(amount_sats), 0)::bigint AS total_sats,
       COUNT(*)::int AS job_count,
       COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN amount_sats ELSE 0 END), 0)::bigint AS paid_sats,
       COALESCE(SUM(CASE WHEN payment_status = 'eventual' THEN amount_sats ELSE 0 END), 0)::bigint AS eventual_sats
     FROM revenue_ledger
     WHERE recorded_at >= $1::date
     GROUP BY DATE(recorded_at)
     ORDER BY DATE(recorded_at) ASC`,
    [startStr]
  );

  // Build a map of date -> daily data
  const dataByDate = new Map<string, {
    sats: number;
    jobs: number;
    paid_sats: number;
    eventual_sats: number;
  }>();
  for (const row of result.rows) {
    dataByDate.set(row.date, {
      sats: Number(row.total_sats),
      jobs: Number(row.job_count),
      paid_sats: Number(row.paid_sats),
      eventual_sats: Number(row.eventual_sats),
    });
  }

  // Fill in every day in the range
  const output: Array<{
    date: string;
    sats: number;
    cumulative_sats: number;
    jobs: number;
    paid_sats: number;
    eventual_sats: number;
  }> = [];

  let cumulative = 0;
  const current = new Date(startStr);
  const today = new Date(new Date().toISOString().slice(0, 10));

  while (current <= today) {
    const dateStr = current.toISOString().slice(0, 10);
    const entry = dataByDate.get(dateStr) ?? { sats: 0, jobs: 0, paid_sats: 0, eventual_sats: 0 };
    cumulative += entry.sats;
    output.push({
      date: dateStr,
      sats: entry.sats,
      cumulative_sats: cumulative,
      jobs: entry.jobs,
      paid_sats: entry.paid_sats,
      eventual_sats: entry.eventual_sats,
    });
    current.setDate(current.getDate() + 1);
  }

  return NextResponse.json(output);
});
