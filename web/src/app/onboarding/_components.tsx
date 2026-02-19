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
    <div className="flex items-center justify-center gap-3 mb-10">
      {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((s) => (
        <div key={s} className="flex items-center gap-3">
          <div
            className={`w-3.5 h-3.5 rounded-full transition-colors ${
              s === current
                ? "bg-accent ring-2 ring-accent/30"
                : s < current
                  ? "bg-accent/40"
                  : "bg-border"
            }`}
          />
          {s < TOTAL_STEPS && <div className="w-6 h-px bg-border" />}
        </div>
      ))}
      <span className="ml-3 text-sm text-muted">
        Step {current} of {TOTAL_STEPS}
      </span>
    </div>
  );
}
