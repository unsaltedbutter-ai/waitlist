"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import QRCode from "react-qr-code";
import { useAuth, authFetch } from "@/lib/hooks/use-auth";

interface InvoiceResponse {
  invoiceId: string;
  checkoutLink: string;
  bolt11: string | null;
  amount_sats: number | null;
}

export default function AddCreditsPage() {
  const { loading: authLoading } = useAuth();
  const [amountStr, setAmountStr] = useState("");
  const [invoice, setInvoice] = useState<InvoiceResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [paid, setPaid] = useState(false);

  // Poll payment status when invoice exists
  useEffect(() => {
    if (!invoice || paid) return;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, 5000));
        if (cancelled) break;
        try {
          const res = await authFetch(
            `/api/credits/prepay/status?invoiceId=${invoice.invoiceId}`
          );
          if (res.ok) {
            const data = await res.json();
            if (data.status === "paid") {
              setPaid(true);
              break;
            }
          }
        } catch {
          // Network error, keep polling
        }
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [invoice, paid]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    setInvoice(null);

    try {
      const body: { amount_usd_cents?: number } = {};
      const trimmed = amountStr.trim();
      if (trimmed !== "") {
        const dollars = parseFloat(trimmed);
        if (isNaN(dollars) || dollars <= 0) {
          setError("Enter a valid dollar amount.");
          setSubmitting(false);
          return;
        }
        body.amount_usd_cents = Math.round(dollars * 100);
      }

      const res = await authFetch("/api/credits/prepay", {
        method: "POST",
        body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create invoice.");
        setSubmitting(false);
        return;
      }

      setInvoice(data);
    } catch {
      setError("Connection failed. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!invoice) return;
    try {
      await navigator.clipboard.writeText(invoice.bolt11 ?? invoice.checkoutLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Failed to copy to clipboard.");
    }
  }

  if (authLoading) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted">Loading...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background px-4 py-12">
      <div className="max-w-lg mx-auto">
        <h1 className="text-4xl font-bold tracking-tight text-foreground mb-2">
          Add credits
        </h1>
        <p className="text-muted mb-8">
          Your service credits cover membership and gift card purchases. Add
          credits in any amount via Lightning Network.
        </p>

        {paid ? (
          <div className="space-y-6">
            <div className="bg-surface border border-green-700 rounded p-6 text-center space-y-3">
              <p className="text-green-400 font-semibold text-lg">
                Payment received
              </p>
              <p className="text-muted text-sm">
                Your credits have been added to your account.
              </p>
            </div>
            <Link
              href="/dashboard"
              className="block w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors text-center"
            >
              Back to dashboard
            </Link>
          </div>
        ) : !invoice ? (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-muted mb-2">
                Amount (USD)
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                placeholder="Leave empty for open amount"
                className="w-full py-3 px-4 bg-surface border border-border rounded text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {submitting ? "Creating invoice..." : "Generate invoice"}
            </button>
          </form>
        ) : (
          <div className="space-y-6">
            <div className="bg-surface border border-border rounded p-6 flex flex-col items-center gap-4">
              <div className="bg-white p-4 rounded inline-block">
                <QRCode value={invoice.bolt11 ?? invoice.checkoutLink} size={220} />
              </div>
              {invoice.amount_sats !== null && (
                <p className="text-sm text-muted">
                  {invoice.amount_sats.toLocaleString()} sats
                </p>
              )}
            </div>

            <p className="text-sm text-muted text-center">
              Scan the Lightning invoice QR code or copy the invoice to pay from
              any Lightning wallet.
            </p>

            <button
              type="button"
              onClick={handleCopy}
              className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors"
            >
              {copied ? "Copied" : "Copy invoice"}
            </button>

            <div className="flex items-center justify-center gap-2 text-muted text-sm py-3">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Waiting for payment...
            </div>

            <a
              href={invoice.checkoutLink}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-center text-xs text-muted/50 hover:text-muted transition-colors"
            >
              Open checkout page instead
            </a>
          </div>
        )}

        {error && <p className="text-red-400 text-sm mt-4">{error}</p>}

        {!paid && (
          <div className="mt-8">
            <Link href="/dashboard" className="text-accent hover:underline text-sm">
              Back to dashboard
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
