"use client";

interface AccessDateLineProps {
  accessEndDate: string | null | undefined;
}

export function formatShortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function daysUntil(iso: string): number {
  const target = new Date(iso + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

export function AccessDateLine({ accessEndDate }: AccessDateLineProps) {
  if (!accessEndDate) return null;

  const days = daysUntil(accessEndDate);
  const formatted = formatShortDate(accessEndDate);

  if (days < 0) {
    // Past date
    return (
      <span className="text-xs text-muted/60">
        Access ended {formatted}
      </span>
    );
  }

  if (days === 0) {
    return (
      <span className="text-xs text-amber-400">
        Access until {formatted} (Ends today)
      </span>
    );
  }

  if (days <= 7) {
    // Within 7 days
    return (
      <span className="text-xs text-amber-400">
        Access until {formatted} ({days} {days === 1 ? "day" : "days"} left)
      </span>
    );
  }

  // Future date, more than 7 days
  return (
    <span className="text-xs text-muted">
      Access until {formatted}
    </span>
  );
}
