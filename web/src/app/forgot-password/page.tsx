"use client";

import { useState } from "react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (res.status === 429) {
        setError("Too many attempts. Wait a few minutes.");
        setLoading(false);
        return;
      }

      setSubmitted(true);
    } catch {
      setError("Connection failed. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-lg w-full">
        <div className="mb-10 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-2">
            Reset password
          </h1>
          <p className="text-muted">
            {submitted
              ? "Check your email."
              : "Enter your email to get a reset link."}
          </p>
        </div>

        {!submitted ? (
          <form onSubmit={handleSubmit} className="space-y-6">
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
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {loading ? "Sending..." : "Send reset link"}
            </button>
          </form>
        ) : (
          <p className="text-sm text-muted text-center">
            If an account with that email exists, a reset link has been sent.
          </p>
        )}

        {error && <p className="text-red-400 text-sm mt-4">{error}</p>}

        <p className="text-center text-sm text-muted mt-6">
          <a href="/login" className="text-accent hover:underline">
            Back to sign in
          </a>
        </p>
      </div>
    </main>
  );
}
