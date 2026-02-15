import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn(),
}));
vi.mock("@/lib/capacity", () => ({
  getActiveUserCount: vi.fn(),
  getUserCap: vi.fn(),
}));

import { query } from "@/lib/db";
import { authenticateRequest } from "@/lib/auth";
import { getActiveUserCount, getUserCap } from "@/lib/capacity";
import { GET } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/operator/waitlist", {
    method: "GET",
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(authenticateRequest).mockReset();
  vi.mocked(getActiveUserCount).mockReset();
  vi.mocked(getUserCap).mockReset();
  vi.stubEnv("OPERATOR_USER_ID", "operator-123");
});

describe("GET /api/operator/waitlist", () => {
  it("returns waitlist entries sorted by created_at", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("operator-123");

    const entries = [
      {
        id: "wl-1",
        email: "first@example.com",
        nostr_npub: null,
        current_services: ["netflix"],
        invited: false,
        invited_at: null,
        created_at: "2025-01-01T00:00:00Z",
      },
      {
        id: "wl-2",
        email: "second@example.com",
        nostr_npub: null,
        current_services: null,
        invited: true,
        invited_at: "2025-01-15T00:00:00Z",
        created_at: "2025-01-10T00:00:00Z",
      },
    ];

    vi.mocked(query).mockResolvedValueOnce(mockQueryResult(entries));
    vi.mocked(getActiveUserCount).mockResolvedValueOnce(247);
    vi.mocked(getUserCap).mockReturnValueOnce(5000);

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toHaveLength(2);
    expect(data.entries[0].id).toBe("wl-1");
    expect(data.entries[1].id).toBe("wl-2");
  });

  it("includes capacity stats correctly", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("operator-123");

    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(getActiveUserCount).mockResolvedValueOnce(247);
    vi.mocked(getUserCap).mockReturnValueOnce(5000);

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.capacity).toEqual({
      activeUsers: 247,
      cap: 5000,
      availableSlots: 4753,
    });
  });

  it("non-operator user -> 403", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("not-operator");

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/[Ff]orbidden/);
  });

  it("unauthenticated -> 401", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce(null as any);

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toMatch(/[Uu]nauthorized/);
  });
});
