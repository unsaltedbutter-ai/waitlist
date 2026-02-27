"use client";

import { useState } from "react";

const BOT_NPUB =
  process.env.NEXT_PUBLIC_NOSTR_BOT_NPUB ??
  "npub1hssdvydgqjx9y6ptlkt23sc5uptnqkc3q2r8j68zpdeyt9psl27s534rcr";
const BOT_NAME =
  process.env.NEXT_PUBLIC_NOSTR_BOT_NAME ?? "UnsaltedButter Bot";

export function BotChip() {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(BOT_NPUB).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  return (
    <span className="relative inline-block align-middle">
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex items-center gap-1.5 bg-purple/12 border border-purple/25 rounded-full px-3.5 py-1 text-sm font-semibold text-purple hover:bg-purple/20 active:scale-[0.97] transition-all cursor-pointer"
      >
        <span className="text-xs">&#9889;</span>
        @{BOT_NAME}
      </button>
      <span
        className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-neutral-700 text-foreground text-xs font-medium px-3 py-1 rounded-lg whitespace-nowrap transition-all duration-200 pointer-events-none ${
          copied
            ? "opacity-100 translate-y-0"
            : "opacity-0 translate-y-1"
        }`}
      >
        npub copied!
      </span>
    </span>
  );
}
