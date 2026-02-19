"use client";

import { getJobStatusConfig } from "@/lib/job-status";

interface JobStatusIndicatorProps {
  status: string;
}

export function JobStatusIndicator({ status }: JobStatusIndicatorProps) {
  const config = getJobStatusConfig(status);
  const label = config.userLabel ?? config.label;

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded shrink-0 ${config.badgeClass}`}
    >
      {config.pulse && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current" />
        </span>
      )}
      {label}
    </span>
  );
}
