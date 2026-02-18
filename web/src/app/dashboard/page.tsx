"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth, authFetch } from "@/lib/hooks/use-auth";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueueItem {
  service_id: string;
  service_name: string;
  position: number;
  subscription_status: "active" | "cancel_scheduled" | "signup_scheduled" | null;
  subscription_end_date: string | null;
  plan_name: string | null;
  plan_price_cents: number | null;
}

interface JobRecord {
  id: string;
  service_name: string;
  flow_type: string;
  status: string;
  completed_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatSats(n: number): string {
  return n.toLocaleString("en-US");
}

function statusColor(
  status: QueueItem["subscription_status"]
): string {
  switch (status) {
    case "active":
      return "bg-green-900/50 text-green-400 border border-green-700";
    case "cancel_scheduled":
      return "bg-amber-900/50 text-amber-400 border border-amber-700";
    case "signup_scheduled":
      return "bg-blue-900/50 text-blue-400 border border-blue-700";
    default:
      return "bg-neutral-800/50 text-neutral-400 border border-neutral-700";
  }
}

function statusLabel(status: QueueItem["subscription_status"]): string {
  switch (status) {
    case "active":
      return "Active";
    case "cancel_scheduled":
      return "Cancelling";
    case "signup_scheduled":
      return "Resuming";
    default:
      return "Queued";
  }
}

function jobStatusBadge(status: string): string {
  switch (status) {
    case "completed":
      return "bg-green-900/50 text-green-400 border border-green-700";
    case "failed":
    case "dead_letter":
      return "bg-red-900/50 text-red-400 border border-red-700";
    case "in_progress":
    case "claimed":
      return "bg-blue-900/50 text-blue-400 border border-blue-700";
    default:
      return "bg-neutral-800/50 text-neutral-400 border border-neutral-700";
  }
}

function flowTypeLabel(flowType: string): string {
  switch (flowType) {
    case "cancel":
      return "Cancel";
    case "signup":
    case "resume":
      return "Resume";
    default:
      return flowType;
  }
}

/** Whether a queue item is "pinned" (not draggable). */
function isItemPinned(item: QueueItem): boolean {
  return (
    item.subscription_status === "active" ||
    item.subscription_status === "cancel_scheduled" ||
    item.subscription_status === "signup_scheduled"
  );
}

/** Display label for user status. */
function userStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "auto_paused":
      return "Paused (debt)";
    default:
      return status;
  }
}

/** CSS class for user status badge. */
function userStatusBadgeClass(status: string): string {
  switch (status) {
    case "active":
      return "bg-green-900/50 text-green-400 border border-green-700";
    case "paused":
      return "bg-neutral-800/50 text-neutral-400 border border-neutral-700";
    case "auto_paused":
      return "bg-amber-900/50 text-amber-400 border border-amber-700";
    default:
      return "bg-neutral-800/50 text-neutral-400 border border-neutral-700";
  }
}

// ---------------------------------------------------------------------------
// SortableItem (draggable queue item)
// ---------------------------------------------------------------------------

interface SortableItemProps {
  item: QueueItem;
}

function SortableItem({ item }: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.service_id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 bg-surface border border-border rounded px-4 py-3"
    >
      <button
        type="button"
        className="cursor-grab text-muted hover:text-foreground transition-colors text-lg leading-none select-none"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${item.service_name}`}
      >
        &#8801;
      </button>
      <span className="flex-1 text-foreground font-medium min-w-0 truncate">
        {item.service_name}
      </span>
      {item.subscription_status && (
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded shrink-0 ${statusColor(item.subscription_status)}`}
        >
          {statusLabel(item.subscription_status)}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PinnedItem (non-draggable, active/scheduled queue item)
// ---------------------------------------------------------------------------

interface PinnedItemProps {
  item: QueueItem;
}

