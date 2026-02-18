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
}

export default function BusinessPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [dailyRevenue, setDailyRevenue] = useState<DailyRevenue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [mRes, rRes] = await Promise.all([
        authFetch("/api/operator/metrics"),
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
            label="Sats Earned (30d)"
            value={`${formatSats(biz.sats_in_30d)} sats`}
            sub="paid cancel/resume invoices"
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
