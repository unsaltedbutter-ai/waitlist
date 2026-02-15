"use client";

import { useState } from "react";

export default function WaitlistPage() {
  const [contactType, setContactType] = useState<"email" | "npub">("npub");
  const [contactValue, setContactValue] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");

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
          currentServices: [],
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
            You&apos;re on the list.
          </h1>
          <p className="text-muted text-lg">
            The first rule about UnsaltedButter: you do not talk about
            UnsaltedButter.
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
            Not watching? Stop paying.
          </h1>
          <p className="text-lg text-muted leading-relaxed">
            Let us help you manage your streaming costs.
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
                onClick={() => setContactType("npub")}
                className={`flex-1 py-2 px-4 rounded text-sm font-medium border transition-colors ${
                  contactType === "npub"
                    ? "bg-accent text-background border-accent"
                    : "bg-surface text-muted border-border hover:border-muted"
                }`}
              >
                Nostr npub
              </button>
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
          Invite only. Bitcoin only.
        </p>
      </div>
    </main>
  );
}
