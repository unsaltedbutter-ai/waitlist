import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

type Period = "day" | "week" | "month" | "all";

const VALID_PERIODS = new Set<string>(["day", "week", "month", "all"]);

function getPeriodRange(period: Period): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);

  if (period === "all") {
    return { start: "1970-01-01", end };
  }

  const daysBack = period === "day" ? 1 : period === "week" ? 7 : 30;
  const start = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  return { start: start.toISOString().slice(0, 10), end };
}

export const GET = withOperator(async (req: NextRequest) => {
  const url = new URL(req.url);
  const period = url.searchParams.get("period") ?? "week";

  if (!VALID_PERIODS.has(period)) {
    return NextResponse.json(
      { error: "Invalid period. Must be one of: day, week, month, all" },
      { status: 400 }
    );
  }

  const range = getPeriodRange(period as Period);
  const dateFilter =
    period === "all" ? "" : "AND created_at >= $1::date";
  const dateParam = period === "all" ? [] : [range.start];

  // Job stats: count by terminal status within date range
  const jobsResult = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::int AS count
     FROM jobs
     WHERE status IN (
       'completed_paid', 'completed_eventual', 'completed_reneged',
       'user_skip', 'user_abandon', 'implied_skip'
     )
     ${dateFilter}
     GROUP BY status`,
    dateParam
  );

  const jobCounts: Record<string, number> = {
    completed_paid: 0,
    completed_eventual: 0,
    completed_reneged: 0,
    user_skip: 0,
    user_abandon: 0,
    implied_skip: 0,
  };
  let total = 0;
  for (const row of jobsResult.rows) {
    const count = Number(row.count);
    jobCounts[row.status] = count;
    total += count;
  }

  // Revenue: earned (paid + eventual) and outstanding (invoice_sent)
  const revenueResult = await query<{ status: string; total_sats: string }>(
    `SELECT status, COALESCE(SUM(amount_sats), 0)::bigint AS total_sats
     FROM transactions
     WHERE status IN ('paid', 'eventual', 'invoice_sent')
     ${dateFilter}
     GROUP BY status`,
    dateParam
  );

  let earnedSats = 0;
  let outstandingSats = 0;
  for (const row of revenueResult.rows) {
    const sats = Number(row.total_sats);
    if (row.status === "paid" || row.status === "eventual") {
      earnedSats += sats;
    } else if (row.status === "invoice_sent") {
      outstandingSats = sats;
    }
  }

  // By-service breakdown: cancels, resumes, sats from paid transactions
  const byServiceResult = await query<{
    service_id: string;
    action: string;
    count: string;
    sats: string;
  }>(
    `SELECT
       t.service_id,
       t.action,
       COUNT(*)::int AS count,
       COALESCE(SUM(t.amount_sats), 0)::bigint AS sats
     FROM transactions t
     WHERE t.status IN ('paid', 'eventual')
     ${dateFilter.replace("created_at", "t.created_at")}
     GROUP BY t.service_id, t.action`,
    dateParam
  );

  const byService: Record<
    string,
    { cancels: number; resumes: number; sats: number }
  > = {};
  for (const row of byServiceResult.rows) {
    if (!byService[row.service_id]) {
      byService[row.service_id] = { cancels: 0, resumes: 0, sats: 0 };
    }
    const entry = byService[row.service_id];
    const count = Number(row.count);
    const sats = Number(row.sats);
    if (row.action === "cancel") {
      entry.cancels = count;
    } else {
      entry.resumes = count;
    }
    entry.sats += sats;
  }

  // Ledger revenue: earned income that survives user deletion
  const ledgerDateFilter =
    period === "all" ? "" : "WHERE recorded_at >= $1::date";
  const ledgerDateParam = period === "all" ? [] : [range.start];

  const ledgerTotalResult = await query<{ total_sats: string }>(
    `SELECT COALESCE(SUM(amount_sats), 0)::bigint AS total_sats FROM revenue_ledger`,
  );

  const ledgerPeriodResult = await query<{ payment_status: string; total_sats: string }>(
    `SELECT payment_status, COALESCE(SUM(amount_sats), 0)::bigint AS total_sats
     FROM revenue_ledger
     ${ledgerDateFilter}
     GROUP BY payment_status`,
    ledgerDateParam
  );

  const ledgerByServiceResult = await query<{
    service_id: string;
    action: string;
    count: string;
    sats: string;
  }>(
    `SELECT
       service_id,
       action,
       COUNT(*)::int AS count,
       COALESCE(SUM(amount_sats), 0)::bigint AS sats
     FROM revenue_ledger
     ${ledgerDateFilter}
     GROUP BY service_id, action`,
    ledgerDateParam
  );

  let ledgerAllTimeSats = Number(ledgerTotalResult.rows[0]?.total_sats ?? 0);
  let ledgerPaidSats = 0;
  let ledgerEventualSats = 0;
  for (const row of ledgerPeriodResult.rows) {
    const sats = Number(row.total_sats);
    if (row.payment_status === "paid") ledgerPaidSats = sats;
    if (row.payment_status === "eventual") ledgerEventualSats = sats;
  }

  const ledgerByService: Record<
    string,
    { cancels: number; resumes: number; sats: number }
  > = {};
  for (const row of ledgerByServiceResult.rows) {
    if (!ledgerByService[row.service_id]) {
      ledgerByService[row.service_id] = { cancels: 0, resumes: 0, sats: 0 };
    }
    const entry = ledgerByService[row.service_id];
    const count = Number(row.count);
    const sats = Number(row.sats);
    if (row.action === "cancel") {
      entry.cancels = count;
    } else {
      entry.resumes = count;
    }
    entry.sats += sats;
  }

  // User counts (not date-filtered, these are current state)
  const usersResult = await query<{
    total: string;
    active: string;
    with_debt: string;
  }>(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE onboarded_at IS NOT NULL)::int AS active,
       COUNT(*) FILTER (WHERE debt_sats > 0)::int AS with_debt
     FROM users`
  );

  const users = usersResult.rows[0] ?? { total: "0", active: "0", with_debt: "0" };

  return NextResponse.json({
    period: { start: range.start, end: range.end },
    jobs: {
      total,
      completed_paid: jobCounts.completed_paid,
      completed_eventual: jobCounts.completed_eventual,
      completed_reneged: jobCounts.completed_reneged,
      user_skip: jobCounts.user_skip,
      user_abandon: jobCounts.user_abandon,
      implied_skip: jobCounts.implied_skip,
    },
    revenue: {
      earned_sats: earnedSats,
      outstanding_sats: outstandingSats,
    },
    ledger: {
      all_time_sats: ledgerAllTimeSats,
      period_paid_sats: ledgerPaidSats,
      period_eventual_sats: ledgerEventualSats,
      period_total_sats: ledgerPaidSats + ledgerEventualSats,
      by_service: ledgerByService,
    },
    by_service: byService,
    users: {
      active: Number(users.active),
      with_debt: Number(users.with_debt),
      total: Number(users.total),
    },
  });
});
