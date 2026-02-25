"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const TOKEN_KEY = "ub_token";
const BOT_NPUB = process.env.NEXT_PUBLIC_NOSTR_BOT_NPUB ?? "npub1hssdvydgqjx9y6ptlkt23sc5uptnqkc3q2r8j68zpdeyt9psl27s534rcr";
const BOT_NAME = process.env.NEXT_PUBLIC_NOSTR_BOT_NAME ?? "UnsaltedButter Bot";

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // OTP state
  const [otpCode, setOtpCode] = useState("");
  const [npubCopied, setNpubCopied] = useState(false);

  // Format OTP input as XXXXXX-XXXXXX
  function handleOtpChange(value: string) {
    // Strip non-digits
    const digits = value.replace(/\D/g, "").slice(0, 12);
    if (digits.length > 6) {
      setOtpCode(`${digits.slice(0, 6)}-${digits.slice(6)}`);
    } else {
      setOtpCode(digits);
    }
  }

  async function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/nostr-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: otpCode }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (res.status === 429) {
          setError("Too many attempts. Wait a few minutes.");
        } else {
          setError(data.error || "Authentication failed.");
        }
        setLoading(false);
        return;
      }

      localStorage.setItem(TOKEN_KEY, data.token);
      router.replace(data.isNew || data.needsOnboarding ? "/onboarding" : "/dashboard");
    } catch {
      setError("Connection failed. Try again.");
      setLoading(false);
    }
  }

  async function handleNostrLogin() {
    setError("");
    setLoading(true);

    try {
      const nostr = (window as unknown as { nostr?: { signEvent: (event: object) => Promise<object> } }).nostr;
      if (!nostr) {
        setError("No Nostr extension found. Install nos2x or Alby.");
        setLoading(false);
        return;
      }

      const event = await nostr.signEvent({
        kind: 22242,
        content: "Sign in to UnsaltedButter",
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      });

      const res = await fetch("/api/auth/nostr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Nostr authentication failed.");
        setLoading(false);
        return;
      }

      localStorage.setItem(TOKEN_KEY, data.token);
      router.replace(data.needsOnboarding ? "/onboarding" : "/dashboard");
    } catch {
      setError("Nostr signing failed or was cancelled.");
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-lg w-full">
        <div className="mb-10 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-2">
            Sign in
          </h1>
          <p className="text-muted">
            Welcome back.
          </p>
        </div>

        <div className="space-y-6">
          <form onSubmit={handleOtpSubmit} className="space-y-6">
            <div>
              <input
                type="text"
                inputMode="numeric"
                required
                value={otpCode}
                onChange={(e) => handleOtpChange(e.target.value)}
                placeholder="XXXXXX-XXXXXX"
                maxLength={13}
                autoFocus
                className="w-full py-3 px-4 bg-surface border border-border rounded text-foreground text-center text-lg font-mono tracking-widest placeholder:text-muted/50 focus:outline-none focus:border-accent"
              />
            </div>

            <button
              type="submit"
              disabled={loading || otpCode.replace("-", "").length !== 12}
              className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {loading ? "Verifying..." : "Sign in"}
            </button>
          </form>

          <div className="text-sm text-muted leading-relaxed text-center">
            <p>Just DM <span className="text-foreground font-medium">login</span></p>
            <p>to your friendly <span className="text-foreground font-medium">{BOT_NAME}</span></p>
            <p>for your login code.</p>
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

          <p className="text-center text-xs text-muted">
            Have a Nostr extension?{" "}
            <button
              type="button"
              onClick={handleNostrLogin}
              disabled={loading}
              className="text-accent hover:underline"
            >
              Sign in with NIP-07
            </button>
          </p>
        </div>

        <p className="text-center text-xs text-muted">
          <a href="/faq" className="hover:text-foreground transition-colors">
            FAQ
          </a>
        </p>

        {/* Error */}
        {error && <p className="text-red-400 text-sm mt-4">{error}</p>}
      </div>
    </main>
  );
}
