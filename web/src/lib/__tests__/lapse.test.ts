import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { query } from "@/lib/db";
import { estimateLapseDate, selectDenomination } from "@/lib/lapse";

beforeEach(() => {
  vi.mocked(query).mockReset();
});

// Use local-time Date constructors to avoid UTC parsing → local time shifts
function localDate(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d);
}
function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("estimateLapseDate", () => {
  it("proportional: $25 card / $15.49 service ≈ 48 days", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { monthlyPriceCents: 1549, lapseCalculation: "proportional" },
      ])
    );

    const signup = localDate(2025, 1, 1);
    const lapse = await estimateLapseDate("netflix", 2500, signup);
    // 2500/1549 * 30 = 48.41 → floor = 48 days → Feb 18
    const expected = localDate(2025, 1, 1);
    expected.setDate(expected.getDate() + 48);
    expect(fmt(lapse)).toBe(fmt(expected));
  });

  it("proportional: exact one month ($15.49 card / $15.49 service = 30 days)", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { monthlyPriceCents: 1549, lapseCalculation: "proportional" },
      ])
    );

    const signup = localDate(2025, 3, 1);
    const lapse = await estimateLapseDate("netflix", 1549, signup);
    // 1549/1549 * 30 = 30 → Mar 1 + 30 = Mar 31
    expect(fmt(lapse)).toBe("2025-03-31");
  });

  it("proportional: $0 card → 0 days (same date)", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { monthlyPriceCents: 1549, lapseCalculation: "proportional" },
      ])
    );

    const signup = localDate(2025, 6, 15);
    const lapse = await estimateLapseDate("netflix", 0, signup);
    expect(fmt(lapse)).toBe("2025-06-15");
  });

  it("calendar_month: 2 full months + partial", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { monthlyPriceCents: 1000, lapseCalculation: "calendar_month" },
      ])
    );

    // $25 card, $10/mo → 2 full months + $5 remaining
    // Signup Jan 15 → Feb 15 → Mar 15. Remaining = 500.
    // March has 31 days, floor(500/1000 * 31) = floor(15.5) = 15
    // Mar 15 + 15 = Mar 30
    const signup = localDate(2025, 1, 15);
    const lapse = await estimateLapseDate("hulu", 2500, signup);
    expect(fmt(lapse)).toBe("2025-03-30");
  });

  it("calendar_month: exact multiple of price → no partial", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { monthlyPriceCents: 1000, lapseCalculation: "calendar_month" },
      ])
    );

    // $30 / $10/mo = 3 full months, 0 remaining
    // Jan 1 → Feb 1 → Mar 1 → Apr 1
    const signup = localDate(2025, 1, 1);
    const lapse = await estimateLapseDate("hulu", 3000, signup);
    expect(fmt(lapse)).toBe("2025-04-01");
  });

  it("unknown service throws", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await expect(
      estimateLapseDate("fake_service", 2500, new Date())
    ).rejects.toThrow("not found");
  });
});

describe("selectDenomination", () => {
  it("picks smallest denomination covering 28 days", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          monthly_price_cents: 1549,
          gift_card_denominations_cents: [1500, 2500, 5000],
        },
      ])
    );

    // minAmount = ceil(1549/30 * 28) = ceil(1445.73) = 1446
    // Smallest >= 1446 is 1500
    const denom = await selectDenomination("netflix");
    expect(denom).toBe(1500);
  });

  it("picks largest if none cover 28 days", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          monthly_price_cents: 5000,
          gift_card_denominations_cents: [1000, 2000],
        },
      ])
    );

    // minAmount = ceil(5000/30 * 28) = ceil(4666.67) = 4667
    // Neither 1000 nor 2000 >= 4667, so pick largest = 2000
    const denom = await selectDenomination("expensive");
    expect(denom).toBe(2000);
  });

  it("unknown service throws", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    await expect(selectDenomination("fake")).rejects.toThrow("not found");
  });

  it("no denominations configured throws", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          monthly_price_cents: 1549,
          gift_card_denominations_cents: [],
        },
      ])
    );

    await expect(selectDenomination("netflix")).rejects.toThrow(
      "No gift card denominations"
    );
  });
});
