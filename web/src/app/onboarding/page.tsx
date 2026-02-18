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
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface ServiceOption {
  service_id: string;
  service_name: string;
}

interface QueueItem {
  serviceId: string;
  serviceName: string;
}

const TOTAL_STEPS = 3;

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center justify-center gap-3 mb-10">
      {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((s) => (
        <div key={s} className="flex items-center gap-3">
          <div
            className={`w-3.5 h-3.5 rounded-full transition-colors ${
              s === current
                ? "bg-accent ring-2 ring-accent/30"
                : s < current
                  ? "bg-accent/40"
                  : "bg-border"
            }`}
          />
          {s < TOTAL_STEPS && <div className="w-6 h-px bg-border" />}
        </div>
      ))}
      <span className="ml-3 text-sm text-muted">
        Step {current} of {TOTAL_STEPS}
      </span>
    </div>
  );
}

function SortableItem({
  item,
  position,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
}: {
  item: QueueItem;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.serviceId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 bg-surface border border-border rounded px-4 py-3 ${
        isDragging ? "opacity-50" : ""
      }`}
    >
      <button
        type="button"
        className="hidden sm:block text-muted cursor-grab active:cursor-grabbing select-none text-lg leading-none"
        {...attributes}
        {...listeners}
      >
        &#8801;
      </button>
      <div className="flex flex-col sm:hidden">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          className="text-muted hover:text-foreground disabled:text-muted/20 transition-colors p-0.5"
          aria-label="Move up"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          className="text-muted hover:text-foreground disabled:text-muted/20 transition-colors p-0.5"
          aria-label="Move down"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      </div>
      <span className="text-sm font-medium text-muted w-6">{position}</span>
      <span className="text-foreground font-medium flex-1 min-w-0 truncate">{item.serviceName}</span>
    </div>
  );
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
  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<string>>(new Set());
  const [creds, setCreds] = useState<Record<string, { email: string; password: string }>>({});
  const [useSameCreds, setUseSameCreds] = useState(false);
  const [sharedCreds, setSharedCreds] = useState({ email: "", password: "" });
  const [showPasswords, setShowPasswords] = useState(false);

  // Step 2 state: queue order
  const [queue, setQueue] = useState<QueueItem[]>([]);

  // Fetch available services on mount
  useEffect(() => {
    // TODO: Fetch from GET /api/services (list of available services).
    // For now, use the service-plans endpoint and extract unique services.
    fetch("/api/service-plans")
      .then((r) => r.json())
      .then((data) => {
        if (data.groups) {
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
      } else {
        next.add(serviceId);
      }
      return next;
    });
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
    if (selectedIds.length < 2) return false;
    if (useSameCreds) {
      return !!sharedCreds.email && !!sharedCreds.password;
    }
    const complete = selectedIds.filter((sid) => {
      const c = creds[sid];
      return c?.email && c?.password;
    });
    return complete.length >= 2;
  })();

  // --- Step 1: Add Services + Credentials ---

  async function saveCredentials() {
    setError("");

    if (useSameCreds) {
      if (!sharedCreds.email || !sharedCreds.password) {
        setError("Enter the shared email and password.");
        return;
      }
      if (selectedIds.length < 2) {
        setError("Select at least two services.");
        return;
      }
    } else {
      const complete = selectedIds.filter((sid) => {
        const c = creds[sid];
        return c?.email && c?.password;
      });
      if (complete.length < 2) {
        setError("Select and provide credentials for at least two services.");
        return;
      }

      for (const sid of selectedIds) {
        const c = creds[sid];
        if (!c?.email || !c?.password) {
          const svc = services.find((s) => s.service_id === sid);
          setError(`Enter credentials for ${svc?.service_name ?? sid}.`);
          return;
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
      const savedQueue: QueueItem[] = selectedIds.map((sid) => {
        const svc = services.find((s) => s.service_id === sid)!;
        return {
          serviceId: sid,
          serviceName: svc.service_name,
        };
      });
      setQueue(savedQueue);
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
            Select the streaming services you want us to manage. Provide the
            login credentials for each. We need at least two for rotation.
          </p>
        </div>

        {/* Credentials callout */}
        <div className="border-l-4 border-amber-500 bg-amber-500/[0.08] rounded-r-lg px-5 py-4">
          <p className="text-amber-200 text-sm font-medium leading-relaxed">
            These are your accounts. Provide the email and password you use
            to log in to each service.
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
                <button
                  type="button"
                  onClick={() => setShowPasswords((p) => !p)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted/50 hover:text-muted transition-colors"
                  tabIndex={-1}
                >
                  {showPasswords ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Service list */}
        <div className="space-y-2">
          {services.map((svc) => {
            const isSelected = selectedServiceIds.has(svc.service_id);

            return (
              <div key={svc.service_id}>
                <button
                  type="button"
                  onClick={() => toggleService(svc.service_id)}
                  className={`flex items-center justify-between w-full px-4 py-3 rounded-lg border text-sm transition-colors ${
                    isSelected
                      ? "bg-surface border-accent/60"
                      : "bg-surface border-border hover:border-amber-500/40"
                  }`}
                >
                  <span className="font-medium text-foreground">
                    {svc.service_name}
                  </span>
                  {isSelected && (
                    <span className="flex items-center gap-2 text-accent text-xs">
                      {!useSameCreds && (!creds[svc.service_id]?.email || !creds[svc.service_id]?.password) && (
                        <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" title="Needs credentials" />
                      )}
                      Selected
                    </span>
                  )}
                </button>

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
                      <button
                        type="button"
                        onClick={() => setShowPasswords((p) => !p)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted/50 hover:text-muted transition-colors"
                        tabIndex={-1}
                      >
                        {showPasswords ? (
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        )}
                      </button>
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
          {submitting ? "Saving..." : "Save credentials"}
        </button>

        {!canSaveStep1 && (
          <p className="text-xs text-muted/60 text-center -mt-3">
            Select at least two services and provide credentials for each.
          </p>
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
      const res = await authFetch("/api/queue", {
        method: "PUT",
        body: JSON.stringify({
          order: queue.map((q) => q.serviceId),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to save queue order.");
        setSubmitting(false);
        return;
      }

      setSubmitting(false);
      setStep(3);
    } catch {
      setError("Connection failed. Try again.");
      setSubmitting(false);
    }
  }

  function renderStep2() {
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
            Arrange your queue
          </h1>
          <p className="text-muted leading-relaxed">
            Drag to reorder. Top of the list is where we start. When you ask
            us to cancel one service and resume the next, we follow this order.
          </p>
        </div>

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

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="button"
          onClick={confirmQueueOrder}
          disabled={submitting}
          className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {submitting ? "Saving..." : "Confirm queue order"}
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
          onClick={() => setStep(2)}
          className="text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; Back
        </button>
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-4">
            Almost there
          </h1>
          <p className="text-muted leading-relaxed">
            Read and accept the terms below to finish setup.
          </p>
        </div>

        <div className="bg-surface border border-border rounded p-6 space-y-4">
          <h3 className="text-lg font-semibold text-foreground">
            How it works
          </h3>
          <ul className="space-y-3 text-sm text-muted leading-relaxed">
            <li className="flex gap-2">
              <span className="text-muted/60 shrink-0">&bull;</span>
              <span>
                You keep your own streaming accounts. We cancel and resume
                subscriptions on your behalf when you ask, for 3,000 sats each.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-muted/60 shrink-0">&bull;</span>
              <span>
                You are charged after each action completes (not before).
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-muted/60 shrink-0">&bull;</span>
              <span>
                Your credentials are encrypted and destroyed immediately if you
                delete your account.
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
            cancelling and resuming streaming subscriptions using
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
