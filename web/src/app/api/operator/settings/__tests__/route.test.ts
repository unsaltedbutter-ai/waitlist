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
import { GET, PATCH } from "../route";

function makeRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/operator/settings", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/operator/settings", () => {
  it("returns parsed action_price_sats", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ value: "5000" }])
    );

    const res = await GET(makeRequest("GET") as any, {});
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action_price_sats).toBe(5000);
  });

  it("returns 3000 fallback when no row exists", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest("GET") as any, {});
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action_price_sats).toBe(3000);
  });

  it("returns 3000 fallback for invalid stored value", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ value: "not_a_number" }])
    );

    const res = await GET(makeRequest("GET") as any, {});
    const data = await res.json();
    expect(data.action_price_sats).toBe(3000);
  });
});

describe("PATCH /api/operator/settings", () => {
  it("updates action_price_sats and writes audit log", async () => {
    // UPDATE
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Audit log
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await PATCH(
      makeRequest("PATCH", { action_price_sats: 5000 }) as any,
      {}
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action_price_sats).toBe(5000);

    // Verify UPDATE was called
    const updateCall = vi.mocked(query).mock.calls[0];
    expect(updateCall[0]).toContain("UPDATE operator_settings");
    expect(updateCall[1]).toEqual(["5000"]);

    // Verify audit log
    const auditCall = vi.mocked(query).mock.calls[1];
    expect(auditCall[0]).toContain("operator_audit_log");
  });

  it("returns 400 for non-integer value", async () => {
    const res = await PATCH(
      makeRequest("PATCH", { action_price_sats: 3000.5 }) as any,
      {}
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for zero", async () => {
    const res = await PATCH(
      makeRequest("PATCH", { action_price_sats: 0 }) as any,
      {}
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for negative", async () => {
    const res = await PATCH(
      makeRequest("PATCH", { action_price_sats: -100 }) as any,
      {}
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for value exceeding ceiling", async () => {
    const res = await PATCH(
      makeRequest("PATCH", { action_price_sats: 1_000_001 }) as any,
      {}
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for string value", async () => {
    const res = await PATCH(
      makeRequest("PATCH", { action_price_sats: "3000" }) as any,
      {}
    );
    expect(res.status).toBe(400);
  });

  it("accepts value at ceiling (1,000,000)", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await PATCH(
      makeRequest("PATCH", { action_price_sats: 1_000_000 }) as any,
      {}
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action_price_sats).toBe(1_000_000);
  });
});
