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
  return new Request("http://localhost/api/me");
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/me", () => {
  const mockUser = {
    id: "test-user",
    nostr_npub: "npub1abc123",
    debt_sats: 0,
    onboarded_at: "2026-01-15T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-15T00:00:00Z",
  };

  const mockJobs = [
    {
      id: "job-1",
      service_name: "Netflix",
      flow_type: "cancel",
      status: "completed_paid",
      completed_at: "2026-01-20T00:00:00Z",
      created_at: "2026-01-19T00:00:00Z",
    },
  ];

  it("returns user profile with correct shape", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(mockQueryResult([mockUser]))
      .mockResolvedValueOnce(mockQueryResult(mockJobs));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({ ...mockUser, recent_jobs: mockJobs });
  });

  it("returns all expected fields", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(mockQueryResult([mockUser]))
      .mockResolvedValueOnce(mockQueryResult(mockJobs));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    expect(data).toHaveProperty("id");
    expect(data).toHaveProperty("nostr_npub");
    expect(data).toHaveProperty("debt_sats");
    expect(data).toHaveProperty("onboarded_at");
    expect(data).toHaveProperty("created_at");
    expect(data).toHaveProperty("updated_at");
    expect(data).toHaveProperty("recent_jobs");
    // v4: no email, status, or paused_at
    expect(data).not.toHaveProperty("email");
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("paused_at");
  });

  it("queries with correct userId parameter", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(mockQueryResult([mockUser]))
      .mockResolvedValueOnce(mockQueryResult([]));

    await GET(makeRequest() as any, { params: Promise.resolve({}) });

    expect(query).toHaveBeenCalledTimes(2);
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain("FROM users WHERE id = $1");
    expect(params).toEqual(["test-user"]);
  });

  it("returns 404 when user is not found", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(mockQueryResult([]))
      .mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/not found/i);
  });

  it("handles user with null optional fields", async () => {
    const partialUser = {
      ...mockUser,
      onboarded_at: null,
    };
    vi.mocked(query)
      .mockResolvedValueOnce(mockQueryResult([partialUser]))
      .mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.onboarded_at).toBeNull();
    expect(data.recent_jobs).toEqual([]);
  });

  it("returns recent_jobs from jobs query", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(mockQueryResult([mockUser]))
      .mockResolvedValueOnce(mockQueryResult(mockJobs));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();
    expect(data.recent_jobs).toHaveLength(1);
    expect(data.recent_jobs[0].service_name).toBe("Netflix");
    expect(data.recent_jobs[0].flow_type).toBe("cancel");
    expect(data.recent_jobs[0].status).toBe("completed_paid");
  });

  it("queries jobs ordered by created_at DESC with limit 10", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(mockQueryResult([mockUser]))
      .mockResolvedValueOnce(mockQueryResult([]));

    await GET(makeRequest() as any, { params: Promise.resolve({}) });

    const [jobSql, jobParams] = vi.mocked(query).mock.calls[1];
    expect(jobSql).toContain("ORDER BY j.created_at DESC");
    expect(jobSql).toContain("LIMIT 10");
    expect(jobParams).toEqual(["test-user"]);
  });
});
