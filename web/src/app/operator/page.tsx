"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { authFetch } from "@/lib/hooks/use-auth";
import {
  Alert,
  Metrics,
  SectionHeader,
  severityStyle,
  formatSats,
} from "./_components";

export default function OperatorHubPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [ackingIds, setAckingIds] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [mRes, aRes] = await Promise.all([
        authFetch("/api/operator/metrics"),
        authFetch("/api/operator/alerts"),
      ]);
      if (mRes.status === 403 || aRes.status === 403) {
        setError("Access denied.");
        return;
      }
      if (!mRes.ok || !aRes.ok) {
        setError("Failed to load operator data.");
        return;
      }
      setMetrics(await mRes.json());
      const aData = await aRes.json();
      setAlerts(aData.alerts);
    } catch {
      setError("Failed to load operator data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const acknowledge = useCallback(async (id: string) => {
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
  }, []);

  if (error === "Access denied.") {
    return <p className="text-red-400 text-sm">403 -- Not authorized.</p>;
  }

  if (loading) return <p className="text-muted">Loading...</p>;
  if (error) return <p className="text-red-400 text-sm">{error}</p>;

  // Compute summary values
  const jobs = metrics?.jobs_today;
  const totalJobs = jobs
    ? Object.values(jobs.by_status).reduce((a, b) => a + b, 0)
    : 0;
  const completedPaid = jobs?.by_status.completed_paid || 0;
  const successRate =
    jobs && totalJobs > 0
      ? Math.round((completedPaid / totalJobs) * 100)
      : 0;

  const biz = metrics?.business;
  const totalUsers = biz?.total_users ?? 0;
  const satsIn = biz?.sats_in_30d ?? 0;
  const totalDebt = biz?.total_debt ?? 0;
  const problemJobCount = metrics?.problem_jobs?.length ?? 0;

  const navCards = [
    {
      href: "/operator/jobs",
      title: "Jobs & Agent Health",
      lines: [
        `${totalJobs} jobs today`,
        `${successRate}% success rate`,
      ],
    },
    {
      href: "/operator/members",
      title: "Members",
      lines: [
        `${totalUsers} total users`,
        `${formatSats(totalDebt)} sats total debt`,
      ],
    },
    {
      href: "/operator/business",
      title: "Revenue & Export",
      lines: [
        `${formatSats(satsIn)} sats earned (30d)`,
        "CSV export for taxes",
      ],
    },
    {
      href: "/operator/waitlist",
      title: "Waitlist",
      lines: ["View capacity & invites"],
    },
    {
      href: "/operator/health",
      title: "System Health",
      lines: ["Orchestrator, agent, inference"],
    },
    {
      href: "/operator/blocklist",
      title: "Blocklist",
      lines: ["Reneged email management"],
    },
    {
      href: "/operator/dead-letter",
      title: "Problem Jobs",
      lines: [`${problemJobCount} items`],
    },
  ];

  return (
    <div className="space-y-8">
      {/* Alerts Banner */}
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
                <p className="text-xs opacity-80 line-clamp-2">{a.message}</p>
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

      {/* Navigation Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {navCards.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="bg-surface border border-border rounded p-5 hover:border-accent transition-colors group"
          >
            <h3 className="text-sm font-semibold text-foreground group-hover:text-accent mb-2">
              {card.title}
            </h3>
            {card.lines.map((line, i) => (
              <p key={i} className="text-xs text-muted">
                {line}
              </p>
            ))}
          </Link>
        ))}
      </div>
    </div>
  );
}
