import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  withAuth: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params
        ? await segmentData.params
        : undefined;
      return handler(req, { userId: "test-user", params });
    };
  }),
}));

import { query } from "@/lib/db";
import { GET } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/debt");
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/debt", () => {
  it("returns debt details with reneged jobs", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(mockQueryResult([{ debt_sats: 6000 }]))
      .mockResolvedValueOnce(
        mockQueryResult([
          {
            id: "job-1",
            service_name: "Netflix",
            action: "cancel",
            amount_sats: 3000,
            status_updated_at: "2026-02-10T00:00:00Z",
          },
          {
            id: "job-2",
            service_name: "Hulu",
            action: "resume",
            amount_sats: 3000,
            status_updated_at: "2026-02-12T00:00:00Z",
          },
        ])
      );

    const res = await GET(makeRequest() as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.debt_sats).toBe(6000);
    expect(data.reneged_jobs).toHaveLength(2);
    expect(data.reneged_jobs[0].service_name).toBe("Netflix");
    expect(data.reneged_jobs[1].action).toBe("resume");
  });

  it("returns zero debt with empty jobs array", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(mockQueryResult([{ debt_sats: 0 }]))
      .mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest() as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.debt_sats).toBe(0);
    expect(data.reneged_jobs).toEqual([]);
  });

  it("returns 404 when user not found", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(mockQueryResult([]))
      .mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest() as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
  });

  it("queries jobs with completed_reneged status", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(mockQueryResult([{ debt_sats: 3000 }]))
      .mockResolvedValueOnce(mockQueryResult([]));

    await GET(makeRequest() as any, { params: Promise.resolve({}) });

    const [jobSql, jobParams] = vi.mocked(query).mock.calls[1];
    expect(jobSql).toContain("completed_reneged");
    expect(jobSql).toContain("ORDER BY j.status_updated_at DESC");
    expect(jobParams).toEqual(["test-user"]);
  });
});
