import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  withAuth: vi.fn((handler: Function) => {
    // Simulate authenticated route: pass userId, resolve params promise
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params
        ? await segmentData.params
        : undefined;
      return handler(req, { userId: "test-user", params });
    };
  }),
}));

import { query, transaction } from "@/lib/db";
import { PUT } from "../route";

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/queue", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(transaction).mockReset();
});

describe("PUT /api/queue (reorder)", () => {
  it("valid reorder → success", async () => {
    // Existing queue
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { service_id: "netflix" },
        { service_id: "hulu" },
        { service_id: "disney" },
      ])
    );

    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
      return cb(txQuery as any);
    });

    const req = makeRequest({ order: ["disney", "netflix", "hulu"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("duplicate IDs → 400", async () => {
    const req = makeRequest({ order: ["netflix", "netflix", "hulu"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/[Dd]uplicate/);
  });

  it("unknown service → 400", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ service_id: "netflix" }, { service_id: "hulu" }])
    );

    const req = makeRequest({ order: ["netflix", "fake_service"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/not in your queue/);
  });

  it("missing services (partial order) → 400", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { service_id: "netflix" },
        { service_id: "hulu" },
        { service_id: "disney" },
      ])
    );

    const req = makeRequest({ order: ["netflix", "hulu"] }); // missing disney
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/all services/i);
  });

  it("empty order → 400", async () => {
    const req = makeRequest({ order: [] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("invalid JSON → 400", async () => {
    const req = new Request("http://localhost/api/queue", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });
});
