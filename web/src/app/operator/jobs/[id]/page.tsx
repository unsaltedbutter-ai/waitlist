"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { authFetch } from "@/lib/hooks/use-auth";
import { TERMINAL_STATUSES } from "@/lib/constants";
import {
  SectionHeader,
  formatDate,
  formatSats,
  thClass,
  tdClass,
  tdMuted,
} from "../../_components";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Job {
  id: string;
  user_id: string;
  service_id: string;
  action: string;
  trigger: string;
  status: string;
  status_updated_at: string;
  billing_date: string | null;
  access_end_date: string | null;
  outreach_count: number;
  next_outreach_at: string | null;
  amount_sats: number | null;
  invoice_id: string | null;
  created_at: string;
}

interface UserSummary {
  id: string;
  nostr_npub: string;
}

interface ActionLog {
  id: string;
  flow_type: string;
  success: boolean;
  duration_seconds: number | null;
  step_count: number | null;
  inference_count: number | null;
  playbook_version: number | null;
  error_message: string | null;
  created_at: string;
}

interface Transaction {
  id: string;
  amount_sats: number;
  status: string;
  created_at: string;
  paid_at: string | null;
}

interface StatusHistoryEntry {
  id: string;
  from_status: string | null;
  to_status: string;
  changed_by: string;
  created_at: string;
}

