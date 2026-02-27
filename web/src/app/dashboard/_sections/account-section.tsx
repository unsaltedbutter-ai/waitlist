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
      <h2 className="text-xs font-semibold text-muted/50 uppercase tracking-wider">
        Account
      </h2>

      {/* Account info */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted min-w-[100px]">Nostr</span>
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
            <span className="text-sm text-muted min-w-[100px]">Member since</span>
            <span className="text-sm text-foreground">
              {formatDate(user.onboarded_at)}
            </span>
          </div>
        )}
      </div>

      {/* Danger zone */}
      <div className="border border-red-800/60 rounded-lg p-5 space-y-3 bg-red-500/5">
        <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wider">
          Danger zone
        </h3>
        <p className="text-sm text-muted leading-relaxed">
          All credentials and account data will be <span className="text-foreground font-medium">destroyed immediately</span>. This cannot be undone. Zero data retained.
        </p>
        <div className="flex gap-3">
          <input
            type="text"
            value={deleteInput}
            onChange={(e) => setDeleteInput(e.target.value)}
            placeholder='Type "destroy" to confirm'
            className="flex-1 py-2.5 px-3.5 bg-black/30 border border-red-500/15 rounded-lg text-foreground placeholder:text-muted/40 focus:outline-none focus:border-red-500/40 text-sm"
          />
          <button
            type="button"
            onClick={handleDeleteAccount}
            disabled={deleteInput !== "destroy" || deleteLoading}
            className="py-2.5 px-5 bg-red-500/15 border border-red-500/25 text-red-400 font-semibold rounded-lg hover:bg-red-500/25 transition-colors disabled:opacity-35 disabled:cursor-not-allowed text-sm whitespace-nowrap"
          >
            {deleteLoading ? "Destroying..." : "Destroy account"}
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={logout}
        className="inline-flex items-center gap-2 py-2.5 px-4 bg-surface border border-border text-muted rounded-lg hover:border-white/15 hover:text-foreground transition-colors text-sm font-medium"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Log out
      </button>
    </section>
  );
}
