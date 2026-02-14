"use client";

import { useState } from "react";
import { SERVICES } from "@/lib/services";

export default function WaitlistPage() {
  const [contactType, setContactType] = useState<"email" | "npub">("email");
  const [contactValue, setContactValue] = useState("");
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [monthlySpend, setMonthlySpend] = useState("");
  const [referralSource, setReferralSource] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");

  function toggleService(id: string) {
    setSelectedServices((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setErrorMsg("");

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactType,
          contactValue,
          currentServices: selectedServices,
          monthlySpend: monthlySpend ? parseFloat(monthlySpend) : undefined,
          referralSource: referralSource || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setStatus("error");
        setErrorMsg(data.error || "Something went wrong.");
        return;
      }

      setStatus("success");
    } catch {
      setStatus("error");
      setErrorMsg("Connection failed. Try again.");
    }
  }

  if (status === "success") {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-lg w-full text-center">
          <h1 className="text-3xl font-bold mb-4 text-foreground">
            You&apos;re in.
          </h1>
          <p className="text-muted text-lg">
            First rule: you don&apos;t talk about the waitlist.
            <br />
            We&apos;ll reach out when it&apos;s your turn.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-16">
      <div className="max-w-lg w-full">
        {/* Header */}
        <div className="mb-12 text-center">
          <h1 className="text-4xl font-bold tracking-tight mb-4 text-foreground">
            Stop paying for streaming you&apos;re not watching.
          </h1>
          <p className="text-lg text-muted leading-relaxed">
            One subscription at a time, rotated automatically. You watch
            what&apos;s on, we handle the rest. $9.99/mo&nbsp;in&nbsp;Bitcoin.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Contact type toggle */}
          <div>
            <label className="block text-sm font-medium text-muted mb-2">
              How should we reach you?
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setContactType("email")}
                className={`flex-1 py-2 px-4 rounded text-sm font-medium border transition-colors ${
                  contactType === "email"
                    ? "bg-accent text-background border-accent"
                    : "bg-surface text-muted border-border hover:border-muted"
                }`}
              >
                Email
              </button>
              <button
                type="button"
                onClick={() => setContactType("npub")}
                className={`flex-1 py-2 px-4 rounded text-sm font-medium border transition-colors ${
                  contactType === "npub"
                    ? "bg-accent text-background border-accent"
                    : "bg-surface text-muted border-border hover:border-muted"
                }`}
              >
                Nostr npub
              </button>
            </div>
          </div>

          {/* Contact input */}
          <div>
            <input
              type={contactType === "email" ? "email" : "text"}
              required
              value={contactValue}
              onChange={(e) => setContactValue(e.target.value)}
              placeholder={
                contactType === "email" ? "you@example.com" : "npub1..."
              }
              className="w-full py-3 px-4 bg-surface border border-border rounded text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
            />
          </div>

          {/* Streaming services */}
          <div>
            <label className="block text-sm font-medium text-muted mb-3">
              What are you paying for right now?
            </label>
            <div className="grid grid-cols-2 gap-2">
              {SERVICES.map((svc) => (
                <button
                  key={svc.id}
                  type="button"
                  onClick={() => toggleService(svc.id)}
                  className={`py-2 px-3 rounded text-sm border transition-colors text-left ${
                    selectedServices.includes(svc.id)
                      ? "bg-accent/10 text-accent border-accent/40"
                      : "bg-surface text-muted border-border hover:border-muted"
                  }`}
                >
                  {svc.label}
                </button>
              ))}
            </div>
          </div>

          {/* Monthly spend */}
          <div>
            <label className="block text-sm font-medium text-muted mb-2">
              Monthly streaming spend (optional)
            </label>
            <div className="relative">
              <span className="absolute left-4 top-3 text-muted">$</span>
              <input
                type="number"
                min="0"
                step="1"
                value={monthlySpend}
                onChange={(e) => setMonthlySpend(e.target.value)}
                placeholder="0"
                className="w-full py-3 pl-8 pr-4 bg-surface border border-border rounded text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          {/* Referral */}
          <div>
            <label className="block text-sm font-medium text-muted mb-2">
              How&apos;d you hear about us? (optional)
            </label>
            <input
              type="text"
              value={referralSource}
              onChange={(e) => setReferralSource(e.target.value)}
              placeholder="A friend, Twitter, etc."
              className="w-full py-3 px-4 bg-surface border border-border rounded text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
            />
          </div>

          {/* Error */}
          {status === "error" && (
            <p className="text-red-400 text-sm">{errorMsg}</p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={status === "submitting"}
            className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
          >
            {status === "submitting" ? "Submitting..." : "Get on the list"}
          </button>
        </form>

        {/* Footer */}
        <p className="text-center text-muted/60 text-xs mt-12">
          Spots limited. Bitcoin only. No refunds on time wasted paying for five
          services at once.
        </p>
      </div>
    </main>
  );
}
