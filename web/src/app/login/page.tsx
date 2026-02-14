"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Tab = "nostr" | "email";
type EmailMode = "login" | "signup";

const TOKEN_KEY = "ub_token";

export default function LoginPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("nostr");
  const [emailMode, setEmailMode] = useState<EmailMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Authentication failed.");
        setLoading(false);
        return;
      }

      localStorage.setItem(TOKEN_KEY, data.token);
      router.replace("/dashboard");
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
            Welcome back. Or welcome for the first time.
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
            <p className="text-sm text-muted">
              Sign in with a Nostr browser extension (nos2x, Alby, etc.).
              Your npub is your identity — no email required.
            </p>
            <button
              type="button"
              onClick={handleNostrLogin}
              disabled={loading}
              className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {loading ? "Signing..." : "Sign in with Nostr"}
            </button>
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
              disabled={loading}
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
                <>
                  No account?{" "}
                  <button
                    type="button"
                    onClick={() => setEmailMode("signup")}
                    className="text-accent hover:underline"
                  >
                    Create one
                  </button>
                </>
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
