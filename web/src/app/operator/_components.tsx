"use client";

import React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobsByService {
  service: string;
  pending: number;
  claimed: number;
  in_progress: number;
  completed: number;
  failed: number;
  dead_letter: number;
}

export interface PerfRow {
  service_name: string;
  flow_type: string;
  total: number;
  succeeded: number;
  success_rate: number;
  avg_inference_steps: number;
  avg_duration_seconds: number;
  avg_steps: number;
}

export interface CacheRow {
  service_name: string;
  pct_7d: number;
  pct_14d: number;
}

export interface DeadLetterRow {
  id: string;
  service_name: string;
  flow_type: string;
  error_message: string | null;
  completed_at: string;
}

export interface Alert {
  id: string;
  alert_type: string;
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  created_at: string;
}

export interface WaitlistEntry {
  id: string;
  email: string | null;
  nostr_npub: string | null;
  current_services: string[] | null;
  invited: boolean;
  invited_at: string | null;
  created_at: string;
}

export interface CapacityInfo {
  activeUsers: number;
  cap: number;
  availableSlots: number;
}

export interface PendingRefund {
  id: string;
  contact: string;
  amount_sats: number;
  created_at: string;
}

export interface LedgerMonth {
  month: string;
  membership_revenue: number;
  credit_deposits: number;
  gift_card_purchases: number;
  refunds: number;
  net_flow: number;
}

export interface Metrics {
  jobs_today: {
    by_status: Record<string, number>;
    by_service: JobsByService[];
  };
  agent_performance: {
    "7d": PerfRow[];
    "30d": PerfRow[];
  };
  playbook_cache: CacheRow[];
  business: {
    users: Record<string, number>;
    subscriptions: Record<string, number>;
    sats_in_30d: number;
    sats_out_30d: number;
    margin_call_count: number;
    total_credit_liability: number;
    total_refund_liability: number;
  };
  dead_letter: DeadLetterRow[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatSats(n: number): string {
  return n.toLocaleString("en-US");
}

export function cacheColor(pct: number): string {
  if (pct >= 80) return "text-green-400";
  if (pct >= 50) return "text-amber-400";
  return "text-red-400";
}

export function severityStyle(severity: string): string {
  if (severity === "critical")
    return "bg-red-900/50 border-red-700 text-red-300";
  if (severity === "warning")
    return "bg-amber-900/50 border-amber-700 text-amber-300";
  return "bg-neutral-800/50 border-neutral-700 text-neutral-300";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const thClass = "text-left text-xs font-medium text-muted px-3 py-2";
export const tdClass = "px-3 py-2 text-sm text-foreground";
export const tdMuted = "px-3 py-2 text-sm text-muted";

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="bg-surface border border-border rounded p-4">
      <p className="text-xs text-muted mb-1">{label}</p>
      <p className="text-xl font-bold text-foreground">{value}</p>
      {sub && <p className="text-xs text-muted mt-1">{sub}</p>}
    </div>
  );
}

export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-medium text-muted mb-3 uppercase tracking-wide">
      {children}
    </h2>
  );
}
