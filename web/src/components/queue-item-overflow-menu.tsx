"use client";

import { useState, useEffect, useRef } from "react";

interface QueueItemOverflowMenuProps {
  onUpdateCredentials: () => void;
  onRemoveService?: () => void;
  hasActiveJob: boolean;
}

export function QueueItemOverflowMenu({
  onUpdateCredentials,
  onRemoveService,
  hasActiveJob,
}: QueueItemOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  function handleAction(fn: () => void) {
    setOpen(false);
    fn();
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="p-1.5 text-muted/60 hover:text-muted transition-colors rounded"
        aria-label="More options"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-48 bg-surface border border-border rounded shadow-lg py-1">
          <button
            type="button"
            onClick={() => handleAction(onUpdateCredentials)}
            className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-border/30 transition-colors"
          >
            Change credentials
          </button>
          {onRemoveService && !hasActiveJob && (
            <>
              <div className="border-t border-border my-1" />
              <button
                type="button"
                onClick={() => handleAction(onRemoveService)}
                className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-border/30 transition-colors"
              >
                Remove service
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
