"use client";

import { useState, useCallback } from "react";
import { authFetch } from "@/lib/hooks/use-auth";
import { hexToNpub } from "@/lib/nostr";
import { formatDate } from "@/lib/format";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AccountSectionProps {
  user: {
    nostr_npub: string;
    onboarded_at: string | null;
  };
  logout: () => void;
  setError: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AccountSection({ user, logout, setError }: AccountSectionProps) {
  // Nostr npub copy
  const [npubCopied, setNpubCopied] = useState(false);

  // Delete account
  const [deleteInput, setDeleteInput] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);

  const handleDeleteAccount = useCallback(async () => {
    if (deleteInput !== "destroy") return;
    setDeleteLoading(true);

    try {
      const res = await authFetch("/api/account", { method: "DELETE" });
      if (res.ok) {
        logout();
      } else {
        setError("Failed to delete account.");
      }
    } catch {
      setError("Failed to delete account.");
    } finally {
      setDeleteLoading(false);
    }
  }, [deleteInput, logout, setError]);

  return (
    <section className="bg-surface border border-border rounded p-6 space-y-6">
      <h2 className="text-sm font-medium text-muted mb-4">Account</h2>

      {/* Account info */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted">Nostr:</span>
          <span className="text-sm text-foreground font-mono">
            {(() => {
              try {
                const npub = hexToNpub(user.nostr_npub);
                return npub.length > 24
                  ? `${npub.slice(0, 14)}...${npub.slice(-10)}`
                  : npub;
              } catch { return user.nostr_npub; }
            })()}
          </span>
        </div>
        {user.onboarded_at && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted">Member since:</span>
            <span className="text-sm text-foreground">
              {formatDate(user.onboarded_at)}
            </span>
          </div>
        )}
      </div>

      {/* Nostr bot */}
      {process.env.NEXT_PUBLIC_NOSTR_BOT_NAME && (
        <div className="border border-border rounded p-4 space-y-2">
          <h3 className="text-sm font-medium text-foreground">
            {process.env.NEXT_PUBLIC_NOSTR_BOT_NAME}
          </h3>
          <p className="text-sm text-muted">
            DM for status, queue, cancel, or resume commands.
          </p>
          {process.env.NEXT_PUBLIC_NOSTR_BOT_NPUB && (
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(
                  process.env.NEXT_PUBLIC_NOSTR_BOT_NPUB!
                );
                setNpubCopied(true);
                setTimeout(() => setNpubCopied(false), 2000);
              }}
              className="text-xs font-mono text-muted hover:text-foreground transition-colors break-all text-left"
            >
              {npubCopied
                ? "Copied!"
                : process.env.NEXT_PUBLIC_NOSTR_BOT_NPUB}
            </button>
          )}
        </div>
      )}

      {/* Danger zone */}
      <div className="border border-red-800 rounded p-4 space-y-3">
        <h3 className="text-sm font-medium text-red-400">
          Danger zone
        </h3>
        <p className="text-sm text-muted">
          All credentials will be destroyed immediately.
          Type{" "}
          <span className="font-mono text-foreground">destroy</span> to
          confirm.
        </p>
        <div className="flex gap-3">
          <input
            type="text"
            value={deleteInput}
            onChange={(e) => setDeleteInput(e.target.value)}
            placeholder='Type "destroy"'
            className="flex-1 py-2 px-3 bg-surface border border-border rounded text-foreground placeholder:text-muted/50 focus:outline-none focus:border-red-700 text-sm"
          />
          <button
            type="button"
            onClick={handleDeleteAccount}
            disabled={deleteInput !== "destroy" || deleteLoading}
            className="py-2 px-4 bg-red-900 text-red-200 font-semibold rounded hover:bg-red-800 transition-colors disabled:opacity-50 text-sm"
          >
            {deleteLoading ? "Destroying..." : "Destroy account"}
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={logout}
        className="py-2 px-4 bg-surface border border-border text-foreground rounded hover:border-muted transition-colors text-sm"
      >
        Log out
      </button>
    </section>
  );
}
