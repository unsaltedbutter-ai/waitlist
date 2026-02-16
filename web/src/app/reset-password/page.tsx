"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordContent />
    </Suspense>
  );
}

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password.length > 128) {
      setError("Password must be 128 characters or fewer.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Referrer-Policy": "no-referrer",
        },
        body: JSON.stringify({ token, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        setLoading(false);
        return;
      }

      setSuccess(true);
    } catch {
      setError("Connection failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-lg w-full text-center">
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-4">
            Invalid link
          </h1>
          <p className="text-sm text-muted mb-6">
            This reset link is missing or malformed.
          </p>
          <a href="/forgot-password" className="text-accent hover:underline text-sm">
            Request a new reset link
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-lg w-full">
        <div className="mb-10 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-2">
            {success ? "Password reset" : "Set new password"}
          </h1>
        </div>

        {success ? (
          <div className="text-center space-y-4">
            <p className="text-sm text-muted">
              Sign in with your new password.
            </p>
            <a
              href="/login"
              className="inline-block py-3 px-6 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors"
            >
              Sign in
            </a>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-muted mb-2">
                New password
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
            <div>
              <label className="block text-sm font-medium text-muted mb-2">
                Confirm password
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                className="w-full py-3 px-4 bg-surface border border-border rounded text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {loading ? "Resetting..." : "Reset password"}
            </button>
          </form>
        )}

        {error && (
          <div className="mt-4">
            <p className="text-red-400 text-sm">{error}</p>
            {error.includes("expired") || error.includes("Invalid") ? (
              <p className="text-sm text-muted mt-2">
                <a href="/forgot-password" className="text-accent hover:underline">
                  Request a new reset link
                </a>
              </p>
            ) : null}
          </div>
        )}
      </div>
    </main>
  );
}
