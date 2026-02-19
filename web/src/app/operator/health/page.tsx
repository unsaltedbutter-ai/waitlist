"use client";

import { useState, useEffect, useCallback } from "react";
import { authFetch } from "@/lib/hooks/use-auth";
import { SectionHeader } from "../_components";

interface ComponentStatus {
  component: string;
  status: "healthy" | "warning" | "critical" | "unknown";
  last_seen_at: string | null;
  payload: Record<string, unknown> | null;
}

const STATUS_CONFIG: Record<
  ComponentStatus["status"],
  { label: string; dotClass: string; bgClass: string }
> = {
  healthy: {
    label: "Healthy",
    dotClass: "bg-green-500",
    bgClass: "border-green-700/50",
  },
  warning: {
    label: "Warning",
    dotClass: "bg-amber-500",
    bgClass: "border-amber-700/50",
  },
  critical: {
    label: "Critical",
    dotClass: "bg-red-500",
    bgClass: "border-red-700/50",
  },
  unknown: {
    label: "Unknown",
    dotClass: "bg-neutral-500",
    bgClass: "border-neutral-700/50",
  },
};

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatComponentName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function StatusCard({ component }: { component: ComponentStatus }) {
  const config = STATUS_CONFIG[component.status];

  return (
    <div
      className={`bg-surface border rounded p-5 ${config.bgClass}`}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">
          {formatComponentName(component.component)}
        </h3>
        <span className="flex items-center gap-1.5">
          <span
            className={`inline-block w-2 h-2 rounded-full ${config.dotClass}`}
          />
          <span className="text-xs text-muted">{config.label}</span>
        </span>
      </div>

      <p className="text-xs text-muted mb-2">
        {component.last_seen_at
          ? `Last seen: ${formatRelativeTime(component.last_seen_at)}`
          : "Never seen"}
      </p>

      {component.payload && Object.keys(component.payload).length > 0 && (
        <div className="mt-3 border-t border-border pt-3 space-y-1">
          {Object.entries(component.payload).map(([key, value]) => {
            let valueClass = "text-foreground font-mono";
            if (key === "version") {
              const vpsHash = process.env.NEXT_PUBLIC_GIT_HASH;
              if (vpsHash && String(value) === vpsHash) {
                valueClass = "text-green-400 font-mono";
              } else if (vpsHash) {
                valueClass = "text-amber-400 font-mono";
              }
            }
            return (
              <div key={key} className="flex justify-between text-xs">
                <span className="text-muted">{key}</span>
                <span className={valueClass}>
                  {String(value)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function HealthPage() {
  const [components, setComponents] = useState<ComponentStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    try {
      const res = await authFetch("/api/operator/heartbeats");
      if (res.status === 403) {
        setError("Access denied.");
        return;
      }
      if (!res.ok) {
        setError("Failed to load system health.");
        return;
      }
      const data = await res.json();
      setComponents(data.components);
      setError("");
    } catch {
      setError("Failed to load system health.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (error === "Access denied.") {
    return <p className="text-red-400 text-sm">403 -- Not authorized.</p>;
  }

  if (loading) return <p className="text-muted">Loading system health...</p>;
  if (error) return <p className="text-red-400 text-sm">{error}</p>;

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader>System Health</SectionHeader>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {components.map((c) => (
            <StatusCard key={c.component} component={c} />
          ))}
        </div>
        <p className="text-xs text-muted mt-4">
          Auto-refreshes every 30 seconds.
        </p>
      </section>
    </div>
  );
}
