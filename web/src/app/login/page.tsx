"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BotChip } from "@/components/bot-chip";

const TOKEN_KEY = "ub_token";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [otpCode, setOtpCode] = useState("");
  const autoSubmitted = useRef(false);

  function handleOtpChange(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 12);
    if (digits.length > 6) {
      setOtpCode(`${digits.slice(0, 6)}-${digits.slice(6)}`);
    } else {
      setOtpCode(digits);
    }
  }

  useEffect(() => {
    if (autoSubmitted.current) return;
    const code = searchParams.get("code");
    if (!code) return;
    const digits = code.replace(/\D/g, "").slice(0, 12);
    if (digits.length !== 12) return;
    const formatted = `${digits.slice(0, 6)}-${digits.slice(6)}`;
    setOtpCode(formatted);
    autoSubmitted.current = true;
  }, [searchParams]);

  useEffect(() => {
    if (!autoSubmitted.current) return;
    if (otpCode.replace("-", "").length !== 12) return;
    if (loading) return;
    const id = setTimeout(() => {
      handleOtpSubmit(new Event("submit") as unknown as React.FormEvent);
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otpCode]);

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
    <main className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="max-w-sm w-full text-center">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-white mb-2">
          Sign in
        </h1>
        <p className="text-base text-muted mb-10">Welcome back.</p>

        <form onSubmit={handleOtpSubmit} className="space-y-4 mb-10">
          <input
            type="text"
            inputMode="numeric"
            required
            value={otpCode}
            onChange={(e) => handleOtpChange(e.target.value)}
            placeholder="XXXXXX-XXXXXX"
            maxLength={13}
            autoFocus
            className="w-full py-4 px-5 bg-surface border border-border rounded-xl text-foreground text-center text-lg font-mono tracking-[3px] placeholder:text-muted/40 focus:outline-none focus:border-accent/40 transition-colors"
          />

          <button
            type="submit"
            disabled={loading || otpCode.replace("-", "").length !== 12}
            className="w-full py-4 px-4 bg-accent text-background font-semibold text-base rounded-xl hover:shadow-[0_6px_24px_rgba(245,158,11,0.3)] hover:-translate-y-px active:translate-y-0 transition-all disabled:opacity-50"
          >
            {loading ? "Verifying..." : "Sign in"}
          </button>
        </form>

        {error && <p className="text-red-400 text-sm mb-6">{error}</p>}

        <div className="leading-loose mb-9 space-y-1">
          <p className="text-base text-muted">
            Just DM <span className="text-foreground font-semibold">login</span>
          </p>
          <p className="text-base text-muted">
            to your friendly <BotChip />
          </p>
          <p className="text-base text-muted">for your login code.</p>
        </div>

        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-muted/50">
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
          <a
            href="/faq"
            className="text-sm text-muted/50 hover:text-muted transition-colors"
          >
            FAQ
          </a>
        </div>
      </div>
    </main>
  );
}
