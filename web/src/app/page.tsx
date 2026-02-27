"use client";

import { useState } from "react";

const BOT_NPUB = process.env.NEXT_PUBLIC_NOSTR_BOT_NPUB ?? "npub1hssdvydgqjx9y6ptlkt23sc5uptnqkc3q2r8j68zpdeyt9psl27s534rcr";
const BOT_NAME = process.env.NEXT_PUBLIC_NOSTR_BOT_NAME ?? "UnsaltedButter Bot";

export default function WaitlistPage() {
  const [npub, setNpub] = useState("");
  const [status, setStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [autoInvited, setAutoInvited] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [npubCopied, setNpubCopied] = useState(false);

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
        <div className="max-w-lg w-full text-center">
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
      <div className="max-w-lg w-full">
        {/* Header */}
        <div className="mb-12 text-center">
          <h1 className="text-4xl font-bold tracking-tight mb-4 text-foreground">
            Not watching? Stop paying.
          </h1>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* npub input */}
          <div>
            <label className="block text-sm font-medium text-muted mb-2">
              Your Nostr npub
            </label>
            <input
              type="text"
              required
              value={npub}
              onChange={(e) => setNpub(e.target.value)}
              placeholder="npub1..."
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

          <div className="text-sm text-muted leading-relaxed text-center">
            <p>Just DM <span className="text-foreground font-medium">waitlist</span></p>
            <p>to your friendly <span className="text-foreground font-medium">{BOT_NAME}</span></p>
            <p>to get in the line.</p>
          </div>

          {BOT_NPUB && (
            <p className="text-center text-xs text-muted">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(BOT_NPUB);
                  setNpubCopied(true);
                  setTimeout(() => setNpubCopied(false), 2000);
                }}
                className="font-mono text-muted hover:text-foreground transition-colors break-all"
              >
                {npubCopied ? "Copied!" : BOT_NPUB}
              </button>
            </p>
          )}
        </form>

        {/* Footer */}
        <div className="text-center text-xs mt-12 space-y-2">
          <p className="text-muted/60">Invite only. Bitcoin only.</p>
        </div>
      </div>
    </main>
  );
}
