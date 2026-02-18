"use client";

import { useState, useEffect, useCallback } from "react";
import { authFetch } from "@/lib/hooks/use-auth";
import {
  Metrics,
  SectionHeader,
  thClass,
  tdClass,
  tdMuted,
  cacheColor,
} from "../_components";

export default function JobsPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [perfWindow, setPerfWindow] = useState<"7d" | "30d">("7d");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authFetch("/api/operator/metrics");
      if (res.status === 403) {
        setError("Access denied.");
        return;
      }
      if (!res.ok) {
        setError("Failed to load metrics.");
        return;
      }
      setMetrics(await res.json());
    } catch {
      setError("Failed to load metrics.");
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

  if (loading) return <p className="text-muted">Loading metrics...</p>;
  if (error) return <p className="text-red-400 text-sm">{error}</p>;
  if (!metrics) return null;

  const perf = metrics.agent_performance[perfWindow];
  const jobs = metrics.jobs_today;

  return (
    <div className="space-y-8">
      {/* Jobs Today */}
      <section>
        <SectionHeader>Jobs Today</SectionHeader>
        {jobs && jobs.by_service.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Service</th>
                  <th className={thClass}>Pending</th>
                  <th className={thClass}>Dispatched</th>
                  <th className={thClass}>Active</th>
                  <th className={thClass}>Completed (Paid)</th>
                </tr>
              </thead>
              <tbody>
                {jobs.by_service.map((s) => (
                  <tr key={s.service} className="border-b border-border/50">
                    <td className={tdClass}>{s.service}</td>
                    <td className={tdMuted}>{s.pending}</td>
                    <td className={tdMuted}>{s.dispatched}</td>
                    <td className={tdClass}>{s.active}</td>
                    <td className="px-3 py-2 text-sm text-green-400">
                      {s.completed_paid}
                    </td>
                  </tr>
                ))}
                <tr className="font-medium">
                  <td className={tdClass}>Total</td>
                  <td className={tdMuted}>
                    {jobs.by_status.pending || 0}
                  </td>
                  <td className={tdMuted}>
                    {jobs.by_status.dispatched || 0}
                  </td>
                  <td className={tdClass}>
                    {jobs.by_status.active || 0}
                  </td>
                  <td className="px-3 py-2 text-sm text-green-400">
                    {jobs.by_status.completed_paid || 0}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted text-sm">No jobs scheduled for today.</p>
        )}
      </section>

      {/* Agent Performance */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <SectionHeader>Agent Performance</SectionHeader>
          <div className="flex gap-1 mb-3">
            {(["7d", "30d"] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setPerfWindow(w)}
                className={`text-xs px-2 py-1 rounded ${
                  perfWindow === w
                    ? "bg-accent text-background font-semibold"
                    : "bg-surface border border-border text-muted hover:text-foreground"
                }`}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
        {perf.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Service</th>
                  <th className={thClass}>Flow</th>
                  <th className={thClass}>Success</th>
                  <th className={thClass}>Avg Duration</th>
                  <th className={thClass}>Avg Inference</th>
                  <th className={thClass}>Avg Steps</th>
                </tr>
              </thead>
              <tbody>
                {perf.map((r, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className={tdClass}>{r.service_name}</td>
                    <td className={tdMuted}>{r.flow_type}</td>
                    <td
                      className={`px-3 py-2 text-sm font-medium ${
                        r.success_rate >= 90
                          ? "text-green-400"
                          : r.success_rate >= 70
                            ? "text-amber-400"
                            : "text-red-400"
                      }`}
                    >
                      {r.success_rate}%
                      <span className="text-muted font-normal ml-1">
                        ({r.succeeded}/{r.total})
                      </span>
                    </td>
                    <td className={tdMuted}>{r.avg_duration_seconds}s</td>
                    <td className={tdMuted}>{r.avg_inference_steps}</td>
                    <td className={tdMuted}>{r.avg_steps}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted text-sm">
            No agent activity in the last {perfWindow}.
          </p>
        )}
      </section>

      {/* Playbook Cache Hit Rate */}
      <section>
        <SectionHeader>Playbook Cache Hit Rate</SectionHeader>
        {metrics.playbook_cache.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Service</th>
                  <th className={thClass}>7d</th>
                  <th className={thClass}>14d</th>
                </tr>
              </thead>
              <tbody>
                {metrics.playbook_cache.map((r) => (
                  <tr
                    key={r.service_name}
                    className="border-b border-border/50"
                  >
                    <td className={tdClass}>{r.service_name}</td>
                    <td
                      className={`px-3 py-2 text-sm font-medium ${cacheColor(r.pct_7d)}`}
                    >
                      {r.pct_7d}%
                    </td>
                    <td
                      className={`px-3 py-2 text-sm font-medium ${cacheColor(r.pct_14d)}`}
                    >
                      {r.pct_14d}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted text-sm">No playbook data yet.</p>
        )}
      </section>
    </div>
  );
}