interface JobDetail {
  job: Job;
  user: UserSummary | null;
  action_logs: ActionLog[];
  transaction: Transaction | null;
  status_history: StatusHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const terminalSet = new Set<string>(TERMINAL_STATUSES);

function statusColor(status: string): string {
  if (status === "completed_paid") return "bg-green-900/60 text-green-300 border-green-700";
  if (status === "completed_eventual") return "bg-green-900/30 text-green-400 border-green-800";
  if (status === "completed_reneged") return "bg-red-900/50 text-red-300 border-red-700";
  if (status === "active") return "bg-blue-900/50 text-blue-300 border-blue-700";
  if (status === "dispatched") return "bg-purple-900/50 text-purple-300 border-purple-700";
  if (status === "pending") return "bg-amber-900/50 text-amber-300 border-amber-700";
  if (status === "failed") return "bg-red-900/50 text-red-300 border-red-700";
  if (status === "user_skip" || status === "user_abandon" || status === "implied_skip")
    return "bg-neutral-800/50 text-neutral-300 border-neutral-600";
  return "bg-neutral-800/50 text-neutral-300 border-neutral-700";
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block text-xs font-semibold px-2 py-0.5 rounded border ${statusColor(status)}`}
    >
      {status}
    </span>
  );
}

const FORCE_STATUS_OPTIONS = [
  "completed_paid",
  "completed_eventual",
  "completed_reneged",
  "user_skip",
  "user_abandon",
  "implied_skip",
  "failed",
] as const;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function JobDetailPage() {
  const params = useParams<{ id: string }>();
  const jobId = params.id;

  const [data, setData] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Force-status form state
  const [showForce, setShowForce] = useState(false);
  const [forceStatus, setForceStatus] = useState<string>(FORCE_STATUS_OPTIONS[0]);
  const [forceReason, setForceReason] = useState("");
  const [forceSubmitting, setForceSubmitting] = useState(false);
  const [forceError, setForceError] = useState("");
  const [forceSuccess, setForceSuccess] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authFetch(`/api/operator/jobs/${jobId}`);
      if (res.status === 403) {
        setError("Access denied.");
        return;
      }
      if (res.status === 404) {
        setError("Job not found.");
        return;
      }
      if (!res.ok) {
        setError("Failed to load job detail.");
        return;
      }
      setData(await res.json());
    } catch {
      setError("Failed to load job detail.");
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleForceSubmit = useCallback(async () => {
    if (!forceReason.trim()) {
      setForceError("Reason is required.");
      return;
    }
    setForceSubmitting(true);
    setForceError("");
    setForceSuccess("");
    try {
      const res = await authFetch(`/api/operator/jobs/${jobId}/force-status`, {
        method: "POST",
        body: JSON.stringify({ status: forceStatus, reason: forceReason.trim() }),
      });
      if (res.status === 409) {
        setForceError("Job is already in a terminal status.");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setForceError(body?.error ?? "Failed to force status.");
        return;
      }
      setForceSuccess(`Status forced to ${forceStatus}.`);
      setShowForce(false);
      setForceReason("");
      // Refresh data to reflect the new status
      fetchData();
    } catch {
      setForceError("Failed to force status.");
    } finally {
      setForceSubmitting(false);
    }
  }, [jobId, forceStatus, forceReason, fetchData]);

  // ---------------------------------------------------------------------------
  // Render: loading / error / 404
  // ---------------------------------------------------------------------------

  if (error === "Access denied.") {
    return <p className="text-red-400 text-sm">403 -- Not authorized.</p>;
  }

  if (loading) return <p className="text-muted">Loading job detail...</p>;

  if (error === "Job not found.") {
    return (
      <div className="space-y-4">
        <Link href="/operator/jobs" className="text-xs text-accent hover:underline">
          &larr; Back to Jobs
        </Link>
        <p className="text-red-400 text-sm">404 -- Job not found.</p>
      </div>
    );
  }

  if (error) return <p className="text-red-400 text-sm">{error}</p>;
  if (!data) return null;

  const { job, user, action_logs, transaction, status_history } = data;
  const isTerminal = terminalSet.has(job.status);

  // ---------------------------------------------------------------------------
  // Render: job detail
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-8">
      {/* Back link */}
      <Link href="/operator/jobs" className="text-xs text-accent hover:underline">
        &larr; Back to Jobs
      </Link>

      {/* Job Header */}
      <section>
        <SectionHeader>Job Detail</SectionHeader>
        <div className="bg-surface border border-border rounded p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted font-mono">{job.id}</span>
            <StatusBadge status={job.status} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted">Service</p>
              <p className="text-foreground">{job.service_id}</p>
            </div>
            <div>
              <p className="text-xs text-muted">Action</p>
              <p className="text-foreground">{job.action}</p>
            </div>
            <div>
              <p className="text-xs text-muted">Trigger</p>
              <p className="text-foreground">{job.trigger}</p>
            </div>
            <div>
              <p className="text-xs text-muted">Created</p>
              <p className="text-foreground">{formatDate(job.created_at)}</p>
            </div>
          </div>
        </div>
      </section>

      {/* User */}
      <section>
        <SectionHeader>User</SectionHeader>
        <div className="bg-surface border border-border rounded p-4 text-sm">
          {user ? (
            <div className="space-y-1">
              <p className="text-xs text-muted">npub</p>
              <p className="text-foreground font-mono text-xs break-all">{user.nostr_npub}</p>
              <p className="text-xs text-muted mt-2">User ID</p>
              <p className="text-foreground font-mono text-xs">{user.id}</p>
            </div>
          ) : (
            <p className="text-muted">User deleted</p>
          )}
        </div>
      </section>

      {/* Status History */}
      <section>
        <SectionHeader>Status History</SectionHeader>
        {status_history.length > 0 ? (
          <div className="space-y-2">
            {status_history.map((entry) => (
              <div
                key={entry.id}
                className="bg-surface border border-border rounded p-3 flex flex-wrap items-center gap-3 text-sm"
              >
                <span className="text-muted text-xs whitespace-nowrap">
                  {formatDate(entry.created_at)}
                </span>
                <span className="text-foreground">
                  {entry.from_status ? (
                    <>
                      <StatusBadge status={entry.from_status} />
                      <span className="mx-2 text-muted">&rarr;</span>
                    </>
                  ) : (
                    <span className="text-muted mr-2">(initial)</span>
                  )}
                  <StatusBadge status={entry.to_status} />
                </span>
                <span className="text-xs text-muted ml-auto">by {entry.changed_by}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted text-sm">No status transitions recorded.</p>
        )}
      </section>

      {/* Action Logs */}
      <section>
        <SectionHeader>Action Logs</SectionHeader>
        {action_logs.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Flow</th>
                  <th className={thClass}>Result</th>
                  <th className={thClass}>Duration</th>
                  <th className={thClass}>Steps</th>
                  <th className={thClass}>Inference</th>
                  <th className={thClass}>Playbook</th>
                  <th className={thClass}>Error</th>
                  <th className={thClass}>Time</th>
                </tr>
              </thead>
              <tbody>
                {action_logs.map((log) => (
                  <tr key={log.id} className="border-b border-border/50">
                    <td className={tdClass}>{log.flow_type}</td>
                    <td
                      className={`px-3 py-2 text-sm font-medium ${
                        log.success ? "text-green-400" : "text-red-400"
                      }`}
                    >
                      {log.success ? "OK" : "FAIL"}
                    </td>
                    <td className={tdMuted}>
                      {log.duration_seconds != null ? `${log.duration_seconds}s` : "--"}
                    </td>
                    <td className={tdMuted}>{log.step_count ?? "--"}</td>
                    <td className={tdMuted}>{log.inference_count ?? "--"}</td>
                    <td className={tdMuted}>
                      {log.playbook_version != null ? `v${log.playbook_version}` : "--"}
                    </td>
                    <td className="px-3 py-2 text-xs text-red-400 max-w-xs truncate">
                      {log.error_message || "--"}
                    </td>
                    <td className={tdMuted}>{formatDate(log.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted text-sm">No action logs.</p>
        )}
      </section>

      {/* Transaction */}
      <section>
        <SectionHeader>Transaction</SectionHeader>
        <div className="bg-surface border border-border rounded p-4 text-sm">
          {transaction ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted">Amount</p>
                <p className="text-foreground">{formatSats(transaction.amount_sats)} sats</p>
              </div>
              <div>
                <p className="text-xs text-muted">Status</p>
                <p className="text-foreground">{transaction.status}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Created</p>
                <p className="text-foreground">{formatDate(transaction.created_at)}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Paid At</p>
                <p className="text-foreground">
                  {transaction.paid_at ? formatDate(transaction.paid_at) : "--"}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-muted">No transaction</p>
          )}
        </div>
      </section>

      {/* Billing Info */}
      <section>
        <SectionHeader>Billing Info</SectionHeader>
        <div className="bg-surface border border-border rounded p-4 text-sm">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-muted">Billing Date</p>
              <p className="text-foreground">
                {job.billing_date ? formatDate(job.billing_date) : "--"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted">Access End Date</p>
              <p className="text-foreground">
                {job.access_end_date ? formatDate(job.access_end_date) : "--"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted">Outreach Count</p>
              <p className="text-foreground">{job.outreach_count}</p>
            </div>
            <div>
              <p className="text-xs text-muted">Next Outreach At</p>
              <p className="text-foreground">
                {job.next_outreach_at ? formatDate(job.next_outreach_at) : "--"}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Force Status (non-terminal only) */}
      {!isTerminal && (
        <section>
          <SectionHeader>Force Status</SectionHeader>
          {forceSuccess && (
            <p className="text-green-400 text-sm mb-3">{forceSuccess}</p>
          )}
          {!showForce ? (
            <button
              type="button"
              onClick={() => setShowForce(true)}
              className="text-xs px-3 py-1.5 rounded bg-red-900/50 border border-red-700 text-red-300 hover:bg-red-900/80 transition-colors"
            >
              Force Terminal Status
            </button>
          ) : (
            <div className="bg-surface border border-border rounded p-4 space-y-4 max-w-md">
              <div>
                <label className="block text-xs text-muted mb-1">New Status</label>
                <select
                  value={forceStatus}
                  onChange={(e) => setForceStatus(e.target.value)}
                  className="w-full text-sm bg-background border border-border rounded px-2 py-1.5 text-foreground"
                >
                  {FORCE_STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">Reason</label>
                <textarea
                  value={forceReason}
                  onChange={(e) => setForceReason(e.target.value)}
                  rows={3}
                  className="w-full text-sm bg-background border border-border rounded px-2 py-1.5 text-foreground resize-none"
                  placeholder="Why are you forcing this status?"
                />
              </div>
              {forceError && (
                <p className="text-red-400 text-xs">{forceError}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleForceSubmit}
                  disabled={forceSubmitting}
                  className="text-xs px-3 py-1.5 rounded bg-red-900/50 border border-red-700 text-red-300 hover:bg-red-900/80 transition-colors disabled:opacity-40"
                >
                  {forceSubmitting ? "Submitting..." : "Confirm"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowForce(false);
                    setForceError("");
                    setForceReason("");
                  }}
                  className="text-xs px-3 py-1.5 rounded border border-border text-muted hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
