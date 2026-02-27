"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { EnrichedQueueItem } from "@/lib/types";
import { JobStatusIndicator } from "@/components/job-status-indicator";
import { AccessDateLine } from "@/components/access-date-line";
import { QueueItemOverflowMenu } from "@/components/queue-item-overflow-menu";
import { ServiceCredentialForm } from "@/components/service-credential-form";

export interface SortableQueueItemProps {
  item: EnrichedQueueItem;
  pinned?: boolean;
  expandedPanel: "credentials" | "remove" | null;
  onExpandPanel: (panel: "credentials" | "remove" | null) => void;
  onUpdateCredentials: (data: { serviceId: string; email: string; password: string }) => Promise<void>;
  onRemoveService: (serviceId: string) => Promise<void>;
  credentialEmail?: string;
  credentialLoading?: boolean;
  credentialError?: boolean;
  updatingCredentials?: boolean;
  removingService?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SortableQueueItem({
  item,
  pinned,
  expandedPanel,
  onExpandPanel,
  onUpdateCredentials,
  onRemoveService,
  credentialEmail,
  credentialLoading,
  credentialError,
  updatingCredentials,
  removingService,
}: SortableQueueItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.service_id, disabled: pinned });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const hasActive = item.active_job_id !== null;

  // ---------------------------------------------------------------------------
  // Secondary line content
  // ---------------------------------------------------------------------------

  function renderSecondaryLine() {
    if (hasActive && item.active_job_status) {
      return (
        <div className="flex items-center gap-2 mt-0.5">
          <JobStatusIndicator status={item.active_job_status} />
        </div>
      );
    }

    return (
      <div className="mt-0.5">
        <AccessDateLine accessEndDate={item.last_access_end_date} />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="bg-surface border border-border rounded"
    >
      {/* Primary row */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Drag handle */}
        {pinned ? (
          <span className="text-muted/40 text-lg leading-none select-none shrink-0">
            &#8801;
          </span>
        ) : (
          <button
            type="button"
            className="text-muted cursor-grab active:cursor-grabbing select-none text-lg leading-none shrink-0"
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${item.service_name}`}
          >
            &#8801;
          </button>
        )}

        {/* Service name, plan, secondary line */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-foreground font-medium truncate">
              {item.service_name}
            </span>
            {item.plan_name && (
              <span className="text-muted text-xs shrink-0">{item.plan_name}</span>
            )}
          </div>
          {renderSecondaryLine()}
        </div>

        {/* Overflow menu */}
        <QueueItemOverflowMenu
          onUpdateCredentials={() => onExpandPanel("credentials")}
          onRemoveService={() => onExpandPanel("remove")}
          hasActiveJob={hasActive}
        />
      </div>

      {/* Expandable panels */}
      {expandedPanel === "credentials" && (
        <div className="border-t border-border px-4 py-3">
          {credentialLoading ? (
            <p className="text-sm text-muted">Decrypting credentials...</p>
          ) : (
            <>
              {credentialError && (
                <p className="text-amber-400 text-xs mb-2">Could not load current email.</p>
              )}
              <ServiceCredentialForm
                serviceId={item.service_id}
                serviceName={item.service_name}
                initialEmail={credentialEmail}
                onSubmit={onUpdateCredentials}
                submitting={updatingCredentials}
                submitLabel="Update credentials"
              />
            </>
          )}
        </div>
      )}

      {expandedPanel === "remove" && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          <p className="text-sm text-red-300">
            Remove{" "}
            <span className="font-medium text-red-200">
              {item.service_name}
            </span>
            ? This will also delete your saved credentials for this service.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onRemoveService(item.service_id)}
              disabled={removingService}
              className="py-1.5 px-3 bg-red-800 text-red-200 text-sm font-medium rounded hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              {removingService ? "Removing..." : "Remove"}
            </button>
            <button
              type="button"
              onClick={() => onExpandPanel(null)}
              disabled={removingService}
              className="py-1.5 px-3 bg-surface border border-border text-foreground text-sm rounded hover:border-muted transition-colors"
            >
              Keep
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
