"use client";

import { useState, useEffect, useCallback } from "react";
import { authFetch } from "@/lib/hooks/use-auth";
import {
  PendingRefund,
  SectionHeader,
  formatSats,
  formatDate,
  thClass,
  tdClass,
  tdMuted,
} from "../_components";

export default function RefundsPage() {
  const [refunds, setRefunds] = useState<PendingRefund[]>([]);
  const [ackingRefunds, setAckingRefunds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authFetch("/api/operator/refunds");
      if (res.status === 403) {
        setError("Access denied.");
        return;
      }
      if (!res.ok) {
        setError("Failed to load refunds.");
        return;
      }
      const data = await res.json();
      setRefunds(data.refunds);
    } catch {
      setError("Failed to load refunds.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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

  if (error === "Access denied.") {
    return <p className="text-red-400 text-sm">403 — Not authorized.</p>;
  }

  if (loading) return <p className="text-muted">Loading refunds...</p>;
  if (error) return <p className="text-red-400 text-sm">{error}</p>;

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader>Pending Refunds ({refunds.length})</SectionHeader>
        {refunds.length > 0 ? (
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
                  <tr key={r.id} className="border-b border-border/50">
                    <td className={tdClass}>{r.contact}</td>
                    <td
                      className={`px-3 py-2 text-sm font-medium ${
                        r.amount_sats > 0 ? "text-amber-400" : "text-muted"
                      }`}
                    >
                      {formatSats(r.amount_sats)} sats
                    </td>
                    <td className={tdMuted}>{formatDate(r.created_at)}</td>
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
        ) : (
          <p className="text-muted text-sm">No pending refunds.</p>
        )}
      </section>
    </div>
  );
}
