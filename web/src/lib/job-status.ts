export interface StatusConfig {
  label: string;
  /** User-facing label (used by inline indicators). Falls back to `label` if not set. */
  userLabel?: string;
  badgeClass: string;
  pulse?: boolean;
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  pending: {
    label: "Pending",
    userLabel: "Queued",
    badgeClass: "bg-neutral-800/50 text-neutral-400 border border-neutral-700",
  },
  dispatched: {
    label: "Dispatched",
    userLabel: "Starting",
    badgeClass: "bg-blue-900/50 text-blue-400 border border-blue-700",
  },
  outreach_sent: {
    label: "Outreach sent",
    userLabel: "Check DMs",
    badgeClass: "bg-amber-900/50 text-amber-400 border border-amber-700",
  },
  snoozed: {
    label: "Snoozed",
    badgeClass: "bg-amber-900/50 text-amber-400 border border-amber-700",
  },
  active: {
    label: "Active",
    userLabel: "In progress",
    badgeClass: "bg-blue-900/50 text-blue-400 border border-blue-700",
    pulse: true,
  },
  awaiting_otp: {
    label: "Awaiting OTP",
    userLabel: "Check DMs (OTP needed)",
    badgeClass: "bg-amber-900/50 text-amber-400 border border-amber-700",
    pulse: true,
  },
  completed_paid: {
    label: "Paid",
    badgeClass: "bg-green-900/50 text-green-400 border border-green-700",
  },
  completed_eventual: {
    label: "Paid (late)",
    badgeClass: "bg-green-900/50 text-green-400 border border-green-700",
  },
  completed_reneged: {
    label: "Unpaid",
    badgeClass: "bg-red-900/50 text-red-400 border border-red-700",
  },
  failed: {
    label: "Failed",
    badgeClass: "bg-red-900/50 text-red-400 border border-red-700",
  },
  user_skip: {
    label: "Skipped",
    badgeClass: "bg-neutral-800/50 text-neutral-500 border border-neutral-700",
  },
  user_abandon: {
    label: "Abandoned",
    badgeClass: "bg-neutral-800/50 text-neutral-500 border border-neutral-700",
  },
  implied_skip: {
    label: "Implied skip",
    badgeClass: "bg-neutral-800/50 text-neutral-500 border border-neutral-700",
  },
};

const DEFAULT_CONFIG: StatusConfig = {
  label: "",
  badgeClass: "bg-neutral-800/50 text-neutral-400 border border-neutral-700",
};

export function getJobStatusConfig(status: string): StatusConfig {
  return STATUS_CONFIG[status] ?? { ...DEFAULT_CONFIG, label: status };
}

export function getJobStatusLabel(status: string): string {
  return getJobStatusConfig(status).label;
}

export function getJobStatusBadgeClass(status: string): string {
  return getJobStatusConfig(status).badgeClass;
}
