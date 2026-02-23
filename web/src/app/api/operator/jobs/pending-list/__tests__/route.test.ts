import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn().mockResolvedValue("operator-user-id"),
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
import { GET } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/operator/jobs/pending-list", {
    method: "GET",
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/operator/jobs/pending-list", () => {
  it("returns pending jobs with user npub", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          id: "j1",
          service_id: "netflix",
          action: "cancel",
          trigger: "outreach",
          status: "pending",
          status_updated_at: "2026-02-22T00:00:00Z",
          created_at: "2026-02-22T00:00:00Z",
          nostr_npub: "a".repeat(64),
        },
        {
          id: "j2",
          service_id: "hulu",
          action: "resume",
          trigger: "on_demand",
          status: "active",
          status_updated_at: "2026-02-22T01:00:00Z",
          created_at: "2026-02-22T01:00:00Z",
          nostr_npub: "b".repeat(64),
        },
      ])
    );

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.jobs).toHaveLength(2);
    expect(data.jobs[0].service_id).toBe("netflix");
    expect(data.jobs[0].nostr_npub).toBe("a".repeat(64));
    expect(data.jobs[1].service_id).toBe("hulu");
  });

  it("returns empty array when no pending jobs", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.jobs).toHaveLength(0);
  });
});
