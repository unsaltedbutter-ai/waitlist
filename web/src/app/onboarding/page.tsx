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

  // Step 1 state: services + credentials
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [serviceGroups, setServiceGroups] = useState<ServiceGroup[]>([]);
  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<string>>(new Set());
  const [selectedPlans, setSelectedPlans] = useState<Record<string, string>>({});
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [creds, setCreds] = useState<Record<string, { email: string; password: string }>>({});
  const [useSameCreds, setUseSameCreds] = useState(false);
  const [sharedCreds, setSharedCreds] = useState({ email: "", password: "" });
  const [showPasswords, setShowPasswords] = useState(false);
  const [credentialMode, setCredentialMode] = useState<"later" | "now">("later");

  // Step 2 state: queue order
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

  function toggleAccordion(serviceId: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(serviceId)) {
        next.delete(serviceId);
      } else {
        next.add(serviceId);
      }
      return next;
    });
  }

  function toggleService(serviceId: string) {
    setSelectedServiceIds((prev) => {
      const next = new Set(prev);
      if (next.has(serviceId)) {
        next.delete(serviceId);
        setCreds((c) => {
          const n = { ...c };
          delete n[serviceId];
          return n;
        });
        setSelectedPlans((p) => {
          const n = { ...p };
          delete n[serviceId];
          return n;
        });
      } else {
        next.add(serviceId);
        // Auto-select single plan for services with only one option
        const group = serviceGroups.find((g) => g.serviceId === serviceId);
        if (group && group.plans.length === 1) {
          setSelectedPlans((p) => ({ ...p, [serviceId]: group.plans[0].id }));
        }
      }
      return next;
    });
  }

  function selectPlan(serviceId: string, planId: string) {
    setSelectedPlans((prev) => {
      if (prev[serviceId] === planId) {
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

  function getCredsFor(serviceId: string): { email: string; password: string } {
    if (useSameCreds) return sharedCreds;
    return creds[serviceId] ?? { email: "", password: "" };
  }

  const selectedIds = Array.from(selectedServiceIds);

  const canSaveStep1 = (() => {
    if (credentialMode === "later") return true;
    if (selectedIds.length === 0) return true;
    if (useSameCreds) {
      return !!sharedCreds.email && !!sharedCreds.password;
    }
    return selectedIds.every((sid) => {
      const c = creds[sid];
      return c?.email && c?.password;
    });
  })();

  // --- Step 1: Add Services + Credentials ---

  async function saveCredentials() {
    setError("");

    // "Later" mode: skip credentials entirely, go to queue step
    if (credentialMode === "later") {
      setStep(2);
      return;
    }

    // If services are selected, validate credentials are filled in
    if (selectedIds.length > 0) {
      if (useSameCreds) {
        if (!sharedCreds.email || !sharedCreds.password) {
          setError("Enter the shared email and password.");
          return;
        }
      } else {
        for (const sid of selectedIds) {
          const c = creds[sid];
          if (!c?.email || !c?.password) {
            const svc = services.find((s) => s.service_id === sid);
            setError(`Enter credentials for ${svc?.service_name ?? sid}.`);
            return;
          }
        }
      }
    }

    setSubmitting(true);
    try {
      for (const sid of selectedIds) {
        const c = getCredsFor(sid);

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
      if (selectedIds.length > 0) {
        const savedQueue: QueueItem[] = selectedIds.map((sid) => {
          const svc = services.find((s) => s.service_id === sid)!;
          const plan = getSelectedPlanForService(sid);
          return {
            serviceId: sid,
            serviceName: svc.service_name,
            planName: plan?.display_name,
          };
        });
        setQueue(savedQueue);
      }

      setSubmitting(false);
      setStep(2);
    } catch {
      setError("Connection failed. Try again.");
      setSubmitting(false);
    }
  }

  function renderStep1() {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-3">
            Add your services
          </h1>
          <p className="text-muted leading-relaxed text-sm">
            Select the streaming services you want us to manage.
          </p>
        </div>

        {/* Credential mode toggle */}
        <div className="rounded-lg border border-border bg-surface p-1 flex">
          <button
            type="button"
            onClick={() => setCredentialMode("later")}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
              credentialMode === "later"
                ? "bg-accent text-background"
                : "text-muted hover:text-foreground"
            }`}
          >
            Add Credentials Later
          </button>
          <button
            type="button"
            onClick={() => setCredentialMode("now")}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
              credentialMode === "now"
                ? "bg-accent text-background"
                : "text-muted hover:text-foreground"
            }`}
          >
            Add Credentials Now
          </button>
        </div>

        {credentialMode === "later" ? (
          <>
            <p className="text-sm text-muted leading-relaxed">
              You can add services later from your dashboard.
            </p>

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <button
              type="button"
              onClick={saveCredentials}
              disabled={submitting}
              className="w-full py-3 px-4 rounded-lg font-medium text-sm transition-colors bg-accent text-background hover:bg-accent/90 disabled:bg-accent/20 disabled:text-accent/40 disabled:cursor-not-allowed"
            >
              Continue
            </button>
          </>
        ) : (
          <>
            {/* Credentials callout */}
            <div className="border-l-4 border-amber-500 bg-amber-500/[0.08] rounded-r-lg px-5 py-4">
              <p className="text-amber-200 text-sm font-medium leading-relaxed">
                Provide the email and password you use to log in to each service. We'll only use them when you explicitly ask us to, otherwise they stay encrypted.
              </p>
            </div>

            {/* Same credentials toggle */}
            <div className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useSameCreds}
                  onChange={(e) => setUseSameCreds(e.target.checked)}
                  className="w-4 h-4 rounded border-border bg-surface text-accent accent-amber-500"
                />
                <span className="text-sm text-foreground font-medium">
                  Use the same credentials for every service
                </span>
              </label>

              {useSameCreds && (
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="email"
                    value={sharedCreds.email}
                    onChange={(e) =>
                      setSharedCreds((prev) => ({ ...prev, email: e.target.value }))
                    }
                    placeholder="Login email"
                    className="py-2.5 px-3 bg-surface border border-border rounded-lg text-foreground placeholder:text-muted/50 text-sm focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/20 transition-colors"
                  />
                  <div className="relative">
                    <input
                      type={showPasswords ? "text" : "password"}
                      value={sharedCreds.password}
                      onChange={(e) =>
                        setSharedCreds((prev) => ({
                          ...prev,
                          password: e.target.value,
                        }))
                      }
                      placeholder="Password"
                      className="w-full py-2.5 px-3 pr-10 bg-surface border border-border rounded-lg text-foreground placeholder:text-muted/50 text-sm focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/20 transition-colors"
                    />
                    <PasswordToggle visible={showPasswords} onToggle={() => setShowPasswords((p) => !p)} />
                  </div>
                </div>
              )}
            </div>

            {/* Service accordion */}
            <div className="space-y-2">
              {services.map((svc) => {
                const isSelected = selectedServiceIds.has(svc.service_id);
                const isExpanded = expandedGroups.has(svc.service_id);
                const group = getGroupForService(svc.service_id);
                const selectedPlan = getSelectedPlanForService(svc.service_id);
                const hasMultiplePlans = group && group.plans.length > 1;

                return (
                  <div key={svc.service_id}>
                    {/* Service header */}
                    <button
                      type="button"
                      onClick={() => {
                        if (hasMultiplePlans) {
                          toggleAccordion(svc.service_id);
                        } else {
                          toggleService(svc.service_id);
                        }
                      }}
                      className={`flex items-center justify-between w-full px-4 py-3 rounded-lg border text-sm transition-colors ${
                        isSelected
                          ? "bg-surface border-accent/60"
                          : "bg-surface border-border hover:border-amber-500/40"
                      }`}
                    >
                      <span className="font-medium text-foreground">
                        {svc.service_name}
                      </span>
                      {isSelected && selectedPlan ? (
                        <span className="flex items-center gap-2 text-accent text-xs">
                          {!useSameCreds && (!creds[svc.service_id]?.email || !creds[svc.service_id]?.password) && (
                            <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" title="Needs credentials" />
                          )}
                          {selectedPlan.display_name} - ${(selectedPlan.monthly_price_cents / 100).toFixed(2)}/mo
                        </span>
                      ) : isSelected ? (
                        <span className="flex items-center gap-2 text-accent text-xs">
                          {!useSameCreds && (!creds[svc.service_id]?.email || !creds[svc.service_id]?.password) && (
                            <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" title="Needs credentials" />
                          )}
                          Selected
                        </span>
                      ) : hasMultiplePlans ? (
                        <span className="text-muted/60 text-xs">
                          {group.plans.length} plans
                        </span>
                      ) : null}
                    </button>

                    {/* Expanded: plan options */}
                    {isExpanded && hasMultiplePlans && (
                      <div className="mt-1 ml-8 space-y-1">
                        {group.plans.map((plan) => {
                          const isPlanSelected = selectedPlans[svc.service_id] === plan.id;
                          return (
                            <button
                              key={plan.id}
                              type="button"
                              onClick={() => {
                                if (!isSelected) {
                                  toggleService(svc.service_id);
                                }
                                selectPlan(svc.service_id, plan.id);
                              }}
                              className={`w-full flex items-center justify-between py-2 px-3 rounded text-sm border transition-colors ${
                                isPlanSelected
                                  ? "bg-accent/10 text-accent border-accent/40"
                                  : "bg-surface text-muted border-border hover:border-muted"
                              }`}
                            >
                              <span>{plan.display_name}</span>
                              <span className={isPlanSelected ? "text-accent" : "text-muted/60"}>
                                ${(plan.monthly_price_cents / 100).toFixed(2)}/mo
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Credentials inputs */}
                    {isSelected && !useSameCreds && (
                      <div className="grid grid-cols-2 gap-3 mt-1 ml-8 pb-2">
                        <input
                          type="email"
                          value={creds[svc.service_id]?.email ?? ""}
                          onChange={(e) =>
                            updateCred(svc.service_id, "email", e.target.value)
                          }
                          placeholder="Login email"
                          className="py-2.5 px-3 bg-surface border border-border rounded-lg text-foreground placeholder:text-muted/50 text-sm focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/20 transition-colors"
                        />
                        <div className="relative">
                          <input
                            type={showPasswords ? "text" : "password"}
                            value={creds[svc.service_id]?.password ?? ""}
                            onChange={(e) =>
                              updateCred(svc.service_id, "password", e.target.value)
                            }
                            placeholder="Password"
                            className="w-full py-2.5 px-3 pr-10 bg-surface border border-border rounded-lg text-foreground placeholder:text-muted/50 text-sm focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/20 transition-colors"
                          />
                          <PasswordToggle visible={showPasswords} onToggle={() => setShowPasswords((p) => !p)} />
                        </div>
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
              disabled={submitting || !canSaveStep1}
              className="w-full py-3 px-4 rounded-lg font-medium text-sm transition-colors bg-accent text-background hover:bg-accent/90 disabled:bg-accent/20 disabled:text-accent/40 disabled:cursor-not-allowed"
            >
              {submitting ? "Saving..." : selectedIds.length === 0 ? "Skip for now" : "Save credentials"}
            </button>

            {selectedIds.length === 0 && (
              <p className="text-xs text-muted/60 text-center -mt-3">
                You can add services later from your dashboard.
              </p>
            )}

            {selectedIds.length > 0 && !canSaveStep1 && (
              <p className="text-xs text-muted/60 text-center -mt-3">
                Provide credentials for each selected service to continue.
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  // --- Step 2: Arrange Queue ---

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    setQueue((items) => {
      const oldIndex = items.findIndex((i) => i.serviceId === active.id);
      const newIndex = items.findIndex((i) => i.serviceId === over.id);
      return arrayMove(items, oldIndex, newIndex);
    });
  }

  async function confirmQueueOrder() {
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

      setSubmitting(false);
      setStep(3);
    } catch {
      setError("Connection failed. Try again.");
      setSubmitting(false);
    }
  }

  function renderStep2() {
    const hasQueue = queue.length > 1;

    return (
      <div className="space-y-8">
        <button
          type="button"
          onClick={() => setStep(1)}
          className="text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; Back
        </button>
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-4">
            {hasQueue ? "Arrange your queue" : "Your queue"}
          </h1>
          <p className="text-muted leading-relaxed text-sm">
            {hasQueue
              ? "When you cancel one service, we suggest resuming the next one in line. Drag to set the order."
              : "When you cancel a service, we suggest resuming the next one in your queue. Add services from your dashboard and arrange them in the order you want us to follow."}
          </p>
        </div>

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
                <div className="space-y-2">
                  {queue.map((item, index) => (
                    <SortableItem
                      key={item.serviceId}
                      item={item}
                      position={index + 1}
                      isFirst={index === 0}
                      isLast={index === queue.length - 1}
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

            <p className="text-xs text-muted/60">
              You can reorder this anytime from the dashboard.
            </p>
          </>
        ) : queue.length === 1 ? (
          <div className="border border-border rounded-lg px-4 py-3 bg-surface">
            <span className="text-sm text-foreground font-medium">{queue[0].serviceName}</span>
            {queue[0].planName && (
              <span className="text-xs text-muted ml-2">{queue[0].planName}</span>
            )}
          </div>
        ) : (
          <div className="border border-dashed border-border rounded-lg px-4 py-6 text-center">
            <p className="text-sm text-muted">No services added yet.</p>
          </div>
        )}

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="button"
          onClick={confirmQueueOrder}
          disabled={submitting}
          className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {submitting ? "Saving..." : "Next"}
        </button>
      </div>
    );
  }

  // --- Step 3: Consent ---

  async function handleConsent() {
    setError("");
    setSubmitting(true);
    try {
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
    return (
      <div className="space-y-8">
        <button
          type="button"
          onClick={() => setStep(queue.length > 1 ? 2 : 1)}
          className="text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; Back
        </button>
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-4">
            Almost there
          </h1>
        </div>

        <div className="bg-surface border border-border rounded p-6 space-y-4">
          <h3 className="text-lg font-semibold text-foreground">
            How it works
          </h3>
          <ul className="space-y-3 text-sm text-muted leading-relaxed">
            <li className="flex gap-2">
              <span className="text-muted/60 shrink-0">&bull;</span>
              <span>
                We cancel and resume subscriptions for you, when you ask.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-muted/60 shrink-0">&bull;</span>
              <span>
                We charge you per transaction.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-muted/60 shrink-0">&bull;</span>
              <span>
                Your credentials are destroyed immediately when you destroy your account.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-muted/60 shrink-0">&bull;</span>
              <span>
                We do not share your data with anyone.
              </span>
            </li>
          </ul>
        </div>

        <div className="bg-amber-950/40 border border-amber-700/50 rounded p-5 space-y-3">
          <p className="text-amber-400 font-semibold text-sm">
            Understand the risks
          </p>
          <p className="text-amber-200/70 text-sm leading-relaxed">
            Using UnsaltedButter to manage your streaming accounts may violate
            those services&apos; Terms of Service. Streaming providers could
            suspend or terminate your account at their discretion.
          </p>
          <p className="text-amber-200/70 text-sm leading-relaxed">
            By authorizing us, you acknowledge this risk and agree that
            UnsaltedButter is not liable for any action a streaming service
            takes against your account (including suspension,
            termination, or loss of content) as a result of using this service.
          </p>
        </div>

        <div className="bg-surface border-2 border-amber-500 rounded p-5">
          <p className="text-foreground text-sm leading-relaxed font-bold">
            You remain responsible for your own subscriptions.
          </p>
          <p className="text-muted text-sm mt-2 leading-relaxed">
            UnsaltedButter acts on your instructions but does not guarantee that
            every cancel or resume will succeed. Check your streaming accounts
            periodically to verify.
          </p>
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={authorized}
            onChange={(e) => setAuthorized(e.target.checked)}
            className="w-4 h-4 mt-0.5 rounded border-border bg-surface text-accent accent-amber-500"
          />
          <span className="text-sm text-foreground leading-relaxed">
            I authorize UnsaltedButter to act on my behalf, including
            cancelling and resuming subscriptions using
            the credentials I provided.
          </span>
        </label>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="button"
          onClick={handleConsent}
          disabled={submitting || !authorized}
          className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Finishing..." : "Accept and finish"}
        </button>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-lg mx-auto px-4 py-12">
        <StepIndicator current={step} />
        {step === 1 && renderStep1()}
        {step === 2 && renderStep2()}
        {step === 3 && renderStep3()}
      </div>
    </main>
  );
}
