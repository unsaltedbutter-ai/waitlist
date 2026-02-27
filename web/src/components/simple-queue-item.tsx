"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/**
 * Lightweight queue item data used by the onboarding flow.
 * Does not include job state, credentials, or action logic.
 */
export interface QueueItemData {
  serviceId: string;
  serviceName: string;
  planName?: string;
  planPriceCents?: number;
}

interface SimpleQueueItemProps {
  item: QueueItemData;
  position?: number;
  isFirst?: boolean;
  isLast?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove?: () => void;
  pinned?: boolean;
  statusBadge?: React.ReactNode;
  icon?: React.ReactNode;
}

/**
 * A simple sortable queue item for contexts that do not need
 * the full enriched dashboard item (e.g., onboarding).
 */
export function SimpleQueueItem({
  item,
  position,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onRemove,
  pinned,
  statusBadge,
  icon,
}: SimpleQueueItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.serviceId, disabled: pinned });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const priceBadge = item.planName ? (
    <span className="text-xs text-accent bg-accent/10 px-2.5 py-1 rounded-md font-medium whitespace-nowrap">
      {item.planName}
      {item.planPriceCents != null && (
        <> &middot; ${(item.planPriceCents / 100).toFixed(2)}</>
      )}
    </span>
  ) : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 bg-surface border border-border rounded-xl px-4 py-3.5"
    >
      {pinned ? (
        <span className="text-muted/40 text-lg leading-none select-none">
          &#8801;
        </span>
      ) : (
        <>
          <button
            type="button"
            className="hidden sm:block text-muted cursor-grab active:cursor-grabbing select-none text-lg leading-none"
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${item.serviceName}`}
          >
            &#8801;
          </button>
          {onMoveUp && onMoveDown && (
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
          )}
        </>
      )}
      {icon}
      {position != null && (
        <span className="text-sm font-medium text-muted w-6">{position}</span>
      )}
      <span className="flex-1 min-w-0 truncate font-semibold text-foreground text-base">
        {item.serviceName}
      </span>
      {priceBadge || statusBadge}
      {onRemove && !pinned && (
        <button
          type="button"
          onClick={onRemove}
          className="text-muted/50 hover:text-red-400 transition-colors shrink-0 p-1"
          aria-label={`Remove ${item.serviceName}`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      )}
    </div>
  );
}
