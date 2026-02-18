import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

let mockUserId: string | null = "user-1";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  withAuth: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      if (!mockUserId) {
        const { NextResponse } = await import("next/server");
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const params = segmentData?.params
        ? await segmentData.params
        : undefined;
      return handler(req, { userId: mockUserId, params });
    };
  }),
}));
vi.mock("@/lib/margin-call", () => ({
  getRequiredBalance: vi.fn(),
}));

import { query } from "@/lib/db";
import { getRequiredBalance } from "@/lib/margin-call";
import { GET } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/required-balance", {
    method: "GET",
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(getRequiredBalance).mockReset();
  mockUserId = "user-1";
});

describe("GET /api/required-balance", () => {
  it("returns balance breakdown for user with queued service", async () => {
    // SELECT rotation_queue JOIN streaming_services
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ service_id: "netflix", display_name: "Netflix" }])
    );
    vi.mocked(getRequiredBalance).mockResolvedValueOnce({
      platformFeeSats: 4400,
      giftCardCostSats: 25000,
      totalSats: 29400,
    });
    // SELECT service_credits
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ credit_sats: "10000" }])
    );

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.platform_fee_sats).toBe(4400);
    expect(data.gift_card_cost_sats).toBe(25000);
    expect(data.total_sats).toBe(29400);
    expect(data.credit_sats).toBe(10000);
    expect(data.shortfall_sats).toBe(19400);
    expect(data.next_service_name).toBe("Netflix");
  });

  it("returns zeros when user has no queued services", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.total_sats).toBe(0);
    expect(data.shortfall_sats).toBe(0);
    expect(data.next_service_name).toBeNull();
  });

  it("returns zero shortfall when balance exceeds requirement", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ service_id: "hulu", display_name: "Hulu" }])
    );
    vi.mocked(getRequiredBalance).mockResolvedValueOnce({
      platformFeeSats: 4400,
      giftCardCostSats: 25000,
      totalSats: 29400,
    });
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ credit_sats: "50000" }])
    );

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.shortfall_sats).toBe(0);
    expect(data.credit_sats).toBe(50000);
    expect(data.next_service_name).toBe("Hulu");
  });

  it("requires auth", async () => {
    mockUserId = null;

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );

    expect(res.status).toBe(401);
  });
});
