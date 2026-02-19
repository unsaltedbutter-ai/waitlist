import { describe, it, expect } from "vitest";
import { getPrimaryAction } from "@/components/sortable-queue-item";
import type { EnrichedQueueItem } from "@/lib/types";

function makeItem(
  overrides: Partial<EnrichedQueueItem> = {},
): EnrichedQueueItem {
  return {
    service_id: "netflix",
    service_name: "Netflix",
    position: 0,
    plan_id: null,
    plan_name: null,
    plan_price_cents: null,
    active_job_id: null,
    active_job_action: null,
    active_job_status: null,
    last_access_end_date: null,
    last_completed_action: null,
    ...overrides,
  };
}

describe("getPrimaryAction", () => {
  it('returns "resume" when last_completed_action is "cancel"', () => {
    const item = makeItem({ last_completed_action: "cancel" });
    expect(getPrimaryAction(item)).toBe("resume");
  });

  it('returns "cancel" when last_completed_action is "resume"', () => {
    const item = makeItem({ last_completed_action: "resume" });
    expect(getPrimaryAction(item)).toBe("cancel");
  });

  it('returns "cancel" when last_completed_action is null', () => {
    const item = makeItem({ last_completed_action: null });
    expect(getPrimaryAction(item)).toBe("cancel");
  });

  it('returns "cancel" when last_completed_action is undefined (missing)', () => {
    // Simulate a response where the field is absent entirely
    const item = makeItem();
    delete (item as Record<string, unknown>)["last_completed_action"];
    expect(getPrimaryAction(item)).toBe("cancel");
  });
});
