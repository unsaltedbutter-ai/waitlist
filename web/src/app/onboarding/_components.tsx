"use client";

export { PasswordToggle } from "@/components/password-toggle";
export { SimpleQueueItem as SortableItem } from "@/components/simple-queue-item";
export type { QueueItemData as QueueItem } from "@/components/simple-queue-item";

// ---------------------------------------------------------------------------
// Step Indicator (onboarding-specific)
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 3;

export function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-10">
      {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((s) => (
        <div key={s} className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full transition-colors ${
              s === current
                ? "bg-accent shadow-[0_0_8px_rgba(245,158,11,0.4)]"
                : s < current
                  ? "bg-accent/50"
                  : "bg-border"
            }`}
          />
          {s < TOTAL_STEPS && (
            <div
              className={`w-6 h-px ${
                s < current ? "bg-accent/30" : "bg-border"
              }`}
            />
          )}
        </div>
      ))}
      <span className="ml-1 text-xs text-muted tracking-wide">
        Step {current} of {TOTAL_STEPS}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Service icon config
// ---------------------------------------------------------------------------

const SERVICE_ICON_MAP: Record<string, { bg: string; label: string }> = {
  netflix: { bg: "bg-[#e50914]", label: "N" },
  hulu: { bg: "bg-[#1ce783]", label: "H" },
  disney_plus: { bg: "bg-[#2f7d8c]", label: "D+" },
  paramount: { bg: "bg-[#0064ff]", label: "P+" },
  peacock: { bg: "bg-black border border-white/15", label: "\uD83E\uDD9A" },
  max: { bg: "bg-[#2e0070]", label: "M" },
};

export function ServiceIcon({ serviceId, size = "md" }: { serviceId: string; size?: "sm" | "md" }) {
  const icon = SERVICE_ICON_MAP[serviceId];
  const sizeClass = size === "sm" ? "w-7 h-7 text-[10px]" : "w-8 h-8 text-[11px]";
  if (!icon) {
    return (
      <div className={`${sizeClass} rounded-lg bg-muted/20 flex items-center justify-center text-foreground font-bold`}>
        ?
      </div>
    );
  }
  return (
    <div className={`${sizeClass} rounded-lg ${icon.bg} flex items-center justify-center text-white font-bold`}>
      {icon.label}
    </div>
  );
}
