"use client";

import { useState, useCallback, useRef } from "react";
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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { SortableQueueItem } from "@/components/sortable-queue-item";
import { ServiceCredentialForm } from "@/components/service-credential-form";
import { authFetch } from "@/lib/hooks/use-auth";
import type { EnrichedQueueItem } from "@/lib/types";
import type { ServiceOption, ServicePlan, CachedCredential } from "./types";
import { isItemPinned } from "./types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface QueueSectionProps {
  queue: EnrichedQueueItem[];
  setQueue: React.Dispatch<React.SetStateAction<EnrichedQueueItem[]>>;
  allServices: ServiceOption[];
  userDebtSats: number;
  error: string;
  setError: (msg: string) => void;
  onRefresh: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QueueSection({
  queue,
  setQueue,
  allServices,
  userDebtSats,
  error,
  setError,
  onRefresh,
}: QueueSectionProps) {
  // Add service panel
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [selectedAddService, setSelectedAddService] = useState<string | null>(null);
  const [selectedAddPlan, setSelectedAddPlan] = useState<string | null>(null);
  const [addSubmitting, setAddSubmitting] = useState(false);

  // Expanded panel state (only one panel open at a time across all items).
  const [expandedPanel, setExpandedPanel] = useState<{
    serviceId: string;
    panel: "credentials" | "confirm-action" | "remove";
    action?: "cancel" | "resume";
  } | null>(null);

  // Credential cache (lazy fetch)
  const [credentialCache, setCredentialCache] = useState<CachedCredential[] | null>(null);
  const [credentialLoading, setCredentialLoading] = useState(false);
  const [credentialError, setCredentialError] = useState(false);
  const [updatingCredentials, setUpdatingCredentials] = useState(false);

  // Action request state
  const [requestingAction, setRequestingAction] = useState(false);
  const [actionError, setActionError] = useState("");

  // Remove state
  const [removingService, setRemovingService] = useState(false);

  // Drag reorder: in-flight guard to prevent concurrent PUTs
  const reorderInFlightRef = useRef(false);
  const pendingReorderRef = useRef<{ order: string[]; rollback: EnrichedQueueItem[] } | null>(null);

  // ---------- Derived data ----------

  const pinnedItems = queue.filter(isItemPinned);
  const sortableItems = queue.filter((q) => !isItemPinned(q));

  const queueServiceIds = new Set(queue.map((q) => q.service_id));
  const availableToAdd = allServices.filter((s) => !queueServiceIds.has(s.serviceId));

  // ---------- Credential fetching ----------

  const fetchCredentials = useCallback(async () => {
    if (credentialCache) return; // already cached
    setCredentialLoading(true);
    setCredentialError(false);
    try {
      const res = await authFetch("/api/credentials");
      if (res.ok) {
        const data = await res.json();
        setCredentialCache(data.credentials ?? []);
      } else {
        setCredentialCache([]);
        setCredentialError(true);
      }
    } catch {
      setCredentialCache([]);
      setCredentialError(true);
    } finally {
      setCredentialLoading(false);
    }
  }, [credentialCache]);

  // ---------- Panel management ----------

  function handleExpandPanel(
    serviceId: string,
    panel: "credentials" | "confirm-action" | "remove" | null,
    action?: "cancel" | "resume"
  ) {
    setActionError("");
    if (panel === null) {
      setExpandedPanel(null);
      return;
    }
    // If opening credentials panel, trigger lazy fetch
    if (panel === "credentials") {
      fetchCredentials();
    }
    setExpandedPanel({ serviceId, panel, action });
  }

  // ---------- Drag and drop ----------

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const flushReorder = useCallback(async () => {
    while (pendingReorderRef.current) {
      const { order, rollback } = pendingReorderRef.current;
      pendingReorderRef.current = null;
      try {
        await authFetch("/api/queue", {
          method: "PUT",
          body: JSON.stringify({ order }),
        });
      } catch {
        setQueue(rollback);
        setError("Failed to save queue order. Please try again.");
      }
    }
    reorderInFlightRef.current = false;
  }, [setQueue, setError]);

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

      const previousQueue = queue; // capture before optimistic update
      setQueue(fullReordered);

      const order = fullReordered.map((q) => q.service_id);

      // If a PUT is already in flight, queue this order (replacing any
      // previously queued order). Only the final state matters.
      if (reorderInFlightRef.current) {
        pendingReorderRef.current = { order, rollback: previousQueue };
        return;
      }

      reorderInFlightRef.current = true;
      try {
        await authFetch("/api/queue", {
          method: "PUT",
          body: JSON.stringify({ order }),
        });
      } catch {
        setQueue(previousQueue);
        setError("Failed to save queue order. Please try again.");
      }
      // Flush any order that was queued while this PUT was in flight
      await flushReorder();
    },
    [queue, pinnedItems, sortableItems, flushReorder, setQueue, setError]
  );

  // ---------- Add service ----------

  async function handleAddService(data: { serviceId: string; email: string; password: string }) {
    setAddSubmitting(true);
    setError("");

    try {
      // 1. Save credentials
      const credRes = await authFetch("/api/credentials", {
        method: "POST",
        body: JSON.stringify({
          serviceId: data.serviceId,
          email: data.email,
          password: data.password,
        }),
      });

      if (!credRes.ok) {
        const credData = await credRes.json();
        throw new Error(credData.error || "Failed to save credentials.");
      }

      // 2. Update queue with the new service appended, preserving existing plans
      const newOrder = [...queue.map((q) => q.service_id), data.serviceId];
      const plansMap: Record<string, string> = {};
      for (const q of queue) {
        if (q.plan_id) plansMap[q.service_id] = q.plan_id;
      }
      if (selectedAddPlan) plansMap[data.serviceId] = selectedAddPlan;
      const queueRes = await authFetch("/api/queue", {
        method: "PUT",
        body: JSON.stringify({
          order: newOrder,
          plans: Object.keys(plansMap).length > 0 ? plansMap : undefined,
        }),
      });

      if (!queueRes.ok) {
        const queueData = await queueRes.json();
        throw new Error(queueData.error || "Failed to update queue.");
      }

      // 3. Invalidate credential cache (new cred was added)
      setCredentialCache(null);

      // 4. Refresh and close panel
      setShowAddPanel(false);
      setSelectedAddService(null);
      setSelectedAddPlan(null);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add service.");
    } finally {
      setAddSubmitting(false);
    }
  }

  // ---------- Update credentials ----------

  async function handleUpdateCredentials(data: { serviceId: string; email: string; password: string }) {
    setUpdatingCredentials(true);
    try {
      const res = await authFetch("/api/credentials", {
        method: "POST",
        body: JSON.stringify({
          serviceId: data.serviceId,
          email: data.email,
          password: data.password,
        }),
      });

      if (!res.ok) {
        const resData = await res.json();
        throw new Error(resData.error || "Failed to update credentials.");
      }

      // Invalidate cache and close panel
      setCredentialCache(null);
      setExpandedPanel(null);
    } catch (err) {
      throw err; // Let the ServiceCredentialForm display the error
    } finally {
      setUpdatingCredentials(false);
    }
  }

  // ---------- Request action (cancel/resume) ----------

  async function handleRequestAction(serviceId: string, action: "cancel" | "resume") {
    setRequestingAction(true);
    setActionError("");

    try {
      const res = await authFetch("/api/on-demand", {
        method: "POST",
        body: JSON.stringify({ serviceId, action }),
      });

      if (res.ok) {
        setExpandedPanel(null);
        await onRefresh();
        return;
      }

      const data = await res.json();
      if (res.status === 403) {
        if (data.debt_sats) {
          setActionError(`Outstanding balance of ${data.debt_sats.toLocaleString()} sats. Clear it first.`);
        } else {
          setActionError(data.error || "Action blocked.");
        }
      } else if (res.status === 409) {
        setActionError("A cancel or resume is already in progress for this service.");
      } else {
        setActionError(data.error || "Something went wrong. Try again or use the Nostr bot.");
      }
    } catch {
      setActionError("Something went wrong. Try again or use the Nostr bot.");
    } finally {
      setRequestingAction(false);
    }
  }

  // ---------- Remove service ----------

  async function handleRemoveService(serviceId: string) {
    setRemovingService(true);
    setError("");

    try {
      const res = await authFetch(`/api/queue/${serviceId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to remove service.");
        return;
      }

      setExpandedPanel(null);
      setCredentialCache(null);
      await onRefresh();
    } catch {
      setError("Failed to remove service.");
    } finally {
      setRemovingService(false);
    }
  }

  // ---------- Helpers for rendering ----------

  function getCredentialEmail(serviceId: string): string | undefined {
    if (!credentialCache) return undefined;
    return credentialCache.find((c) => c.serviceId === serviceId)?.email;
  }

  function renderQueueItem(item: EnrichedQueueItem, pinned: boolean) {
    const isExpanded = expandedPanel?.serviceId === item.service_id;
    const currentPanel = isExpanded ? expandedPanel!.panel : null;

    return (
      <SortableQueueItem
        key={item.service_id}
        item={item}
        pinned={pinned}
        expandedPanel={currentPanel}
        overrideAction={isExpanded ? expandedPanel!.action : undefined}
        onExpandPanel={(panel, action) => handleExpandPanel(item.service_id, panel, action)}
        onUpdateCredentials={handleUpdateCredentials}
        onRequestAction={handleRequestAction}
        onRemoveService={handleRemoveService}
        credentialEmail={getCredentialEmail(item.service_id)}
        credentialLoading={credentialLoading && isExpanded && currentPanel === "credentials"}
        credentialError={credentialError && isExpanded && currentPanel === "credentials"}
        updatingCredentials={updatingCredentials}
        requestingAction={requestingAction}
        removingService={removingService}
        userDebtSats={userDebtSats}
        actionError={isExpanded && currentPanel === "confirm-action" ? actionError : undefined}
      />
    );
  }

  // ---------- Render ----------

  return (
    <section className="bg-surface border border-border rounded p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-muted">
          Your queue
        </h2>
        {availableToAdd.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setShowAddPanel(!showAddPanel);
              setSelectedAddService(null);
              setSelectedAddPlan(null);
            }}
            className="text-xs font-medium text-accent hover:text-accent/80 transition-colors"
          >
            {showAddPanel ? "Cancel" : "+ Add service"}
          </button>
        )}
      </div>

      {/* Add service panel */}
      {showAddPanel && (() => {
        const selectedSvc = availableToAdd.find((s) => s.serviceId === selectedAddService);
        const hasMultiplePlans = selectedSvc && selectedSvc.plans.length > 1;
        const needsPlanSelection = selectedAddService && hasMultiplePlans && !selectedAddPlan;
        const showCredForm = selectedAddService && (!hasMultiplePlans || selectedAddPlan);

        return (
          <div className="bg-surface border border-accent/30 rounded p-4 mb-4 space-y-3">
            <p className="text-sm font-medium text-foreground">
              Add a service
            </p>
            {!selectedAddService ? (
              <div className="space-y-2">
                {availableToAdd.map((svc) => (
                  <button
                    key={svc.serviceId}
                    type="button"
                    onClick={() => {
                      setSelectedAddService(svc.serviceId);
                      setSelectedAddPlan(null);
                      // Auto-select plan for single-plan services
                      if (svc.plans.length === 1) {
                        setSelectedAddPlan(svc.plans[0].id);
                      }
                    }}
                    className="flex items-center justify-between w-full px-4 py-3 rounded-lg border border-border bg-surface hover:border-amber-500/40 text-sm transition-colors"
                  >
                    <span className="font-medium text-foreground">{svc.label}</span>
                    <span className="text-muted text-xs">Select</span>
                  </button>
                ))}
              </div>
            ) : needsPlanSelection ? (
              <div>
                <button
                  type="button"
                  onClick={() => { setSelectedAddService(null); setSelectedAddPlan(null); }}
                  className="text-xs text-muted hover:text-foreground transition-colors mb-2"
                >
                  &larr; Pick a different service
                </button>
                <p className="text-sm text-muted mb-2">Which plan?</p>
                <div className="space-y-1">
                  {selectedSvc!.plans.map((plan) => (
                    <button
                      key={plan.id}
                      type="button"
                      onClick={() => setSelectedAddPlan(plan.id)}
                      className="w-full flex items-center justify-between py-2 px-3 rounded text-sm border border-border bg-surface hover:border-amber-500/40 transition-colors"
                    >
                      <span>{plan.display_name}</span>
                      <span className="text-muted/60">${(plan.monthly_price_cents / 100).toFixed(2)}/mo</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : showCredForm ? (
              <div>
                <button
                  type="button"
                  onClick={() => { setSelectedAddService(null); setSelectedAddPlan(null); }}
                  className="text-xs text-muted hover:text-foreground transition-colors mb-2"
                >
                  &larr; Pick a different service
                </button>
                {selectedAddPlan && selectedSvc && (
                  <p className="text-xs text-muted mb-2">
                    {selectedSvc.plans.find((p) => p.id === selectedAddPlan)?.display_name}
                  </p>
                )}
                <ServiceCredentialForm
                  serviceId={selectedAddService!}
                  serviceName={selectedSvc?.label ?? selectedAddService!}
                  onSubmit={handleAddService}
                  submitting={addSubmitting}
                  submitLabel="Add to queue"
                />
              </div>
            ) : null}
          </div>
        );
      })()}

      {queue.length === 0 ? (
        <p className="text-muted text-sm">
          No services in your queue. Add services above.
        </p>
      ) : (
        <div className="space-y-2">
          {/* Pinned items (active jobs) */}
          {pinnedItems.map((item) => renderQueueItem(item, true))}

          {/* Sortable items (no active job) */}
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
                  {sortableItems.map((item) => renderQueueItem(item, false))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      )}

      <p className="text-xs text-muted/60 mt-4">
        Drag to reorder queued services. We&apos;ll use this order to remind you when it is time to rotate.
      </p>
    </section>
  );
}
