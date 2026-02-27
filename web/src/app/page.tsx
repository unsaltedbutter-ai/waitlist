"use client";

import { useState } from "react";
import { BotChip } from "@/components/bot-chip";

export default function WaitlistPage() {
  const [npub, setNpub] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [autoInvited, setAutoInvited] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setErrorMsg("");

    const trimmed = npub.trim();
    if (!trimmed.startsWith("npub1")) {
      setStatus("error");
      setErrorMsg("Enter a valid Nostr npub (starts with npub1).");
      return;
    }

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nostrNpub: trimmed }),
      });

      const data = await res.json();

      if (!res.ok) {
        setStatus("error");
        setErrorMsg(data.error || "Something went wrong.");
        return;
      }

      setAutoInvited(!!data.autoInvited);
      setStatus("success");
    } catch {
      setStatus("error");
      setErrorMsg("Connection failed. Try again.");
    }
  }

  if (status === "success") {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full text-center">
          {autoInvited ? (
            <>
              <h1 className="text-3xl font-bold mb-4 text-foreground">
                Check your Nostr DMs.
              </h1>
              <p className="text-muted text-lg">
                We sent you a login link. It expires in 15 minutes.
                <br />
                <br />
                If it expires, just DM &apos;login&apos; to the bot for a fresh one.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-bold mb-4 text-foreground">
                You&apos;re on the list.
              </h1>
              <p className="text-muted text-lg">
                The first rule about UnsaltedButter:
                <br />
                you do not talk about UnsaltedButter.
                <br />
                <br />
                We&apos;ll reach out when it&apos;s your turn.
              </p>
            </>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-16">
      <div className="max-w-md w-full text-center">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-12 text-white leading-tight">
          Not watching?<br />Stop paying.
        </h1>

        <form onSubmit={handleSubmit} className="space-y-4 mb-12">
          <div className="text-left">
            <label className="block text-xs font-semibold text-muted/70 uppercase tracking-wider mb-2">
              Your Nostr npub
            </label>
            <input
              type="text"
              required
              value={npub}
              onChange={(e) => setNpub(e.target.value)}
              placeholder="npub1..."
              className="w-full py-4 px-5 bg-surface border border-border rounded-xl text-foreground text-base placeholder:text-muted/40 focus:outline-none focus:border-accent/40 transition-colors"
            />
          </div>

          {status === "error" && (
            <p className="text-red-400 text-sm">{errorMsg}</p>
          )}

          <button
            type="submit"
            disabled={status === "submitting"}
            className="w-full py-4 px-4 bg-accent text-background font-semibold text-base rounded-xl hover:shadow-[0_6px_24px_rgba(245,158,11,0.3)] hover:-translate-y-px active:translate-y-0 transition-all disabled:opacity-50"
          >
            {status === "submitting" ? "Submitting..." : "Get on the list"}
          </button>
        </form>

        <div className="leading-relaxed mb-8 space-y-1">
          <p className="text-base text-muted">
            Just DM <span className="text-foreground font-semibold">waitlist</span>
          </p>
          <p className="text-base text-muted">
            to your friendly <BotChip />
          </p>
          <p className="text-base text-muted">to get in the line.</p>
        </div>

        <a
          href="/faq"
          className="text-sm text-muted/50 hover:text-muted transition-colors"
        >
          FAQ
        </a>
      </div>
    </main>
  );
}
