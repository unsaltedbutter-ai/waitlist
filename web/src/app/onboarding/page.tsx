"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
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
import {
  StepIndicator,
  SortableItem,
  PasswordToggle,
  ServiceIcon,
  type QueueItem,
} from "./_components";

interface Plan {
  id: string;
  service_id: string;
  display_name: string;
  monthly_price_cents: number;
  has_ads: boolean;
  is_bundle: boolean;
}

interface ServiceGroup {
  id: string;
  label: string;
  serviceId: string;
  plans: Plan[];
}

interface ServiceOption {
  service_id: string;
  service_name: string;
}

export default function OnboardingPage() {
  const router = useRouter();
  const { loading } = useAuth();

  const [step, setStep] = useState(1);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  // Step 2 state: services + credentials
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [serviceGroups, setServiceGroups] = useState<ServiceGroup[]>([]);
  const [selectedPlans, setSelectedPlans] = useState<Record<string, string>>({});
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [creds, setCreds] = useState<Record<string, { email: string; password: string }>>({});
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});

  // Step 3 state: queue order
  const [queue, setQueue] = useState<QueueItem[]>([]);

  // Fetch available services on mount
  useEffect(() => {
    fetch("/api/service-plans")
      .then((r) => r.json())
      .then((data) => {
        if (data.groups) {
          setServiceGroups(data.groups);
          const svcList: ServiceOption[] = data.groups.map((g: { serviceId: string; label: string }) => ({
            service_id: g.serviceId,
            service_name: g.label,
          }));
          setServices(svcList);
        }
      })
      .catch(() => {});
  }, []);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-muted">Loading...</p>
      </main>
    );
  }

  // --- Helpers ---

  const selectedServiceIds = Object.keys(selectedPlans);

  function toggleCard(serviceId: string) {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(serviceId)) {
        next.delete(serviceId);
      } else {
        next.add(serviceId);
      }
      return next;
    });
  }

  function selectPlan(serviceId: string, planId: string) {
    setSelectedPlans((prev) => {
      if (prev[serviceId] === planId) {
        // Deselect: remove the plan (deselects the service)
        const next = { ...prev };
        delete next[serviceId];
        return next;
      }
      return { ...prev, [serviceId]: planId };
    });
  }

  function getGroupForService(serviceId: string): ServiceGroup | undefined {
    return serviceGroups.find((g) => g.serviceId === serviceId);
  }

  function getSelectedPlanForService(serviceId: string): Plan | undefined {
    const planId = selectedPlans[serviceId];
    if (!planId) return undefined;
    const group = getGroupForService(serviceId);
    return group?.plans.find((p) => p.id === planId);
  }

  function updateCred(serviceId: string, field: "email" | "password", value: string) {
    setCreds((prev) => ({
      ...prev,
      [serviceId]: {
        email: prev[serviceId]?.email ?? "",
        password: prev[serviceId]?.password ?? "",
        [field]: value,
      },
    }));
  }

  function formatPrice(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  const canSaveStep2 = (() => {
    if (selectedServiceIds.length === 0) return true; // allow skip
    return selectedServiceIds.every((sid) => {
      const c = creds[sid];
      return c?.email && c?.password;
    });
  })();

  // =====================================================================
  // Step 1: Before you start
  // =====================================================================

  function renderStep1() {
    return (
      <div className="space-y-8">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white">
          Before you start
        </h1>

        <div className="flex flex-col gap-4">
          <div className="flex gap-3.5 items-start text-base text-muted leading-relaxed">
            <svg className="w-5 h-5 mt-0.5 shrink-0 text-accent opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <span>We cancel &amp; resume subscriptions on your behalf, charged per transaction.</span>
          </div>
          <div className="flex gap-3.5 items-start text-base text-muted leading-relaxed">
            <svg className="w-5 h-5 mt-0.5 shrink-0 text-accent opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            <span>Your credentials are encrypted and destroyed when you delete your account. We never share your data.</span>
          </div>
          <div className="flex gap-3.5 items-start text-base text-muted leading-relaxed">
            <svg className="w-5 h-5 mt-0.5 shrink-0 text-accent opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span>Using UnsaltedButter may violate a streaming service&apos;s Terms of Service. Accounts could be suspended at their discretion.</span>
          </div>
          <div className="flex gap-3.5 items-start text-base text-muted leading-relaxed">
            <svg className="w-5 h-5 mt-0.5 shrink-0 text-accent opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            <span>You&apos;re responsible for verifying your subscriptions. We can&apos;t guarantee every action will succeed.</span>
          </div>
        </div>

        <div className="bg-accent/10 border border-accent/30 rounded-xl p-5">
          <p className="text-xs font-semibold text-accent uppercase tracking-wider mb-2">
            Heads up
          </p>
          <p className="text-sm text-muted leading-relaxed">
            UnsaltedButter is not liable for any action a streaming provider takes against your account, including suspension or loss of content.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setStep(2)}
          className="w-full py-4 px-4 bg-accent text-background font-semibold text-base rounded-xl hover:shadow-[0_6px_24px_rgba(245,158,11,0.3)] hover:-translate-y-px active:translate-y-0 transition-all"
        >
          Continue
        </button>
      </div>
    );
  }

  // =====================================================================
  // Step 2: Add Services + Credentials
  // =====================================================================

  async function saveCredentials() {
    setError("");

    // If no services selected, skip to queue step
    if (selectedServiceIds.length === 0) {
      setQueue([]);
      setStep(3);
      return;
    }

    // Validate credentials are filled in
    for (const sid of selectedServiceIds) {
      const c = creds[sid];
      if (!c?.email || !c?.password) {
        const svc = services.find((s) => s.service_id === sid);
        setError(`Enter credentials for ${svc?.service_name ?? sid}.`);
        return;
      }
    }

    setSubmitting(true);
    try {
      for (const sid of selectedServiceIds) {
        const c = creds[sid] ?? { email: "", password: "" };

        const res = await authFetch("/api/credentials", {
          method: "POST",
          body: JSON.stringify({
            serviceId: sid,
            email: c.email,
            password: c.password,
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          const svc = services.find((s) => s.service_id === sid);
          setError(data.error || `Failed to save credentials for ${svc?.service_name ?? sid}.`);
          setSubmitting(false);
          return;
        }
      }

      // Build queue from selected services
      const savedQueue: QueueItem[] = selectedServiceIds.map((sid) => {
        const svc = services.find((s) => s.service_id === sid)!;
        const plan = getSelectedPlanForService(sid);
        return {
          serviceId: sid,
          serviceName: svc.service_name,
          planName: plan?.display_name,
          planPriceCents: plan?.monthly_price_cents,
        };
      });
      setQueue(savedQueue);

      setSubmitting(false);
      setStep(3);
    } catch {
      setError("Connection failed. Try again.");
      setSubmitting(false);
    }
  }

  function renderStep2() {
    return (
      <div className="space-y-6">
        <button
          type="button"
          onClick={() => setStep(1)}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>

        <div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-3">
            Add your services
          </h1>
          <p className="text-base text-muted leading-relaxed">
            Select the streaming services you want us to manage, pick your plan, and add your login.
          </p>
        </div>

        {/* Trust banner */}
        <div className="flex items-start gap-3 bg-green-500/8 border border-green-500/20 rounded-xl p-4">
          <svg className="w-4.5 h-4.5 mt-0.5 shrink-0 text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <p className="text-sm text-muted leading-relaxed">
            Your credentials are <span className="text-foreground font-medium">encrypted at rest</span> and only used when you explicitly ask us to act. We never share or access them otherwise.
          </p>
        </div>

        {/* Service cards */}
        <div className="flex flex-col gap-2.5">
          {services.map((svc) => {
            const group = getGroupForService(svc.service_id);
            const isExpanded = expandedCards.has(svc.service_id);
            const selectedPlan = getSelectedPlanForService(svc.service_id);
            const isSelected = !!selectedPlan;
            const hasCreds = !!(creds[svc.service_id]?.email && creds[svc.service_id]?.password);

            return (
              <div
                key={svc.service_id}
                className={`border rounded-xl overflow-hidden transition-colors ${
                  isSelected
                    ? "border-accent/30"
                    : "border-border"
                } ${!isSelected && !isExpanded ? "opacity-70" : ""}`}
              >
                {/* Card header */}
                <button
                  type="button"
                  onClick={() => toggleCard(svc.service_id)}
                  className="flex items-center justify-between w-full px-4 py-3.5 bg-surface hover:bg-surface/80 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <ServiceIcon serviceId={svc.service_id} />
                    <span className="font-semibold text-foreground text-base">
                      {svc.service_name}
                    </span>
                  </div>
                  <div className="flex items-center gap-2.5">
                    {isSelected && selectedPlan ? (
                      <span className="text-xs text-accent bg-accent/10 px-2.5 py-1 rounded-md font-medium">
                        {selectedPlan.display_name} &middot; {formatPrice(selectedPlan.monthly_price_cents)}
                      </span>
                    ) : group && group.plans.length > 0 ? (
                      <span className="text-xs text-muted/50 bg-white/4 px-2.5 py-1 rounded-md">
                        {group.plans.length} plan{group.plans.length > 1 ? "s" : ""}
                      </span>
                    ) : null}
                    <svg
                      className={`w-4.5 h-4.5 text-muted/40 transition-transform duration-200 ${
                        isExpanded ? "rotate-180" : ""
                      }`}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </button>

                {/* Card body (expanded) */}
                {isExpanded && group && (
                  <div className="px-4 pb-4 bg-surface space-y-4">
                    {/* Plan selector */}
                    <div className="space-y-1.5">
                      <span className="text-xs font-semibold text-muted/50 uppercase tracking-wider">
                        Select your plan
                      </span>
                      {group.plans.map((plan) => {
                        const isPlanSelected = selectedPlans[svc.service_id] === plan.id;
                        return (
                          <button
                            key={plan.id}
                            type="button"
                            onClick={() => selectPlan(svc.service_id, plan.id)}
                            className={`w-full flex items-center justify-between py-2.5 px-3.5 rounded-lg border text-sm transition-colors ${
                              isPlanSelected
                                ? "border-accent bg-accent/10"
                                : "border-border hover:border-white/15"
                            }`}
                          >
                            <span className={isPlanSelected ? "text-foreground" : "text-muted"}>
                              {plan.display_name}
                            </span>
                            <span className={`font-semibold ${isPlanSelected ? "text-accent" : "text-muted/40"}`}>
                              {formatPrice(plan.monthly_price_cents)}/mo
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Credential fields */}
                    {isSelected && (
                      <div className="flex gap-2.5">
                        <div className="flex-1">
                          <input
                            type="email"
                            value={creds[svc.service_id]?.email ?? ""}
                            onChange={(e) => updateCred(svc.service_id, "email", e.target.value)}
                            placeholder="Email"
                            className="w-full py-3 px-3.5 bg-background border border-border rounded-lg text-foreground placeholder:text-muted/40 text-sm focus:outline-none focus:border-accent/50 transition-colors"
                          />
                        </div>
                        <div className="flex-1 relative">
                          <input
                            type={showPasswords[svc.service_id] ? "text" : "password"}
                            value={creds[svc.service_id]?.password ?? ""}
                            onChange={(e) => updateCred(svc.service_id, "password", e.target.value)}
                            placeholder="Password"
                            className="w-full py-3 px-3.5 pr-10 bg-background border border-border rounded-lg text-foreground placeholder:text-muted/40 text-sm focus:outline-none focus:border-accent/50 transition-colors"
                          />
                          <PasswordToggle
                            visible={!!showPasswords[svc.service_id]}
                            onToggle={() =>
                              setShowPasswords((prev) => ({
                                ...prev,
                                [svc.service_id]: !prev[svc.service_id],
                              }))
                            }
                          />
                        </div>
                      </div>
                    )}

                    {/* Status indicator */}
                    {isSelected && hasCreds && (
                      <p className="text-xs text-green-400/70 flex items-center gap-1.5">
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                        Ready
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="button"
          onClick={saveCredentials}
          disabled={submitting || !canSaveStep2}
          className="w-full py-4 px-4 bg-accent text-background font-semibold text-base rounded-xl hover:shadow-[0_6px_24px_rgba(245,158,11,0.3)] hover:-translate-y-px active:translate-y-0 transition-all disabled:opacity-30 disabled:hover:shadow-none disabled:hover:translate-y-0 disabled:cursor-not-allowed"
        >
          {submitting ? "Saving..." : selectedServiceIds.length === 0 ? "Skip for now" : (
            <span className="inline-flex items-center justify-center gap-2">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              Save credentials
            </span>
          )}
        </button>

        {selectedServiceIds.length === 0 && (
          <p className="text-xs text-muted/50 text-center -mt-3">
            You can add services later from your dashboard.
          </p>
        )}

        {selectedServiceIds.length > 0 && !canSaveStep2 && (
          <p className="text-xs text-muted/50 text-center -mt-3">
            Provide credentials for each selected service to continue.
          </p>
        )}
      </div>
    );
  }

  // =====================================================================
  // Step 3: Queue + Authorization
  // =====================================================================

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    setQueue((items) => {
      const oldIndex = items.findIndex((i) => i.serviceId === active.id);
      const newIndex = items.findIndex((i) => i.serviceId === over.id);
      return arrayMove(items, oldIndex, newIndex);
    });
  }

  async function handleFinish() {
    setError("");
    setSubmitting(true);

    try {
      // Save queue order if any services were selected
      if (queue.length > 0) {
        const plansPayload: Record<string, string> = {};
        for (const q of queue) {
          if (selectedPlans[q.serviceId]) {
            plansPayload[q.serviceId] = selectedPlans[q.serviceId];
          }
        }
        const res = await authFetch("/api/queue", {
          method: "PUT",
          body: JSON.stringify({
            order: queue.map((q) => q.serviceId),
            plans: Object.keys(plansPayload).length > 0 ? plansPayload : undefined,
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          setError(data.error || "Failed to save queue order.");
          setSubmitting(false);
          return;
        }
      }

      // Record consent
      const authOk = await authFetch("/api/consent", {
        method: "POST",
        body: JSON.stringify({ consentType: "authorization" }),
      });
      if (!authOk.ok) {
        setError("Failed to record authorization. Try again.");
        setSubmitting(false);
        return;
      }

      const confirmOk = await authFetch("/api/consent", {
        method: "POST",
        body: JSON.stringify({ consentType: "confirmation" }),
      });
      if (!confirmOk.ok) {
        setError("Failed to record confirmation. Try again.");
        setSubmitting(false);
        return;
      }

      router.push("/dashboard");
    } catch {
      setError("Connection failed. Try again.");
      setSubmitting(false);
    }
  }

  function renderStep3() {
    const hasQueue = queue.length > 1;

    return (
      <div className="space-y-6">
        <button
          type="button"
          onClick={() => setStep(2)}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>

        <div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white mb-3">
            {hasQueue ? "Arrange your queue" : "Your queue"}
          </h1>
          <p className="text-base text-muted leading-relaxed">
            {hasQueue
              ? "Set the order you'd like to rotate through your services. Drag to reorder."
              : "When you cancel a service, we suggest resuming the next one in your queue. Add services from your dashboard and arrange them in the order you want us to follow."}
          </p>
        </div>

        {/* How it works explainer */}
        {hasQueue && (
          <div className="flex items-start gap-3.5 bg-accent/10 border border-accent/30 rounded-xl p-4">
            <svg className="w-5 h-5 mt-0.5 shrink-0 text-accent opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
            <p className="text-sm text-muted leading-relaxed">
              <span className="text-foreground font-medium">How this works:</span> When you cancel a service, we&apos;ll suggest resuming the next one in line, so you always have something to watch without paying for everything at once.
            </p>
          </div>
        )}

        {hasQueue ? (
          <>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={queue.map((q) => q.serviceId)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-2.5">
                  {queue.map((item, index) => (
                    <SortableItem
                      key={item.serviceId}
                      item={item}
                      isFirst={index === 0}
                      isLast={index === queue.length - 1}
                      icon={<ServiceIcon serviceId={item.serviceId} />}
                      onMoveUp={() => {
                        if (index === 0) return;
                        setQueue((prev) => arrayMove(prev, index, index - 1));
                      }}
                      onMoveDown={() => {
                        if (index === queue.length - 1) return;
                        setQueue((prev) => arrayMove(prev, index, index + 1));
                      }}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            <p className="text-xs text-muted/50">
              You can reorder this anytime from your dashboard.
            </p>
          </>
        ) : queue.length === 1 ? (
          <div className="flex items-center gap-3 border border-border rounded-xl px-4 py-3.5 bg-surface">
            <ServiceIcon serviceId={queue[0].serviceId} />
            <span className="flex-1 min-w-0 truncate font-semibold text-foreground text-base">
              {queue[0].serviceName}
            </span>
            {queue[0].planName && (
              <span className="text-xs text-accent bg-accent/10 px-2.5 py-1 rounded-md font-medium whitespace-nowrap">
                {queue[0].planName}
                {queue[0].planPriceCents != null && (
                  <> &middot; ${(queue[0].planPriceCents / 100).toFixed(2)}</>
                )}
              </span>
            )}
          </div>
        ) : (
          <div className="border border-dashed border-border rounded-xl px-4 py-6 text-center">
            <p className="text-sm text-muted">No services added yet.</p>
          </div>
        )}

        {/* Divider */}
        <div className="h-px bg-border" />

        {/* Authorization */}
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={authorized}
            onChange={(e) => setAuthorized(e.target.checked)}
            className="mt-0.5 w-5 h-5 rounded-md border-2 border-white/20 bg-transparent appearance-none checked:bg-accent checked:border-accent cursor-pointer shrink-0 relative
              after:content-[''] after:absolute after:left-[5px] after:top-[1px] after:w-[6px] after:h-[11px] after:border-background after:border-r-[2.5px] after:border-b-[2.5px] after:rotate-45 after:opacity-0 checked:after:opacity-100"
          />
          <span className="text-sm text-muted leading-relaxed">
            I authorize <span className="text-foreground font-medium">UnsaltedButter</span> to act on my behalf, including cancelling and resuming subscriptions using the credentials I provided.
          </span>
        </label>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="button"
          onClick={handleFinish}
          disabled={submitting || !authorized}
          className="w-full py-4 px-4 bg-accent text-background font-semibold text-base rounded-xl hover:shadow-[0_6px_24px_rgba(245,158,11,0.3)] hover:-translate-y-px active:translate-y-0 transition-all disabled:opacity-30 disabled:hover:shadow-none disabled:hover:translate-y-0 disabled:cursor-not-allowed"
        >
          {submitting ? "Finishing..." : "Authorize & finish"}
        </button>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-md mx-auto px-5 py-12">
        <StepIndicator current={step} />
        {step === 1 && renderStep1()}
        {step === 2 && renderStep2()}
        {step === 3 && renderStep3()}
      </div>
    </main>
  );
}
