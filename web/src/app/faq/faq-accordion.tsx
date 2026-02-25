"use client";

import { useState } from "react";

interface FaqItem {
  id: string;
  question: string;
  answer: string;
}

export function FaqAccordion({ items }: { items: FaqItem[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  function toggle(id: string) {
    setOpenId(openId === id ? null : id);
  }

  return (
    <div className="bg-surface border border-border rounded divide-y divide-border">
      {items.map((item) => {
        const isOpen = openId === item.id;
        return (
          <div key={item.id}>
            <button
              type="button"
              onClick={() => toggle(item.id)}
              aria-expanded={isOpen}
              aria-controls={`faq-panel-${item.id}`}
              className="w-full flex items-center justify-between py-4 px-5 text-left text-foreground hover:text-accent transition-colors"
            >
              <span className="font-medium pr-4">{item.question}</span>
              <span
                className={`text-muted text-xl leading-none flex-shrink-0 transition-transform duration-200 ${isOpen ? "rotate-45" : ""}`}
              >
                +
              </span>
            </button>
            {isOpen && (
              <div
                id={`faq-panel-${item.id}`}
                role="region"
                aria-labelledby={`faq-btn-${item.id}`}
                className="px-5 pb-4 text-muted text-sm leading-relaxed"
              >
                {item.answer.split("\n").map((para, i) => (
                  <p key={i} className={i > 0 ? "mt-3" : ""}>{para}</p>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
