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
  };
  const netflixPremium = {
    id: "netflix-premium",
    service_id: "netflix",
    display_name: "Premium",
    monthly_price_cents: 2299,
    has_ads: false,
    is_bundle: false,
  };
  const huluBasic = {
    id: "hulu-basic",
    service_id: "hulu",
    display_name: "Hulu (With Ads)",
    monthly_price_cents: 999,
    has_ads: true,
    is_bundle: false,
  };

  it("returns plans grouped by service_id", async () => {
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

  it("uses service_id as label fallback for unknown services", async () => {
    const unknownPlan = {
      id: "mystery-plan",
      service_id: "mystery_service",
      display_name: "Unknown Plan",
      monthly_price_cents: 499,
      has_ads: false,
      is_bundle: false,
    };
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([unknownPlan]));

    const res = await GET();
    const data = await res.json();

    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].label).toBe("mystery_service");
    expect(data.groups[0].id).toBe("mystery_service");
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

  it("queries only active plans ordered by display_order", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await GET();

    expect(query).toHaveBeenCalledOnce();
    const sql = vi.mocked(query).mock.calls[0][0] as string;
    expect(sql).toContain("active = TRUE");
    expect(sql).toContain("ORDER BY display_order");
  });

  it("maps all known service labels correctly", async () => {
    const services = [
      { service_id: "netflix", expectedLabel: "Netflix" },
      { service_id: "hulu", expectedLabel: "Hulu" },
      { service_id: "disney_plus", expectedLabel: "Disney+" },
      { service_id: "max", expectedLabel: "Max" },
      { service_id: "paramount", expectedLabel: "Paramount+" },
      { service_id: "peacock", expectedLabel: "Peacock" },
      { service_id: "apple_tv", expectedLabel: "Apple TV+" },
    ];

    const rows = services.map((s) => ({
      id: `${s.service_id}-plan`,
      service_id: s.service_id,
      display_name: "Plan",
      monthly_price_cents: 999,
      has_ads: false,
      is_bundle: false,
    }));

    vi.mocked(query).mockResolvedValueOnce(mockQueryResult(rows));

    const res = await GET();
    const data = await res.json();

    for (const svc of services) {
      const group = data.groups.find(
        (g: { id: string }) => g.id === svc.service_id
      );
      expect(group.label).toBe(svc.expectedLabel);
    }
  });
});
