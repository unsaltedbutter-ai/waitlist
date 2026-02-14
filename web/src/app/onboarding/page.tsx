"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, authFetch } from "@/lib/hooks/use-auth";
import { SERVICES } from "@/lib/services";
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

interface CredentialEntry {
  serviceId: string;
  email: string;
  password: string;
}

interface QueueItem {
  serviceId: string;
  label: string;
}

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center justify-center gap-3 mb-10">
      {[1, 2, 3, 4].map((s) => (
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
          {s < 4 && <div className="w-6 h-px bg-border" />}
        </div>
      ))}
      <span className="ml-3 text-sm text-muted">Step {current} of 4</span>
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
      <span className="text-foreground font-medium">{item.label}</span>
    </div>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const { loading } = useAuth();

  const [step, setStep] = useState(1);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Step 2 state
  const [credentials, setCredentials] = useState<CredentialEntry[]>([
    { serviceId: "", email: "", password: "" },
    { serviceId: "", email: "", password: "" },
  ]);

  // Step 3 state
  const [queue, setQueue] = useState<QueueItem[]>([]);

  // Step 4 state
  const [amountUsd, setAmountUsd] = useState("");
  const [invoice, setInvoice] = useState<{
    invoiceId: string;
    checkoutLink: string;
    amount_sats: number | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [paid, setPaid] = useState(false);

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

  // --- Step 1: Disclaimer ---
  function renderStep1() {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-6">
            Before we begin.
          </h1>
          <div className="space-y-4 text-muted leading-relaxed">
            <p>
              UnsaltedButter manages your streaming subscriptions by signing up
              for services on your behalf. We buy gift cards with your BTC
              balance to activate services. When the gift card balance runs out,
              the service ends naturally — no cancellation needed.
            </p>
            <p>
              This works. But it is not magic, and you need to understand how it
              works.
            </p>
          </div>
        </div>

        <div className="bg-surface border border-border rounded p-6">
          <p className="text-foreground font-bold leading-relaxed">
            We purchase gift cards to activate your streaming services. When the
            gift card balance runs out, the service ends naturally. No
            cancellation needed, no risk of extra charges.
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
              We buy gift cards with your BTC balance to activate services. Gift
              card codes are encrypted and destroyed after redemption.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-muted/60 shrink-0">&bull;</span>
            <span>
              We never store screenshots containing your personal information.
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
              Membership is $9.99/month, deducted from your BTC balance.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-muted/60 shrink-0">&bull;</span>
            <span>No refunds for partial months except at our discretion.</span>
          </li>
        </ul>

        <button
          type="button"
          onClick={() => setStep(2)}
          className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors"
        >
          I understand. Continue.
        </button>
      </div>
    );
  }

  // --- Step 2: Add Streaming Credentials ---
  function updateCredential(
    index: number,
    field: keyof CredentialEntry,
    value: string
  ) {
    setCredentials((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  }

  function addCredential() {
    setCredentials((prev) => [
      ...prev,
      { serviceId: "", email: "", password: "" },
    ]);
  }

  function removeCredential(index: number) {
    if (credentials.length <= 2) return;
    setCredentials((prev) => prev.filter((_, i) => i !== index));
  }

  function usedServiceIds(): Set<string> {
    return new Set(credentials.map((c) => c.serviceId).filter(Boolean));
  }

  async function saveCredentials() {
    setError("");

    // Validate minimum 2
    const filled = credentials.filter(
      (c) => c.serviceId && c.email && c.password
    );
    if (filled.length < 2) {
      setError("Add at least two services with complete credentials.");
      return;
    }

    // Validate no empty fields in filled entries
    for (let i = 0; i < credentials.length; i++) {
      const c = credentials[i];
      if (c.serviceId || c.email || c.password) {
        if (!c.serviceId || !c.email || !c.password) {
          setError(`Entry ${i + 1} is incomplete. Fill all fields or remove it.`);
          return;
        }
      }
    }

    // Validate no duplicate services
    const serviceIds = credentials.filter((c) => c.serviceId).map((c) => c.serviceId);
    if (new Set(serviceIds).size !== serviceIds.length) {
      setError("Each service can only appear once.");
      return;
    }

    setSubmitting(true);

    try {
      const entries = credentials.filter(
        (c) => c.serviceId && c.email && c.password
      );

      for (const entry of entries) {
        const res = await authFetch("/api/credentials", {
          method: "POST",
          body: JSON.stringify({
            serviceId: entry.serviceId,
            email: entry.email,
            password: entry.password,
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          setError(data.error || `Failed to save credentials for ${entry.serviceId}.`);
          setSubmitting(false);
          return;
        }
      }

      // Build queue from saved credentials
      const savedQueue: QueueItem[] = entries.map((e) => {
        const svc = SERVICES.find((s) => s.id === e.serviceId);
        return { serviceId: e.serviceId, label: svc?.label ?? e.serviceId };
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
    const used = usedServiceIds();

    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-4">
            Your streaming accounts
          </h1>
          <p className="text-muted leading-relaxed">
            Add the login credentials for each streaming service you want in
            your rotation. We need these to sign up on your behalf using gift
            cards. If you have an existing subscription, let it lapse or cancel
            it — we&apos;ll resubscribe with a gift card when your turn comes.
          </p>
        </div>

        <div className="space-y-6">
          {credentials.map((cred, i) => (
            <div key={i} className="bg-surface border border-border rounded p-5 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted">
                  Service {i + 1}
                </span>
                {credentials.length > 2 && (
                  <button
                    type="button"
                    onClick={() => removeCredential(i)}
                    className="text-muted hover:text-foreground transition-colors text-sm"
                    aria-label="Remove entry"
                  >
                    &#10005;
                  </button>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-muted mb-2">
                  Service
                </label>
                <select
                  value={cred.serviceId}
                  onChange={(e) => updateCredential(i, "serviceId", e.target.value)}
                  className="w-full py-3 px-4 bg-surface border border-border rounded text-foreground focus:outline-none focus:border-accent"
                >
                  <option value="">Select a service</option>
                  {SERVICES.map((svc) => (
                    <option
                      key={svc.id}
                      value={svc.id}
                      disabled={used.has(svc.id) && cred.serviceId !== svc.id}
                    >
                      {svc.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-muted mb-2">
                  Login email
                </label>
                <input
                  type="email"
                  value={cred.email}
                  onChange={(e) => updateCredential(i, "email", e.target.value)}
                  placeholder="you@example.com"
                  className="w-full py-3 px-4 bg-surface border border-border rounded text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-muted mb-2">
                  Password
                </label>
                <input
                  type="password"
                  value={cred.password}
                  onChange={(e) => updateCredential(i, "password", e.target.value)}
                  placeholder="Enter password"
                  className="w-full py-3 px-4 bg-surface border border-border rounded text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
                />
                <p className="text-xs text-muted mt-1.5">
                  Use a strong, unique password. We encrypt it immediately. You
                  can update it anytime.
                </p>
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={addCredential}
          className="py-2 px-4 text-muted border border-border rounded hover:border-muted transition-colors text-sm"
        >
          + Add another service
        </button>

        <p className="text-sm text-muted">
          Add at least two services to enable rotation. One service alone has
          nothing to rotate with.
        </p>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="button"
          onClick={saveCredentials}
          disabled={submitting}
          className="w-full py-3 px-4 bg-accent text-background font-semibold rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {submitting ? "Saving..." : "Save credentials"}
        </button>
      </div>
    );
  }

  // --- Step 3: Set Rotation Order ---
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
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-4">
            Your rotation queue
          </h1>
          <p className="text-muted leading-relaxed">
            Drag to reorder. The service at the top starts first. Each service
            stays active until the gift card runs out (roughly 30–40 days), then
            the next one in line activates. The queue loops — after the last
            service, it starts over at the top.
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
          Each rotation is roughly 30–40 days depending on gift card value vs.
          monthly price. Some variation is normal.
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

  // --- Step 4: Prepay for Service ---
  async function createInvoice() {
    setError("");
    setSubmitting(true);

    try {
      const body: { amount_usd_cents?: number } = {};
      if (amountUsd) {
        const cents = Math.round(parseFloat(amountUsd) * 100);
        if (isNaN(cents) || cents <= 0) {
          setError("Enter a valid dollar amount.");
          setSubmitting(false);
          return;
        }
        body.amount_usd_cents = cents;
      }

      const res = await authFetch("/api/credits/prepay", {
        method: "POST",
        body: JSON.stringify(body),
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
              Credits added.
            </h1>
            <p className="text-muted leading-relaxed">
              Your credits are loaded. Your first rotation starts within 24
              hours — we&apos;ll buy a gift card for the top service in your
              queue and activate it. After that, everything is automatic. Check
              your dashboard anytime — but you won&apos;t need to.
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
              Prepay for service
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
            Prepay for service
          </h1>
          <p className="text-muted leading-relaxed">
            Your service credits cover everything: membership ($9.99/mo) and
            gift card purchases for your streaming services. Add credits in any
            amount via Lightning Network. More credits = more rotations without
            interruption.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-muted mb-2">
            Amount (USD)
          </label>
          <div className="relative">
            <span className="absolute left-4 top-3 text-muted">$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={amountUsd}
              onChange={(e) => setAmountUsd(e.target.value)}
              placeholder="Leave empty for open amount"
              className="w-full py-3 pl-8 pr-4 bg-surface border border-border rounded text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
            />
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
      </div>
    </main>
  );
}
