import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn(),
}));

import { query } from "@/lib/db";
import { authenticateRequest } from "@/lib/auth";
import { GET } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/operator/ledger", {
    method: "GET",
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(authenticateRequest).mockReset();
  vi.stubEnv("OPERATOR_USER_ID", "operator-123");
});

describe("GET /api/operator/ledger", () => {
  it("returns monthly ledger with correct net_flow computation", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("operator-123");
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          month: "2026-02",
          platform_fee_revenue: "0",
          credit_deposits: "1455000",
          gift_card_purchases: "592000",
          refunds: "0",
        },
        {
          month: "2026-01",
          platform_fee_revenue: "50000",
          credit_deposits: "800000",
          gift_card_purchases: "300000",
          refunds: "10000",
        },
      ])
    );

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.months).toHaveLength(2);

    expect(data.months[0]).toEqual({
      month: "2026-02",
      platform_fee_revenue: 0,
      credit_deposits: 1455000,
      gift_card_purchases: 592000,
      refunds: 0,
      net_flow: 863000,
    });

    expect(data.months[1]).toEqual({
      month: "2026-01",
      platform_fee_revenue: 50000,
      credit_deposits: 800000,
      gift_card_purchases: 300000,
      refunds: 10000,
      net_flow: 540000,
    });
  });

  it("returns empty months array when no data", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("operator-123");
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.months).toEqual([]);
  });

  it("non-operator -> 403", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("not-operator");

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/[Ff]orbidden/);
  });

  it("unauthenticated -> 401", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce(null as any);

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toMatch(/[Uu]nauthorized/);
  });
});
