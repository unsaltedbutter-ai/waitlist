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
import QRCode from "react-qr-code";

interface Plan {
  id: string;
  service_group: string;
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

interface QueueItem {
  serviceId: string;
  groupLabel: string;
  planName: string;
  isBundle: boolean;
  priceCents: number;
}

const TOTAL_STEPS = 5;

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center justify-center gap-3 mb-10">
      {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((s) => (
        <div key={s} className="flex items-center gap-3">
          <div
            className={`w-2.5 h-2.5 rounded-full transition-colors ${
              s === current
                ? "bg-accent"
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
}: {
  item: QueueItem;
  position: number;
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

  const displayLabel = item.isBundle
    ? item.planName
    : item.groupLabel === item.planName
      ? item.groupLabel
      : `${item.groupLabel} (${item.planName})`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-4 bg-surface border border-border rounded px-4 py-3 ${
        isDragging ? "opacity-50" : ""
      }`}
    >
      <button
        type="button"
        className="text-muted cursor-grab active:cursor-grabbing select-none text-lg leading-none"
        {...attributes}
        {...listeners}
      >
        &#8801;
      </button>
      <span className="text-sm font-medium text-muted w-6">{position}</span>
      <span className="text-foreground font-medium flex-1">{displayLabel}</span>
      <span className="text-muted/60 text-sm">
        ${(item.priceCents / 100).toFixed(2)}/mo
      </span>
    </div>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const { loading } = useAuth();

  const [step, setStep] = useState(1);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Step 3 state (plan selection)
  const [groups, setGroups] = useState<ServiceGroup[]>([]);
  const [selectedPlans, setSelectedPlans] = useState<Record<string, string>>(
    {}
  );
  const [creds, setCreds] = useState<
    Record<string, { email: string; password: string }>
  >({});

  // Step 4 state (rotation queue)
  const [queue, setQueue] = useState<QueueItem[]>([]);

  // Step 5 state (payment)
  const [membership, setMembership] = useState<"monthly" | "annual">("annual");
  const [invoice, setInvoice] = useState<{
    invoiceId: string;
    checkoutLink: string;
    amount_sats: number | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [paid, setPaid] = useState(false);

  // Fetch plans on mount
  useEffect(() => {
    fetch("/api/service-plans")
      .then((r) => r.json())
      .then((data) => setGroups(data.groups))
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
  function togglePlan(groupId: string, planId: string) {
    setSelectedPlans((prev) => {
      if (prev[groupId] === planId) {
        const next = { ...prev };
        delete next[groupId];
        setCreds((c) => {
          const n = { ...c };
          delete n[groupId];
          return n;
        });
        return next;
      }
      return { ...prev, [groupId]: planId };
    });
  }

  function updateCred(
    groupId: string,
    field: "email" | "password",
    value: string
  ) {
    setCreds((prev) => ({
      ...prev,
      [groupId]: {
        email: prev[groupId]?.email ?? "",
        password: prev[groupId]?.password ?? "",
        [field]: value,
      },
    }));
  }

  function getSelectedPlan(groupId: string): Plan | undefined {
    const planId = selectedPlans[groupId];
    if (!planId) return undefined;
    for (const g of groups) {
      const plan = g.plans.find((p) => p.id === planId);
      if (plan) return plan;
    }
    return undefined;
  }

  function getSelectedPlanPrice(groupId: string): number {
    return getSelectedPlan(groupId)?.monthly_price_cents ?? 0;
  }

  const selectedGroupIds = Object.keys(selectedPlans);
  const selectedPrices = selectedGroupIds.map((gid) =>
    getSelectedPlanPrice(gid)
  );
  const monthlyTotal = selectedPrices.reduce((s, p) => s + p, 0);
  const minPrice = selectedPrices.length > 0 ? Math.min(...selectedPrices) : 0;
  const maxPrice = selectedPrices.length > 0 ? Math.max(...selectedPrices) : 0;

  // First service info (used in steps 4-5)
  const firstQueueItem = queue[0];
  const firstServiceLabel = firstQueueItem?.groupLabel ?? "your first service";

  // Membership pricing (cents)
  const MEMBERSHIP_MONTHLY = 778;
  const MEMBERSHIP_ANNUAL = 7380;
  const membershipCents =
    membership === "monthly" ? MEMBERSHIP_MONTHLY : MEMBERSHIP_ANNUAL;
  const firstServicePrice = firstQueueItem?.priceCents ?? 0;
  const totalCents = membershipCents + firstServicePrice;

  // Annual savings
  const savingsCents = MEMBERSHIP_MONTHLY * 12 - MEMBERSHIP_ANNUAL; // 1956 = $19.56
  const cheapestInQueue = queue.length > 0
    ? [...queue].sort((a, b) => a.priceCents - b.priceCents)[0]
    : null;
  const cheapestLabel = cheapestInQueue
    ? cheapestInQueue.isBundle
      ? cheapestInQueue.planName
      : cheapestInQueue.groupLabel
    : null;

  // --- Consent capture ---
  async function recordConsent(consentType: "authorization" | "confirmation") {
    const res = await authFetch("/api/consent", {
      method: "POST",
      body: JSON.stringify({ consentType }),
    });
    return res.ok;
  }

  // --- Step 1: Authorization ---
  async function handleAuthorize() {
    setError("");
    setSubmitting(true);
    try {
      const ok = await recordConsent("authorization");
      if (!ok) {
        setError("Failed to record authorization. Try again.");
        setSubmitting(false);
        return;
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
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-6">
            Authorization
          </h1>
          <p className="text-muted leading-relaxed text-lg">
            Do you authorize UnsaltedButter and its agents to act on your behalf
            with third parties to initiate and terminate streaming service
            accounts?
          </p>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="button"
          onClick={handleAuthorize}
          disabled={submitting}
          className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {submitting ? "Recording..." : "I authorize"}
        </button>
      </div>
    );
  }

  // --- Step 2: How it works + Confirmation ---
  async function handleConfirm() {
    setError("");
    setSubmitting(true);
    try {
      const ok = await recordConsent("confirmation");
      if (!ok) {
        setError("Failed to record confirmation. Try again.");
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
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-6">
            How it works
          </h1>
          <p className="text-muted leading-relaxed">
            We use gift cards &mdash; not credit cards &mdash; to activate
            services. One subscription runs at a time. When the gift card is
            depleted, the subscription ends and the next one in your queue
            starts.
          </p>
        </div>

        <div className="bg-surface border border-border rounded p-6">
          <p className="text-foreground font-bold leading-relaxed">
            We purchase gift cards to activate your streaming services. Gift
            cards mean no recurring charges, no stored credit cards, and no
            surprise bills.
          </p>
        </div>

        <ul className="space-y-3 text-sm text-muted leading-relaxed">
          <li className="flex gap-2">
            <span className="text-muted/60 shrink-0">&bull;</span>
            <span>
              Your streaming credentials are encrypted at rest and destroyed
              immediately if your membership ends.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-muted/60 shrink-0">&bull;</span>
            <span>
              We do not share your data with anyone. There is no one to share it
              with.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-muted/60 shrink-0">&bull;</span>
            <span>
              Membership is $7.78/month, or $6.15/month paid annually.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-muted/60 shrink-0">&bull;</span>
            <span>
              Membership &amp; service credits payable in Bitcoin only.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-muted/60 shrink-0">&bull;</span>
            <span>
              Unspent service credits can be returned, minus network fees.
            </span>
          </li>
        </ul>

        <div>
          <p className="text-muted leading-relaxed mb-4">
            Are you still onboard with letting UnsaltedButter act on your
            behalf?
          </p>

          {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
          >
            {submitting
              ? "Recording..."
              : "Yes. I authorize UnsaltedButter to act on my behalf."}
          </button>
        </div>
      </div>
    );
  }

  // --- Step 3: Select Plans & Add Credentials ---
  async function saveCredentials() {
    setError("");

    const complete = selectedGroupIds.filter((gid) => {
      const c = creds[gid];
      return c?.email && c?.password;
    });
    if (complete.length < 2) {
      setError("Select and provide credentials for at least two services.");
      return;
    }

    for (const gid of selectedGroupIds) {
      const c = creds[gid];
      if (!c?.email || !c?.password) {
        const group = groups.find((g) => g.id === gid);
        setError(`Enter credentials for ${group?.label ?? gid}.`);
        return;
      }
    }

    setSubmitting(true);
    try {
      for (const gid of selectedGroupIds) {
        const group = groups.find((g) => g.id === gid);
        if (!group) continue;
        const c = creds[gid];

        const res = await authFetch("/api/credentials", {
          method: "POST",
          body: JSON.stringify({
            serviceId: group.serviceId,
            email: c.email,
            password: c.password,
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          setError(
            data.error || `Failed to save credentials for ${group.label}.`
          );
          setSubmitting(false);
          return;
        }
      }

      // Build queue from selected groups with full plan info
      const savedQueue: QueueItem[] = selectedGroupIds.map((gid) => {
        const group = groups.find((g) => g.id === gid)!;
        const plan = getSelectedPlan(gid)!;
        return {
          serviceId: group.serviceId,
          groupLabel: group.label,
          planName: plan.display_name,
          isBundle: plan.is_bundle,
          priceCents: plan.monthly_price_cents,
        };
      });
      setQueue(savedQueue);
      setSubmitting(false);
      setStep(4);
    } catch {
      setError("Connection failed. Try again.");
      setSubmitting(false);
    }
  }

  function renderStep3() {
    const canSave = selectedGroupIds.length >= 2;

    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-3">
            Your streaming plans
          </h1>
          <p className="text-muted leading-relaxed text-sm">
            Select the plans you want us to rotate. If you get a service bundled
            with something else (phone plan, internet, etc.), skip it. Add at
            least two for rotation to work.
          </p>
        </div>

        <div className="space-y-4">
          {groups.map((group) => {
            const selectedPlanId = selectedPlans[group.id];
            const isSelected = !!selectedPlanId;

            return (
              <div key={group.id}>
                <p className="text-xs font-semibold text-muted/70 uppercase tracking-wider mb-1.5">
                  {group.label}
                </p>
                <div className="space-y-1">
                  {group.plans.map((plan) => {
                    const selected = selectedPlanId === plan.id;
                    return (
                      <button
                        key={plan.id}
                        type="button"
                        onClick={() => togglePlan(group.id, plan.id)}
                        className={`w-full flex items-center justify-between py-2 px-3 rounded text-sm border transition-colors ${
                          selected
                            ? "bg-accent/10 text-accent border-accent/40"
                            : "bg-surface text-muted border-border hover:border-muted"
                        }`}
                      >
                        <span>{plan.display_name}</span>
                        <span
                          className={
                            selected ? "text-accent" : "text-muted/60"
                          }
                        >
                          ${(plan.monthly_price_cents / 100).toFixed(2)}/mo
                        </span>
                      </button>
                    );
                  })}
                </div>

                {isSelected && (
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <input
                      type="email"
                      value={creds[group.id]?.email ?? ""}
                      onChange={(e) =>
                        updateCred(group.id, "email", e.target.value)
                      }
                      placeholder="Login email"
                      className="py-2 px-3 bg-surface border border-border rounded text-foreground placeholder:text-muted/50 text-sm focus:outline-none focus:border-accent"
                    />
                    <input
                      type="password"
                      value={creds[group.id]?.password ?? ""}
                      onChange={(e) =>
                        updateCred(group.id, "password", e.target.value)
                      }
                      placeholder="Password"
                      className="py-2 px-3 bg-surface border border-border rounded text-foreground placeholder:text-muted/50 text-sm focus:outline-none focus:border-accent"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {monthlyTotal > 0 && (
          <div className="space-y-1">
            <p className="text-sm text-muted">
              This would cost you{" "}
              <span className="text-foreground font-medium">
                ${(monthlyTotal / 100).toFixed(2)}/month
              </span>
              , but with UnsaltedButter you&apos;ll spend way less.
            </p>
            {selectedGroupIds.length >= 2 && (
              <p className="text-sm text-muted">
                You will need between{" "}
                <span className="text-foreground font-medium">
                  ${(minPrice / 100).toFixed(2)}
                </span>{" "}
                and{" "}
                <span className="text-foreground font-medium">
                  ${(maxPrice / 100).toFixed(2)}
                </span>{" "}
                worth of service credits every month. You can pay up front, or
                just in time if you&apos;ve given us a real Nostr or email
                contact.
              </p>
            )}
          </div>
        )}

        <div className="bg-surface border border-border rounded p-4 space-y-2 text-sm text-muted leading-relaxed">
          <p>
            <span className="text-foreground font-medium">
              Fresh accounts are cleanest.
            </span>{" "}
            Create new accounts for each service and we handle everything from
            scratch.
          </p>
          <p>
            If you&apos;re using existing accounts, cancel all but one service
            now and try to remove your credit card from each. If you can&apos;t
            remove it, we&apos;ll take care of that when we next activate the
            subscription.
          </p>
        </div>

        <p className="text-sm text-muted">
          You&apos;ll be able to change the rotation order on the next step.
        </p>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="button"
          onClick={saveCredentials}
          disabled={submitting || !canSave}
          className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {submitting ? "Saving..." : "Save credentials"}
        </button>
      </div>
    );
  }

  // --- Step 4: Set Rotation Order ---
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    setQueue((items) => {
      const oldIndex = items.findIndex((i) => i.serviceId === active.id);
      const newIndex = items.findIndex((i) => i.serviceId === over.id);
      return arrayMove(items, oldIndex, newIndex);
    });
  }

  async function confirmRotationOrder() {
    setError("");
    setSubmitting(true);

    try {
      const res = await authFetch("/api/queue", {
        method: "PUT",
        body: JSON.stringify({ order: queue.map((q) => q.serviceId) }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to save rotation order.");
        setSubmitting(false);
        return;
      }

      setSubmitting(false);
      setStep(5);
    } catch {
      setError("Connection failed. Try again.");
      setSubmitting(false);
    }
  }

  function renderStep4() {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-4">
            Your rotation queue
          </h1>
          <p className="text-muted leading-relaxed">
            Drag to reorder. The service at the top starts first. Each service
            stays active until the gift card runs out (roughly 30-40 days), then
            the next one in line activates. The queue loops.
          </p>
        </div>

        <div className="bg-red-500/10 border border-red-500/30 rounded p-4">
          <p className="text-red-400 font-semibold text-sm">
            Cancel all your existing streaming subscriptions before we start.
          </p>
          <p className="text-muted text-sm mt-1">
            We&apos;ll handle everything from here. If you leave active
            subscriptions running, you&apos;ll be double-paying.
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
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <p className="text-sm text-muted">
          We&apos;ll keep you up to date as services rotate, or you can ping us
          on Nostr for details.
        </p>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="button"
          onClick={confirmRotationOrder}
          disabled={submitting}
          className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {submitting ? "Saving..." : "Confirm rotation order"}
        </button>
      </div>
    );
  }

  // --- Step 5: Payment ---
  async function createInvoice() {
    setError("");
    setSubmitting(true);

    try {
      const res = await authFetch("/api/credits/prepay", {
        method: "POST",
        body: JSON.stringify({ amount_usd_cents: totalCents }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to create invoice.");
        setSubmitting(false);
        return;
      }

      const data = await res.json();
      setInvoice(data);
      setSubmitting(false);
    } catch {
      setError("Connection failed. Try again.");
      setSubmitting(false);
    }
  }

  async function copyInvoice() {
    if (!invoice) return;
    try {
      await navigator.clipboard.writeText(invoice.checkoutLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  }

  function savingsCallout(): string {
    const saved = (savingsCents / 100).toFixed(2);
    if (!cheapestLabel) return `That saves you $${saved}/yr.`;
    if (cheapestInQueue && savingsCents >= cheapestInQueue.priceCents) {
      return `That saves you $${saved}/yr \u2014 a free month of ${cheapestLabel}.`;
    }
    return `That saves you $${saved}/yr \u2014 almost a free month of ${cheapestLabel}.`;
  }

  function renderStep5() {
    if (paid) {
      return (
        <div className="space-y-8">
          <div>
            <h1 className="text-4xl font-bold tracking-tight text-foreground mb-4">
              Credits added.
            </h1>
            <p className="text-muted leading-relaxed">
              Your first rotation starts within 24 hours &mdash; we&apos;ll
              activate {firstServiceLabel} and take it from there. Check your
              dashboard anytime, but you won&apos;t need to.
            </p>
          </div>

          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors"
          >
            Go to dashboard
          </button>
        </div>
      );
    }

    if (invoice) {
      return (
        <div className="space-y-8">
          <div>
            <h1 className="text-4xl font-bold tracking-tight text-foreground mb-4">
              Fund your account
            </h1>
            <p className="text-muted leading-relaxed">
              Scan the Lightning invoice QR code or copy the invoice to pay from
              any Lightning wallet. Your credits update instantly.
            </p>
          </div>

          <div className="flex justify-center">
            <div className="bg-white p-4 rounded">
              <QRCode value={invoice.checkoutLink} size={200} />
            </div>
          </div>

          {invoice.amount_sats && (
            <p className="text-center text-sm text-muted">
              {invoice.amount_sats.toLocaleString()} sats
            </p>
          )}

          <button
            type="button"
            onClick={copyInvoice}
            className="w-full py-2 px-4 text-muted border border-border rounded hover:border-muted transition-colors text-sm"
          >
            {copied ? "Copied" : "Copy invoice"}
          </button>

          <button
            type="button"
            onClick={() => setPaid(true)}
            className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors"
          >
            Continue to dashboard
          </button>
        </div>
      );
    }

    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-4">
            Fund your account
          </h1>
          <p className="text-muted leading-relaxed">
            Your first payment covers your membership and the service credit for{" "}
            {firstServiceLabel}. We&apos;ll activate it within 24 hours.
          </p>
        </div>

        {/* Membership toggle */}
        <div>
          <label className="block text-sm font-medium text-muted mb-2">
            Membership
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMembership("annual")}
              className={`flex-1 py-2 px-4 rounded text-sm font-medium border transition-colors ${
                membership === "annual"
                  ? "bg-accent text-background border-accent"
                  : "bg-surface text-muted border-border hover:border-muted"
              }`}
            >
              Annual &mdash; $6.15/mo
            </button>
            <button
              type="button"
              onClick={() => setMembership("monthly")}
              className={`flex-1 py-2 px-4 rounded text-sm font-medium border transition-colors ${
                membership === "monthly"
                  ? "bg-accent text-background border-accent"
                  : "bg-surface text-muted border-border hover:border-muted"
              }`}
            >
              Monthly &mdash; $7.78/mo
            </button>
          </div>
          {membership === "annual" && (
            <p className="text-sm text-accent mt-2">{savingsCallout()}</p>
          )}
        </div>

        {/* Breakdown */}
        <div className="bg-surface border border-border rounded p-4">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">
                Membership (
                {membership === "monthly" ? "1 month" : "12 months"})
              </span>
              <span className="text-foreground">
                ${(membershipCents / 100).toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">
                {firstServiceLabel} (first month)
              </span>
              <span className="text-foreground">
                ${(firstServicePrice / 100).toFixed(2)}
              </span>
            </div>
            <div className="border-t border-border pt-2 mt-2 flex justify-between font-medium">
              <span className="text-foreground">Total due today</span>
              <span className="text-foreground">
                ${(totalCents / 100).toFixed(2)}
              </span>
            </div>
          </div>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="button"
          onClick={createInvoice}
          disabled={submitting}
          className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {submitting ? "Creating invoice..." : "Add service credits"}
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
        {step === 4 && renderStep4()}
        {step === 5 && renderStep5()}
      </div>
    </main>
  );
}
