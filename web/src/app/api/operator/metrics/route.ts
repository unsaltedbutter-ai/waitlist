import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

export const GET = withOperator(async (_req: NextRequest) => {
  try {
    const [
      jobsToday,
      perf7d,
      perf30d,
      cache7d,
      cache14d,
      totalUsers,
      jobsByStatus,
      satsIn,
      debtTotal,
      deadLetter,
    ] = await Promise.all([
      // Section 1: Jobs Today
      query(`
        SELECT
          j.status,
          ss.display_name AS service_name,
          COUNT(*)::int AS count
        FROM jobs j
        JOIN streaming_services ss ON ss.id = j.service_id
        WHERE j.created_at::date = CURRENT_DATE
        GROUP BY j.status, ss.display_name
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

      // Section 4: Business, total users
      query(`SELECT COUNT(*)::int AS count FROM users`),

      // Section 4: Business, jobs by status (active/recent)
      query(`
        SELECT status, COUNT(*)::int AS count
        FROM jobs
        WHERE status NOT IN (
          'completed_paid', 'completed_eventual', 'completed_reneged',
          'user_skip', 'user_abandon', 'implied_skip', 'failed'
        )
        GROUP BY status
      `),

      // Section 4: Business, sats in (paid transactions, 30d)
      query(`
        SELECT COALESCE(SUM(amount_sats), 0)::bigint AS sats_in
        FROM transactions
        WHERE status = 'paid' AND paid_at > NOW() - INTERVAL '30 days'
      `),

      // Section 4: Business, total user debt
      query(`
        SELECT COALESCE(SUM(debt_sats), 0)::bigint AS total_debt
        FROM users
        WHERE debt_sats > 0
      `),

      // Section 5: Stuck/failed jobs (terminal failure states)
      query(`
        SELECT j.id, ss.display_name AS service_name, j.action AS flow_type,
               j.status, j.status_updated_at
        FROM jobs j
        JOIN streaming_services ss ON ss.id = j.service_id
        WHERE j.status IN ('completed_reneged', 'user_abandon', 'failed')
        ORDER BY j.status_updated_at DESC
        LIMIT 20
      `),
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
      dispatched: statuses.dispatched || 0,
      active: statuses.active || 0,
      completed_paid: statuses.completed_paid || 0,
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

    // Transform cache hit rates: merge 7d and 14d by service
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

    // Active jobs by status
    const activeJobs: Record<string, number> = {};
    for (const row of jobsByStatus.rows) {
      activeJobs[row.status] = row.count;
    }

    return NextResponse.json({
      jobs_today: {
        by_status: byStatus,
        by_service: byService,
      },
      agent_performance: {
        "7d": formatPerf(perf7d.rows),
        "30d": formatPerf(perf30d.rows),
      },
      playbook_cache: playbookCache,
      business: {
        total_users: totalUsers.rows[0]?.count ?? 0,
        active_jobs: activeJobs,
        sats_in_30d: Number(satsIn.rows[0]?.sats_in ?? 0),
        total_debt: Number(debtTotal.rows[0]?.total_debt ?? 0),
      },
      problem_jobs: deadLetter.rows.map((r) => ({
        id: r.id,
        service_name: r.service_name,
        flow_type: r.flow_type,
        status: r.status,
        status_updated_at: r.status_updated_at,
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
