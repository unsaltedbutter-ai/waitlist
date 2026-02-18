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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { SortableQueueItem } from "@/components/sortable-queue-item";
import { ServiceCredentialForm } from "@/components/service-credential-form";
import { DebtBanner } from "@/components/debt-banner";
import { hexToNpub } from "@/lib/nostr";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueueItem {
  service_id: string;
  service_name: string;
  position: number;
  subscription_status: "active" | "cancel_scheduled" | "signup_scheduled" | null;
  subscription_end_date: string | null;
  plan_id: string | null;
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

interface ServicePlan {
  id: string;
  service_id: string;
  display_name: string;
  monthly_price_cents: number;
  has_ads: boolean;
  is_bundle: boolean;
}

interface ServiceOption {
  serviceId: string;
  label: string;
  plans: ServicePlan[];
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
    case "completed_paid":
    case "completed_eventual":
      return "bg-green-900/50 text-green-400 border border-green-700";
    case "completed_reneged":
      return "bg-red-900/50 text-red-400 border border-red-700";
    case "active":
    case "awaiting_otp":
    case "dispatched":
      return "bg-blue-900/50 text-blue-400 border border-blue-700";
    case "outreach_sent":
    case "snoozed":
      return "bg-amber-900/50 text-amber-400 border border-amber-700";
    case "user_skip":
    case "user_abandon":
    case "implied_skip":
      return "bg-neutral-800/50 text-neutral-500 border border-neutral-700";
    case "pending":
    default:
      return "bg-neutral-800/50 text-neutral-400 border border-neutral-700";
  }
}

function flowTypeLabel(flowType: string): string {
  switch (flowType) {
    case "cancel":
      return "Cancel";
    case "resume":
      return "Resume";
    default:
      return flowType;
  }
}

function jobStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "dispatched":
      return "Dispatched";
    case "outreach_sent":
      return "Outreach sent";
    case "snoozed":
      return "Snoozed";
    case "active":
      return "Active";
    case "awaiting_otp":
      return "Awaiting OTP";
    case "completed_paid":
      return "Paid";
    case "completed_eventual":
      return "Paid (late)";
    case "completed_reneged":
      return "Unpaid";
    case "user_skip":
      return "Skipped";
    case "user_abandon":
      return "Abandoned";
    case "implied_skip":
      return "Implied skip";
    default:
      return status;
  }
}

function isItemPinned(item: QueueItem): boolean {
  return (
    item.subscription_status === "active" ||
    item.subscription_status === "cancel_scheduled" ||
    item.subscription_status === "signup_scheduled"
  );
}

