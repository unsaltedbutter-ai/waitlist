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
import { PATCH } from "../route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/operator/services/netflix", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("PATCH /api/operator/services/[id]", () => {
  it("updates fields and writes audit log", async () => {
    // UPDATE
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "netflix", display_name: "Netflix Updated", supported: true }])
    );
    // Audit log
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await PATCH(
      makeRequest({ display_name: "Netflix Updated" }) as any,
      { params: Promise.resolve({ id: "netflix" }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.service.display_name).toBe("Netflix Updated");

    // Verify UPDATE query
    const updateCall = vi.mocked(query).mock.calls[0];
    expect(updateCall[0]).toContain("UPDATE streaming_services");
    expect(updateCall[0]).toContain("display_name");
  });

  it("returns 404 when service not found", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await PATCH(
      makeRequest({ display_name: "Nope" }) as any,
      { params: Promise.resolve({ id: "nonexistent" }) }
    );
    expect(res.status).toBe(404);
  });

  it("toggles supported field", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "netflix", supported: false }])
    );
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await PATCH(
      makeRequest({ supported: false }) as any,
      { params: Promise.resolve({ id: "netflix" }) }
    );
    expect(res.status).toBe(200);

    const updateCall = vi.mocked(query).mock.calls[0];
    expect(updateCall[0]).toContain("supported");
  });

  it("returns 400 when no fields provided", async () => {
    const res = await PATCH(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: "netflix" }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/No fields/);
  });

  it("returns 400 when id param is missing", async () => {
    const res = await PATCH(
      makeRequest({ display_name: "test" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
  });
});
