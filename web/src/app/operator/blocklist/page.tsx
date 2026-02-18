"use client";

import { useState, useEffect, useCallback } from "react";
import { authFetch } from "@/lib/hooks/use-auth";
import {
  SectionHeader,
  formatDate,
  formatSats,
  thClass,
  tdClass,
  tdMuted,
} from "../_components";

interface RenegedEntry {
  email_hash: string;
  total_debt_sats: number;
  created_at: string;
}

function TruncatedHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  const display =
    hash.length > 16 ? `${hash.slice(0, 8)}...${hash.slice(-6)}` : hash;

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(hash);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-left font-mono text-xs hover:text-accent transition-colors cursor-pointer"
      title={hash}
    >
      {copied ? "Copied!" : display}
    </button>
  );
}

async function hashEmailClient(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function BlocklistPage() {
  const [entries, setEntries] = useState<RenegedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [clearingHash, setClearingHash] = useState<string | null>(null);
  const [clearReason, setClearReason] = useState("");
  const [clearError, setClearError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [filterEmail, setFilterEmail] = useState("");
  const [filterHash, setFilterHash] = useState<string | null>(null);

  const applyFilter = async () => {
    const trimmed = filterEmail.trim();
    if (!trimmed) {
      setFilterHash(null);
      return;
    }
    const hash = await hashEmailClient(trimmed);
    setFilterHash(hash);
  };

  const clearFilter = () => {
    setFilterEmail("");
    setFilterHash(null);
  };

  const displayedEntries =
    filterHash !== null
      ? entries.filter((e) => e.email_hash === filterHash)
      : entries;

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authFetch("/api/operator/reneged");
      if (res.status === 403) {
        setError("Access denied.");
        return;
      }
      if (!res.ok) {
        setError("Failed to load blocklist.");
        return;
      }
      const data = await res.json();
      setEntries(data.entries);
    } catch {
      setError("Failed to load blocklist.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openClearDialog = (hash: string) => {
    setClearingHash(hash);
    setClearReason("");
    setClearError("");
  };

  const closeClearDialog = () => {
    setClearingHash(null);
    setClearReason("");
    setClearError("");
  };

  const submitClear = async () => {
    if (!clearingHash) return;
    const trimmed = clearReason.trim();
    if (!trimmed) {
      setClearError("Reason is required.");
      return;
    }

    setSubmitting(true);
    setClearError("");
    try {
      const res = await authFetch(
        `/api/operator/reneged/${encodeURIComponent(clearingHash)}`,
        {
          method: "DELETE",
          body: JSON.stringify({ reason: trimmed }),
        }
      );
      if (res.status === 404) {
        setClearError("Entry not found (may have already been cleared).");
        return;
      }
      if (!res.ok) {
        setClearError("Failed to clear entry.");
        return;
      }
      // Remove from local state and close dialog
      setEntries((prev) =>
        prev.filter((e) => e.email_hash !== clearingHash)
      );
      closeClearDialog();
    } catch {
      setClearError("Failed to clear entry.");
    } finally {
      setSubmitting(false);
    }
  };

  if (error === "Access denied.") {
    return <p className="text-red-400 text-sm">403 -- Not authorized.</p>;
  }

  if (loading) return <p className="text-muted">Loading blocklist...</p>;
  if (error) return <p className="text-red-400 text-sm">{error}</p>;

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader>Blocklist Management</SectionHeader>

        <div className="flex items-center gap-2 mb-4">
          <input
            type="email"
            value={filterEmail}
            onChange={(e) => setFilterEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyFilter();
            }}
            placeholder="Filter by email (hashed client-side, never sent to server)"
            className="flex-1 bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={applyFilter}
            className="text-xs px-3 py-1.5 rounded border border-border text-muted hover:text-foreground transition-colors"
          >
            Filter
          </button>
          {filterHash !== null && (
            <button
              type="button"
              onClick={clearFilter}
              className="text-xs px-3 py-1.5 rounded border border-border text-muted hover:text-foreground transition-colors"
            >
              Clear filter
            </button>
          )}
        </div>

        {entries.length > 0 ? (
          displayedEntries.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className={thClass}>Email Hash</th>
                    <th className={thClass}>Debt (sats)</th>
                    <th className={thClass}>Blocklisted</th>
                    <th className={thClass}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedEntries.map((entry) => (
                    <tr
                      key={entry.email_hash}
                      className="border-b border-border/50"
                    >
                      <td className={tdClass}>
                        <TruncatedHash hash={entry.email_hash} />
                      </td>
                      <td className={tdMuted}>
                        {formatSats(entry.total_debt_sats)}
                      </td>
                      <td className={tdMuted}>
                        {formatDate(entry.created_at)}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => openClearDialog(entry.email_hash)}
                          className="text-xs px-2 py-1 rounded border border-red-600 text-red-400 hover:bg-red-900/30 transition-colors"
                        >
                          Clear
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-muted text-sm">
              No matching entry found for this email.
            </p>
          )
        ) : (
          <p className="text-muted text-sm">No blocklisted emails.</p>
        )}
      </section>

      {/* Clear confirmation dialog */}
      {clearingHash && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-surface border border-border rounded p-6 w-full max-w-md space-y-4">
            <h3 className="text-sm font-semibold text-foreground">
              Clear Blocklist Entry
            </h3>
            <p className="text-xs text-muted">
              Removing{" "}
              <span className="font-mono text-foreground">
                {clearingHash.length > 16
                  ? `${clearingHash.slice(0, 8)}...${clearingHash.slice(-6)}`
                  : clearingHash}
              </span>{" "}
              from the blocklist. This action is logged.
            </p>

            <div>
              <label
                htmlFor="clear-reason"
                className="block text-xs text-muted mb-1"
              >
                Reason (required)
              </label>
              <textarea
                id="clear-reason"
                value={clearReason}
                onChange={(e) => setClearReason(e.target.value)}
                rows={3}
                className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
                placeholder="Why is this entry being cleared?"
              />
            </div>

            {clearError && (
              <p className="text-red-400 text-xs">{clearError}</p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closeClearDialog}
                disabled={submitting}
                className="text-xs px-3 py-1.5 rounded border border-border text-muted hover:text-foreground transition-colors disabled:opacity-30"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitClear}
                disabled={submitting}
                className="text-xs px-3 py-1.5 rounded border border-red-600 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-30"
              >
                {submitting ? "Clearing..." : "Confirm Clear"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
