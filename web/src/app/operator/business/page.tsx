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
    return <p className="text-red-400 text-sm">403 — Not authorized.</p>;
  }

  if (loading) return <p className="text-muted">Loading business data...</p>;
  if (error) return <p className="text-red-400 text-sm">{error}</p>;
  if (!metrics) return null;

  const biz = metrics.business;

  return (
    <div className="space-y-8">
      {/* Business stat cards */}
      <section>
        <SectionHeader>Business</SectionHeader>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatCard label="Active Users" value={biz.users?.active ?? 0} />
          <StatCard
            label="Active Subs"
            value={
              (biz.subscriptions?.active ?? 0) +
              (biz.subscriptions?.lapsing ?? 0) +
              (biz.subscriptions?.signup_scheduled ?? 0)
            }
          />
          <StatCard
            label="Sats In (30d)"
            value={formatSats(biz.sats_in_30d ?? 0)}
          />
          <StatCard
            label="Sats Out (30d)"
            value={formatSats(biz.sats_out_30d ?? 0)}
          />
          <StatCard
            label="Margin Call Risk"
            value={biz.margin_call_count ?? 0}
            sub={
              (biz.margin_call_count ?? 0) > 0
                ? "users underfunded"
                : undefined
            }
          />
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <StatCard
            label="Credit Liability"
            value={`${formatSats(biz.total_credit_liability ?? 0)} sats`}
            sub="total user balances"
          />
          <StatCard
            label="Refund Liability"
            value={`${formatSats(biz.total_refund_liability ?? 0)} sats`}
            sub="owed to deleted users"
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
                  <th className={thClass}>Membership</th>
                  <th className={thClass}>Deposits</th>
                  <th className={thClass}>Gift Cards</th>
                  <th className={thClass}>Refunds</th>
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
                    <td className="px-3 py-2 text-sm text-red-400">
                      {formatSats(m.gift_card_purchases)}
                    </td>
                    <td className="px-3 py-2 text-sm text-red-400">
                      {formatSats(m.refunds)}
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
