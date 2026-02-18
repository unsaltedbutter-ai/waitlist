import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn(),
}));

import { query } from "@/lib/db";
import { authenticateRequest } from "@/lib/auth";
import { GET } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/operator/reneged", {
    method: "GET",
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(authenticateRequest).mockReset();
  vi.stubEnv("OPERATOR_USER_ID", "operator-123");
});

describe("GET /api/operator/reneged", () => {
  it("returns reneged entries ordered by created_at desc", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("operator-123");

    const entries = [
      {
        email_hash: "abc123",
        total_debt_sats: 9000,
        created_at: "2025-06-15T00:00:00Z",
      },
      {
        email_hash: "def456",
        total_debt_sats: 3000,
        created_at: "2025-06-01T00:00:00Z",
      },
    ];

    vi.mocked(query).mockResolvedValueOnce(mockQueryResult(entries));

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toHaveLength(2);
    expect(data.entries[0].email_hash).toBe("abc123");
    expect(data.entries[0].total_debt_sats).toBe(9000);
    expect(data.entries[1].email_hash).toBe("def456");
  });

  it("returns empty array when no entries exist", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("operator-123");
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toEqual([]);
  });

  it("non-operator user returns 403", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("not-operator");

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/[Ff]orbidden/);
  });

  it("unauthenticated returns 401", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce(null as any);

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toMatch(/[Uu]nauthorized/);
  });

  it("returns 500 on database error", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("operator-123");
    vi.mocked(query).mockRejectedValueOnce(new Error("connection failed"));

    const res = await GET(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toMatch(/[Ii]nternal/);
  });
});
