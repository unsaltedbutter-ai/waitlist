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

function makeRequest(search?: string): Request {
  const url = search
    ? `http://localhost/api/operator/users?search=${encodeURIComponent(search)}`
    : "http://localhost/api/operator/users";
  return new Request(url, { method: "GET" });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/operator/users", () => {
  it("returns latest 50 users when no search param", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          id: "u1",
          nostr_npub: "npub1abc",
          debt_sats: 0,
          onboarded_at: "2026-01-01T00:00:00Z",
          created_at: "2026-01-01T00:00:00Z",
          queue_count: "2",
          job_count: "5",
        },
      ])
    );

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.users).toHaveLength(1);
    expect(data.users[0].id).toBe("u1");
    expect(data.users[0].queue_count).toBe("2");
    expect(data.users[0].job_count).toBe("5");
  });

  it("searches by npub substring (case-insensitive)", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          id: "u2",
          nostr_npub: "npub1xyz",
          debt_sats: 3000,
          onboarded_at: null,
          created_at: "2026-02-01T00:00:00Z",
          queue_count: "0",
          job_count: "1",
        },
      ])
    );

    const res = await GET(makeRequest("XYZ") as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.users).toHaveLength(1);
    expect(data.users[0].nostr_npub).toBe("npub1xyz");

    // Verify the search param was passed with LIKE pattern
    const callArgs = vi.mocked(query).mock.calls[0];
    expect(callArgs[1]).toEqual(["%XYZ%"]);
  });

  it("returns empty array when no users match search", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest("nonexistent") as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.users).toEqual([]);
  });

  it("trims whitespace from search param", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await GET(makeRequest("  npub1  ") as any, {
      params: Promise.resolve({}),
    });

    const callArgs = vi.mocked(query).mock.calls[0];
    expect(callArgs[1]).toEqual(["%npub1%"]);
  });

  it("returns empty-string search as no-search (latest 50)", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await GET(makeRequest("") as any, {
      params: Promise.resolve({}),
    });

    // Should not have search param (empty string is falsy after trim)
    const callArgs = vi.mocked(query).mock.calls[0];
    expect(callArgs[1]).toBeUndefined();
  });
});
