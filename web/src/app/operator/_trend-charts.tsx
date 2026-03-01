"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { authFetch } from "@/lib/hooks/use-auth";
import { SectionHeader, thClass, tdClass, tdMuted } from "./_components";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SuccessRateRow {
  bucket_date: string;
  service_id: string;
  service_name: string;
  total: number;
  succeeded: number;
}

interface OtpRateRow {
  bucket_date: string;
  service_id: string;
  service_name: string;
  total: number;
  otp_count: number;
}

interface AvgInferenceRow {
  bucket_date: string;
  service_id: string;
  service_name: string;
  avg_inference: number;
}

interface FailureRow {
  service_id: string;
  service_name: string;
  error_code: string;
  count: number;
}

interface TrendsData {
  days: number;
  bucket: string;
  success_rate: SuccessRateRow[];
  otp_rate: OtpRateRow[];
  avg_inference: AvgInferenceRow[];
  failure_breakdown: FailureRow[];
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const SERVICE_COLORS: Record<string, string> = {
  netflix: "#e50914",
  hulu: "#1ce783",
  disney_plus: "#2f7d8c",
  paramount: "#0064ff",
  peacock: "#000000",
  max: "#2e0070",
};

function getColor(serviceId: string): string {
  return SERVICE_COLORS[serviceId] ?? "#888888";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBucketDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Pivot rows (one per service per bucket) into recharts-compatible
 * array (one object per bucket, with service_id keys).
 */
function pivotByBucket<T extends { bucket_date: string; service_id: string }>(
  rows: T[],
  valueKey: string,
  valueFn: (row: T) => number
): { data: Record<string, unknown>[]; services: string[] } {
  const serviceSet = new Set<string>();
  const bucketMap = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    serviceSet.add(row.service_id);
    let entry = bucketMap.get(row.bucket_date);
    if (!entry) {
      entry = { date: formatBucketDate(row.bucket_date) };
      bucketMap.set(row.bucket_date, entry);
    }
    entry[row.service_id] = valueFn(row);
  }

  // Sort by date
  const sorted = [...bucketMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);

  return { data: sorted, services: [...serviceSet].sort() };
}

// ---------------------------------------------------------------------------
// TrendChart
// ---------------------------------------------------------------------------

function TrendChart({
  title,
  data,
  services,
  yFormatter,
}: {
  title: string;
  data: Record<string, unknown>[];
  services: string[];
  yFormatter?: (v: number) => string;
}) {
  if (data.length === 0) {
    return (
      <div className="bg-surface border border-border rounded p-4">
        <p className="text-xs text-muted uppercase tracking-wide mb-2">{title}</p>
        <p className="text-muted text-sm">No data yet.</p>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded p-4">
      <p className="text-xs text-muted uppercase tracking-wide mb-3">{title}</p>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#888" }} />
          <YAxis
            tick={{ fontSize: 11, fill: "#888" }}
            tickFormatter={yFormatter}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value) =>
              yFormatter && typeof value === "number"
                ? yFormatter(value)
                : value
            }
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {services.map((svc) => (
            <Line
              key={svc}
              type="monotone"
              dataKey={svc}
              name={svc}
              stroke={getColor(svc)}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FailureBreakdownTable
// ---------------------------------------------------------------------------

function errorBadgeClass(code: string): string {
  if (code === "credential_invalid") return "bg-red-900/50 text-red-300 border-red-700";
  if (code === "captcha") return "bg-amber-900/50 text-amber-300 border-amber-700";
  return "bg-neutral-800/50 text-neutral-300 border-neutral-600";
}

function FailureBreakdownTable({ rows }: { rows: FailureRow[] }) {
  if (rows.length === 0) {
    return <p className="text-muted text-sm">No failures in this period.</p>;
  }

  // Group by service
  const byService = new Map<string, FailureRow[]>();
  for (const row of rows) {
    const key = row.service_name;
    const list = byService.get(key) ?? [];
    list.push(row);
    byService.set(key, list);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            <th className={thClass}>Service</th>
            <th className={thClass}>Error Code</th>
            <th className={thClass}>Count</th>
          </tr>
        </thead>
        <tbody>
          {[...byService.entries()].map(([serviceName, serviceRows]) =>
            serviceRows.map((row, i) => (
              <tr
                key={`${row.service_id}-${row.error_code}`}
                className="border-b border-border/50"
              >
                {i === 0 ? (
                  <td className={tdClass} rowSpan={serviceRows.length}>
                    {serviceName}
                  </td>
                ) : null}
                <td className="px-3 py-2">
                  <span
                    className={`inline-block text-xs px-2 py-0.5 rounded border ${errorBadgeClass(row.error_code)}`}
                  >
                    {row.error_code}
                  </span>
                </td>
                <td className={tdMuted}>{row.count}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TrendsSection (main export)
// ---------------------------------------------------------------------------

export default function TrendsSection() {
  const [data, setData] = useState<TrendsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [bucket, setBucket] = useState<"daily" | "weekly">("weekly");

  const fetchTrends = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authFetch(
        `/api/operator/trends?days=${days}&bucket=${bucket}`
      );
      if (res.status === 403) return;
      if (!res.ok) {
        setError("Failed to load trends.");
        return;
      }
      setData(await res.json());
    } catch {
      setError("Failed to load trends.");
    } finally {
      setLoading(false);
    }
  }, [days, bucket]);

  useEffect(() => {
    fetchTrends();
  }, [fetchTrends]);

  if (error) return <p className="text-red-400 text-sm">{error}</p>;

  // Pivot data for charts
  const successPivot = data
    ? pivotByBucket(
        data.success_rate,
        "rate",
        (r) => (r.total > 0 ? Math.round((r.succeeded / r.total) * 100) : 0)
      )
    : { data: [], services: [] };

  const otpPivot = data
    ? pivotByBucket(
        data.otp_rate,
        "rate",
        (r) => (r.total > 0 ? Math.round((r.otp_count / r.total) * 100) : 0)
      )
    : { data: [], services: [] };

  const inferencePivot = data
    ? pivotByBucket(
        data.avg_inference,
        "avg",
        (r) => Number(r.avg_inference)
      )
    : { data: [], services: [] };

  const pctFormatter = (v: number) => `${v}%`;

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <SectionHeader>Trends</SectionHeader>

        {/* Time range selector */}
        <div className="flex gap-1 mb-3">
          {([7, 30, 90] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`text-xs px-2 py-1 rounded ${
                days === d
                  ? "bg-accent text-background font-semibold"
                  : "bg-surface border border-border text-muted hover:text-foreground"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>

        {/* Bucket toggle */}
        <div className="flex gap-1 mb-3">
          {(["daily", "weekly"] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBucket(b)}
              className={`text-xs px-2 py-1 rounded ${
                bucket === b
                  ? "bg-accent text-background font-semibold"
                  : "bg-surface border border-border text-muted hover:text-foreground"
              }`}
            >
              {b}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="text-muted text-sm">Loading trends...</p>}

      {!loading && data && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TrendChart
              title="Success Rate by Service"
              data={successPivot.data}
              services={successPivot.services}
              yFormatter={pctFormatter}
            />
            <TrendChart
              title="OTP Rate by Service"
              data={otpPivot.data}
              services={otpPivot.services}
              yFormatter={pctFormatter}
            />
          </div>

          <TrendChart
            title="Avg Inferences by Service"
            data={inferencePivot.data}
            services={inferencePivot.services}
          />

          <div>
            <p className="text-xs text-muted uppercase tracking-wide mb-3">
              Failure Breakdown
            </p>
            <FailureBreakdownTable rows={data.failure_breakdown} />
          </div>
        </div>
      )}
    </section>
  );
}
