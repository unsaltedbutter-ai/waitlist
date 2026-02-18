"use client";

import {
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueueItem {
  serviceId: string;
  serviceName: string;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

export function EyeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
  );
}

export function EyeOffIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
  );
}

/** Toggle button for show/hide password fields. */
export function PasswordToggle({
  visible,
  onToggle,
}: {
  visible: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted/50 hover:text-muted transition-colors"
      tabIndex={-1}
    >
      {visible ? <EyeOffIcon /> : <EyeIcon />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Step Indicator
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

// ---------------------------------------------------------------------------
// Sortable Item (drag-and-drop queue row)
// ---------------------------------------------------------------------------

export function SortableItem({
  item,
  position,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
}: {
  item: QueueItem;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.serviceId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 bg-surface border border-border rounded px-4 py-3 ${
        isDragging ? "opacity-50" : ""
      }`}
    >
      <button
        type="button"
        className="hidden sm:block text-muted cursor-grab active:cursor-grabbing select-none text-lg leading-none"
        {...attributes}
        {...listeners}
      >
        &#8801;
      </button>
      <div className="flex flex-col sm:hidden">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          className="text-muted hover:text-foreground disabled:text-muted/20 transition-colors p-0.5"
          aria-label="Move up"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          className="text-muted hover:text-foreground disabled:text-muted/20 transition-colors p-0.5"
          aria-label="Move down"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      </div>
      <span className="text-sm font-medium text-muted w-6">{position}</span>
      <span className="text-foreground font-medium flex-1 min-w-0 truncate">{item.serviceName}</span>
    </div>
  );
}
