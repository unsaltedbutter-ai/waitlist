"use client";

import { useState, useEffect, useCallback } from "react";
import { authFetch } from "@/lib/hooks/use-auth";
import {
  ProblemJobRow,
  SectionHeader,
  formatDate,
  thClass,
  tdClass,
  tdMuted,
} from "../_components";

export default function DeadLetterPage() {
  const [problemJobs, setProblemJobs] = useState<ProblemJobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await authFetch("/api/operator/metrics");
      if (res.status === 403) {
        setError("Access denied.");
        return;
      }
      if (!res.ok) {
        setError("Failed to load data.");
        return;
      }
      const data = await res.json();
      setProblemJobs(data.problem_jobs);
    } catch {
      setError("Failed to load data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (error === "Access denied.") {
    return <p className="text-red-400 text-sm">403 -- Not authorized.</p>;
  }

  if (loading) return <p className="text-muted">Loading problem jobs...</p>;
  if (error) return <p className="text-red-400 text-sm">{error}</p>;

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader>Problem Jobs</SectionHeader>
        {problemJobs.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Service</th>
                  <th className={thClass}>Flow</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Last Updated</th>
                </tr>
              </thead>
              <tbody>
                {problemJobs.map((r) => (
                  <tr key={r.id} className="border-b border-border/50">
                    <td className={tdClass}>{r.service_name}</td>
                    <td className={tdMuted}>{r.flow_type}</td>
                    <td className="px-3 py-2 text-sm text-red-400">
                      {r.status}
                    </td>
                    <td className={tdMuted}>
                      {r.status_updated_at
                        ? formatDate(r.status_updated_at)
                        : "--"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted text-sm">No problem jobs.</p>
        )}
      </section>
    </div>
  );
}
