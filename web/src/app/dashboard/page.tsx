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
  subscription_status: "active" | "cancel_scheduled" | "signup_scheduled" | null;
  subscription_end_date: string | null;
  plan_name: string | null;
  plan_price_cents: number | null;
}

interface SlotData {
  slot_number: number;
  current_service_id: string | null;
  current_service_name: string | null;
  next_service_id: string | null;
  next_service_name: string | null;
  locked_at: string | null;
  subscription_status: "active" | "cancel_scheduled" | "signup_scheduled" | null;
  subscription_end_date: string | null;
}

type LockInState = "unlocked" | "imminent" | "locked";

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
      return "Signing up";
    default:
      return "Queued";
  }
}

function activeDescription(item: QueueItem): string {
  const date = item.subscription_end_date
    ? formatDate(item.subscription_end_date)
    : null;

  switch (item.subscription_status) {
    case "active":
      return date
        ? `Active through ~${date}`
        : "Active";
    case "cancel_scheduled":
      return date
        ? `Cancel pending, ends ~${date}`
        : "Cancel pending";
    case "signup_scheduled":
      return "Signing up now";
    default:
      return "Queued";
  }
}

/** Determine lock-in state for a slot. */
function getLockInState(slot: SlotData): LockInState {
  // If locked_at is set, the gift card has been purchased
  if (slot.locked_at) return "locked";

  // If there's an active subscription, check how far along we are
  if (slot.subscription_status === "active" && slot.subscription_end_date) {
    // Lock-in happens around day 14. If cancel is already scheduled, it's imminent or locked.
    return "unlocked";
  }

  if (slot.subscription_status === "cancel_scheduled") {
    return "imminent";
  }

  if (slot.subscription_status === "signup_scheduled") {
    return "imminent";
  }

  return "unlocked";
}

