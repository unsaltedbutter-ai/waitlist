import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";
import { checkMarginCalls } from "@/lib/margin-call";

export const GET = withOperator(async (_req: NextRequest) => {
  try {
    const [
      jobsToday,
      perf7d,
      perf30d,
      cache7d,
      cache14d,
      usersByStatus,
      subsByStatus,
      satsIn,
      satsOut,
      deadLetter,
      marginCallUsers,
    ] = await Promise.all([
      // Section 1: Jobs Today
      query(`
        SELECT
          aj.status,
          ss.display_name AS service_name,
          COUNT(*)::int AS count
        FROM agent_jobs aj
        JOIN streaming_services ss ON ss.id = aj.service_id
        WHERE aj.scheduled_for = CURRENT_DATE
        GROUP BY aj.status, ss.display_name
      `),

      // Section 2: Agent Performance 7d
      query(`
        SELECT
          ss.display_name AS service_name,
          al.flow_type,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE al.success)::int AS succeeded,
          ROUND(AVG(al.inference_count)::numeric, 1) AS avg_inference_steps,
          ROUND(AVG(al.duration_seconds)::numeric, 0) AS avg_duration_seconds,
          ROUND(AVG(al.step_count)::numeric, 1) AS avg_steps
        FROM action_logs al
        JOIN streaming_services ss ON ss.id = al.service_id
        WHERE al.created_at > NOW() - INTERVAL '7 days'
        GROUP BY ss.display_name, al.flow_type
      `),

      // Section 2: Agent Performance 30d
      query(`
        SELECT
          ss.display_name AS service_name,
          al.flow_type,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE al.success)::int AS succeeded,
          ROUND(AVG(al.inference_count)::numeric, 1) AS avg_inference_steps,
          ROUND(AVG(al.duration_seconds)::numeric, 0) AS avg_duration_seconds,
          ROUND(AVG(al.step_count)::numeric, 1) AS avg_steps
        FROM action_logs al
        JOIN streaming_services ss ON ss.id = al.service_id
        WHERE al.created_at > NOW() - INTERVAL '30 days'
        GROUP BY ss.display_name, al.flow_type
      `),

      // Section 3: Cache Hit Rate 7d
      query(`
        SELECT
          ss.display_name AS service_name,
          ROUND(AVG(
            CASE WHEN al.step_count > 0
              THEN (al.step_count - al.inference_count)::numeric / al.step_count
              ELSE 0 END
          ) * 100, 1) AS cache_hit_pct
        FROM action_logs al
        JOIN streaming_services ss ON ss.id = al.service_id
        WHERE al.created_at > NOW() - INTERVAL '7 days'
        GROUP BY ss.display_name
      `),

      // Section 3: Cache Hit Rate 14d
      query(`
        SELECT
          ss.display_name AS service_name,
          ROUND(AVG(
            CASE WHEN al.step_count > 0
              THEN (al.step_count - al.inference_count)::numeric / al.step_count
              ELSE 0 END
          ) * 100, 1) AS cache_hit_pct
        FROM action_logs al
        JOIN streaming_services ss ON ss.id = al.service_id
        WHERE al.created_at > NOW() - INTERVAL '14 days'
        GROUP BY ss.display_name
      `),

      // Section 4: Business — Users by status
      query(`SELECT status, COUNT(*)::int AS count FROM users GROUP BY status`),

      // Section 4: Business — Subscriptions by status
      query(`
        SELECT status, COUNT(*)::int AS count
        FROM subscriptions
        WHERE status IN ('active', 'lapsing', 'signup_scheduled')
        GROUP BY status
      `),

      // Section 4: Business — Sats in (30d)
      query(`
        SELECT COALESCE(SUM(received_amount_sats), 0)::bigint AS sats_in
        FROM btc_prepayments
        WHERE status = 'paid' AND created_at > NOW() - INTERVAL '30 days'
      `),

      // Section 4: Business — Sats out (30d)
      query(`
        SELECT COALESCE(SUM(cost_sats), 0)::bigint AS sats_out
        FROM gift_card_purchases
        WHERE status IN ('purchased', 'redeemed') AND created_at > NOW() - INTERVAL '30 days'
      `),

      // Section 5: Dead Letter Jobs
      query(`
        SELECT aj.id, ss.display_name AS service_name, aj.flow_type, aj.error_message, aj.completed_at
        FROM agent_jobs aj
        JOIN streaming_services ss ON ss.id = aj.service_id
        WHERE aj.status = 'dead_letter'
        ORDER BY aj.completed_at DESC
        LIMIT 20
      `),

      // Section 4: Margin call risk count
      checkMarginCalls().catch(() => []),
    ]);

    // Transform jobs today into structured shape
    const byStatus: Record<string, number> = {};
    const serviceMap: Record<string, Record<string, number>> = {};
    for (const row of jobsToday.rows) {
      byStatus[row.status] = (byStatus[row.status] || 0) + row.count;
      if (!serviceMap[row.service_name]) {
        serviceMap[row.service_name] = {};
      }
      serviceMap[row.service_name][row.status] =
        (serviceMap[row.service_name][row.status] || 0) + row.count;
    }
    const byService = Object.entries(serviceMap).map(([service, statuses]) => ({
      service,
      pending: statuses.pending || 0,
      claimed: statuses.claimed || 0,
      in_progress: statuses.in_progress || 0,
      completed: statuses.completed || 0,
      failed: statuses.failed || 0,
      dead_letter: statuses.dead_letter || 0,
    }));

    // Transform performance rows
    const formatPerf = (rows: Record<string, unknown>[]) =>
      rows.map((r) => ({
        service_name: r.service_name,
        flow_type: r.flow_type,
        total: r.total,
        succeeded: r.succeeded,
        success_rate:
          Number(r.total) > 0
            ? Math.round((Number(r.succeeded) / Number(r.total)) * 100)
            : 0,
        avg_inference_steps: Number(r.avg_inference_steps) || 0,
        avg_duration_seconds: Number(r.avg_duration_seconds) || 0,
        avg_steps: Number(r.avg_steps) || 0,
      }));

    // Transform cache hit rates — merge 7d and 14d by service
    const cacheMap: Record<string, { pct_7d: number; pct_14d: number }> = {};
    for (const row of cache7d.rows) {
      cacheMap[row.service_name] = {
        pct_7d: Number(row.cache_hit_pct) || 0,
        pct_14d: 0,
      };
    }
    for (const row of cache14d.rows) {
      if (!cacheMap[row.service_name]) {
        cacheMap[row.service_name] = { pct_7d: 0, pct_14d: 0 };
      }
      cacheMap[row.service_name].pct_14d = Number(row.cache_hit_pct) || 0;
    }
    const playbookCache = Object.entries(cacheMap).map(
      ([service_name, rates]) => ({
        service_name,
        ...rates,
      })
    );

    // Status maps
    const usersStatus: Record<string, number> = {};
    for (const row of usersByStatus.rows) {
      usersStatus[row.status] = row.count;
    }
    const subsStatus: Record<string, number> = {};
    for (const row of subsByStatus.rows) {
      subsStatus[row.status] = row.count;
    }

    return NextResponse.json({
      jobs_today: {
        by_status: {
          pending: byStatus.pending || 0,
          claimed: byStatus.claimed || 0,
          in_progress: byStatus.in_progress || 0,
          completed: byStatus.completed || 0,
          failed: byStatus.failed || 0,
          dead_letter: byStatus.dead_letter || 0,
        },
        by_service: byService,
      },
      agent_performance: {
        "7d": formatPerf(perf7d.rows),
        "30d": formatPerf(perf30d.rows),
      },
      playbook_cache: playbookCache,
      business: {
        users: usersStatus,
        subscriptions: subsStatus,
        sats_in_30d: Number(satsIn.rows[0]?.sats_in ?? 0),
        sats_out_30d: Number(satsOut.rows[0]?.sats_out ?? 0),
        margin_call_count: marginCallUsers.length,
      },
      dead_letter: deadLetter.rows.map((r) => ({
        id: r.id,
        service_name: r.service_name,
        flow_type: r.flow_type,
        error_message: r.error_message,
        completed_at: r.completed_at,
      })),
    });
  } catch (err) {
    console.error("Operator metrics error:", err);
    return NextResponse.json(
      { error: "Failed to fetch metrics" },
      { status: 500 }
    );
  }
});
