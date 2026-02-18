import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/agent-auth", () => ({
  withAgentAuth: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const body = await req.text();
      const params = segmentData?.params
        ? await segmentData.params
        : undefined;
      return handler(req, { body, params });
    };
  }),
}));

import { query } from "@/lib/db";
import { POST } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/agent/waitlist/uuid-1/dm-sent", {
    method: "POST",
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("POST /api/agent/waitlist/[id]/dm-sent", () => {
  it("marks invite dm as sent", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "uuid-1" }])
    );

    const req = makeRequest();
    const res = await POST(req as any, {
      params: Promise.resolve({ id: "uuid-1" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain("UPDATE waitlist");
    expect(sql).toContain("invite_dm_pending = FALSE");
    expect(params![0]).toBe("uuid-1");
  });

  it("returns 404 when entry not found", async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: "UPDATE",
      oid: 0,
      fields: [],
    } as any);

    const req = makeRequest();
    const res = await POST(req as any, {
      params: Promise.resolve({ id: "nonexistent" }),
    });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/Not found/);
  });

  it("returns 500 on db error", async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error("db down"));

    const req = makeRequest();
    const res = await POST(req as any, {
      params: Promise.resolve({ id: "uuid-1" }),
    });

    expect(res.status).toBe(500);
  });
});
