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
import { getCredsForGroup } from "@/lib/creds-resolver";

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

interface QueueItem {
  serviceId: string;
  groupLabel: string;
  planName: string;
  isBundle: boolean;
  priceCents: number;
}

interface MembershipPrice {
  plan: "solo" | "duo";
  period: "monthly" | "annual";
  price_sats: number;
  approx_usd_cents: number;
}

const TOTAL_STEPS = 4;
const BOT_NPUB = process.env.NEXT_PUBLIC_NOSTR_BOT_NPUB ?? "";
const BOT_NAME = process.env.NEXT_PUBLIC_NOSTR_BOT_NAME ?? "UnsaltedButter Bot";

function formatSats(sats: number): string {
  return sats.toLocaleString();
}

function formatUsdFromCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

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

  const displayLabel = item.isBundle
    ? item.planName
    : item.groupLabel === item.planName
      ? item.groupLabel
      : `${item.groupLabel} (${item.planName})`;

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
      <span className="text-foreground font-medium flex-1 min-w-0 truncate">{displayLabel}</span>
      <span className="text-muted/60 text-sm shrink-0">
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
  const [authorized, setAuthorized] = useState(false);
  const [npubCopied, setNpubCopied] = useState(false);

  // Step 3 state (plan selection)
  const [groups, setGroups] = useState<ServiceGroup[]>([]);
  const [selectedPlans, setSelectedPlans] = useState<Record<string, string>>(
    {}
  );
  const [creds, setCreds] = useState<
    Record<string, { email: string; password: string }>
  >({});
  const [signupQuestions, setSignupQuestions] = useState<
    {
      id: string;
      label: string;
      field_type: "text" | "date" | "select";
      options: string[] | null;
      placeholder: string | null;
    }[]
  >([]);
  const [signupAnswers, setSignupAnswers] = useState<Record<string, string>>(
    () => {
      const d = new Date();
      const minAge = 20;
      const maxAge = 50;
      const age = minAge + Math.floor(Math.random() * (maxAge - minAge));
      d.setFullYear(d.getFullYear() - age);
      d.setMonth(Math.floor(Math.random() * 12));
      d.setDate(1 + Math.floor(Math.random() * 28));
      return { birthdate: d.toISOString().split("T")[0] };
    }
  );
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [useSameCreds, setUseSameCreds] = useState(false);
  const [sharedCreds, setSharedCreds] = useState({ email: "", password: "" });
  const [showPasswords, setShowPasswords] = useState(false);

  // Step 4 state (rotation queue)
  const [queue, setQueue] = useState<QueueItem[]>([]);

  // Step 5 state (payment)
  const [membershipPlan, setMembershipPlan] = useState<"solo" | "duo">("solo");
  const [membership, setMembership] = useState<"monthly" | "annual">("annual");
  const [pricing, setPricing] = useState<MembershipPrice[]>([]);
  const [invoice, setInvoice] = useState<{
    invoiceId: string;
    checkoutLink: string;
    amount_sats: number | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [paid, setPaid] = useState(false);

  // Fetch plans + pricing on mount
  useEffect(() => {
    fetch("/api/service-plans")
      .then((r) => r.json())
      .then((data) => setGroups(data.groups))
      .catch(() => {});
    fetch("/api/membership-pricing")
      .then((r) => r.json())
      .then((data) => setPricing(data.pricing))
      .catch(() => {});
    fetch("/api/signup-questions")
      .then((r) => r.json())
      .then((data) => {
        setSignupQuestions(data.questions);
        // Prepopulate defaults for select fields
        const defaults: Record<string, string> = {};
        for (const q of data.questions) {
          if (q.id === "gender") defaults[q.id] = "Prefer Not To Say";
        }
        setSignupAnswers((prev) => ({ ...defaults, ...prev }));
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

  // Membership pricing (sats, from DB)
  function getPrice(plan: "solo" | "duo", period: "monthly" | "annual"): MembershipPrice | undefined {
    return pricing.find((p) => p.plan === plan && p.period === period);
  }

  const currentPrice = getPrice(membershipPlan, membership);
  const membershipSats = currentPrice?.price_sats ?? 0;
  const membershipUsdCents = currentPrice?.approx_usd_cents ?? 0;
  const membershipTotalSats = membership === "annual" ? membershipSats * 12 : membershipSats;
  const membershipTotalUsdCents = membership === "annual" ? membershipUsdCents * 12 : membershipUsdCents;

  // First service price in sats (approximate — gift cards are USD-denominated)
  const firstServicePriceCents = firstQueueItem?.priceCents ?? 0;

  // Approximate sats-per-USD-cent rate derived from pricing data
  function approxUsdCentsToSats(cents: number): number {
    if (pricing.length === 0 || cents === 0) return 0;
    const p = pricing[0];
    if (!p.approx_usd_cents || p.approx_usd_cents === 0) return 0;
    return Math.round(cents * (p.price_sats / p.approx_usd_cents));
  }

  // First service in sats (approximate — gift cards are USD-denominated)
  const firstServiceApproxSats = approxUsdCentsToSats(firstServicePriceCents);
  const totalApproxSats = membershipTotalSats + firstServiceApproxSats;

  // Annual savings in sats
  const monthlyPrice = getPrice(membershipPlan, "monthly");
  const annualPrice = getPrice(membershipPlan, "annual");
  const savingsSats = monthlyPrice && annualPrice
    ? (monthlyPrice.price_sats * 12) - (annualPrice.price_sats * 12)
    : 0;

  // --- Consent capture ---
  async function recordConsent(consentType: "authorization" | "confirmation") {
    const res = await authFetch("/api/consent", {
      method: "POST",
      body: JSON.stringify({ consentType }),
    });
    return res.ok;
  }

  // --- Step 1: How it works + Authorization ---
  async function handleLetsGo() {
    setError("");
    setSubmitting(true);
    try {
      // Record both consent types
      const authOk = await recordConsent("authorization");
      if (!authOk) {
        setError("Failed to record authorization. Try again.");
        setSubmitting(false);
        return;
      }
      const confirmOk = await recordConsent("confirmation");
      if (!confirmOk) {
        setError("Failed to record confirmation. Try again.");
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
            How it works
          </h1>
          <p className="text-muted leading-relaxed">
            We handle starting and cancelling your streaming subscriptions.
            One month per service, in the order you choose.
          </p>
        </div>

        <div className="bg-surface border border-border rounded p-6 space-y-3">
          <p className="text-foreground font-bold leading-relaxed">
            Gift cards mean no recurring charges, no stored credit cards, and
            no surprise bills.
          </p>
          <p className="text-muted text-sm leading-relaxed">
            Gift card denominations don&apos;t always match monthly prices
            exactly, so you may carry a small balance with a service. When
            your balance is enough to cover another month, we just
            reactivate &mdash; no new gift card needed.
          </p>
        </div>

        <ul className="space-y-3 text-sm text-muted leading-relaxed">
          <li className="flex gap-2">
            <span className="text-muted/60 shrink-0">&bull;</span>
            <span>
              <span className="text-foreground font-medium">Solo</span> runs
              one service at a time.{" "}
              <span className="text-foreground font-medium">Duo</span> runs
              two simultaneously. You choose at checkout.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-muted/60 shrink-0">&bull;</span>
            <span>
              About two weeks into each cycle, your next service locks in
              &mdash; we purchase the gift card and commit to the rotation.
              Before that, you can reorder your queue freely.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-muted/60 shrink-0">&bull;</span>
            <span>
              Your credentials are encrypted at rest and destroyed immediately
              if your membership ends.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-muted/60 shrink-0">&bull;</span>
            <span>
              We do not share your data with anyone. There is no one to share
              it with.
            </span>
          </li>
        </ul>

        <div className="border-l-4 border-amber-500 bg-amber-500/[0.08] rounded-r-lg px-5 py-4">
          <p className="text-amber-200 text-sm font-medium leading-relaxed">
            If you have active streaming subscriptions, cancel them before we
            start. Anything you leave running means you&apos;re paying twice.
          </p>
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
            takes against your account &mdash; including suspension,
            termination, or loss of content &mdash; as a result of using this
            service.
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
            I authorize UnsaltedButter to act on my behalf &mdash; including
            signing up, cancelling, and managing streaming subscriptions using
            the credentials I provide.
          </span>
        </label>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="button"
          onClick={handleLetsGo}
          disabled={submitting || !authorized}
          className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Recording..." : "Let\u2019s go"}
        </button>
      </div>
    );
  }

  // --- Step 2: Select Plans & Add Credentials ---

  async function saveCredentials() {
    setError("");

    if (useSameCreds) {
      if (!sharedCreds.email || !sharedCreds.password) {
        setError("Enter the shared email and password.");
        return;
      }
      if (selectedGroupIds.length < 2) {
        setError("Select at least two services.");
        return;
      }
    } else {
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
    }

    setSubmitting(true);
    try {
      for (const gid of selectedGroupIds) {
        const group = groups.find((g) => g.id === gid);
        if (!group) continue;
        const c = getCredsForGroup(gid, useSameCreds, sharedCreds, creds);

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

      // Save signup answers (optional — don't block if empty)
      if (Object.keys(signupAnswers).length > 0) {
        const answersRes = await authFetch("/api/signup-answers", {
          method: "POST",
          body: JSON.stringify({ answers: signupAnswers }),
        });
        if (!answersRes.ok) {
          const data = await answersRes.json();
          setError(data.error || "Failed to save account details.");
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
      setStep(3);
    } catch {
      setError("Connection failed. Try again.");
      setSubmitting(false);
    }
  }

  function toggleAccordion(groupId: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  function getCheapestPrice(group: ServiceGroup): number {
    return Math.min(...group.plans.map((p) => p.monthly_price_cents));
  }

  function renderStep2() {
    const hasEnoughServices = selectedGroupIds.length >= 2;
    const canSave = useSameCreds
      ? hasEnoughServices && !!sharedCreds.email && !!sharedCreds.password
      : selectedGroupIds.filter((gid) => {
          const c = creds[gid];
          return c?.email && c?.password;
        }).length >= 2;

    return (
      <div className="space-y-6">
        <button
          type="button"
          onClick={() => setStep(1)}
          className="text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; Back
        </button>
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

        {/* Credentials callout — amber left border, top of page */}
        <div className="border-l-4 border-amber-500 bg-amber-500/[0.08] rounded-r-lg px-5 py-4">
          <p className="text-amber-200 text-sm font-medium leading-relaxed">
            Fresh credentials are cleanest. Give us an email and password you
            haven&apos;t used with the service before &mdash; we&apos;ll create
            a new account for you.
          </p>
          <p className="text-muted text-sm mt-3 leading-relaxed">
            Using existing accounts? Cancel all of them first. Remove your
            credit card where you can. When your first queued service expires,
            we&apos;ll add another month. After that the rotation begins.
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

        {/* Service accordion */}
        <div className="space-y-2">
          {groups.map((group) => {
            const selectedPlanId = selectedPlans[group.id];
            const isSelected = !!selectedPlanId;
            const isExpanded = expandedGroups.has(group.id);
            const selectedPlan = getSelectedPlan(group.id);

            return (
              <div key={group.id}>
                {/* Collapsed header */}
                <button
                  type="button"
                  onClick={() => toggleAccordion(group.id)}
                  className={`flex items-center justify-between w-full px-4 py-3 rounded-lg border text-sm transition-colors ${
                    isSelected
                      ? "bg-surface border-accent/60"
                      : "bg-surface border-border hover:border-amber-500/40"
                  }`}
                >
                  <span className="font-medium text-foreground">
                    {group.label}
                  </span>
                  {isSelected && selectedPlan ? (
                    <span className="flex items-center gap-2 text-accent text-xs">
                      {!useSameCreds && (!creds[group.id]?.email || !creds[group.id]?.password) && (
                        <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" title="Needs credentials" />
                      )}
                      {selectedPlan.display_name} &mdash; $
                      {(selectedPlan.monthly_price_cents / 100).toFixed(2)}/mo
                    </span>
                  ) : (
                    <span className="text-muted/60 text-xs">
                      from ${(getCheapestPrice(group) / 100).toFixed(2)}/mo
                    </span>
                  )}
                </button>

                {/* Expanded: plan options + credentials */}
                {isExpanded && (
                  <div className="mt-1 ml-8 space-y-1">
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

                    {isSelected && !useSameCreds && (
                      <div className="grid grid-cols-2 gap-3 pt-1 pb-2">
                        <input
                          type="email"
                          value={creds[group.id]?.email ?? ""}
                          onChange={(e) =>
                            updateCred(group.id, "email", e.target.value)
                          }
                          placeholder="Login email"
                          className="py-2.5 px-3 bg-surface border border-border rounded-lg text-foreground placeholder:text-muted/50 text-sm focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/20 transition-colors"
                        />
                        <div className="relative">
                          <input
                            type={showPasswords ? "text" : "password"}
                            value={creds[group.id]?.password ?? ""}
                            onChange={(e) =>
                              updateCred(group.id, "password", e.target.value)
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
                )}
              </div>
            );
          })}
        </div>

        {/* Cost summary */}
        {monthlyTotal > 0 && (
          <div className="space-y-1">
            <p className="text-sm text-muted">
              This would cost you{" "}
              <span className="text-foreground font-medium">
                ${(monthlyTotal / 100).toFixed(2)}/month
              </span>
              .
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
                worth of service credits every month.
              </p>
            )}
          </div>
        )}

        {/* Divider between sections */}
        <hr className="border-border my-4" />

        {/* Section 2: Account details */}
        {signupQuestions.length > 0 && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-foreground mb-1">
                Account details
              </h3>
              <p className="text-sm text-muted">
                Used to create accounts on your behalf. One set of details for
                all services.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {signupQuestions.map((q) => {
                const isFullWidth = q.id === "full_name";
                if (q.field_type === "select" && q.options) {
                  return (
                    <div
                      key={q.id}
                      className={isFullWidth ? "sm:col-span-2" : ""}
                    >
                      <label className="text-xs text-muted/70 mb-1.5 block">
                        {q.label}
                      </label>
                      <select
                        value={signupAnswers[q.id] ?? ""}
                        onChange={(e) =>
                          setSignupAnswers((prev) => ({
                            ...prev,
                            [q.id]: e.target.value,
                          }))
                        }
                        className="w-full py-2.5 px-3 bg-surface border border-border rounded-lg text-foreground text-sm focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/20 appearance-none transition-colors"
                      >
                        <option value="" disabled>
                          Select
                        </option>
                        {q.options.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                }
                const isDate = q.id === "birthdate";
                const maxDate = isDate
                  ? (() => {
                      const d = new Date();
                      d.setFullYear(d.getFullYear() - 18);
                      return d.toISOString().split("T")[0];
                    })()
                  : undefined;

                return (
                  <div
                    key={q.id}
                    className={isFullWidth ? "sm:col-span-2" : ""}
                  >
                    <label className="text-xs text-muted/70 mb-1.5 block">
                      {q.label}
                    </label>
                    <input
                      type={isDate ? "date" : "text"}
                      max={maxDate}
                      value={signupAnswers[q.id] ?? ""}
                      onChange={(e) =>
                        setSignupAnswers((prev) => ({
                          ...prev,
                          [q.id]: e.target.value,
                        }))
                      }
                      placeholder={q.placeholder ?? q.label}
                      className="w-full py-2.5 px-3 bg-surface border border-border rounded-lg text-foreground placeholder:text-muted/50 text-sm focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/20 transition-colors"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="button"
          onClick={saveCredentials}
          disabled={submitting || !canSave}
          className="w-full py-3 px-4 rounded-lg font-medium text-sm transition-colors bg-accent text-background hover:bg-accent/90 disabled:bg-accent/20 disabled:text-accent/40 disabled:cursor-not-allowed"
        >
          {submitting ? "Saving..." : "Save credentials"}
        </button>

        {!canSave && (
          <p className="text-xs text-muted/60 text-center -mt-3">
            Select at least two services and provide credentials for each.
          </p>
        )}
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
      setStep(4);
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
            Your rotation queue
          </h1>
          <p className="text-muted leading-relaxed">
            Reorder your services. Top of the list goes first. Each service runs
            one month, then the next one kicks in. The queue loops.
          </p>
        </div>

        <div className="border-l-4 border-amber-500 bg-amber-500/[0.08] rounded-r-lg px-5 py-4">
          <p className="text-amber-200 text-sm font-medium leading-relaxed">
            Cancel your existing streaming subscriptions before we start.
          </p>
          <p className="text-muted text-sm mt-2 leading-relaxed">
            We handle everything from here. Anything you leave running means
            you&apos;re paying twice.
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
          About two weeks into each cycle, the next service locks in. Reorder
          anytime before that.
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

        <div className="text-sm text-muted leading-relaxed text-center">
          <p>Just DM <span className="text-foreground font-medium">status</span></p>
          <p>to your friendly <span className="text-foreground font-medium">{BOT_NAME}</span></p>
          <p>as services rotate.</p>
        </div>

        {BOT_NPUB && (
          <p className="text-center text-xs text-muted">
            {BOT_NAME}:{" "}
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(BOT_NPUB);
                setNpubCopied(true);
                setTimeout(() => setNpubCopied(false), 2000);
              }}
              className="font-mono text-muted hover:text-foreground transition-colors"
            >
              {npubCopied ? "Copied!" : BOT_NPUB}
            </button>
          </p>
        )}
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
        body: JSON.stringify({
          amount_sats: membershipTotalSats,
          membership_plan: membershipPlan,
          billing_period: membership,
          service_credit_usd_cents: firstServicePriceCents,
        }),
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

  function renderStep4() {
    if (paid) {
      return (
        <div className="space-y-8">
          <div>
            <h1 className="text-4xl font-bold tracking-tight text-foreground mb-4">
              You&apos;re in.
            </h1>
            <p className="text-muted leading-relaxed">
              We&apos;re getting your {firstServiceLabel} account ready now.
              Expect it to be active within 24 hours. We&apos;ll notify you
              when it&apos;s live.
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
              Scan to pay
            </h1>
            <p className="text-muted leading-relaxed">
              Pay from any Lightning wallet. We&apos;ll have{" "}
              {firstServiceLabel} up within 24 hours.
            </p>
          </div>

          {invoice.amount_sats && (
            <p className="text-center text-2xl font-bold text-foreground">
              {invoice.amount_sats.toLocaleString()} sats
            </p>
          )}

          <div className="flex justify-center">
            <div className="bg-white p-4 rounded">
              <QRCode value={invoice.checkoutLink} size={200} />
            </div>
          </div>

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

    const soloPriceMonthly = getPrice("solo", "monthly");
    const soloPriceAnnual = getPrice("solo", "annual");
    const duoPriceMonthly = getPrice("duo", "monthly");
    const duoPriceAnnual = getPrice("duo", "annual");

    const soloDisplay = membership === "monthly" ? soloPriceMonthly : soloPriceAnnual;
    const duoDisplay = membership === "monthly" ? duoPriceMonthly : duoPriceAnnual;

    return (
      <div className="space-y-8">
        <button
          type="button"
          onClick={() => setStep(3)}
          className="text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; Back
        </button>
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-4">
            Activate your membership
          </h1>
          <p className="text-muted leading-relaxed">
            One Lightning invoice covers your UnsaltedButter membership and the{" "}
            {firstServiceLabel} gift card. We&apos;ll have {firstServiceLabel} up
            within 24 hours.
          </p>
        </div>

        {/* Plan selection */}
        <div>
          <label className="block text-sm font-medium text-muted mb-2">
            Plan
          </label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setMembershipPlan("solo")}
              className={`p-4 rounded border text-left transition-colors ${
                membershipPlan === "solo"
                  ? "border-accent bg-accent/5"
                  : "border-border bg-surface hover:border-muted"
              }`}
            >
              <p className={`font-semibold ${membershipPlan === "solo" ? "text-accent" : "text-foreground"}`}>
                Solo
              </p>
              <p className="text-sm text-muted mt-1">1 streaming service at a time</p>
              {soloDisplay && (
                <p className={`text-sm mt-2 ${membershipPlan === "solo" ? "text-accent" : "text-muted/60"}`}>
                  {formatSats(soloDisplay.price_sats)} sats/mo
                </p>
              )}
            </button>
            <button
              type="button"
              onClick={() => setMembershipPlan("duo")}
              className={`p-4 rounded border text-left transition-colors ${
                membershipPlan === "duo"
                  ? "border-accent bg-accent/5"
                  : "border-border bg-surface hover:border-muted"
              }`}
            >
              <p className={`font-semibold ${membershipPlan === "duo" ? "text-accent" : "text-foreground"}`}>
                Duo
              </p>
              <p className="text-sm text-muted mt-1">2 streaming services at once</p>
              {duoDisplay && (
                <p className={`text-sm mt-2 ${membershipPlan === "duo" ? "text-accent" : "text-muted/60"}`}>
                  {formatSats(duoDisplay.price_sats)} sats/mo
                </p>
              )}
            </button>
          </div>
        </div>

        {/* Billing period toggle */}
        <div>
          <label className="block text-sm font-medium text-muted mb-2">
            Billing
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMembership("monthly")}
              className={`flex-1 py-2 px-4 rounded text-sm font-medium border transition-colors ${
                membership === "monthly"
                  ? "bg-accent text-background border-accent"
                  : "bg-surface text-muted border-border hover:border-muted"
              }`}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setMembership("annual")}
              className={`flex-1 py-2 px-4 rounded text-sm font-medium border transition-colors ${
                membership === "annual"
                  ? "bg-accent text-background border-accent"
                  : "bg-surface text-muted border-border hover:border-muted"
              }`}
            >
              Annual
            </button>
          </div>
          {membership === "annual" && savingsSats > 0 && monthlyPrice && (
            <p className="text-sm text-accent mt-2">
              Save {Math.round((savingsSats / (monthlyPrice.price_sats * 12)) * 100)}% &mdash;{" "}
              {formatSats(Math.round(savingsSats / 12))} sats/mo with annual billing
            </p>
          )}
        </div>

        {/* Breakdown */}
        <div className="bg-surface border border-border rounded p-4">
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap justify-between gap-x-4">
              <span className="text-muted">
                Membership ({membershipPlan === "solo" ? "Solo" : "Duo"},{" "}
                {membership === "monthly" ? "1 mo" : "12 mo"})
              </span>
              <span className="text-foreground">
                {membership === "annual" && (
                  <span className="text-muted/60 mr-1">
                    ({formatSats(membershipSats)}/mo)
                  </span>
                )}
                {formatSats(membershipTotalSats)} sats
              </span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-4">
              <span className="text-muted">
                Service credit ({firstServiceLabel})
              </span>
              <span className="text-foreground">
                <span className="text-muted/60 mr-1">
                  (${(firstServicePriceCents / 100).toFixed(2)})
                </span>
                ~{formatSats(firstServiceApproxSats)} sats
              </span>
            </div>
            <div className="border-t border-border pt-2 mt-2 flex flex-wrap justify-between gap-x-4 font-medium">
              <span className="text-foreground">Total due today</span>
              <span className="text-foreground">
                ~{formatSats(totalApproxSats)} sats
              </span>
            </div>
          </div>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="button"
          onClick={createInvoice}
          disabled={submitting || membershipSats === 0}
          className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {submitting ? "Creating invoice..." : "Pay with Lightning"}
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
      </div>
    </main>
  );
}
