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
  return new Request("http://localhost/api/agent/jobs/pending", {
    method: "GET",
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/agent/jobs/pending", () => {
  it("returns pending jobs", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          id: "job-1",
          user_id: "user-1",
          service_id: "netflix",
          action: "cancel",
          trigger: "scheduled",
          billing_date: "2026-03-01",
          created_at: "2026-02-15T05:00:00Z",
        },
        {
          id: "job-2",
          user_id: "user-2",
          service_id: "hulu",
          action: "resume",
          trigger: "on_demand",
          billing_date: null,
          created_at: "2026-02-15T05:01:00Z",
        },
      ])
    );

    const res = await GET(makeRequest() as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.jobs).toHaveLength(2);
    expect(data.jobs[0].id).toBe("job-1");
    expect(data.jobs[0].service_id).toBe("netflix");
    expect(data.jobs[1].id).toBe("job-2");
    expect(data.jobs[1].billing_date).toBeNull();
  });

  it("returns empty array when no pending jobs", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest() as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.jobs).toHaveLength(0);
  });

  it("queries for pending status only", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await GET(makeRequest() as any, { params: Promise.resolve({}) });

    expect(query).toHaveBeenCalledOnce();
    const sql = vi.mocked(query).mock.calls[0][0] as string;
    expect(sql).toContain("status = 'pending'");
  });
});
