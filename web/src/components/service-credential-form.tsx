"use client";

import { useState } from "react";
import { PasswordToggle } from "@/components/password-toggle";

interface ServiceCredentialFormProps {
  serviceId: string;
  serviceName: string;
  initialEmail?: string;
  onSubmit: (data: { serviceId: string; email: string; password: string }) => Promise<void>;
  submitting?: boolean;
  submitLabel?: string;
}

export function ServiceCredentialForm({
  serviceId,
  serviceName,
  initialEmail,
  onSubmit,
  submitting,
  submitLabel = "Save credentials",
}: ServiceCredentialFormProps) {
  const [email, setEmail] = useState(initialEmail ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = !!email && !!password && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await onSubmit({ serviceId, email, password });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save credentials.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <p className="text-sm font-medium text-foreground">{serviceName}</p>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Login email"
        className="w-full py-2.5 px-3 bg-surface border border-border rounded-lg text-foreground placeholder:text-muted/50 text-sm focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/20 transition-colors"
      />
      <div className="relative">
        <input
          type={showPassword ? "text" : "password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full py-2.5 px-3 pr-10 bg-surface border border-border rounded-lg text-foreground placeholder:text-muted/50 text-sm focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/20 transition-colors"
        />
        <PasswordToggle visible={showPassword} onToggle={() => setShowPassword((p) => !p)} />
      </div>
      {error && <p className="text-red-400 text-sm">{error}</p>}
      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full py-2.5 px-4 rounded-lg font-medium text-sm transition-colors bg-accent text-background hover:bg-accent/90 disabled:bg-accent/20 disabled:text-accent/40 disabled:cursor-not-allowed"
      >
        {submitting ? "Saving..." : submitLabel}
      </button>
    </form>
  );
}
