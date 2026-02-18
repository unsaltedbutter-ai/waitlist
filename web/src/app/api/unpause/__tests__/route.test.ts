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
vi.mock("@/lib/orchestrator-notify", () => ({
  notifyOrchestrator: vi.fn(),
}));

import { query } from "@/lib/db";
import { getRequiredBalance } from "@/lib/margin-call";
import { notifyOrchestrator } from "@/lib/orchestrator-notify";
import { POST } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/unpause", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(getRequiredBalance).mockReset();
  vi.mocked(notifyOrchestrator).mockReset();
  vi.mocked(notifyOrchestrator).mockResolvedValue(undefined);
  mockUserId = "user-1";
});

describe("POST /api/unpause", () => {
  it("activates paused user with sufficient balance", async () => {
    // SELECT status, onboarded_at
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "paused", onboarded_at: "2025-01-01" }])
    );
    // SELECT rotation_queue (next service)
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ service_id: "netflix" }])
    );
    // getRequiredBalance
    vi.mocked(getRequiredBalance).mockResolvedValueOnce({
      platformFeeSats: 4400,
      giftCardCostSats: 20000,
      totalSats: 24400,
    });
    // SELECT service_credits
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ credit_sats: "30000" }])
    );
    // UPDATE users to active
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // SELECT subscriptions (check for active sub)
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(notifyOrchestrator).toHaveBeenCalledWith("user-1");
  });

  it("returns 402 with shortfall when insufficient balance", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "paused", onboarded_at: "2025-01-01" }])
    );
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ service_id: "netflix" }])
    );
    vi.mocked(getRequiredBalance).mockResolvedValueOnce({
      platformFeeSats: 4400,
      giftCardCostSats: 20000,
      totalSats: 24400,
    });
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ credit_sats: "5000" }])
    );
    // UPDATE users to auto_paused
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    const data = await res.json();

    expect(res.status).toBe(402);
    expect(data.shortfall_sats).toBe(19400);
    expect(data.platform_fee_sats).toBe(4400);
    expect(data.gift_card_cost_sats).toBe(20000);
    expect(notifyOrchestrator).not.toHaveBeenCalled();
  });

  it("does not notify orchestrator when active sub exists", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "paused", onboarded_at: "2025-01-01" }])
    );
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ service_id: "hulu" }])
    );
    vi.mocked(getRequiredBalance).mockResolvedValueOnce({
      platformFeeSats: 4400,
      giftCardCostSats: 20000,
      totalSats: 24400,
    });
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ credit_sats: "50000" }])
    );
    // UPDATE users
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // SELECT subscriptions: active sub exists
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "sub-1" }])
    );

    const res = await POST(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );

    expect(res.status).toBe(200);
    expect(notifyOrchestrator).not.toHaveBeenCalled();
  });

  it("rejects unpause from non-paused state", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "active", onboarded_at: "2025-01-01" }])
    );

    const res = await POST(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );

    expect(res.status).toBe(409);
  });

  it("activates auto_paused user with sufficient balance", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "auto_paused", onboarded_at: "2025-01-01" }])
    );
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ service_id: "netflix" }])
    );
    vi.mocked(getRequiredBalance).mockResolvedValueOnce({
      platformFeeSats: 4400,
      giftCardCostSats: 25000,
      totalSats: 29400,
    });
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ credit_sats: "35000" }])
    );
    // UPDATE users to active
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // SELECT subscriptions
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(notifyOrchestrator).toHaveBeenCalledWith("user-1");
  });

  it("rejects auto_paused user who has not completed onboarding", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "auto_paused", onboarded_at: null }])
    );

    const res = await POST(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toBe("Complete onboarding first");
  });

  it("requires auth", async () => {
    mockUserId = null;

    const res = await POST(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );

    expect(res.status).toBe(401);
  });
});
