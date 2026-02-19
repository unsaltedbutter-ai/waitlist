"use client";

interface ActionConfirmPanelProps {
  serviceName: string;
  action: "cancel" | "resume";
  planName?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  error?: string;
}

export function ActionConfirmPanel({
  serviceName,
  action,
  planName,
  onConfirm,
  onCancel,
  loading,
  error,
}: ActionConfirmPanelProps) {
  const isCancel = action === "cancel";

  return (
    <div className="border-t border-border px-4 py-3 space-y-3">
      <p className="text-sm text-foreground">
        {isCancel
          ? `Cancel ${serviceName}? You will be billed 3,000 sats after the cancellation completes.`
          : `Resume ${serviceName}? You will be billed 3,000 sats after the subscription is reactivated.`}
      </p>

      {!isCancel && planName && (
        <p className="text-xs text-muted">
          We will reactivate your subscription using the plan in your queue ({planName}).
        </p>
      )}

      <p className="text-xs text-muted">
        You may need to provide a verification code via Nostr DM during the process.
      </p>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={loading}
          className={`py-1.5 px-3 text-sm font-medium rounded transition-colors disabled:opacity-50 ${
            isCancel
              ? "bg-amber-800 text-amber-200 hover:bg-amber-700"
              : "bg-blue-800 text-blue-200 hover:bg-blue-700"
          }`}
        >
          {loading
            ? "Submitting..."
            : isCancel
              ? "Confirm cancel"
              : "Confirm resume"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          className="py-1.5 px-3 bg-surface border border-border text-foreground text-sm rounded hover:border-muted transition-colors"
        >
          Nevermind
        </button>
      </div>
    </div>
  );
}
