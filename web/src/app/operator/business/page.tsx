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

// All possible job statuses from the schema
const JOB_STATUSES = [
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
] as const;

function formatDateInput(date: Date): string {
  return date.toISOString().split("T")[0];
}

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return formatDateInput(d);
}

function defaultTo(): string {
  return formatDateInput(new Date());
}

async function downloadCsv(
  url: string,
  filename: string
): Promise<void> {
  const res = await authFetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Export failed (${res.status})`);
  }
  const csv = await res.text();
  const blob = new Blob([csv], { type: "text/csv" });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(blobUrl);
}

const inputClass =
  "bg-surface border border-border rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-amber-500";
const btnClass =
  "bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-1.5 rounded transition-colors";

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

      {/* Export Data */}
      <ExportSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export Section
// ---------------------------------------------------------------------------

function ExportSection() {
  const [revFrom, setRevFrom] = useState(defaultFrom);
  const [revTo, setRevTo] = useState(defaultTo);
  const [revLoading, setRevLoading] = useState(false);
  const [revError, setRevError] = useState("");

  const [jobsFrom, setJobsFrom] = useState(defaultFrom);
  const [jobsTo, setJobsTo] = useState(defaultTo);
  const [jobsStatus, setJobsStatus] = useState("");
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState("");

  const handleRevenueExport = async () => {
    setRevLoading(true);
    setRevError("");
    try {
      await downloadCsv(
        `/api/operator/export/revenue?from=${revFrom}&to=${revTo}`,
        `revenue-${revFrom}-to-${revTo}.csv`
      );
    } catch (e) {
      setRevError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setRevLoading(false);
    }
  };

  const handleJobsExport = async () => {
    setJobsLoading(true);
    setJobsError("");
    try {
      const params = new URLSearchParams({ from: jobsFrom, to: jobsTo });
      if (jobsStatus) params.set("status", jobsStatus);
      await downloadCsv(
        `/api/operator/export/jobs?${params.toString()}`,
        `jobs-${jobsFrom}-to-${jobsTo}${jobsStatus ? `-${jobsStatus}` : ""}.csv`
      );
    } catch (e) {
      setJobsError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setJobsLoading(false);
    }
  };

  return (
    <section>
      <SectionHeader>Export Data</SectionHeader>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Revenue Export */}
        <div className="bg-surface border border-border rounded p-4 space-y-3">
          <p className="text-sm font-medium text-foreground">Revenue CSV</p>
          <div className="flex flex-wrap gap-3 items-end">
            <label className="space-y-1">
              <span className="text-xs text-muted">From</span>
              <input
                type="date"
                value={revFrom}
                onChange={(e) => setRevFrom(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted">To</span>
              <input
                type="date"
                value={revTo}
                onChange={(e) => setRevTo(e.target.value)}
                className={inputClass}
              />
            </label>
            <button
              onClick={handleRevenueExport}
              disabled={revLoading}
              className={btnClass}
            >
              {revLoading ? "Downloading..." : "Download Revenue CSV"}
            </button>
          </div>
          {revError && (
            <p className="text-red-400 text-xs">{revError}</p>
          )}
        </div>

        {/* Jobs Export */}
        <div className="bg-surface border border-border rounded p-4 space-y-3">
          <p className="text-sm font-medium text-foreground">Jobs CSV</p>
          <div className="flex flex-wrap gap-3 items-end">
            <label className="space-y-1">
              <span className="text-xs text-muted">From</span>
              <input
                type="date"
                value={jobsFrom}
                onChange={(e) => setJobsFrom(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted">To</span>
              <input
                type="date"
                value={jobsTo}
                onChange={(e) => setJobsTo(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted">Status</span>
              <select
                value={jobsStatus}
                onChange={(e) => setJobsStatus(e.target.value)}
                className={inputClass}
              >
                <option value="">All</option>
                {JOB_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={handleJobsExport}
              disabled={jobsLoading}
              className={btnClass}
            >
              {jobsLoading ? "Downloading..." : "Download Jobs CSV"}
            </button>
          </div>
          {jobsError && (
            <p className="text-red-400 text-xs">{jobsError}</p>
          )}
        </div>
      </div>
    </section>
  );
}
