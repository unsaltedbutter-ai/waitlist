"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth, authFetch } from "@/lib/hooks/use-auth";
import { DebtBanner } from "@/components/debt-banner";
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

  useEffect(() => {
    if (!authLoading && user) {
      fetchData();
      fetchAllServices();
    }
  }, [authLoading, user, fetchData, fetchAllServices]);

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

            <p className="text-center text-xs text-muted pt-4">
              <a href="/faq" className="hover:text-foreground transition-colors">
                FAQ
              </a>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