/** Border class for lock-in state. */
function lockInBorderClass(state: LockInState): string {
  switch (state) {
    case "locked":
      return "border-green-600";
    case "imminent":
      return "border-amber-600";
    default:
      return "border-border";
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
      {item.plan_name && (
        <span className="text-muted/60 text-sm shrink-0">
          {item.plan_name}
          {item.plan_price_cents != null &&
            `  $${(item.plan_price_cents / 100).toFixed(2)}/mo`}
        </span>
      )}
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
// PinnedItem (non-draggable, locked/imminent queue item)
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
      {item.plan_name && (
        <span className="text-muted/60 text-sm shrink-0">
          {item.plan_name}
          {item.plan_price_cents != null &&
            `  $${(item.plan_price_cents / 100).toFixed(2)}/mo`}
        </span>
      )}
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
// SlotCard
// ---------------------------------------------------------------------------

interface SlotCardProps {
  slot: SlotData;
  slotLabel: string;
  onStay: (serviceId: string, serviceName: string) => void;
  onSkip: (serviceId: string, serviceName: string) => void;
  onSendBackToQueue: (serviceId: string) => void;
}

function SlotCard({ slot, slotLabel, onStay, onSkip, onSendBackToQueue }: SlotCardProps) {
  const lockInState = getLockInState(slot);
  const borderClass = lockInBorderClass(lockInState);

  const hasCurrentService = slot.current_service_id && slot.current_service_name;
  const hasNextService = slot.next_service_id && slot.next_service_name;

  return (
    <div className={`bg-surface border ${borderClass} rounded p-6`}>
      <h2 className="text-sm font-medium text-muted mb-4">
        {slotLabel}
      </h2>

      {hasCurrentService ? (
        <div>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-2xl font-bold text-foreground">
              {slot.current_service_name}
            </span>
            {slot.subscription_status && (
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded ${statusColor(slot.subscription_status)}`}
              >
                {statusLabel(slot.subscription_status)}
              </span>
            )}
          </div>

          <p className="text-muted text-sm mb-4">
            {activeDescription({
              service_id: slot.current_service_id!,
              service_name: slot.current_service_name!,
              position: 0,
              subscription_status: slot.subscription_status,
              subscription_end_date: slot.subscription_end_date,
              plan_name: null,
              plan_price_cents: null,
            })}
          </p>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() =>
                onStay(slot.current_service_id!, slot.current_service_name!)
              }
              className="py-2 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors text-sm"
            >
              Stay
            </button>
            <button
              type="button"
              onClick={() =>
                onSkip(slot.current_service_id!, slot.current_service_name!)
              }
              className="py-2 px-4 bg-surface border border-border text-foreground font-semibold rounded hover:border-muted transition-colors text-sm"
            >
              Skip
            </button>
          </div>
        </div>
      ) : (
        <p className="text-muted text-sm">
          No active subscription in this slot.
        </p>
      )}

      {/* Next service info */}
      {hasNextService && (
        <div className="mt-4 pt-4 border-t border-border">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="text-xs font-medium text-muted">Next up: </span>
              <span className="text-sm font-medium text-foreground">
                {slot.next_service_name}
              </span>
              {lockInState === "locked" && (
                <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded bg-green-900/50 text-green-400 border border-green-700">
                  Locked in
                </span>
              )}
              {lockInState === "imminent" && (
                <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded bg-amber-900/50 text-amber-400 border border-amber-700">
                  Locking soon
                </span>
              )}
            </div>
            {lockInState === "unlocked" && (
              <button
                type="button"
                onClick={() => onSendBackToQueue(slot.next_service_id!)}
                className="shrink-0 py-1.5 px-3 bg-surface border border-border text-muted font-medium rounded hover:border-muted hover:text-foreground transition-colors text-xs"
              >
                Send back to queue
              </button>
            )}
          </div>
        </div>
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
  const [slots, setSlots] = useState<SlotData[]>([]);
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

  // Nostr npub copy
  const [npubCopied, setNpubCopied] = useState(false);

  // Delete account
  const [deleteInput, setDeleteInput] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);

  const isDuo = user?.membership_plan === "duo";

  // ---------- Data fetching ----------

  const fetchData = useCallback(async () => {
    setLoadingData(true);
    setError("");
    try {
      const fetches: Promise<Response>[] = [
        authFetch("/api/queue"),
        authFetch("/api/credits"),
      ];

      // Fetch slots for all users (Solo gets 1, Duo gets 2)
      fetches.push(authFetch("/api/slots"));

      const responses = await Promise.all(fetches);
      const [qRes, cRes, sRes] = responses;

      if (!qRes.ok || !cRes.ok) {
        setError("Failed to load dashboard data.");
        setLoadingData(false);
        return;
      }

      const qData = await qRes.json();
      const cData = await cRes.json();
      setQueue(qData.queue);
      setCredits(cData);

      if (sRes && sRes.ok) {
        const sData = await sRes.json();
        setSlots(sData.slots);
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

  // Split queue into pinned (active/scheduled) and sortable (queued)
  const pinnedItems = queue.filter(isItemPinned);
  const sortableItems = queue.filter((q) => !isItemPinned(q));

  // For Solo users without slot data, fall back to the old active item detection
  const activeItem = queue.find(
    (q) =>
      q.subscription_status === "active" ||
      q.subscription_status === "cancel_scheduled" ||
      q.subscription_status === "signup_scheduled"
  );

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

      // Only reorder within sortable items, then reconstruct full queue
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
        // Revert on failure
        setQueue(queue);
      }
    },
    [queue, pinnedItems, sortableItems]
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

  // ---------- Send back to queue ----------

  const handleSendBackToQueue = useCallback(
    async (serviceId: string) => {
      // Move the service from next_service on its slot back to the end of the queue.
      // Reorder: put it at the end of the current queue order.
      const currentOrder = queue.map((q) => q.service_id);
      // If the service is already in the queue, move it to the end
      const filtered = currentOrder.filter((id) => id !== serviceId);
      const newOrder = [...filtered, serviceId];

      // Optimistic update
      const serviceInQueue = queue.find((q) => q.service_id === serviceId);
      if (serviceInQueue) {
        const reordered = [
          ...queue.filter((q) => q.service_id !== serviceId),
          { ...serviceInQueue, subscription_status: null as QueueItem["subscription_status"], subscription_end_date: null },
        ];
        setQueue(reordered);
      }

      try {
        await authFetch("/api/queue", {
          method: "PUT",
          body: JSON.stringify({ order: newOrder }),
        });
        await fetchData();
      } catch {
        setError("Failed to send service back to queue.");
        await fetchData(); // Revert by re-fetching
      }
    },
    [queue, fetchData]
  );

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

  const containerWidth = isDuo ? "max-w-4xl" : "max-w-2xl";
  const hasSlots = slots.length > 0;

  return (
    <main className="min-h-screen">
      <div className={`${containerWidth} mx-auto px-4 py-12 space-y-8`}>
        <h1 className="text-4xl font-bold tracking-tight text-foreground">
          Your rotation
        </h1>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        {loadingData ? (
          <p className="text-muted">Loading your data...</p>
        ) : (
          <>
            {/* --------------------------------------------------------- */}
            {/* 1. Slot Cards (or single active subscription card)        */}
            {/* --------------------------------------------------------- */}
            {hasSlots ? (
              <div
                className={
                  isDuo
                    ? "grid grid-cols-1 md:grid-cols-2 gap-4"
                    : ""
                }
              >
                {slots.map((slot) => (
                  <SlotCard
                    key={slot.slot_number}
                    slot={slot}
                    slotLabel={
                      isDuo
                        ? `Slot ${slot.slot_number}`
                        : "Current subscription"
                    }
                    onStay={(serviceId, serviceName) =>
                      setConfirmAction({ type: "stay", serviceId, serviceName })
                    }
                    onSkip={(serviceId, serviceName) =>
                      setConfirmAction({ type: "skip", serviceId, serviceName })
                    }
                    onSendBackToQueue={handleSendBackToQueue}
                  />
                ))}
              </div>
            ) : (
              /* Fallback: no slots exist yet (Solo, pre-orchestrator) */
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
            )}

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
                    <span className="flex-1 text-foreground font-medium min-w-0 truncate">
                      {queue[0].service_name}
                    </span>
                    {queue[0].plan_name && (
                      <span className="text-muted/60 text-sm shrink-0">
                        {queue[0].plan_name}
                        {queue[0].plan_price_cents != null &&
                          `  $${(queue[0].plan_price_cents / 100).toFixed(2)}/mo`}
                      </span>
                    )}
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
                  {/* Pinned items (active/scheduled) - not draggable */}
                  {pinnedItems.map((item) => (
                    <PinnedItem key={item.service_id} item={item} />
                  ))}

                  {/* Sortable items (queued) - draggable */}
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
                          className="flex items-center justify-between gap-3 text-sm py-2 border-b border-border last:border-b-0"
                        >
                          <div className="min-w-0">
                            <span className="text-foreground truncate block">
                              {tx.description}
                            </span>
                            <span className="text-muted text-xs">
                              {formatDate(tx.created_at)}
                            </span>
                          </div>
                          <span
                            className={`shrink-0 ${
                              tx.amount_sats >= 0
                                ? "text-green-400 font-medium"
                                : "text-red-400 font-medium"
                            }`}
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

              <div className="text-sm text-foreground space-y-2">
                <div>
                  <span className="text-muted">Membership:</span>{" "}
                  <span className="font-medium">
                    {user.status === "active" ? "Active" : user.status}
                    {user.membership_expires_at &&
                      ` \u2014 renews ${formatDate(user.membership_expires_at)}`}
                  </span>
                </div>
                <div>
                  <span className="text-muted">Plan:</span>{" "}
                  <span className="font-medium capitalize">
                    {user.membership_plan}
                  </span>
                  {user.membership_plan === "solo" && (
                    <Link
                      href="/dashboard/upgrade"
                      className="ml-3 text-xs text-accent hover:text-accent/80 transition-colors"
                    >
                      Upgrade to Duo
                    </Link>
                  )}
                </div>
              </div>

              {/* Nostr bot */}
              {process.env.NEXT_PUBLIC_NOSTR_BOT_NAME && (
                <div className="border border-border rounded p-4 space-y-2">
                  <h3 className="text-sm font-medium text-foreground">
                    {process.env.NEXT_PUBLIC_NOSTR_BOT_NAME}
                  </h3>
                  <p className="text-sm text-muted">
                    DM for status, queue, skip, or stay commands.
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
