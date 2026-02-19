import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/operator-auth", () => ({
  withOperator: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params ? await segmentData.params : undefined;
      return handler(req, { userId: "operator-user-id", params });
    };
  }),
}));

import { query } from "@/lib/db";
import { GET, POST } from "../route";

function makeRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/operator/plans", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/operator/plans", () => {
  it("returns all plans with service display name", async () => {
    const plans = [
      { id: "netflix_standard", service_id: "netflix", display_name: "Standard", service_display_name: "Netflix" },
      { id: "hulu_basic", service_id: "hulu", display_name: "Basic", service_display_name: "Hulu" },
    ];
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult(plans));

    const res = await GET(makeRequest("GET") as any, {});
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.plans).toHaveLength(2);
    expect(data.plans[0].service_display_name).toBe("Netflix");
  });

  it("queries with JOIN on streaming_services", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await GET(makeRequest("GET") as any, {});

    const sql = vi.mocked(query).mock.calls[0][0] as string;
    expect(sql).toContain("JOIN streaming_services");
    expect(sql).toContain("service_display_name");
  });
});

describe("POST /api/operator/plans", () => {
  it("creates plan with compound id", async () => {
    // Service check
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "netflix" }]));
    // Duplicate check
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // INSERT
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "netflix_ultra", display_name: "Ultra", service_id: "netflix" }])
    );
    // Audit log
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest("POST", {
        service_id: "netflix",
        display_name: "Ultra",
        monthly_price_cents: 2999,
      }) as any,
      {}
    );
    expect(res.status).toBe(201);

    // Verify compound id
    const insertCall = vi.mocked(query).mock.calls[2];
    expect(insertCall[1]![0]).toBe("netflix_ultra");
  });

  it("returns 400 when service_id does not exist", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest("POST", {
        service_id: "nonexistent",
        display_name: "Plan",
        monthly_price_cents: 999,
      }) as any,
      {}
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/service_id/);
  });

  it("returns 400 when display_name is missing", async () => {
    const res = await POST(
      makeRequest("POST", {
        service_id: "netflix",
        monthly_price_cents: 999,
      }) as any,
      {}
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when monthly_price_cents is negative", async () => {
    const res = await POST(
      makeRequest("POST", {
        service_id: "netflix",
        display_name: "Bad Plan",
        monthly_price_cents: -100,
      }) as any,
      {}
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 on duplicate plan id", async () => {
    // Service check
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "netflix" }]));
    // Duplicate check
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "netflix_standard" }]));

    const res = await POST(
      makeRequest("POST", {
        service_id: "netflix",
        display_name: "Standard",
        monthly_price_cents: 1799,
      }) as any,
      {}
    );
    expect(res.status).toBe(409);
  });

  it("accepts zero price", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "netflix" }]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "netflix_free", display_name: "Free" }])
    );
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest("POST", {
        service_id: "netflix",
        display_name: "Free",
        monthly_price_cents: 0,
      }) as any,
      {}
    );
    expect(res.status).toBe(201);
  });
});
