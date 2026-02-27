"use client";

import { formatDate } from "@/lib/format";
import { getJobStatusBadgeClass, getJobStatusLabel } from "@/lib/job-status";
import type { JobRecord } from "./types";
import { flowTypeLabel } from "./types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface RecentJobsSectionProps {
  jobs: JobRecord[];
  jobsError: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RecentJobsSection({ jobs, jobsError }: RecentJobsSectionProps) {
  return (
    <section className="bg-surface border border-border rounded p-6">
      <h2 className="text-xs font-semibold text-muted/50 uppercase tracking-wider mb-5">
        Recent jobs
      </h2>

      {jobsError && (
        <p className="text-amber-400 text-sm">Could not load recent jobs.</p>
      )}

      {jobs.length > 0 ? (
        <>
          {/* Desktop table (hidden on small screens) */}
          <div className="hidden sm:block overflow-x-auto">
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
                      <span className={`text-xs font-medium px-2 py-0.5 rounded ${getJobStatusBadgeClass(job.status)}`}>
                        {getJobStatusLabel(job.status)}
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

          {/* Mobile stacked cards (shown on small screens) */}
          <div className="sm:hidden space-y-2">
            {jobs.map((job) => (
              <div
                key={job.id}
                className="border border-border/50 rounded p-3 space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">
                    {job.service_name}
                  </span>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${getJobStatusBadgeClass(job.status)}`}>
                    {getJobStatusLabel(job.status)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-muted">
                  <span>{flowTypeLabel(job.flow_type)}</span>
                  <span>{formatDate(job.completed_at ?? job.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : !jobsError ? (
        <p className="text-sm text-muted/50 text-center py-6">
          No jobs yet. Send a DM to cancel or resume a service.
        </p>
      ) : null}
    </section>
  );
}
