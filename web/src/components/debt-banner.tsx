"use client";

import { useState, useEffect, useCallback } from "react";
import QRCode from "react-qr-code";
import { authFetch } from "@/lib/hooks/use-auth";
import { formatDate } from "@/lib/format";

interface RenegedJob {
  id: string;
  service_name: string;
  action: string;
  amount_sats: number;
  status_updated_at: string;
}

interface DebtData {
  debt_sats: number;
  reneged_jobs: RenegedJob[];
}

interface InvoiceData {
  invoice_id: string;
  bolt11?: string;
  amount_sats: number;
  already_exists?: boolean;
}

function formatSats(n: number): string {
  return n.toLocaleString("en-US");
}

function actionLabel(action: string): string {
  return action === "cancel" ? "Cancel" : action === "resume" ? "Resume" : action;
}

export function DebtBanner() {
  const [debt, setDebt] = useState<DebtData | null>(null);
  const [loading, setLoading] = useState(true);
  const [invoice, setInvoice] = useState<InvoiceData | null>(null);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const fetchDebt = useCallback(async () => {
    try {
      const res = await authFetch("/api/debt");
      if (!res.ok) return;
      const data = await res.json();
      setDebt(data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDebt();
  }, [fetchDebt]);

  if (loading || !debt || debt.debt_sats <= 0) return null;

  async function handlePay() {
    setPaying(true);
    setError("");
    try {
      const res = await authFetch("/api/debt/pay", { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to create invoice.");
        return;
      }
      const data = await res.json();
      setInvoice(data);
    } catch {
      setError("Failed to create invoice.");
    } finally {
      setPaying(false);
    }
  }

  function handleCopyBolt11() {
    if (!invoice?.bolt11) return;
    navigator.clipboard.writeText(invoice.bolt11);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="bg-red-900/20 border border-red-700 rounded p-5 space-y-4">
      <div>
        <h3 className="text-sm font-medium text-red-300">
          Outstanding balance: {formatSats(debt.debt_sats)} sats
        </h3>
        <p className="text-xs text-red-400/80 mt-1">
          Our records indicate you owe us a few sats.
        </p>
      </div>

      {/* Job breakdown */}
      {debt.reneged_jobs.length > 0 && (
        <div className="space-y-1">
          {debt.reneged_jobs.map((job) => (
            <div
              key={job.id}
              className="flex items-center justify-between text-sm py-1.5 border-b border-red-800/40 last:border-0"
            >
              <div className="flex items-center gap-2">
                <span className="text-red-200">{job.service_name}</span>
                <span className="text-red-400/70 text-xs">
                  {actionLabel(job.action)}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-red-300 text-xs">
                  {formatDate(job.status_updated_at)}
                </span>
                <span className="text-red-200 font-medium text-xs">
                  {formatSats(job.amount_sats)} sats
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-red-400 text-xs">{error}</p>}

      {/* Invoice display */}
      {invoice ? (
        <div className="bg-neutral-900 border border-neutral-700 rounded p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">
              Lightning Invoice
            </span>
            <span className="text-xs text-muted">
              {formatSats(invoice.amount_sats)} sats
            </span>
          </div>

          {invoice.bolt11 && (
            <>
              {/* QR code */}
              <div className="flex justify-center bg-white rounded p-3">
                <QRCode
                  value={invoice.bolt11}
                  size={180}
                  level="M"
                />
              </div>

              {/* Bolt11 string with copy */}
              <div className="space-y-2">
                <p className="text-xs text-muted font-mono break-all leading-relaxed max-h-20 overflow-y-auto">
                  {invoice.bolt11}
                </p>
                <button
                  type="button"
                  onClick={handleCopyBolt11}
                  className="w-full py-2 px-3 bg-surface border border-border text-foreground text-sm font-medium rounded hover:border-muted transition-colors"
                >
                  {copied ? "Copied!" : "Copy invoice"}
                </button>
              </div>
            </>
          )}

          {invoice.already_exists && (
            <p className="text-xs text-amber-400">
              An invoice already exists for this debt. Pay the invoice above, or contact the bot for a new one.
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={handlePay}
          disabled={paying}
          className="w-full py-2.5 px-4 bg-amber-700 text-amber-100 font-semibold text-sm rounded hover:bg-amber-600 transition-colors disabled:opacity-50"
        >
          {paying ? "Creating invoice..." : "Pay now"}
        </button>
      )}
    </div>
  );
}
