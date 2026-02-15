import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

vi.mock("@/lib/btc-price", () => ({
  satsToUsdCents: vi.fn((sats: number) => Math.round(sats / 10)),
}));

import { query } from "@/lib/db";
import { GET } from "../route";

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/membership-pricing", () => {
  it("returns all pricing rows with approx USD", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { plan: "duo", period: "annual", price_sats: 5850 },
        { plan: "duo", period: "monthly", price_sats: 7300 },
        { plan: "solo", period: "annual", price_sats: 3500 },
        { plan: "solo", period: "monthly", price_sats: 4400 },
      ])
    );

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.pricing).toHaveLength(4);
    expect(data.pricing[0]).toEqual({
      plan: "duo",
      period: "annual",
      price_sats: 5850,
      approx_usd_cents: 585,
    });
    expect(data.pricing[3]).toEqual({
      plan: "solo",
      period: "monthly",
      price_sats: 4400,
      approx_usd_cents: 440,
    });
  });

  it("returns empty array when no pricing configured", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.pricing).toEqual([]);
  });
});
