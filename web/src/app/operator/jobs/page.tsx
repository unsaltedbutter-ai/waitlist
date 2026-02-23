"use client";

import { useState, useEffect, useCallback } from "react";
import { authFetch } from "@/lib/hooks/use-auth";
import { getJobStatusConfig } from "@/lib/job-status";
import {
  Metrics,
  SectionHeader,
  formatDate,
  thClass,
  tdClass,
  tdMuted,
  cacheColor,
} from "../_components";

// Statuses where the operator can cancel the job
const CANCELLABLE = new Set(["pending", "dispatched", "outreach_sent", "snoozed"]);
// Statuses where the job is inflight (no action available)
const INFLIGHT = new Set(["active", "awaiting_otp"]);

interface LookupUser {
  id: string;
  nostr_npub: string;
  debt_sats: number;
}

interface LookupJob {
  id: string;
  service_id: string;
  action: string;
  trigger: string;
  status: string;
  status_updated_at: string;
  billing_date: string | null;
  access_end_date: string | null;
  amount_sats: number | null;
  created_at: string;
}

interface PendingJob {
  id: string;
  service_id: string;
  action: string;
  trigger: string;
  status: string;
  status_updated_at: string;
  created_at: string;
  nostr_npub: string;
}

export default function JobsPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [perfWindow, setPerfWindow] = useState<"7d" | "30d">("7d");

  // Pending jobs state
  const [pendingJobs, setPendingJobs] = useState<PendingJob[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [pendingError, setPendingError] = useState("");
  const [copiedNpub, setCopiedNpub] = useState<string | null>(null);
  const [pendingCancellingId, setPendingCancellingId] = useState<string | null>(null);

  // Npub lookup state
  const [npubInput, setNpubInput] = useState("");
  const [lookupUser, setLookupUser] = useState<LookupUser | null>(null);
  const [lookupJobs, setLookupJobs] = useState<LookupJob[]>([]);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const fetchPendingJobs = useCallback(async () => {
    setPendingLoading(true);
    setPendingError("");
    try {
      const res = await authFetch("/api/operator/jobs/pending-list");
      if (res.status === 403) return;
      if (!res.ok) {
        setPendingError("Failed to load pending jobs.");
        return;
      }
      const data = await res.json();
      setPendingJobs(data.jobs);
    } catch {
      setPendingError("Failed to load pending jobs.");
    } finally {
      setPendingLoading(false);
    }
  }, []);

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
    fetchPendingJobs();
  }, [fetchData, fetchPendingJobs]);

  const searchNpub = async () => {
    const trimmed = npubInput.trim();
    if (!trimmed) return;

    setLookupLoading(true);
    setLookupError("");
    setLookupUser(null);
    setLookupJobs([]);

    try {
      const res = await authFetch(
        `/api/operator/jobs/by-npub?npub=${encodeURIComponent(trimmed)}`
      );
      if (res.status === 404) {
        setLookupError("User not found.");
        return;
      }
      if (res.status === 400) {
        const data = await res.json();
        setLookupError(data.error || "Invalid npub.");
        return;
      }
      if (!res.ok) {
        setLookupError("Search failed.");
        return;
      }
      const data = await res.json();
      setLookupUser(data.user);
      setLookupJobs(data.jobs);
    } catch {
      setLookupError("Search failed.");
    } finally {
      setLookupLoading(false);
    }
  };

  const copyNpub = (npub: string) => {
    navigator.clipboard.writeText(npub);
    setCopiedNpub(npub);
    setTimeout(() => setCopiedNpub(null), 2000);
  };

  const cancelPendingJob = async (jobId: string) => {
    setPendingCancellingId(jobId);
    try {
      const res = await authFetch(`/api/operator/jobs/${jobId}/force-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "user_skip", reason: "Operator cancelled" }),
      });
      if (res.ok) {
        await fetchPendingJobs();
      }
    } finally {
      setPendingCancellingId(null);
    }
  };

  const cancelJob = async (jobId: string) => {
    setCancellingId(jobId);
    try {
      const res = await authFetch(`/api/operator/jobs/${jobId}/force-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "user_skip", reason: "Operator cancelled" }),
      });
      if (res.ok) {
        // Refetch the lookup results
        await searchNpub();
      }
    } finally {
      setCancellingId(null);
    }
  };

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
      {/* Pending Jobs */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <SectionHeader>Pending Jobs</SectionHeader>
          <button
            type="button"
            onClick={fetchPendingJobs}
            disabled={pendingLoading}
            className="text-xs px-2 py-1 rounded border border-border text-muted hover:text-foreground disabled:opacity-50 mb-3"
          >
            {pendingLoading ? "Loading..." : "Refresh"}
          </button>
        </div>

        {pendingError && (
          <p className="text-red-400 text-sm mb-4">{pendingError}</p>
        )}

        {!pendingLoading && pendingJobs.length === 0 && !pendingError && (
          <p className="text-muted text-sm">No pending jobs in queue.</p>
        )}

        {pendingJobs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Npub</th>
                  <th className={thClass}>Service</th>
                  <th className={thClass}>Action</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Created</th>
                  <th className={thClass}>Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingJobs.map((j) => {
                  const cfg = getJobStatusConfig(j.status);
                  return (
                    <tr key={j.id} className="border-b border-border/50">
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => copyNpub(j.nostr_npub)}
                          className="font-mono text-xs text-foreground hover:text-accent cursor-pointer"
                          title="Click to copy full npub"
                        >
                          {copiedNpub === j.nostr_npub
                            ? "Copied!"
                            : `${j.nostr_npub.slice(0, 12)}...`}
                        </button>
                      </td>
                      <td className={tdClass}>{j.service_id}</td>
                      <td className={tdMuted}>{j.action}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-block text-xs px-2 py-0.5 rounded ${cfg.badgeClass}`}
                        >
                          {cfg.label}
                        </span>
                      </td>
                      <td className={tdMuted}>{formatDate(j.created_at)}</td>
                      <td className="px-3 py-2">
                        {CANCELLABLE.has(j.status) ? (
                          <button
                            type="button"
                            onClick={() => cancelPendingJob(j.id)}
                            disabled={pendingCancellingId === j.id}
                            className="text-xs px-2 py-1 rounded border border-red-700/50 bg-red-900/20 text-red-400 hover:bg-red-900/40 disabled:opacity-50"
                          >
                            {pendingCancellingId === j.id ? "..." : "Cancel"}
                          </button>
                        ) : INFLIGHT.has(j.status) ? (
                          <span className="text-xs text-amber-400">inflight</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Npub Job Lookup */}
      <section>
        <SectionHeader>Job Lookup by Npub</SectionHeader>
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={npubInput}
            onChange={(e) => setNpubInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && searchNpub()}
            placeholder="npub1... or hex pubkey"
            className="flex-1 bg-surface border border-border rounded px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={searchNpub}
            disabled={lookupLoading || !npubInput.trim()}
            className="px-4 py-2 text-sm font-medium rounded bg-accent text-background hover:bg-accent/80 disabled:opacity-50"
          >
            {lookupLoading ? "Searching..." : "Search"}
          </button>
        </div>

        {lookupError && (
          <p className="text-red-400 text-sm mb-4">{lookupError}</p>
        )}

        {lookupUser && (
          <div className="space-y-3">
            <div className="flex items-center gap-4 text-sm">
              <span className="text-muted">User:</span>
              <span className="text-foreground font-mono text-xs">
                {lookupUser.nostr_npub.slice(0, 16)}...
              </span>
              {lookupUser.debt_sats > 0 && (
                <span className="text-red-400 font-medium">
                  Debt: {lookupUser.debt_sats.toLocaleString()} sats
                </span>
              )}
            </div>

            {lookupJobs.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className={thClass}>Service</th>
                      <th className={thClass}>Action</th>
                      <th className={thClass}>Status</th>
                      <th className={thClass}>Billing Date</th>
                      <th className={thClass}>Created</th>
                      <th className={thClass}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lookupJobs.map((j) => {
                      const cfg = getJobStatusConfig(j.status);
                      return (
                        <tr key={j.id} className="border-b border-border/50">
                          <td className={tdClass}>{j.service_id}</td>
                          <td className={tdMuted}>{j.action}</td>
                          <td className="px-3 py-2">
                            <span
                              className={`inline-block text-xs px-2 py-0.5 rounded ${cfg.badgeClass}`}
                            >
                              {cfg.label}
                            </span>
                          </td>
                          <td className={tdMuted}>
                            {j.billing_date
                              ? new Date(j.billing_date).toLocaleDateString(
                                  "en-US",
                                  { month: "short", day: "numeric" }
                                )
                              : "N/A"}
                          </td>
                          <td className={tdMuted}>{formatDate(j.created_at)}</td>
                          <td className="px-3 py-2">
                            {CANCELLABLE.has(j.status) ? (
                              <button
                                type="button"
                                onClick={() => cancelJob(j.id)}
                                disabled={cancellingId === j.id}
                                className="text-xs px-2 py-1 rounded border border-red-700/50 bg-red-900/20 text-red-400 hover:bg-red-900/40 disabled:opacity-50"
                              >
                                {cancellingId === j.id ? "..." : "Cancel"}
                              </button>
                            ) : INFLIGHT.has(j.status) ? (
                              <span className="text-xs text-amber-400">inflight</span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-muted text-sm">No jobs found for this user.</p>
            )}
          </div>
        )}
      </section>

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
