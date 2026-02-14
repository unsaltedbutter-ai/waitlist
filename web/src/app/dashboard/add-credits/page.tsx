"use client";

import { useState } from "react";
import Link from "next/link";
import QRCode from "react-qr-code";
import { useAuth, authFetch } from "@/lib/hooks/use-auth";

interface InvoiceResponse {
  invoiceId: string;
  checkoutLink: string;
  amount_sats: number | null;
}

export default function AddCreditsPage() {
  const { loading: authLoading } = useAuth();
  const [amountStr, setAmountStr] = useState("");
  const [invoice, setInvoice] = useState<InvoiceResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

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
      await navigator.clipboard.writeText(invoice.checkoutLink);
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

        {!invoice ? (
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
                <QRCode value={invoice.checkoutLink} size={220} />
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
              {copied ? "Copied" : "Copy invoice link"}
            </button>
          </div>
        )}

        {error && <p className="text-red-400 text-sm mt-4">{error}</p>}

        <div className="mt-8">
          <Link href="/dashboard" className="text-accent hover:underline text-sm">
            Back to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
