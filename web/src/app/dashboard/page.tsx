"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth, authFetch } from "@/lib/hooks/use-auth";
import { DebtBanner } from "@/components/debt-banner";
import { BotChip } from "@/components/bot-chip";
import { QueueSection, RecentJobsSection, AccountSection } from "./_sections";
import type { EnrichedQueueItem } from "@/lib/types";
import type { JobRecord, ServiceOption, ServicePlan } from "./_sections/types";

// ---------------------------------------------------------------------------
// Dashboard Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const { user, loading: authLoading, logout } = useAuth();

  const [queue, setQueue] = useState<EnrichedQueueItem[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState("");
  const [jobsError, setJobsError] = useState(false);
  const [actionPriceSats, setActionPriceSats] = useState(3000);

  // Service catalog (for "add service" in QueueSection)
  const [allServices, setAllServices] = useState<ServiceOption[]>([]);

  // ---------- Data fetching ----------

  const fetchData = useCallback(async () => {
    setLoadingData(true);
    setError("");
    setJobsError(false);
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
      } else {
        setJobs([]);
        setJobsError(true);
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

  const fetchPricing = useCallback(async () => {
    try {
      const res = await fetch("/api/pricing");
      if (res.ok) {
        const data = await res.json();
        if (data.action_price_sats) {
          setActionPriceSats(data.action_price_sats);
        }
      }
    } catch {
      // silent, keep default
    }
  }, []);

  useEffect(() => {
    if (!authLoading && user) {
      fetchData();
      fetchAllServices();
      fetchPricing();
    }
  }, [authLoading, user, fetchData, fetchAllServices, fetchPricing]);

  // ---------- Derived ----------

  const userDebtSats = user?.debt_sats ?? 0;

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

  return (
    <main className="min-h-screen">
      <div className="max-w-2xl mx-auto px-4 py-12 space-y-5">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-white mb-2">
          Dashboard
        </h1>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        {/* Outstanding debt warning + pay flow */}
        <DebtBanner />

        {/* Nostr DM callout */}
        <div className="flex items-start gap-4 bg-purple/6 border border-purple/20 rounded-xl p-5">
          <div className="shrink-0 w-9 h-9 rounded-lg bg-purple/15 flex items-center justify-center text-lg">
            &#9889;
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base font-semibold text-foreground mb-1">
              Cancel or resume via Nostr DM
            </p>
            <p className="text-sm text-muted leading-relaxed">
              Send a message to <BotChip /> to cancel or resume any service. Each action costs{" "}
              <span className="text-foreground font-medium">
                {actionPriceSats.toLocaleString()} sats
              </span>.
            </p>
            <div className="flex gap-2 mt-3 flex-wrap">
              <span className="font-mono text-xs px-3 py-1.5 rounded-full bg-purple/10 border border-purple/20 text-purple">
                &quot;Cancel Netflix&quot;
              </span>
              <span className="font-mono text-xs px-3 py-1.5 rounded-full bg-purple/10 border border-purple/20 text-purple">
                &quot;Resume Disney+&quot;
              </span>
            </div>
          </div>
        </div>

        {loadingData ? (
          <p className="text-muted">Loading your data...</p>
        ) : (
          <>
            <QueueSection
              queue={queue}
              setQueue={setQueue}
              allServices={allServices}
              userDebtSats={userDebtSats}
              error={error}
              setError={setError}
              onRefresh={fetchData}
            />

            <RecentJobsSection
              jobs={jobs}
              jobsError={jobsError}
            />

            <AccountSection
              user={user}
              logout={logout}
              setError={setError}
            />

            <p className="text-center text-xs text-muted/40 pt-4">
              <a href="/faq" className="hover:text-muted transition-colors">
                FAQ
              </a>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
