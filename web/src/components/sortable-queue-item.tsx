"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { EnrichedQueueItem } from "@/lib/types";
import { JobStatusIndicator } from "@/components/job-status-indicator";
import { AccessDateLine } from "@/components/access-date-line";
import { QueueItemOverflowMenu } from "@/components/queue-item-overflow-menu";
import { ActionConfirmPanel } from "@/components/action-confirm-panel";
import { ServiceCredentialForm } from "@/components/service-credential-form";
import { ACTION_STYLES } from "@/lib/constants";

export interface SortableQueueItemProps {
  item: EnrichedQueueItem;
  pinned?: boolean;
  expandedPanel: "credentials" | "confirm-action" | "remove" | null;
  /** When set, the confirm-action panel uses this action instead of the primary action.
   *  This supports the overflow menu escape hatch (e.g., user picks "Request cancel"
   *  even though the primary button would show "Resume"). */
  overrideAction?: "cancel" | "resume";
  onExpandPanel: (panel: "credentials" | "confirm-action" | "remove" | null, action?: "cancel" | "resume") => void;
  onUpdateCredentials: (data: { serviceId: string; email: string; password: string }) => Promise<void>;
  onRequestAction: (serviceId: string, action: "cancel" | "resume") => Promise<void>;
  onRemoveService: (serviceId: string) => Promise<void>;
  credentialEmail?: string;
  credentialLoading?: boolean;
  credentialError?: boolean;
  updatingCredentials?: boolean;
  requestingAction?: boolean;
  removingService?: boolean;
  userDebtSats?: number;
  actionError?: string;
}

// ---------------------------------------------------------------------------
// Action button decision tree
// ---------------------------------------------------------------------------

type PrimaryAction = "cancel" | "resume";

export function getPrimaryAction(item: EnrichedQueueItem): PrimaryAction {
  if (item.last_completed_action === "cancel") {
    return "resume";
  }
  // last_completed_action is "resume", null, or there is no history
  return "cancel";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SortableQueueItem({
  item,
  pinned,
  expandedPanel,
  overrideAction,
  onExpandPanel,
  onUpdateCredentials,
  onRequestAction,
  onRemoveService,
  credentialEmail,
  credentialLoading,
  credentialError,
  updatingCredentials,
  requestingAction,
  removingService,
  userDebtSats,
  actionError,
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
  const primaryAction = getPrimaryAction(item);
  const debtBlocked = (userDebtSats ?? 0) > 0;

  // The action to use in the confirm panel: override (from overflow) or primary
  const confirmAction: "cancel" | "resume" = overrideAction ?? primaryAction;

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
  // Action button or status indicator (right side, desktop only)
  // ---------------------------------------------------------------------------

  function renderActionArea() {
    if (hasActive) {
      // Status shown on secondary line; nothing on the right
      return null;
    }

    if (debtBlocked) {
      return (
        <span className="text-xs text-muted/50 shrink-0">
          Clear balance first
        </span>
      );
    }

    const isCancel = primaryAction === "cancel";
    return (
      <button
        type="button"
        onClick={() => onExpandPanel("confirm-action")}
        className={`text-xs font-medium px-2.5 py-1 rounded border shrink-0 transition-colors ${
          isCancel ? ACTION_STYLES.cancel : ACTION_STYLES.resume
        }`}
      >
        {isCancel ? "Cancel" : "Resume"}
      </button>
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

        {/* Action button area (desktop) */}
        <div className="hidden sm:flex items-center shrink-0">
          {renderActionArea()}
        </div>

        {/* Overflow menu */}
        <QueueItemOverflowMenu
          onUpdateCredentials={() => onExpandPanel("credentials")}
          onRequestCancel={() => onExpandPanel("confirm-action", "cancel")}
          onRequestResume={() => onExpandPanel("confirm-action", "resume")}
          onRemoveService={() => onExpandPanel("remove")}
          hasActiveJob={hasActive}
        />
      </div>

      {/* Mobile action button (below primary row, above panels) */}
      {!hasActive && !debtBlocked && !expandedPanel && (
        <div className="sm:hidden px-4 pb-3">
          {(() => {
            const isCancel = primaryAction === "cancel";
            return (
              <button
                type="button"
                onClick={() => onExpandPanel("confirm-action")}
                className={`w-full text-xs font-medium px-2.5 py-1.5 rounded border transition-colors ${
                  isCancel ? ACTION_STYLES.cancel : ACTION_STYLES.resume
                }`}
              >
                {isCancel ? "Cancel subscription" : "Resume subscription"}
              </button>
            );
          })()}
        </div>
      )}
      {!hasActive && debtBlocked && !expandedPanel && (
        <div className="sm:hidden px-4 pb-3">
          <span className="text-xs text-muted/50">Clear balance first</span>
        </div>
      )}

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

      {expandedPanel === "confirm-action" && (
        <ActionConfirmPanel
          serviceName={item.service_name}
          action={confirmAction}
          planName={item.plan_name}
          onConfirm={() => onRequestAction(item.service_id, confirmAction)}
          onCancel={() => onExpandPanel(null)}
          loading={requestingAction}
          error={actionError}
        />
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
