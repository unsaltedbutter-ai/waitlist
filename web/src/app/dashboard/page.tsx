"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
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
  never_rotate: boolean;
  subscription_status: "active" | "lapsing" | "signup_scheduled" | null;
  estimated_lapse_at: string | null;
}

interface Credits {
  credit_sats: number;
  credit_usd_cents: number;
  recent_transactions: Transaction[];
}

interface Transaction {
  id: string;
  type: string;
  amount_sats: number;
  balance_after_sats: number;
  description: string;
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

function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function statusColor(
  status: QueueItem["subscription_status"]
): string {
  switch (status) {
    case "active":
      return "bg-green-900/50 text-green-400 border border-green-700";
    case "lapsing":
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
    case "lapsing":
      return "Lapsing";
    case "signup_scheduled":
      return "Signing up";
    default:
      return "Ended";
  }
}

function activeDescription(item: QueueItem): string {
  const date = item.estimated_lapse_at
    ? formatDate(item.estimated_lapse_at)
    : null;

  switch (item.subscription_status) {
    case "active":
      return date
        ? `${item.service_name} — active through ${date}`
        : `${item.service_name} — active`;
    case "lapsing":
      return date
        ? `${item.service_name} — winding down, ends ~${date}`
        : `${item.service_name} — winding down`;
    case "signup_scheduled":
      return `${item.service_name} — signing up now`;
    default:
      return `${item.service_name} — ended`;
  }
}

// ---------------------------------------------------------------------------
// SortableItem
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
      <span className="flex-1 text-foreground font-medium">
        {item.service_name}
      </span>
      {item.subscription_status && (
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded ${statusColor(item.subscription_status)}`}
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
  const [credits, setCredits] = useState<Credits | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState("");

  // Confirmation dialogs
  const [confirmAction, setConfirmAction] = useState<{
    type: "stay" | "skip";
    serviceId: string;
    serviceName: string;
  } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Delete account
  const [deleteInput, setDeleteInput] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);

  // ---------- Data fetching ----------

  const fetchData = useCallback(async () => {
    setLoadingData(true);
    setError("");
    try {
      const [qRes, cRes] = await Promise.all([
        authFetch("/api/queue"),
        authFetch("/api/credits"),
      ]);

      if (!qRes.ok || !cRes.ok) {
        setError("Failed to load dashboard data.");
        setLoadingData(false);
        return;
      }

      const qData = await qRes.json();
      const cData = await cRes.json();
      setQueue(qData.queue);
      setCredits(cData);
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

      const oldIndex = queue.findIndex((q) => q.service_id === active.id);
      const newIndex = queue.findIndex((q) => q.service_id === over.id);
      const reordered = arrayMove(queue, oldIndex, newIndex);
      setQueue(reordered);

      try {
        await authFetch("/api/queue", {
          method: "PUT",
          body: JSON.stringify({
            order: reordered.map((q) => q.service_id),
          }),
        });
      } catch {
        // Revert on failure
        setQueue(queue);
      }
    },
    [queue]
  );

  // ---------- Stay / Skip ----------

  const handleConfirmAction = useCallback(async () => {
    if (!confirmAction) return;
    setActionLoading(true);

    try {
      const res = await authFetch(
        `/api/queue/${confirmAction.serviceId}/${confirmAction.type}`,
        { method: "POST" }
      );
      if (!res.ok) {
        setError(`Failed to ${confirmAction.type} ${confirmAction.serviceName}.`);
      } else {
        await fetchData();
      }
    } catch {
      setError(`Failed to ${confirmAction.type} ${confirmAction.serviceName}.`);
    } finally {
      setActionLoading(false);
      setConfirmAction(null);
    }
  }, [confirmAction, fetchData]);

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

  // ---------- Derived data ----------

  const activeItem = queue.find(
    (q) =>
      q.subscription_status === "active" ||
      q.subscription_status === "lapsing" ||
      q.subscription_status === "signup_scheduled"
  );

  // ---------- Render ----------

  return (
    <main className="min-h-screen">
      <div className="max-w-2xl mx-auto px-4 py-12 space-y-8">
        <h1 className="text-4xl font-bold tracking-tight text-foreground">
          Your rotation
        </h1>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        {loadingData ? (
          <p className="text-muted">Loading your data...</p>
        ) : (
          <>
            {/* --------------------------------------------------------- */}
            {/* 1. Active Subscription Card                               */}
            {/* --------------------------------------------------------- */}
            <section className="bg-surface border border-border rounded p-6">
              <h2 className="text-sm font-medium text-muted mb-4">
                Current subscription
              </h2>

              {activeItem ? (
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-2xl font-bold text-foreground">
                      {activeItem.service_name}
                    </span>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded ${statusColor(activeItem.subscription_status)}`}
                    >
                      {statusLabel(activeItem.subscription_status)}
                    </span>
                  </div>

                  <p className="text-muted text-sm mb-4">
                    {activeDescription(activeItem)}
                  </p>

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() =>
                        setConfirmAction({
                          type: "stay",
                          serviceId: activeItem.service_id,
                          serviceName: activeItem.service_name,
                        })
                      }
                      className="py-2 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors text-sm"
                    >
                      Stay
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setConfirmAction({
                          type: "skip",
                          serviceId: activeItem.service_id,
                          serviceName: activeItem.service_name,
                        })
                      }
                      className="py-2 px-4 bg-surface border border-border text-foreground font-semibold rounded hover:border-muted transition-colors text-sm"
                    >
                      Skip
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-muted text-sm">
                  No active subscription right now.
                </p>
              )}
            </section>

            {/* --------------------------------------------------------- */}
            {/* Confirmation Dialog                                       */}
            {/* --------------------------------------------------------- */}
            {confirmAction && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
                <div className="bg-surface border border-border rounded p-6 max-w-sm w-full mx-4 space-y-4">
                  <h3 className="text-lg font-bold text-foreground">
                    {confirmAction.type === "stay"
                      ? `Stay on ${confirmAction.serviceName}?`
                      : `Skip ${confirmAction.serviceName}?`}
                  </h3>
                  <p className="text-sm text-muted">
                    {confirmAction.type === "stay"
                      ? `This will keep your ${confirmAction.serviceName} subscription active and delay rotation.`
                      : `This will cancel ${confirmAction.serviceName} and move to the next service in your queue.`}
                  </p>
                  <div className="flex gap-3 justify-end">
                    <button
                      type="button"
                      onClick={() => setConfirmAction(null)}
                      disabled={actionLoading}
                      className="py-2 px-4 bg-surface border border-border text-foreground rounded hover:border-muted transition-colors text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleConfirmAction}
                      disabled={actionLoading}
                      className="py-2 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50 text-sm"
                    >
                      {actionLoading ? "Processing..." : "Confirm"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* --------------------------------------------------------- */}
            {/* 2. Rotation Queue                                         */}
            {/* --------------------------------------------------------- */}
            <section className="bg-surface border border-border rounded p-6">
              <h2 className="text-sm font-medium text-muted mb-4">
                Rotation queue
              </h2>

              {queue.length === 0 ? (
                <p className="text-muted text-sm">
                  No services in your queue. Add at least two to start rotating.
                </p>
              ) : queue.length === 1 ? (
                <>
                  <div className="flex items-center gap-3 bg-surface border border-border rounded px-4 py-3 mb-3">
                    <span className="text-muted text-lg leading-none select-none">
                      &#8801;
                    </span>
                    <span className="flex-1 text-foreground font-medium">
                      {queue[0].service_name}
                    </span>
                    {queue[0].subscription_status && (
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded ${statusColor(queue[0].subscription_status)}`}
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
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={queue.map((q) => q.service_id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-2">
                      {queue.map((item) => (
                        <SortableItem key={item.service_id} item={item} />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </section>

            {/* --------------------------------------------------------- */}
            {/* 3. Service Credits                                        */}
            {/* --------------------------------------------------------- */}
            {credits && (
              <section className="bg-surface border border-border rounded p-6">
                <h2 className="text-sm font-medium text-muted mb-4">
                  Service credits
                </h2>

                <div className="flex items-baseline gap-2 mb-4">
                  <span className="text-2xl font-bold text-foreground">
                    {formatSats(credits.credit_sats)} sats
                  </span>
                  <span className="text-muted text-sm">
                    (~${centsToDollars(credits.credit_usd_cents)})
                  </span>
                </div>

                <Link
                  href="/dashboard/add-credits"
                  className="inline-block py-2 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors text-sm mb-6"
                >
                  Add credits
                </Link>

                {credits.recent_transactions.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-muted mb-2">
                      Recent transactions
                    </h3>
                    <div className="space-y-1">
                      {credits.recent_transactions.map((tx) => (
                        <div
                          key={tx.id}
                          className="flex items-center justify-between text-sm py-2 border-b border-border last:border-b-0"
                        >
                          <div>
                            <span className="text-foreground">
                              {tx.description}
                            </span>
                            <span className="text-muted ml-2">
                              {formatDate(tx.created_at)}
                            </span>
                          </div>
                          <span
                            className={
                              tx.amount_sats >= 0
                                ? "text-green-400 font-medium"
                                : "text-red-400 font-medium"
                            }
                          >
                            {tx.amount_sats >= 0 ? "+" : ""}
                            {formatSats(tx.amount_sats)} sats
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* --------------------------------------------------------- */}
            {/* 4. Account                                                */}
            {/* --------------------------------------------------------- */}
            <section className="bg-surface border border-border rounded p-6 space-y-6">
              <h2 className="text-sm font-medium text-muted mb-4">Account</h2>

              <div className="text-sm text-foreground">
                <span className="text-muted">Membership:</span>{" "}
                <span className="font-medium">
                  {user.status === "active" ? "Active" : user.status}
                  {user.membership_expires_at &&
                    ` — renews ${formatDate(user.membership_expires_at)}`}
                </span>
              </div>

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
