"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth, authFetch } from "@/lib/hooks/use-auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JobsByService {
  service: string;
  pending: number;
  claimed: number;
  in_progress: number;
  completed: number;
  failed: number;
  dead_letter: number;
}

interface PerfRow {
  service_name: string;
  flow_type: string;
  total: number;
  succeeded: number;
  success_rate: number;
  avg_inference_steps: number;
  avg_duration_seconds: number;
  avg_steps: number;
}

interface CacheRow {
  service_name: string;
  pct_7d: number;
  pct_14d: number;
}

interface DeadLetterRow {
  id: string;
  service_name: string;
  flow_type: string;
  error_message: string | null;
  completed_at: string;
}

interface Alert {
  id: string;
  alert_type: string;
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  created_at: string;
}

interface WaitlistEntry {
  id: string;
  email: string | null;
  nostr_npub: string | null;
  current_services: string[] | null;
  invited: boolean;
  invited_at: string | null;
  created_at: string;
}

interface CapacityInfo {
  activeUsers: number;
  cap: number;
  availableSlots: number;
}

interface PendingRefund {
  id: string;
  contact: string;
  amount_sats: number;
  created_at: string;
}

interface LedgerMonth {
  month: string;
  membership_revenue: number;
  credit_deposits: number;
  gift_card_purchases: number;
  refunds: number;
  net_flow: number;
}

