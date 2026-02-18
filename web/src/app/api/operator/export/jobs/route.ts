import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";
import { toCsv } from "@/lib/csv";

const DEFAULT_DAYS = 90;
const MAX_DAYS = 3650;

const HEADERS = [
  "date",
  "job_id",
  "user_npub",
  "service",
  "flow_type",
  "status",
  "billing_date",
  "created_at",
  "completed_at",
];

const VALID_STATUSES = new Set([
  "pending",
  "dispatched",
  "outreach_sent",
  "snoozed",
  "active",
  "awaiting_otp",
  "completed_paid",
  "completed_eventual",
  "completed_reneged",
  "user_skip",
  "user_abandon",
  "implied_skip",
  "failed",
]);

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

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(from)) return { error: `Invalid 'from' date: ${from}` };
  if (!dateRe.test(to)) return { error: `Invalid 'to' date: ${to}` };
  if (from > to) return { error: "'from' must not be after 'to'" };

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
  const statusParam = url.searchParams.get("status");

  if (statusParam && !VALID_STATUSES.has(statusParam)) {
    return NextResponse.json(
      { error: `Invalid status: ${statusParam}` },
      { status: 400 }
    );
  }

  const params: unknown[] = [from, to];
  let statusClause = "";
  if (statusParam) {
    params.push(statusParam);
    statusClause = `AND j.status = $${params.length}`;
  }

  const result = await query<{
    date: string;
    job_id: string;
    user_npub: string;
    service: string;
    flow_type: string;
    status: string;
    billing_date: string | null;
    created_at: string;
    completed_at: string;
  }>(
    `SELECT
       DATE(j.created_at)::text AS date,
       j.id::text AS job_id,
       COALESCE(u.nostr_npub, 'deleted') AS user_npub,
       j.service_id AS service,
       j.action AS flow_type,
       j.status,
       j.billing_date::text AS billing_date,
       j.created_at::text AS created_at,
       j.status_updated_at::text AS completed_at
     FROM jobs j
     LEFT JOIN users u ON u.id = j.user_id
     WHERE j.created_at >= $1::date
       AND j.created_at < ($2::date + INTERVAL '1 day')
       ${statusClause}
     ORDER BY j.created_at ASC`,
    params
  );

  const rows = result.rows.map((r) => [
    r.date,
    r.job_id,
    r.user_npub,
    r.service,
    r.flow_type,
    r.status,
    r.billing_date ?? "",
    r.created_at,
    r.completed_at,
  ]);

  const csv = toCsv(HEADERS, rows);
  const filename = `jobs-${from}-to-${to}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});