function PinnedItem({ item }: PinnedItemProps) {
  const borderColor =
    item.subscription_status === "active"
      ? "border-green-600"
      : item.subscription_status === "cancel_scheduled"
        ? "border-amber-600"
        : "border-blue-600";

  return (
    <div
      className={`flex items-center gap-3 bg-surface border ${borderColor} rounded px-4 py-3`}
    >
      <span className="text-muted/40 text-lg leading-none select-none">
        &#8801;
      </span>
      <span className="flex-1 text-foreground font-medium min-w-0 truncate">
        {item.service_name}
      </span>
      {item.subscription_status && (
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded shrink-0 ${statusColor(item.subscription_status)}`}
        >
          {statusLabel(item.subscription_status)}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const { user, loading: authLoading, logout } = useAuth();

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [debtSats, setDebtSats] = useState(0);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState("");

  // Pause/unpause
  const [pauseLoading, setPauseLoading] = useState(false);
  const [unpauseError, setUnpauseError] = useState("");

  // Nostr npub copy
  const [npubCopied, setNpubCopied] = useState(false);

  // Delete account
  const [deleteInput, setDeleteInput] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);

  // ---------- Data fetching ----------

  const fetchData = useCallback(async () => {
    setLoadingData(true);
    setError("");
    try {
      const [qRes, meRes] = await Promise.all([
        authFetch("/api/queue"),
        // TODO: GET /api/me should return { debt_sats, recent_jobs }
        // For now, try fetching it; if it fails, fall back gracefully.
        authFetch("/api/me").catch(() => null),
      ]);

      if (!qRes.ok) {
        setError("Failed to load dashboard data.");
        setLoadingData(false);
        return;
      }

      const qData = await qRes.json();
      setQueue(qData.queue);

      if (meRes && meRes.ok) {
        const meData = await meRes.json();
        setDebtSats(meData.debt_sats ?? 0);
        setJobs(meData.recent_jobs ?? []);
      }
    } catch {
      setError("Failed to load dashboard data.");
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && user) {
      fetchData();
    }
  }, [authLoading, user, fetchData]);

  // ---------- Derived data ----------

  const pinnedItems = queue.filter(isItemPinned);
  const sortableItems = queue.filter((q) => !isItemPinned(q));

  // ---------- Drag and drop ----------

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldSortableIndex = sortableItems.findIndex(
        (q) => q.service_id === active.id
      );
      const newSortableIndex = sortableItems.findIndex(
        (q) => q.service_id === over.id
      );
      if (oldSortableIndex === -1 || newSortableIndex === -1) return;

      const reorderedSortable = arrayMove(
        sortableItems,
        oldSortableIndex,
        newSortableIndex
      );
      const fullReordered = [...pinnedItems, ...reorderedSortable];
      setQueue(fullReordered);

      try {
        await authFetch("/api/queue", {
          method: "PUT",
          body: JSON.stringify({
            order: fullReordered.map((q) => q.service_id),
          }),
        });
      } catch {
        setQueue(queue);
      }
    },
    [queue, pinnedItems, sortableItems]
  );

  // ---------- Pause / Unpause ----------

  const handlePause = useCallback(async () => {
    setPauseLoading(true);
    setUnpauseError("");
    try {
      const res = await authFetch("/api/pause", { method: "POST" });
      if (res.ok) {
        window.location.reload();
      } else {
        const data = await res.json().catch(() => ({}));
        setUnpauseError(data.error || "Failed to pause.");
      }
    } catch {
      setUnpauseError("Connection failed.");
    } finally {
      setPauseLoading(false);
    }
  }, []);

  const handleUnpause = useCallback(async () => {
    setPauseLoading(true);
    setUnpauseError("");
    try {
      const res = await authFetch("/api/unpause", { method: "POST" });
      if (res.ok) {
        window.location.reload();
      } else {
        const data = await res.json().catch(() => ({}));
        setUnpauseError(data.error || "Failed to resume.");
      }
    } catch {
      setUnpauseError("Connection failed.");
    } finally {
      setPauseLoading(false);
    }
  }, []);

  // ---------- Delete account ----------

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
  }, [deleteInput, logout]);

  // ---------- Loading states ----------

  if (authLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-muted">Loading...</p>
      </main>
    );
  }

  if (!user) return null;

  // ---------- Render ----------

  return (
    <main className="min-h-screen">
      <div className="max-w-2xl mx-auto px-4 py-12 space-y-8">
        <h1 className="text-4xl font-bold tracking-tight text-foreground">
          Dashboard
        </h1>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        {/* Outstanding debt warning */}
        {debtSats > 0 && (
          <div className="bg-red-900/30 border border-red-700 rounded p-4">
            <p className="text-red-300 text-sm font-medium">
              You have an outstanding balance of {formatSats(debtSats)} sats.
              Pay via the Nostr bot to continue using the service.
            </p>
          </div>
        )}

        {loadingData ? (
          <p className="text-muted">Loading your data...</p>
        ) : (
          <>
            {/* --------------------------------------------------------- */}
            {/* 1. Rotation Queue                                         */}
            {/* --------------------------------------------------------- */}
            <section className="bg-surface border border-border rounded p-6">
              <h2 className="text-sm font-medium text-muted mb-4">
                Your queue
              </h2>

              {queue.length === 0 ? (
                <p className="text-muted text-sm">
                  No services in your queue. Add services from settings.
                </p>
              ) : queue.length === 1 ? (
                <>
                  <div className="flex items-center gap-3 bg-surface border border-border rounded px-4 py-3 mb-3">
                    <span className="text-muted text-lg leading-none select-none">
                      &#8801;
                    </span>
                    <span className="flex-1 text-foreground font-medium min-w-0 truncate">
                      {queue[0].service_name}
                    </span>
                    {queue[0].subscription_status && (
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded shrink-0 ${statusColor(queue[0].subscription_status)}`}
                      >
                        {statusLabel(queue[0].subscription_status)}
                      </span>
                    )}
                  </div>
                  <p className="text-muted text-sm">
                    You only have one service. Add another to enable rotation.
                  </p>
                </>
              ) : (
                <div className="space-y-2">
                  {/* Pinned items (active/scheduled) */}
                  {pinnedItems.map((item) => (
                    <PinnedItem key={item.service_id} item={item} />
                  ))}

                  {/* Sortable items (queued) */}
                  {sortableItems.length > 0 && (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleDragEnd}
                    >
                      <SortableContext
                        items={sortableItems.map((q) => q.service_id)}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="space-y-2">
                          {sortableItems.map((item) => (
                            <SortableItem key={item.service_id} item={item} />
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                  )}
                </div>
              )}

              <p className="text-xs text-muted/60 mt-4">
                Each cancel or resume costs 3,000 sats. Drag to reorder queued services.
              </p>
            </section>

            {/* --------------------------------------------------------- */}
            {/* 2. Recent Job History                                      */}
            {/* --------------------------------------------------------- */}
            <section className="bg-surface border border-border rounded p-6">
              <h2 className="text-sm font-medium text-muted mb-4">
                Recent jobs
              </h2>

              {jobs.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left text-xs font-medium text-muted px-3 py-2">Service</th>
                        <th className="text-left text-xs font-medium text-muted px-3 py-2">Action</th>
                        <th className="text-left text-xs font-medium text-muted px-3 py-2">Status</th>
                        <th className="text-left text-xs font-medium text-muted px-3 py-2">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.map((job) => (
                        <tr key={job.id} className="border-b border-border/50">
                          <td className="px-3 py-2 text-sm text-foreground">
                            {job.service_name}
                          </td>
                          <td className="px-3 py-2 text-sm text-muted">
                            {flowTypeLabel(job.flow_type)}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`text-xs font-medium px-2 py-0.5 rounded ${jobStatusBadge(job.status)}`}>
                              {job.status}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-sm text-muted">
                            {formatDate(job.completed_at ?? job.created_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-muted text-sm">
                  No jobs yet. When you request a cancel or resume, it will show up here.
                </p>
              )}
            </section>

            {/* --------------------------------------------------------- */}
            {/* 3. Account                                                */}
            {/* --------------------------------------------------------- */}
            <section className="bg-surface border border-border rounded p-6 space-y-6">
              <h2 className="text-sm font-medium text-muted mb-4">Account</h2>

              {/* Status + pause toggle */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted">Status:</span>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded ${userStatusBadgeClass(user.status)}`}
                    >
                      {userStatusLabel(user.status)}
                    </span>
                  </div>

                  {/* iOS-style toggle for active/paused */}
                  {(user.status === "active" || user.status === "paused") && (
                    <button
                      type="button"
                      onClick={user.status === "active" ? handlePause : handleUnpause}
                      disabled={pauseLoading}
                      className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                        user.status === "active" ? "bg-green-600" : "bg-neutral-600"
                      }`}
                      role="switch"
                      aria-checked={user.status === "active"}
                      aria-label={user.status === "active" ? "Pause rotation" : "Resume rotation"}
                    >
                      <span
                        className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          user.status === "active" ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  )}
                </div>

                {user.status === "auto_paused" && (
                  <p className="text-sm text-amber-400">
                    Paused due to outstanding debt. Pay your balance to resume.
                  </p>
                )}

                {unpauseError && (
                  <p className="text-red-400 text-sm">{unpauseError}</p>
                )}
              </div>

              {/* Nostr bot */}
              {process.env.NEXT_PUBLIC_NOSTR_BOT_NAME && (
                <div className="border border-border rounded p-4 space-y-2">
                  <h3 className="text-sm font-medium text-foreground">
                    {process.env.NEXT_PUBLIC_NOSTR_BOT_NAME}
                  </h3>
                  <p className="text-sm text-muted">
                    DM for status, queue, cancel, resume, or pause commands.
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
                  Deleting your account is permanent. All credentials and queue
                  data will be destroyed immediately. Type{" "}
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
          </>
        )}
      </div>
    </main>
  );
}
