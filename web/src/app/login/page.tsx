"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Tab = "nostr" | "email";
type EmailMode = "login" | "signup";

const TOKEN_KEY = "ub_token";
const BOT_NPUB = process.env.NEXT_PUBLIC_NOSTR_BOT_NPUB ?? "";
const BOT_NAME = process.env.NEXT_PUBLIC_NOSTR_BOT_NAME ?? "UnsaltedButter Bot";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>("nostr");
  const [emailMode, setEmailMode] = useState<EmailMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Invite code state
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [codeValid, setCodeValid] = useState<boolean | null>(null);
  const [codeChecking, setCodeChecking] = useState(false);

  // OTP state
  const [otpCode, setOtpCode] = useState("");
  const [otpSent, setOtpSent] = useState(false);

  // Validate invite code from URL on mount
  useEffect(() => {
    const code = searchParams.get("code");
    if (!code) {
      setCodeValid(false);
      return;
    }

    setInviteCode(code);
    setCodeChecking(true);

    fetch("/api/invite/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then((res) => res.json())
      .then((data) => {
        setCodeValid(data.valid === true);
        if (data.valid) {
          setEmailMode("signup");
        }
      })
      .catch(() => {
        setCodeValid(false);
      })
      .finally(() => {
        setCodeChecking(false);
      });
  }, [searchParams]);

  const canSignup = codeValid === true;

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
        body: JSON.stringify({
          code: otpCode,
          ...(canSignup && inviteCode ? { inviteCode } : {}),
        }),
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
      router.replace(data.isNew ? "/onboarding" : "/dashboard");
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
        body: JSON.stringify({
          event,
          ...(canSignup && inviteCode ? { inviteCode } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Nostr authentication failed.");
        setLoading(false);
        return;
      }

      localStorage.setItem(TOKEN_KEY, data.token);
      router.replace("/dashboard");
    } catch {
      setError("Nostr signing failed or was cancelled.");
      setLoading(false);
    }
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const endpoint = emailMode === "login" ? "/api/auth/login" : "/api/auth/signup";

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          ...(emailMode === "signup" && inviteCode ? { inviteCode } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Authentication failed.");
        setLoading(false);
        return;
      }

      localStorage.setItem(TOKEN_KEY, data.token);
      router.replace(emailMode === "signup" ? "/onboarding" : "/dashboard");
    } catch {
      setError("Connection failed. Try again.");
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
            {canSignup
              ? "You've been invited. Create your account."
              : "Welcome back."}
          </p>
        </div>

        {/* Tab toggle */}
        <div className="flex gap-2 mb-8">
          <button
            type="button"
            onClick={() => setTab("nostr")}
            className={`flex-1 py-2 px-4 rounded text-sm font-medium border transition-colors ${
              tab === "nostr"
                ? "bg-accent text-background border-accent"
                : "bg-surface text-muted border-border hover:border-muted"
            }`}
          >
            Nostr
          </button>
          <button
            type="button"
            onClick={() => setTab("email")}
            className={`flex-1 py-2 px-4 rounded text-sm font-medium border transition-colors ${
              tab === "email"
                ? "bg-accent text-background border-accent"
                : "bg-surface text-muted border-border hover:border-muted"
            }`}
          >
            Email
          </button>
        </div>

        {/* Nostr tab */}
        {tab === "nostr" && (
          <div className="space-y-6">
            {!otpSent ? (
              <>
                <div className="space-y-3">
                  <p className="text-sm text-muted">
                    DM <span className="text-foreground font-medium">login</span> to{" "}
                    <span className="text-foreground font-medium">{BOT_NAME}</span>
                  </p>
                  {BOT_NPUB && (
                    <p className="text-xs text-muted font-mono break-all">
                      {BOT_NPUB}
                    </p>
                  )}
                  <p className="text-sm text-muted">
                    You&apos;ll get a 12-digit code back. Enter it below.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setOtpSent(true)}
                  disabled={codeChecking}
                  className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
                >
                  I have my code
                </button>

                {!canSignup && (
                  <p className="text-sm text-muted">
                    No invite? DM{" "}
                    <span className="text-foreground font-medium">waitlist</span> to{" "}
                    <span className="text-foreground font-medium">{BOT_NAME}</span>{" "}
                    to join the line.
                  </p>
                )}

                <p className="text-center text-xs text-muted">
                  Have a Nostr extension?{" "}
                  <button
                    type="button"
                    onClick={handleNostrLogin}
                    disabled={loading || codeChecking}
                    className="text-accent hover:underline"
                  >
                    Sign in with NIP-07
                  </button>
                </p>
              </>
            ) : (
              <form onSubmit={handleOtpSubmit} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-muted mb-2">
                    Login code
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    required
                    value={otpCode}
                    onChange={(e) => handleOtpChange(e.target.value)}
                    placeholder="XXXXXX-XXXXXX"
                    maxLength={13}
                    className="w-full py-3 px-4 bg-surface border border-border rounded text-foreground text-center text-lg font-mono tracking-widest placeholder:text-muted/50 focus:outline-none focus:border-accent"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading || otpCode.replace("-", "").length !== 12}
                  className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
                >
                  {loading
                    ? "Verifying..."
                    : canSignup
                      ? "Create account"
                      : "Sign in"}
                </button>

                <p className="text-center text-sm text-muted">
                  <button
                    type="button"
                    onClick={() => {
                      setOtpSent(false);
                      setOtpCode("");
                      setError("");
                    }}
                    className="text-accent hover:underline"
                  >
                    Back
                  </button>
                </p>
              </form>
            )}
          </div>
        )}

        {/* Email tab */}
        {tab === "email" && (
          <form onSubmit={handleEmailSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-muted mb-2">
                Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full py-3 px-4 bg-surface border border-border rounded text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-muted mb-2">
                Password
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min 8 characters"
                className="w-full py-3 px-4 bg-surface border border-border rounded text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
              />
            </div>
            <button
              type="submit"
              disabled={loading || codeChecking}
              className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {loading
                ? "Submitting..."
                : emailMode === "login"
                  ? "Sign in"
                  : "Create account"}
            </button>
            <p className="text-center text-sm text-muted">
              {emailMode === "login" ? (
                canSignup ? (
                  <>
                    New here?{" "}
                    <button
                      type="button"
                      onClick={() => setEmailMode("signup")}
                      className="text-accent hover:underline"
                    >
                      Create account
                    </button>
                  </>
                ) : (
                  <span>
                    Need an account?{" "}
                    <a href="/" className="text-accent hover:underline">
                      Join the waitlist
                    </a>
                  </span>
                )
              ) : (
                <>
                  Already have an account?{" "}
                  <button
                    type="button"
                    onClick={() => setEmailMode("login")}
                    className="text-accent hover:underline"
                  >
                    Sign in
                  </button>
                </>
              )}
            </p>
          </form>
        )}

        {/* Error */}
        {error && <p className="text-red-400 text-sm mt-4">{error}</p>}
      </div>
    </main>
  );
}
