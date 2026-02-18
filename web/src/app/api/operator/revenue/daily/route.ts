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

  // Get daily revenue from paid/eventual transactions
  const result = await query<{
    date: string;
    sats: string;
    jobs: string;
  }>(
    `SELECT
       created_at::date::text AS date,
       COALESCE(SUM(amount_sats), 0)::bigint AS sats,
       COUNT(*)::int AS jobs
     FROM transactions
     WHERE status IN ('paid', 'eventual')
       AND created_at >= $1::date
     GROUP BY created_at::date
     ORDER BY created_at::date ASC`,
    [startStr]
  );

  // Build a map of date -> { sats, jobs }
  const dataByDate = new Map<string, { sats: number; jobs: number }>();
  for (const row of result.rows) {
    dataByDate.set(row.date, {
      sats: Number(row.sats),
      jobs: Number(row.jobs),
    });
  }

  // Fill in every day in the range
  const output: Array<{
    date: string;
    sats: number;
    cumulative_sats: number;
    jobs: number;
  }> = [];

  let cumulative = 0;
  const current = new Date(startStr);
  const today = new Date(new Date().toISOString().slice(0, 10));

  while (current <= today) {
    const dateStr = current.toISOString().slice(0, 10);
    const entry = dataByDate.get(dateStr) ?? { sats: 0, jobs: 0 };
    cumulative += entry.sats;
    output.push({
      date: dateStr,
      sats: entry.sats,
      cumulative_sats: cumulative,
      jobs: entry.jobs,
    });
    current.setDate(current.getDate() + 1);
  }

  return NextResponse.json(output);
});
