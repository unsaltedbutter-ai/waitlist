"use client";

import { useState, useEffect, useCallback, FormEvent } from "react";
import { nip19 } from "nostr-tools";
import { authFetch } from "@/lib/hooks/use-auth";
import {
  SectionHeader,
  formatDate,
  formatSats,
  thClass,
  tdClass,
  tdMuted,
} from "../_components";

// ---------------------------------------------------------------------------
// Types (matching API response shapes)
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  nostr_npub: string;
  debt_sats: number;
  onboarded_at: string | null;
  created_at: string;
  queue_count: number;
  job_count: number;
}

interface QueueItem {
  id: string;
  service_id: string;
  position: number;
  plan_id: string | null;
  plan_name: string | null;
  created_at: string;
}

interface JobRow {
  id: string;
  service_id: string;
  action: string;
  trigger: string;
  status: string;
  status_updated_at: string;
  billing_date: string | null;
  amount_sats: number | null;
  created_at: string;
}

interface CredentialRow {
  id: string;
  service_id: string;
  created_at: string;
  updated_at: string;
}

interface ConsentRow {
  id: string;
  consent_type: string;
  created_at: string;
}

interface UserDetail {
  user: {
    id: string;
    nostr_npub: string;
    debt_sats: number;
    onboarded_at: string | null;
    created_at: string;
    updated_at: string;
  };
  queue: QueueItem[];
  jobs: JobRow[];
  credentials: CredentialRow[];
  consents: ConsentRow[];
  transactions: {
    total_count: number;
    total_sats: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToNpub(hex: string): string {
  try {
    return nip19.npubEncode(hex);
  } catch {
    return hex;
  }
}

function NpubCell({ hex, full }: { hex: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  const npub = hexToNpub(hex);
  const display = full ? npub : `${npub.slice(0, 12)}...${npub.slice(-6)}`;

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

function statusColor(status: string): string {
  switch (status) {
    case "completed_paid":
      return "text-green-400";
    case "completed_unpaid":
      return "text-amber-400";
    case "failed":
    case "cancelled":
      return "text-red-400";
    case "active":
      return "text-blue-400";
    default:
      return "text-muted";
  }
}

// ---------------------------------------------------------------------------
// Detail Panel
// ---------------------------------------------------------------------------

function UserDetailPanel({
  detail,
  onDebtAdjusted,
  onDeleted,
}: {
  detail: UserDetail;
  onDebtAdjusted: (newDebt: number) => void;
  onDeleted: () => void;
}) {
  const { user, queue, jobs, credentials, consents, transactions } = detail;

  // Adjust debt state
  const [showDebtForm, setShowDebtForm] = useState(false);
  const [debtInput, setDebtInput] = useState(String(user.debt_sats));
  const [debtReason, setDebtReason] = useState("");
  const [debtSubmitting, setDebtSubmitting] = useState(false);
  const [debtError, setDebtError] = useState("");

  // Delete state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const handleAdjustDebt = async (e: FormEvent) => {
    e.preventDefault();
    setDebtError("");
    const parsed = parseInt(debtInput, 10);
    if (isNaN(parsed) || parsed < 0) {
      setDebtError("Must be a non-negative integer.");
      return;
    }
    if (!debtReason.trim()) {
      setDebtError("Reason is required.");
      return;
    }
    setDebtSubmitting(true);
    try {
      const res = await authFetch(`/api/operator/users/${user.id}/adjust-debt`, {
        method: "POST",
        body: JSON.stringify({ debt_sats: parsed, reason: debtReason.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDebtError(data.error || "Failed to adjust debt.");
        return;
      }
      const data = await res.json();
      onDebtAdjusted(data.user.debt_sats);
      setShowDebtForm(false);
      setDebtReason("");
    } catch {
      setDebtError("Network error.");
    } finally {
      setDebtSubmitting(false);
    }
  };

  const handleDelete = async (e: FormEvent) => {
    e.preventDefault();
    setDeleteError("");
    if (!deleteReason.trim()) {
      setDeleteError("Reason is required.");
      return;
    }
    setDeleteSubmitting(true);
    try {
      const res = await authFetch(`/api/operator/users/${user.id}/delete`, {
        method: "POST",
        body: JSON.stringify({ reason: deleteReason.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDeleteError(data.error || "Failed to delete account.");
        return;
      }
      onDeleted();
    } catch {
      setDeleteError("Network error.");
    } finally {
      setDeleteSubmitting(false);
    }
  };

  return (
    <div className="bg-surface border border-border rounded p-4 space-y-6">
      {/* User Info */}
      <div>
        <SectionHeader>User Info</SectionHeader>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">npub</dt>
          <dd><NpubCell hex={user.nostr_npub} full /></dd>
          <dt className="text-muted">ID</dt>
          <dd className="font-mono text-xs text-foreground">{user.id}</dd>
          <dt className="text-muted">Debt</dt>
          <dd className={user.debt_sats > 0 ? "text-red-400 font-medium" : "text-foreground"}>
            {formatSats(user.debt_sats)} sats
          </dd>
          <dt className="text-muted">Onboarded</dt>
          <dd className="text-foreground">
            {user.onboarded_at ? formatDate(user.onboarded_at) : "Not yet"}
          </dd>
          <dt className="text-muted">Created</dt>
          <dd className="text-foreground">{formatDate(user.created_at)}</dd>
        </dl>
      </div>

      {/* Transactions Summary */}
      <div>
        <SectionHeader>Transactions</SectionHeader>
        <p className="text-sm text-foreground">
          {transactions.total_count} payments, {formatSats(transactions.total_sats)} sats total
        </p>
      </div>

      {/* Credentials */}
      {credentials.length > 0 && (
        <div>
          <SectionHeader>Credentials ({credentials.length})</SectionHeader>
          <div className="flex flex-wrap gap-2">
            {credentials.map((c) => (
              <span
                key={c.id}
                className="text-xs px-2 py-0.5 bg-neutral-800 border border-border rounded text-foreground"
              >
                {c.service_id}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Consents */}
      {consents.length > 0 && (
        <div>
          <SectionHeader>Consents ({consents.length})</SectionHeader>
          <div className="flex flex-wrap gap-2">
            {consents.map((c) => (
              <span
                key={c.id}
                className="text-xs px-2 py-0.5 bg-neutral-800 border border-border rounded text-muted"
                title={formatDate(c.created_at)}
              >
                {c.consent_type}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Queue */}
      <div>
        <SectionHeader>Queue ({queue.length})</SectionHeader>
        {queue.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Service</th>
                  <th className={thClass}>Plan</th>
                  <th className={thClass}>Position</th>
                  <th className={thClass}>Added</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((q) => (
                  <tr key={q.id} className="border-b border-border/50">
                    <td className={tdClass}>{q.service_id}</td>
                    <td className={tdMuted}>{q.plan_name ?? q.plan_id ?? "N/A"}</td>
                    <td className={tdMuted}>{q.position}</td>
                    <td className={tdMuted}>{formatDate(q.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted text-sm">No queue items.</p>
        )}
      </div>

      {/* Recent Jobs */}
      <div>
        <SectionHeader>Recent Jobs ({jobs.length})</SectionHeader>
        {jobs.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Service</th>
                  <th className={thClass}>Action</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Billing Date</th>
                  <th className={thClass}>Amount</th>
                  <th className={thClass}>Created</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-b border-border/50">
                    <td className={tdClass}>{j.service_id}</td>
                    <td className={tdMuted}>{j.action}</td>
                    <td className={`px-3 py-2 text-sm font-medium ${statusColor(j.status)}`}>
                      {j.status}
                    </td>
                    <td className={tdMuted}>
                      {j.billing_date ?? "N/A"}
                    </td>
                    <td className={tdMuted}>
                      {j.amount_sats != null ? `${formatSats(j.amount_sats)} sats` : "N/A"}
                    </td>
                    <td className={tdMuted}>{formatDate(j.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted text-sm">No jobs.</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-2 border-t border-border">
        <button
          type="button"
          onClick={() => {
            setShowDebtForm(!showDebtForm);
            setShowDeleteConfirm(false);
            setDebtInput(String(user.debt_sats));
            setDebtReason("");
            setDebtError("");
          }}
          className="text-xs px-3 py-1.5 rounded border border-accent text-accent hover:bg-accent hover:text-background transition-colors"
        >
          Adjust Debt
        </button>
        <button
          type="button"
          onClick={() => {
            setShowDeleteConfirm(!showDeleteConfirm);
            setShowDebtForm(false);
            setDeleteReason("");
            setDeleteError("");
          }}
          disabled={user.debt_sats > 0}
          className="text-xs px-3 py-1.5 rounded border border-red-600 text-red-400 hover:bg-red-600 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title={user.debt_sats > 0 ? "Clear debt before deleting" : "Delete this account"}
        >
          Delete Account
        </button>
      </div>

      {/* Adjust Debt Form */}
      {showDebtForm && (
        <form onSubmit={handleAdjustDebt} className="space-y-3 p-3 border border-border rounded bg-background">
          <p className="text-xs text-muted">
            Current debt: {formatSats(user.debt_sats)} sats
          </p>
          <div>
            <label htmlFor="debt-input" className="text-xs text-muted block mb-1">
              New debt (sats)
            </label>
            <input
              id="debt-input"
              type="number"
              min="0"
              step="1"
              value={debtInput}
              onChange={(e) => setDebtInput(e.target.value)}
              className="w-full px-2 py-1.5 text-sm bg-surface border border-border rounded text-foreground focus:outline-none focus:border-accent"
            />
          </div>
          <div>
            <label htmlFor="debt-reason" className="text-xs text-muted block mb-1">
              Reason
            </label>
            <textarea
              id="debt-reason"
              rows={2}
              value={debtReason}
              onChange={(e) => setDebtReason(e.target.value)}
              className="w-full px-2 py-1.5 text-sm bg-surface border border-border rounded text-foreground focus:outline-none focus:border-accent resize-none"
              placeholder="Why are you adjusting this debt?"
            />
          </div>
          {debtError && <p className="text-xs text-red-400">{debtError}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={debtSubmitting}
              className="text-xs px-3 py-1.5 rounded bg-accent text-background font-semibold hover:opacity-90 transition-opacity disabled:opacity-30"
            >
              {debtSubmitting ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setShowDebtForm(false)}
              className="text-xs px-3 py-1.5 rounded border border-border text-muted hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Delete Confirmation */}
      {showDeleteConfirm && (
        <form onSubmit={handleDelete} className="space-y-3 p-3 border border-red-900 rounded bg-red-950/30">
          <p className="text-xs text-red-400 font-medium">
            This will permanently delete the user and all associated data (credentials, queue, jobs, transactions). This cannot be undone.
          </p>
          <div>
            <label htmlFor="delete-reason" className="text-xs text-muted block mb-1">
              Reason for deletion
            </label>
            <textarea
              id="delete-reason"
              rows={2}
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              className="w-full px-2 py-1.5 text-sm bg-surface border border-border rounded text-foreground focus:outline-none focus:border-red-600 resize-none"
              placeholder="Why are you deleting this account?"
            />
          </div>
          {deleteError && <p className="text-xs text-red-400">{deleteError}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={deleteSubmitting}
              className="text-xs px-3 py-1.5 rounded bg-red-600 text-white font-semibold hover:opacity-90 transition-opacity disabled:opacity-30"
            >
              {deleteSubmitting ? "Deleting..." : "Confirm Delete"}
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(false)}
              className="text-xs px-3 py-1.5 rounded border border-border text-muted hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function MembersPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasSearched, setHasSearched] = useState(false);

  // Detail panel
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const searchUsers = useCallback(async (q: string) => {
    setLoading(true);
    setError("");
    setHasSearched(true);
    try {
      const url = q.trim()
        ? `/api/operator/users?search=${encodeURIComponent(q.trim())}`
        : "/api/operator/users";
      const res = await authFetch(url);
      if (res.status === 403) {
        setError("Access denied.");
        return;
      }
      if (!res.ok) {
        setError("Failed to search users.");
        return;
      }
      const data = await res.json();
      setUsers(data.users);
    } catch {
      setError("Failed to search users.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load all users on mount
  useEffect(() => {
    searchUsers("");
  }, [searchUsers]);

  const handleSearch = (e: FormEvent) => {
    e.preventDefault();
    // Close detail panel on new search
    setSelectedUserId(null);
    setDetail(null);
    searchUsers(searchQuery);
  };

  const fetchDetail = useCallback(async (userId: string) => {
    setDetailLoading(true);
    setDetailError("");
    try {
      const res = await authFetch(`/api/operator/users/${userId}`);
      if (!res.ok) {
        setDetailError("Failed to load user details.");
        return;
      }
      setDetail(await res.json());
    } catch {
      setDetailError("Failed to load user details.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const selectUser = (userId: string) => {
    if (selectedUserId === userId) {
      // Toggle off
      setSelectedUserId(null);
      setDetail(null);
      return;
    }
    setSelectedUserId(userId);
    setDetail(null);
    fetchDetail(userId);
  };

  const handleDebtAdjusted = (newDebt: number) => {
    // Update the user list row
    setUsers((prev) =>
      prev.map((u) =>
        u.id === selectedUserId ? { ...u, debt_sats: newDebt } : u
      )
    );
    // Update the detail panel
    if (detail && selectedUserId) {
      setDetail({
        ...detail,
        user: { ...detail.user, debt_sats: newDebt },
      });
    }
  };

  const handleDeleted = () => {
    // Remove from list and close detail
    setUsers((prev) => prev.filter((u) => u.id !== selectedUserId));
    setSelectedUserId(null);
    setDetail(null);
  };

  if (error === "Access denied.") {
    return <p className="text-red-400 text-sm">403 -- Not authorized.</p>;
  }

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader>Members</SectionHeader>

        {/* Search */}
        <form onSubmit={handleSearch} className="flex gap-2 mb-4">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by npub..."
            className="flex-1 px-3 py-2 text-sm bg-surface border border-border rounded text-foreground placeholder:text-muted focus:outline-none focus:border-accent font-mono"
          />
          <button
            type="submit"
            disabled={loading}
            className="text-xs px-4 py-2 rounded border border-accent text-accent hover:bg-accent hover:text-background transition-colors disabled:opacity-30"
          >
            {loading ? "Searching..." : "Search"}
          </button>
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                setSelectedUserId(null);
                setDetail(null);
                searchUsers("");
              }}
              className="text-xs px-3 py-2 rounded border border-border text-muted hover:text-foreground transition-colors"
            >
              Clear
            </button>
          )}
        </form>

        {/* Results */}
        {loading && !hasSearched ? (
          <p className="text-muted text-sm">Loading members...</p>
        ) : error ? (
          <p className="text-red-400 text-sm">{error}</p>
        ) : users.length === 0 && hasSearched ? (
          <p className="text-muted text-sm">No users found.</p>
        ) : users.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>npub</th>
                  <th className={thClass}>Debt</th>
                  <th className={thClass}>Onboarded</th>
                  <th className={thClass}>Queue</th>
                  <th className={thClass}>Jobs</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr
                    key={u.id}
                    onClick={() => selectUser(u.id)}
                    className={`border-b border-border/50 cursor-pointer transition-colors ${
                      selectedUserId === u.id
                        ? "bg-accent/10"
                        : "hover:bg-surface"
                    }`}
                  >
                    <td className={tdClass}>
                      <NpubCell hex={u.nostr_npub} />
                    </td>
                    <td
                      className={`px-3 py-2 text-sm ${
                        u.debt_sats > 0 ? "text-red-400 font-medium" : "text-foreground"
                      }`}
                    >
                      {formatSats(u.debt_sats)}
                    </td>
                    <td className={tdMuted}>
                      {u.onboarded_at ? formatDate(u.onboarded_at) : "No"}
                    </td>
                    <td className={tdMuted}>{u.queue_count}</td>
                    <td className={tdMuted}>{u.job_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {/* Detail Panel */}
        {selectedUserId && (
          <div className="mt-4">
            {detailLoading ? (
              <p className="text-muted text-sm">Loading user details...</p>
            ) : detailError ? (
              <p className="text-red-400 text-sm">{detailError}</p>
            ) : detail ? (
              <UserDetailPanel
                detail={detail}
                onDebtAdjusted={handleDebtAdjusted}
                onDeleted={handleDeleted}
              />
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
