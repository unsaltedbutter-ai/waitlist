import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { query } from "@/lib/db";
import { GET } from "../route";

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/service-plans", () => {
  const netflixBasic = {
    id: "netflix-basic",
    service_id: "netflix",
    display_name: "Standard with Ads",
    monthly_price_cents: 699,
    has_ads: true,
    is_bundle: false,
    service_display_name: "Netflix",
  };
  const netflixPremium = {
    id: "netflix-premium",
    service_id: "netflix",
    display_name: "Premium",
    monthly_price_cents: 2299,
    has_ads: false,
    is_bundle: false,
    service_display_name: "Netflix",
  };
  const huluBasic = {
    id: "hulu-basic",
    service_id: "hulu",
    display_name: "Hulu (With Ads)",
    monthly_price_cents: 999,
    has_ads: true,
    is_bundle: false,
    service_display_name: "Hulu",
  };

  it("returns plans grouped by service_id with display_name from JOIN", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([netflixBasic, netflixPremium, huluBasic])
    );

    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.groups).toHaveLength(2);

    const netflix = data.groups.find(
      (g: { id: string }) => g.id === "netflix"
    );
    expect(netflix).toBeDefined();
    expect(netflix.label).toBe("Netflix");
    expect(netflix.serviceId).toBe("netflix");
    expect(netflix.plans).toHaveLength(2);

    const hulu = data.groups.find((g: { id: string }) => g.id === "hulu");
    expect(hulu).toBeDefined();
    expect(hulu.label).toBe("Hulu");
    expect(hulu.plans).toHaveLength(1);
  });

  it("returns empty groups array when no plans exist", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.groups).toEqual([]);
  });

  it("preserves plan fields in each group", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([netflixBasic]));

    const res = await GET();
    const data = await res.json();
    const plan = data.groups[0].plans[0];

    expect(plan.id).toBe("netflix-basic");
    expect(plan.display_name).toBe("Standard with Ads");
    expect(plan.monthly_price_cents).toBe(699);
    expect(plan.has_ads).toBe(true);
    expect(plan.is_bundle).toBe(false);
  });

  it("queries with JOIN on streaming_services filtering active and supported", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await GET();

    expect(query).toHaveBeenCalledOnce();
    const sql = vi.mocked(query).mock.calls[0][0] as string;
    expect(sql).toContain("active = TRUE");
    expect(sql).toContain("supported = TRUE");
    expect(sql).toContain("JOIN streaming_services");
    expect(sql).toContain("ORDER BY");
  });
});
