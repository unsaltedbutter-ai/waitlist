"use client";

import { useState, useEffect, useCallback } from "react";
import { nip19 } from "nostr-tools";
import { authFetch } from "@/lib/hooks/use-auth";
import {
  WaitlistEntry,
  CapacityInfo,
  SectionHeader,
  formatDate,
  thClass,
  tdClass,
  tdMuted,
} from "../_components";

function hexToNpub(hex: string): string {
  try {
    return nip19.npubEncode(hex);
  } catch {
    return hex;
  }
}

function NpubCell({ hex }: { hex: string }) {
  const [copied, setCopied] = useState(false);
  const npub = hexToNpub(hex);
  const display = `${npub.slice(0, 12)}...${npub.slice(-6)}`;

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(npub);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-left font-mono text-xs hover:text-accent transition-colors cursor-pointer"
      title={npub}
    >
      {copied ? "Copied!" : display}
    </button>
  );
}

export default function WaitlistPage() {
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [capacity, setCapacity] = useState<CapacityInfo | null>(null);
  const [generatingInvite, setGeneratingInvite] = useState<Set<string>>(
    new Set()
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authFetch("/api/operator/waitlist");
      if (res.status === 403) {
        setError("Access denied.");
        return;
      }
      if (!res.ok) {
        setError("Failed to load waitlist.");
        return;
      }
      const data = await res.json();
      setWaitlist(data.entries);
      setCapacity(data.capacity);
    } catch {
      setError("Failed to load waitlist.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const generateInvite = useCallback(
    async (waitlistId: string) => {
      setGeneratingInvite((prev) => new Set(prev).add(waitlistId));
      try {
        const res = await authFetch("/api/operator/invite", {
          method: "POST",
          body: JSON.stringify({ waitlistId }),
        });
        if (res.ok) {
          setWaitlist((prev) =>
            prev.map((e) =>
              e.id === waitlistId
                ? { ...e, invited: true, invited_at: new Date().toISOString() }
                : e
            )
          );
          if (capacity) {
            setCapacity({
              ...capacity,
              availableSlots: capacity.availableSlots - 1,
            });
          }
        }
      } finally {
        setGeneratingInvite((prev) => {
          const next = new Set(prev);
          next.delete(waitlistId);
          return next;
        });
      }
    },
    [capacity]
  );

  if (error === "Access denied.") {
    return <p className="text-red-400 text-sm">403 -- Not authorized.</p>;
  }

  if (loading) return <p className="text-muted">Loading waitlist...</p>;
  if (error) return <p className="text-red-400 text-sm">{error}</p>;

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader>Waitlist Management</SectionHeader>

        {/* Capacity bar */}
        {capacity && (
          <div className="mb-4">
            <div className="flex justify-between text-xs text-muted mb-1">
              <span>
                {capacity.activeUsers.toLocaleString()} /{" "}
                {capacity.cap.toLocaleString()} active users
              </span>
              <span>
                {capacity.availableSlots.toLocaleString()} slots available
              </span>
            </div>
            <div className="w-full h-2 bg-surface border border-border rounded overflow-hidden">
              <div
                className={`h-full transition-all ${
                  capacity.activeUsers / capacity.cap > 0.9
                    ? "bg-red-500"
                    : capacity.activeUsers / capacity.cap > 0.7
                      ? "bg-amber-500"
                      : "bg-green-500"
                }`}
                style={{
                  width: `${Math.min(100, (capacity.activeUsers / capacity.cap) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Waitlist table */}
        {waitlist.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Contact</th>
                  <th className={thClass}>Signed Up</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Action</th>
                </tr>
              </thead>
              <tbody>
                {waitlist.map((entry) => (
                  <tr key={entry.id} className="border-b border-border/50">
                    <td className={tdClass}>
                      <NpubCell hex={entry.nostr_npub} />
                    </td>
                    <td className={tdMuted}>{formatDate(entry.created_at)}</td>
                    <td className={tdClass}>
                      {entry.invited ? (
                        <span className="text-xs px-2 py-0.5 bg-green-900/40 text-green-400 rounded">
                          Invited{" "}
                          {entry.invited_at
                            ? formatDate(entry.invited_at)
                            : ""}
                        </span>
                      ) : (
                        <span className="text-xs text-muted">Waiting</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {entry.invited ? (
                        <span className="text-xs text-muted">--</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => generateInvite(entry.id)}
                          disabled={
                            generatingInvite.has(entry.id) ||
                            (capacity?.availableSlots ?? 0) === 0
                          }
                          className="text-xs px-2 py-1 rounded border border-accent text-accent hover:bg-accent hover:text-background transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          {generatingInvite.has(entry.id)
                            ? "Generating..."
                            : "Generate Invite"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted text-sm">No waitlist entries.</p>
        )}
      </section>
    </div>
  );
}