interface Metrics {
  jobs_today: {
    by_status: Record<string, number>;
    by_service: JobsByService[];
  };
  agent_performance: {
    "7d": PerfRow[];
    "30d": PerfRow[];
  };
  playbook_cache: CacheRow[];
  business: {
    users: Record<string, number>;
    subscriptions: Record<string, number>;
    sats_in_30d: number;
    sats_out_30d: number;
    margin_call_count: number;
    total_credit_liability: number;
    total_refund_liability: number;
  };
  dead_letter: DeadLetterRow[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSats(n: number): string {
  return n.toLocaleString("en-US");
}

function cacheColor(pct: number): string {
  if (pct >= 80) return "text-green-400";
  if (pct >= 50) return "text-amber-400";
  return "text-red-400";
}

function severityStyle(severity: string): string {
  if (severity === "critical")
    return "bg-red-900/50 border-red-700 text-red-300";
  if (severity === "warning")
    return "bg-amber-900/50 border-amber-700 text-amber-300";
  return "bg-neutral-800/50 border-neutral-700 text-neutral-300";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="bg-surface border border-border rounded p-4">
      <p className="text-xs text-muted mb-1">{label}</p>
      <p className="text-xl font-bold text-foreground">{value}</p>
      {sub && <p className="text-xs text-muted mt-1">{sub}</p>}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-medium text-muted mb-3 uppercase tracking-wide">
      {children}
    </h2>
  );
}

const thClass = "text-left text-xs font-medium text-muted px-3 py-2";
const tdClass = "px-3 py-2 text-sm text-foreground";
const tdMuted = "px-3 py-2 text-sm text-muted";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OperatorPage() {
  const { user, loading: authLoading } = useAuth();

  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [perfWindow, setPerfWindow] = useState<"7d" | "30d">("7d");
  const [ackingIds, setAckingIds] = useState<Set<string>>(new Set());
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [capacity, setCapacity] = useState<CapacityInfo | null>(null);
  const [generatingInvite, setGeneratingInvite] = useState<Set<string>>(
    new Set()
  );
  const [inviteLinks, setInviteLinks] = useState<Record<string, string>>({});
  const [refunds, setRefunds] = useState<PendingRefund[]>([]);
  const [ackingRefunds, setAckingRefunds] = useState<Set<string>>(new Set());
  const [ledger, setLedger] = useState<LedgerMonth[]>([]);

  // ---------- Fetch ----------

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [mRes, aRes, wRes, rRes, lRes] = await Promise.all([
        authFetch("/api/operator/metrics"),
        authFetch("/api/operator/alerts"),
        authFetch("/api/operator/waitlist"),
        authFetch("/api/operator/refunds"),
        authFetch("/api/operator/ledger"),
      ]);

      if (mRes.status === 403 || aRes.status === 403) {
        setError("Access denied.");
        setLoading(false);
        return;
      }

      if (!mRes.ok || !aRes.ok) {
        setError("Failed to load operator data.");
        setLoading(false);
        return;
      }

      const mData = await mRes.json();
      const aData = await aRes.json();
      setMetrics(mData);
      setAlerts(aData.alerts);

      if (wRes.ok) {
        const wData = await wRes.json();
        setWaitlist(wData.entries);
        setCapacity(wData.capacity);
      }

      if (rRes.ok) {
        const rData = await rRes.json();
        setRefunds(rData.refunds);
      }

      if (lRes.ok) {
        const lData = await lRes.json();
        setLedger(lData.months);
      }
    } catch {
      setError("Failed to load operator data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && user) {
      fetchAll();
    }
  }, [authLoading, user, fetchAll]);

  // ---------- Acknowledge ----------

  const acknowledge = useCallback(
    async (id: string) => {
      setAckingIds((prev) => new Set(prev).add(id));
      try {
        const res = await authFetch("/api/operator/alerts", {
          method: "POST",
          body: JSON.stringify({ ids: [id] }),
        });
        if (res.ok) {
          setAlerts((prev) => prev.filter((a) => a.id !== id));
        }
      } finally {
        setAckingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    []
  );

  // ---------- Generate Invite ----------

  const generateInvite = useCallback(
    async (waitlistId: string) => {
      setGeneratingInvite((prev) => new Set(prev).add(waitlistId));
      try {
        const res = await authFetch("/api/operator/invite", {
          method: "POST",
          body: JSON.stringify({ waitlistId }),
        });
        if (res.ok) {
          const data = await res.json();
          setInviteLinks((prev) => ({ ...prev, [waitlistId]: data.inviteLink }));
          setWaitlist((prev) =>
            prev.map((e) =>
              e.id === waitlistId
                ? { ...e, invited: true, invited_at: new Date().toISOString() }
                : e
            )
          );
          if (capacity) {
            setCapacity({
              ...capacity,
              availableSlots: capacity.availableSlots - 1,
            });
          }
        }
      } finally {
        setGeneratingInvite((prev) => {
          const next = new Set(prev);
          next.delete(waitlistId);
          return next;
        });
      }
    },
    [capacity]
  );

  // ---------- Acknowledge Refund ----------

  const acknowledgeRefund = useCallback(async (refundId: string) => {
    setAckingRefunds((prev) => new Set(prev).add(refundId));
    try {
      const res = await authFetch("/api/operator/refunds", {
        method: "DELETE",
        body: JSON.stringify({ refundId }),
      });
      if (res.ok) {
        setRefunds((prev) => prev.filter((r) => r.id !== refundId));
      }
    } finally {
      setAckingRefunds((prev) => {
        const next = new Set(prev);
        next.delete(refundId);
        return next;
      });
    }
  }, []);

  // ---------- Loading / Auth ----------

  if (authLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-muted">Loading...</p>
      </main>
    );
  }

  if (!user) return null;

  if (error === "Access denied.") {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-red-400 text-sm">403 — Not authorized.</p>
      </main>
    );
  }

  // ---------- Render ----------

  const perf = metrics?.agent_performance[perfWindow] ?? [];
  const jobs = metrics?.jobs_today;
  const biz = metrics?.business;

  return (
    <main className="min-h-screen">
      <div className="max-w-5xl mx-auto px-4 py-10 space-y-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          Operator
        </h1>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        {loading ? (
          <p className="text-muted">Loading metrics...</p>
        ) : (
          metrics && (
            <>
              {/* --------------------------------------------------------- */}
              {/* 1. Alerts Banner                                          */}
              {/* --------------------------------------------------------- */}
              {alerts.length > 0 && (
                <section className="space-y-2">
                  <SectionHeader>
                    Alerts ({alerts.length} unacknowledged)
                  </SectionHeader>
                  {alerts.map((a) => (
                    <div
                      key={a.id}
                      className={`flex items-start justify-between gap-4 border rounded p-3 ${severityStyle(a.severity)}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold uppercase">
                            {a.severity}
                          </span>
                          <span className="text-sm font-medium truncate">
                            {a.title}
                          </span>
                        </div>
                        <p className="text-xs opacity-80 line-clamp-2">
                          {a.message}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => acknowledge(a.id)}
                        disabled={ackingIds.has(a.id)}
                        className="shrink-0 text-xs px-2 py-1 rounded border border-current opacity-70 hover:opacity-100 transition-opacity disabled:opacity-30"
                      >
                        Ack
                      </button>
                    </div>
                  ))}
                </section>
              )}

              {/* --------------------------------------------------------- */}
              {/* 2. Jobs Today                                             */}
              {/* --------------------------------------------------------- */}
              <section>
                <SectionHeader>Jobs Today</SectionHeader>
                {jobs && jobs.by_service.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border">
                          <th className={thClass}>Service</th>
                          <th className={thClass}>Pending</th>
                          <th className={thClass}>In Progress</th>
                          <th className={thClass}>Completed</th>
                          <th className={thClass}>Failed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {jobs.by_service.map((s) => (
                          <tr
                            key={s.service}
                            className="border-b border-border/50"
                          >
                            <td className={tdClass}>{s.service}</td>
                            <td className={tdMuted}>
                              {s.pending + s.claimed}
                            </td>
                            <td className={tdClass}>{s.in_progress}</td>
                            <td className="px-3 py-2 text-sm text-green-400">
                              {s.completed}
                            </td>
                            <td className="px-3 py-2 text-sm text-red-400">
                              {s.failed + s.dead_letter}
                            </td>
                          </tr>
                        ))}
                        <tr className="font-medium">
                          <td className={tdClass}>Total</td>
                          <td className={tdMuted}>
                            {(jobs.by_status.pending || 0) +
                              (jobs.by_status.claimed || 0)}
                          </td>
                          <td className={tdClass}>
                            {jobs.by_status.in_progress || 0}
                          </td>
                          <td className="px-3 py-2 text-sm text-green-400">
                            {jobs.by_status.completed || 0}
                          </td>
                          <td className="px-3 py-2 text-sm text-red-400">
                            {(jobs.by_status.failed || 0) +
                              (jobs.by_status.dead_letter || 0)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-muted text-sm">
                    No jobs scheduled for today.
                  </p>
                )}
              </section>

              {/* --------------------------------------------------------- */}
              {/* 3. Agent Performance                                      */}
              {/* --------------------------------------------------------- */}
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
                          <tr
                            key={i}
                            className="border-b border-border/50"
                          >
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
                            <td className={tdMuted}>
                              {r.avg_duration_seconds}s
                            </td>
                            <td className={tdMuted}>
                              {r.avg_inference_steps}
                            </td>
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

              {/* --------------------------------------------------------- */}
              {/* 4. Playbook Cache                                         */}
              {/* --------------------------------------------------------- */}
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
                  <p className="text-muted text-sm">
                    No playbook data yet.
                  </p>
                )}
              </section>

              {/* --------------------------------------------------------- */}
              {/* 5. Business                                               */}
              {/* --------------------------------------------------------- */}
              <section>
                <SectionHeader>Business</SectionHeader>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  <StatCard
                    label="Active Users"
                    value={biz?.users?.active ?? 0}
                  />
                  <StatCard
                    label="Active Subs"
                    value={
                      (biz?.subscriptions?.active ?? 0) +
                      (biz?.subscriptions?.lapsing ?? 0) +
                      (biz?.subscriptions?.signup_scheduled ?? 0)
                    }
                  />
                  <StatCard
                    label="Sats In (30d)"
                    value={formatSats(biz?.sats_in_30d ?? 0)}
                  />
                  <StatCard
                    label="Sats Out (30d)"
                    value={formatSats(biz?.sats_out_30d ?? 0)}
                  />
                  <StatCard
                    label="Margin Call Risk"
                    value={biz?.margin_call_count ?? 0}
                    sub={
                      (biz?.margin_call_count ?? 0) > 0
                        ? "users underfunded"
                        : undefined
                    }
                  />
                </div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <StatCard
                    label="Credit Liability"
                    value={`${formatSats(biz?.total_credit_liability ?? 0)} sats`}
                    sub="total user balances"
                  />
                  <StatCard
                    label="Refund Liability"
                    value={`${formatSats(biz?.total_refund_liability ?? 0)} sats`}
                    sub="owed to deleted users"
                  />
                </div>
              </section>

              {/* --------------------------------------------------------- */}
              {/* Monthly Ledger                                             */}
              {/* --------------------------------------------------------- */}
              <section>
                <SectionHeader>Monthly Ledger</SectionHeader>
                {ledger.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border">
                          <th className={thClass}>Month</th>
                          <th className={thClass}>Membership</th>
                          <th className={thClass}>Deposits</th>
                          <th className={thClass}>Gift Cards</th>
                          <th className={thClass}>Refunds</th>
                          <th className={thClass}>Net Flow</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ledger.map((m) => (
                          <tr
                            key={m.month}
                            className="border-b border-border/50"
                          >
                            <td className={tdClass}>{m.month}</td>
                            <td className={tdMuted}>
                              {formatSats(m.membership_revenue)}
                            </td>
                            <td className="px-3 py-2 text-sm text-green-400">
                              {formatSats(m.credit_deposits)}
                            </td>
                            <td className="px-3 py-2 text-sm text-red-400">
                              {formatSats(m.gift_card_purchases)}
                            </td>
                            <td className="px-3 py-2 text-sm text-red-400">
                              {formatSats(m.refunds)}
                            </td>
                            <td
                              className={`px-3 py-2 text-sm font-medium ${
                                m.net_flow >= 0
                                  ? "text-green-400"
                                  : "text-red-400"
                              }`}
                            >
                              {m.net_flow >= 0 ? "+" : ""}
                              {formatSats(m.net_flow)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-muted text-sm">
                    No transaction data yet.
                  </p>
                )}
              </section>

              {/* --------------------------------------------------------- */}
              {/* 6. Pending Refunds                                        */}
              {/* --------------------------------------------------------- */}
              {refunds.length > 0 && (
                <section>
                  <SectionHeader>
                    Pending Refunds ({refunds.length})
                  </SectionHeader>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border">
                          <th className={thClass}>Contact</th>
                          <th className={thClass}>Balance</th>
                          <th className={thClass}>Deleted</th>
                          <th className={thClass}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {refunds.map((r) => (
                          <tr
                            key={r.id}
                            className="border-b border-border/50"
                          >
                            <td className={tdClass}>{r.contact}</td>
                            <td
                              className={`px-3 py-2 text-sm font-medium ${
                                r.amount_sats > 0
                                  ? "text-amber-400"
                                  : "text-muted"
                              }`}
                            >
                              {formatSats(r.amount_sats)} sats
                            </td>
                            <td className={tdMuted}>
                              {formatDate(r.created_at)}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() => acknowledgeRefund(r.id)}
                                disabled={ackingRefunds.has(r.id)}
                                className="text-xs px-2 py-1 rounded border border-current text-muted opacity-70 hover:opacity-100 transition-opacity disabled:opacity-30"
                              >
                                {ackingRefunds.has(r.id)
                                  ? "Removing..."
                                  : "Acknowledge"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {/* --------------------------------------------------------- */}
              {/* 7. Waitlist Management                                    */}
              {/* --------------------------------------------------------- */}
              <section>
                <SectionHeader>Waitlist Management</SectionHeader>

                {/* Capacity bar */}
                {capacity && (
                  <div className="mb-4">
                    <div className="flex justify-between text-xs text-muted mb-1">
                      <span>
                        {capacity.activeUsers.toLocaleString()} /{" "}
                        {capacity.cap.toLocaleString()} active users
                      </span>
                      <span>
                        {capacity.availableSlots.toLocaleString()} slots
                        available
                      </span>
                    </div>
                    <div className="w-full h-2 bg-surface border border-border rounded overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          capacity.activeUsers / capacity.cap > 0.9
                            ? "bg-red-500"
                            : capacity.activeUsers / capacity.cap > 0.7
                              ? "bg-amber-500"
                              : "bg-green-500"
                        }`}
                        style={{
                          width: `${Math.min(100, (capacity.activeUsers / capacity.cap) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Waitlist table */}
                {waitlist.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border">
                          <th className={thClass}>Contact</th>
                          <th className={thClass}>Services</th>
                          <th className={thClass}>Signed Up</th>
                          <th className={thClass}>Status</th>
                          <th className={thClass}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {waitlist.map((entry) => (
                          <tr
                            key={entry.id}
                            className="border-b border-border/50"
                          >
                            <td className={tdClass}>
                              {entry.email ??
                                (entry.nostr_npub
                                  ? `${entry.nostr_npub.slice(0, 12)}...`
                                  : "—")}
                            </td>
                            <td className={tdMuted}>
                              {entry.current_services?.join(", ") ?? "—"}
                            </td>
                            <td className={tdMuted}>
                              {formatDate(entry.created_at)}
                            </td>
                            <td className={tdClass}>
                              {entry.invited ? (
                                <span className="text-xs px-2 py-0.5 bg-green-900/40 text-green-400 rounded">
                                  Invited{" "}
                                  {entry.invited_at
                                    ? formatDate(entry.invited_at)
                                    : ""}
                                </span>
                              ) : (
                                <span className="text-xs text-muted">
                                  Waiting
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {entry.invited ? (
                                inviteLinks[entry.id] ? (
                                  <input
                                    readOnly
                                    value={inviteLinks[entry.id]}
                                    onClick={(e) => {
                                      (e.target as HTMLInputElement).select();
                                      navigator.clipboard.writeText(
                                        inviteLinks[entry.id]
                                      );
                                    }}
                                    className="text-xs bg-surface border border-border rounded px-2 py-1 text-foreground w-48 cursor-pointer"
                                    title="Click to copy"
                                  />
                                ) : (
                                  <span className="text-xs text-muted">—</span>
                                )
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => generateInvite(entry.id)}
                                  disabled={
                                    generatingInvite.has(entry.id) ||
                                    (capacity?.availableSlots ?? 0) === 0
                                  }
                                  className="text-xs px-2 py-1 rounded border border-accent text-accent hover:bg-accent hover:text-background transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                >
                                  {generatingInvite.has(entry.id)
                                    ? "Generating..."
                                    : "Generate Invite"}
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-muted text-sm">No waitlist entries.</p>
                )}
              </section>

              {/* --------------------------------------------------------- */}
              {/* 7. Dead Letter                                            */}
              {/* --------------------------------------------------------- */}
              <section>
                <SectionHeader>Dead Letter Queue</SectionHeader>
                {metrics.dead_letter.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border">
                          <th className={thClass}>Service</th>
                          <th className={thClass}>Flow</th>
                          <th className={thClass}>Error</th>
                          <th className={thClass}>Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {metrics.dead_letter.map((r) => (
                          <tr
                            key={r.id}
                            className="border-b border-border/50"
                          >
                            <td className={tdClass}>{r.service_name}</td>
                            <td className={tdMuted}>{r.flow_type}</td>
                            <td
                              className="px-3 py-2 text-sm text-red-400 max-w-xs truncate"
                              title={r.error_message ?? ""}
                            >
                              {r.error_message ?? "—"}
                            </td>
                            <td className={tdMuted}>
                              {r.completed_at
                                ? formatDate(r.completed_at)
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-muted text-sm">
                    No dead letter jobs.
                  </p>
                )}
              </section>
            </>
          )
        )}
      </div>
    </main>
  );
}
