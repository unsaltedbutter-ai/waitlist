import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";
import { toCsv } from "@/lib/csv";

const DEFAULT_DAYS = 90;
const MAX_DAYS = 3650; // ~10 years, generous for tax exports

const HEADERS = [
  "date",
  "job_id",
  "service",
  "flow_type",
  "amount_sats",
  "type",
  "created_at",
];

function parseDateRange(url: URL): { from: string; to: string } | { error: string } {
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  const now = new Date();
  const to = toParam ?? now.toISOString().slice(0, 10);
  const from =
    fromParam ??
    new Date(now.getTime() - DEFAULT_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

  // Validate YYYY-MM-DD format
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(from)) return { error: `Invalid 'from' date: ${from}` };
  if (!dateRe.test(to)) return { error: `Invalid 'to' date: ${to}` };
  if (from > to) return { error: "'from' must not be after 'to'" };

  // Sanity check range
  const diffMs = new Date(to).getTime() - new Date(from).getTime();
  const diffDays = diffMs / (24 * 60 * 60 * 1000);
  if (diffDays > MAX_DAYS) {
    return { error: `Date range exceeds maximum of ${MAX_DAYS} days` };
  }

  return { from, to };
}

export const GET = withOperator(async (req: NextRequest) => {
  const url = new URL(req.url);
  const range = parseDateRange(url);
  if ("error" in range) {
    return NextResponse.json({ error: range.error }, { status: 400 });
  }

  const { from, to } = range;

  const result = await query<{
    date: string;
    id: string;
    service_id: string;
    action: string;
    amount_sats: number;
    payment_status: string;
    recorded_at: string;
  }>(
    `SELECT
       DATE(recorded_at)::text AS date,
       id,
       service_id,
       action,
       amount_sats,
       payment_status,
       recorded_at::text AS recorded_at
     FROM revenue_ledger
     WHERE recorded_at >= $1::date
       AND recorded_at < ($2::date + INTERVAL '1 day')
     ORDER BY recorded_at ASC`,
    [from, to]
  );

  const rows = result.rows.map((r) => [
    r.date,
    r.id,
    r.service_id,
    r.action,
    String(r.amount_sats),
    r.payment_status,
    r.recorded_at,
  ]);

  const csv = toCsv(HEADERS, rows);
  const filename = `revenue-${from}-to-${to}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});
