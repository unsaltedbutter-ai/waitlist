import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/agent-auth", () => ({
  withAgentAuth: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params
        ? await segmentData.params
        : undefined;
      return handler(req, { body: "", params });
    };
  }),
}));

import { query } from "@/lib/db";
import { GET } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/agent/waitlist/pending-invites", {
    method: "GET",
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/agent/waitlist/pending-invites", () => {
  it("returns pending invite entries", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { id: "uuid-1", nostr_npub: "aabb", invite_code: "CODE1" },
        { id: "uuid-2", nostr_npub: "ccdd", invite_code: "CODE2" },
      ])
    );

    const req = makeRequest();
    const res = await GET(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pending).toHaveLength(2);
    expect(data.pending[0].id).toBe("uuid-1");
    expect(data.pending[0].nostr_npub).toBe("aabb");
    expect(data.pending[0].invite_code).toBe("CODE1");
    expect(data.pending[1].id).toBe("uuid-2");
  });

  it("returns empty array when none pending", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest();
    const res = await GET(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pending).toEqual([]);
  });

  it("queries with correct WHERE conditions", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest();
    await GET(req as any, { params: Promise.resolve({}) });

    const sql = vi.mocked(query).mock.calls[0][0] as string;
    expect(sql).toContain("invite_dm_pending = TRUE");
    expect(sql).toContain("nostr_npub IS NOT NULL");
    expect(sql).toContain("invite_code IS NOT NULL");
  });

  it("returns 500 on db error", async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error("db down"));

    const req = makeRequest();
    const res = await GET(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(500);
  });
});