// ---------------------------------------------------------------------------
// Dashboard Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const { user, loading: authLoading, logout } = useAuth();

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState("");

  // Nostr npub copy
  const [npubCopied, setNpubCopied] = useState(false);

  // Delete account
  const [deleteInput, setDeleteInput] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Add service panel
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [allServices, setAllServices] = useState<ServiceOption[]>([]);
  const [selectedAddService, setSelectedAddService] = useState<string | null>(null);
  const [selectedAddPlan, setSelectedAddPlan] = useState<string | null>(null);
  const [addSubmitting, setAddSubmitting] = useState(false);

  // Remove confirmation
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);
  const [removeLoading, setRemoveLoading] = useState(false);

  // ---------- Data fetching ----------

  const fetchData = useCallback(async () => {
    setLoadingData(true);
    setError("");
    try {
      const [qRes, meRes] = await Promise.all([
        authFetch("/api/queue"),
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
        setJobs(meData.recent_jobs ?? []);
      }
    } catch {
      setError("Failed to load dashboard data.");
    } finally {
      setLoadingData(false);
    }
  }, []);

  const fetchAllServices = useCallback(async () => {
    try {
      const res = await fetch("/api/service-plans");
      if (!res.ok) return;
      const data = await res.json();
      if (data.groups) {
        setAllServices(
          data.groups.map((g: { serviceId: string; label: string; plans: ServicePlan[] }) => ({
            serviceId: g.serviceId,
            label: g.label,
            plans: g.plans,
          }))
        );
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    if (!authLoading && user) {
      fetchData();
      fetchAllServices();
    }
  }, [authLoading, user, fetchData, fetchAllServices]);

  // ---------- Derived data ----------

  const pinnedItems = queue.filter(isItemPinned);
  const sortableItems = queue.filter((q) => !isItemPinned(q));

  const queueServiceIds = new Set(queue.map((q) => q.service_id));
  const availableToAdd = allServices.filter((s) => !queueServiceIds.has(s.serviceId));

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

      // 3. Refresh and close panel
      setShowAddPanel(false);
      setSelectedAddService(null);
      setSelectedAddPlan(null);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add service.");
    } finally {
      setAddSubmitting(false);
    }
  }

  // ---------- Remove service ----------

  async function handleRemoveService(serviceId: string) {
    setRemoveLoading(true);
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

      setRemoveConfirm(null);
      await fetchData();
    } catch {
      setError("Failed to remove service.");
    } finally {
      setRemoveLoading(false);
    }
  }

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

  // ---------- Helpers for rendering ----------

  function renderStatusBadge(item: QueueItem) {
    if (!item.subscription_status) return null;
    return (
      <span
        className={`text-xs font-medium px-2 py-0.5 rounded shrink-0 ${statusColor(item.subscription_status)}`}
      >
        {statusLabel(item.subscription_status)}
      </span>
    );
  }

  // ---------- Render ----------

  return (
    <main className="min-h-screen">
      <div className="max-w-2xl mx-auto px-4 py-12 space-y-8">
        <h1 className="text-4xl font-bold tracking-tight text-foreground">
          Dashboard
        </h1>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        {/* Outstanding debt warning + pay flow */}
        <DebtBanner />

        {loadingData ? (
          <p className="text-muted">Loading your data...</p>
        ) : (
          <>
            {/* --------------------------------------------------------- */}
            {/* 1. Rotation Queue                                         */}
            {/* --------------------------------------------------------- */}
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

              {/* Remove confirmation dialog */}
              {removeConfirm && (
                <div className="bg-red-900/20 border border-red-700 rounded p-4 mb-4">
                  <p className="text-sm text-red-300 mb-3">
                    Remove{" "}
                    <span className="font-medium text-red-200">
                      {queue.find((q) => q.service_id === removeConfirm)?.service_name}
                    </span>
                    ? This will also delete your saved credentials for this service.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleRemoveService(removeConfirm)}
                      disabled={removeLoading}
                      className="py-1.5 px-3 bg-red-800 text-red-200 text-sm font-medium rounded hover:bg-red-700 transition-colors disabled:opacity-50"
                    >
                      {removeLoading ? "Removing..." : "Remove"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemoveConfirm(null)}
                      disabled={removeLoading}
                      className="py-1.5 px-3 bg-surface border border-border text-foreground text-sm rounded hover:border-muted transition-colors"
                    >
                      Keep
                    </button>
                  </div>
                </div>
              )}

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
                  {/* Pinned items (active/scheduled) */}
                  {pinnedItems.map((item) => (
                    <SortableQueueItem
                      key={item.service_id}
                      item={{ serviceId: item.service_id, serviceName: item.service_name, planName: item.plan_name ?? undefined }}
                      pinned
                      statusBadge={renderStatusBadge(item)}
                    />
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
                            <SortableQueueItem
                              key={item.service_id}
                              item={{ serviceId: item.service_id, serviceName: item.service_name, planName: item.plan_name ?? undefined }}
                              statusBadge={renderStatusBadge(item)}
                              onRemove={() => setRemoveConfirm(item.service_id)}
                            />
                          ))}
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

            {/* --------------------------------------------------------- */}
            {/* 2. Recent Job History                                      */}
            {/* --------------------------------------------------------- */}
            <section className="bg-surface border border-border rounded p-6">
              <h2 className="text-sm font-medium text-muted mb-4">
                Recent jobs
              </h2>

              <p className="text-xs text-muted/60 mb-4">
                When you request a cancel or resume, it will show up here. Each cancel or resume costs 3,000 sats.
              </p>

              {jobs.length > 0 && (
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
                              {jobStatusLabel(job.status)}
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
              )}
            </section>

            {/* --------------------------------------------------------- */}
            {/* 3. Account                                                */}
            {/* --------------------------------------------------------- */}
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
                  All credentials and queue data will be destroyed immediately.
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
          </>
        )}
      </div>
    </main>
  );
}
