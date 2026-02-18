"use client";

import { useState, useEffect, useCallback } from "react";
import { authFetch } from "@/lib/hooks/use-auth";
import {
  Metrics,
  LedgerMonth,
  StatCard,
  SectionHeader,
  formatSats,
  thClass,
  tdClass,
  tdMuted,
} from "../_components";

export default function BusinessPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [ledger, setLedger] = useState<LedgerMonth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [mRes, lRes] = await Promise.all([
        authFetch("/api/operator/metrics"),
        authFetch("/api/operator/ledger"),
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
      if (lRes.ok) {
        const lData = await lRes.json();
        setLedger(lData.months);
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

  // TODO: once GET /api/operator/stats returns job-based revenue
  // (earned_sats, outstanding_debt_sats), replace sats_in/sats_out
  // with those values.

  return (
    <div className="space-y-8">
      {/* Business stat cards */}
      <section>
        <SectionHeader>Revenue & Users</SectionHeader>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          <StatCard label="Active Users" value={biz.users?.active ?? 0} />
          <StatCard
            label="Jobs Revenue (30d)"
            value={`${formatSats(biz.sats_in_30d ?? 0)} sats`}
            sub="earned from cancel/resume jobs"
          />
          <StatCard
            label="Outstanding Debt"
            value={`${formatSats(biz.sats_out_30d ?? 0)} sats`}
            sub="unpaid user balances"
          />
          <StatCard
            label="Underfunded Users"
            value={biz.margin_call_count ?? 0}
            sub={
              (biz.margin_call_count ?? 0) > 0
                ? "users with debt"
                : undefined
            }
          />
        </div>
      </section>

      {/* Monthly Ledger */}
      <section>
        <SectionHeader>Monthly Ledger</SectionHeader>
        {ledger.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Month</th>
                  <th className={thClass}>Jobs Revenue</th>
                  <th className={thClass}>Payments In</th>
                  <th className={thClass}>Net Flow</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((m) => (
                  <tr key={m.month} className="border-b border-border/50">
                    <td className={tdClass}>{m.month}</td>
                    <td className={tdMuted}>
                      {formatSats(m.membership_revenue)}
                    </td>
                    <td className="px-3 py-2 text-sm text-green-400">
                      {formatSats(m.credit_deposits)}
                    </td>
                    <td
                      className={`px-3 py-2 text-sm font-medium ${
                        m.net_flow >= 0 ? "text-green-400" : "text-red-400"
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
          <p className="text-muted text-sm">No transaction data yet.</p>
        )}
      </section>
    </div>
  );
}
