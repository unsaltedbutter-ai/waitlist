"use client";

import { useState, useEffect, useCallback } from "react";
import { authFetch } from "@/lib/hooks/use-auth";
import {
  Metrics,
  StatCard,
  SectionHeader,
  formatSats,
  thClass,
  tdClass,
  tdMuted,
} from "../_components";

// Daily revenue data from GET /api/operator/revenue/daily
interface DailyRevenue {
  date: string;
  sats: number;
  cumulative_sats: number;
  jobs: number;
  paid_sats: number;
  eventual_sats: number;
}

// Ledger stats from GET /api/operator/stats
interface LedgerStats {
  all_time_sats: number;
  period_paid_sats: number;
  period_eventual_sats: number;
  period_total_sats: number;
  by_service: Record<string, { cancels: number; resumes: number; sats: number }>;
}

export default function BusinessPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [ledger, setLedger] = useState<LedgerStats | null>(null);
  const [dailyRevenue, setDailyRevenue] = useState<DailyRevenue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [mRes, sRes, rRes] = await Promise.all([
        authFetch("/api/operator/metrics"),
        authFetch("/api/operator/stats?period=month"),
        authFetch("/api/operator/revenue/daily?days=90"),
      ]);
      if (mRes.status === 403) {
        setError("Access denied.");
        return;
      }
      if (!mRes.ok) {
        setError("Failed to load metrics.");
        return;
      }
      setMetrics(await mRes.json());
      if (sRes.ok) {
        const statsData = await sRes.json();
        setLedger(statsData.ledger ?? null);
      }
      if (rRes.ok) {
        setDailyRevenue(await rRes.json());
      }
    } catch {
      setError("Failed to load data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (error === "Access denied.") {
    return <p className="text-red-400 text-sm">403 -- Not authorized.</p>;
  }

  if (loading) return <p className="text-muted">Loading business data...</p>;
  if (error) return <p className="text-red-400 text-sm">{error}</p>;
  if (!metrics) return null;

  const biz = metrics.business;

  // Count active jobs across all non-terminal statuses
  const activeJobTotal = Object.values(biz.active_jobs).reduce(
    (sum, n) => sum + n,
    0
  );

  return (
    <div className="space-y-8">
      {/* Business stat cards */}
      <section>
        <SectionHeader>Revenue & Users</SectionHeader>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          <StatCard label="Total Users" value={biz.total_users} />
          <StatCard
            label="Lifetime Income"
            value={`${formatSats(ledger?.all_time_sats ?? 0)} sats`}
            sub="from revenue ledger (survives deletion)"
          />
          <StatCard
            label="Income (30d)"
            value={`${formatSats(ledger?.period_total_sats ?? biz.sats_in_30d)} sats`}
            sub={`${formatSats(ledger?.period_paid_sats ?? 0)} paid, ${formatSats(ledger?.period_eventual_sats ?? 0)} eventual`}
          />
          <StatCard
            label="Outstanding Debt"
            value={`${formatSats(biz.total_debt)} sats`}
            sub="unpaid user balances"
          />
          <StatCard
            label="Active Jobs"
            value={activeJobTotal}
            sub="non-terminal jobs in system"
          />
        </div>
      </section>

      {/* Ledger by-service breakdown */}
      {ledger && Object.keys(ledger.by_service).length > 0 && (
        <section>
          <SectionHeader>Income by Service (30d, from Ledger)</SectionHeader>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Service</th>
                  <th className={thClass}>Cancels</th>
                  <th className={thClass}>Resumes</th>
                  <th className={thClass}>Sats</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(ledger.by_service).map(([svc, data]) => (
                  <tr key={svc} className="border-b border-border/50">
                    <td className={tdClass}>{svc}</td>
                    <td className={tdMuted}>{data.cancels}</td>
                    <td className={tdMuted}>{data.resumes}</td>
                    <td className="px-3 py-2 text-sm text-green-400">
                      {formatSats(data.sats)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Daily Revenue Table */}
      <section>
        <SectionHeader>Daily Revenue (Last 90 Days)</SectionHeader>
        {dailyRevenue.length > 0 ? (
          <div className="overflow-x-auto max-h-96">
            <table className="w-full">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b border-border">
                  <th className={thClass}>Date</th>
                  <th className={thClass}>Jobs</th>
                  <th className={thClass}>Sats</th>
                  <th className={thClass}>Paid</th>
                  <th className={thClass}>Eventual</th>
                  <th className={thClass}>Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {[...dailyRevenue].reverse().map((d) => (
                  <tr key={d.date} className="border-b border-border/50">
                    <td className={tdClass}>{d.date}</td>
                    <td className={tdMuted}>{d.jobs}</td>
                    <td className="px-3 py-2 text-sm text-green-400">
                      {formatSats(d.sats)}
                    </td>
                    <td className={tdMuted}>{formatSats(d.paid_sats)}</td>
                    <td className={tdMuted}>{formatSats(d.eventual_sats)}</td>
                    <td className={tdMuted}>
                      {formatSats(d.cumulative_sats)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted text-sm">No revenue data yet.</p>
        )}
      </section>
    </div>
  );
}
