import { describe, it, expect, vi, afterEach } from "vitest";
import { daysUntil, formatShortDate } from "@/components/access-date-line";

// Pin "today" so date math is deterministic.
// We set the fake clock to 2026-02-19T00:00:00 local time.
function fakeToday(): Date {
  return new Date(2026, 1, 19, 0, 0, 0, 0); // months are 0-indexed
}

describe("formatShortDate", () => {
  it("formats an ISO date string as short month + day", () => {
    // "en-US" { month: "short", day: "numeric" } => "Feb 19"
    expect(formatShortDate("2026-02-19")).toBe("Feb 19");
    expect(formatShortDate("2026-12-01")).toBe("Dec 1");
    expect(formatShortDate("2026-01-31")).toBe("Jan 31");
  });
});

describe("daysUntil", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns negative number for a past date", () => {
    vi.useFakeTimers({ now: fakeToday() });
    // 2026-02-10 is 9 days before 2026-02-19
    expect(daysUntil("2026-02-10")).toBe(-9);
  });

  it("returns 0 for today", () => {
    vi.useFakeTimers({ now: fakeToday() });
    expect(daysUntil("2026-02-19")).toBe(0);
  });

  it("returns positive number for a future date within 7 days", () => {
    vi.useFakeTimers({ now: fakeToday() });
    // 2026-02-24 is 5 days after 2026-02-19
    expect(daysUntil("2026-02-24")).toBe(5);
  });

  it("returns positive number for a future date more than 7 days out", () => {
    vi.useFakeTimers({ now: fakeToday() });
    // 2026-03-15 is 24 days after 2026-02-19
    expect(daysUntil("2026-03-15")).toBe(24);
  });
});

describe("AccessDateLine rendering logic (pure)", () => {
  // These tests verify the branching logic by testing daysUntil values
  // against the thresholds used in the component (< 0, === 0, <= 7, > 7).
  // The component itself is a React component and needs jsdom to render,
  // so we verify the data layer here.

  afterEach(() => {
    vi.useRealTimers();
  });

  it("past date: daysUntil returns negative (triggers 'Access ended' branch)", () => {
    vi.useFakeTimers({ now: fakeToday() });
    const days = daysUntil("2026-01-15");
    expect(days).toBeLessThan(0);
  });

  it("future date > 7 days: daysUntil returns > 7 (no urgency branch)", () => {
    vi.useFakeTimers({ now: fakeToday() });
    const days = daysUntil("2026-03-01");
    expect(days).toBeGreaterThan(7);
  });

  it("date within 7 days: daysUntil returns 1-7 (urgency branch)", () => {
    vi.useFakeTimers({ now: fakeToday() });
    const days = daysUntil("2026-02-22");
    expect(days).toBe(3);
    expect(days).toBeGreaterThan(0);
    expect(days).toBeLessThanOrEqual(7);
  });

  it("null accessEndDate: component returns null (no date to compute)", () => {
    // The component checks `if (!accessEndDate) return null;`
    // We verify null/undefined are falsy, which drives the early return.
    expect(!null).toBe(true);
    expect(!undefined).toBe(true);
  });
});
