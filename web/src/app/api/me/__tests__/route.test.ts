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
    email: "test@example.com",
    nostr_npub: "npub1abc123",
    status: "active",
    paused_at: null,
    onboarded_at: "2026-01-15T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
  };

  it("returns user profile with correct shape", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([mockUser]));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual(mockUser);
  });

  it("returns all expected fields", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([mockUser]));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    expect(data).toHaveProperty("id");
    expect(data).toHaveProperty("email");
    expect(data).toHaveProperty("nostr_npub");
    expect(data).toHaveProperty("status");
    expect(data).toHaveProperty("paused_at");
    expect(data).toHaveProperty("onboarded_at");
    expect(data).toHaveProperty("created_at");
  });

  it("queries with correct userId parameter", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([mockUser]));

    await GET(makeRequest() as any, { params: Promise.resolve({}) });

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain("FROM users WHERE id = $1");
    expect(params).toEqual(["test-user"]);
  });

  it("returns 404 when user is not found", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

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
      email: null,
      paused_at: null,
      onboarded_at: null,
    };
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([partialUser]));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.email).toBeNull();
    expect(data.paused_at).toBeNull();
    expect(data.onboarded_at).toBeNull();
  });
});
