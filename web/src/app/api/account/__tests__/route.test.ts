import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

const { mockAuthenticateRequest } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => {
  return {
    authenticateRequest: mockAuthenticateRequest,
    withAuth(
      handler: (
        req: import("next/server").NextRequest,
        ctx: { userId: string; params?: Record<string, string> }
      ) => Promise<import("next/server").NextResponse>
    ) {
      return async (
        req: import("next/server").NextRequest,
        segmentData: { params: Promise<Record<string, string>> }
      ) => {
        const { NextResponse } = await import("next/server");
        const userId = await mockAuthenticateRequest(req);
        if (!userId) {
          return NextResponse.json(
            { error: "Unauthorized" },
            { status: 401 }
          );
        }
        const params = await segmentData.params;
        return handler(req, { userId, params });
      };
    },
  };
});

import { query } from "@/lib/db";
import { DELETE, GET } from "../route";

function makeDeleteRequest(): Request {
  return new Request("http://localhost/api/account", { method: "DELETE" });
}

function makeGetRequest(): Request {
  return new Request("http://localhost/api/account", { method: "GET" });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  mockAuthenticateRequest.mockReset();
});

describe("GET /api/account", () => {
  it("returns user info -> 200", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce("user-123");
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        nostr_npub: "npub1abc123",
        debt_sats: 0,
        onboarded_at: "2026-01-01T00:00:00Z",
        created_at: "2025-12-01T00:00:00Z",
      }])
    );

    const res = await GET(
      makeGetRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.nostrNpub).toBe("npub1abc123");
    expect(data.debtSats).toBe(0);
    expect(data.onboardedAt).toBe("2026-01-01T00:00:00Z");
    expect(data.createdAt).toBe("2025-12-01T00:00:00Z");
  });

  it("user with debt -> 200 with debtSats", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce("user-123");
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        nostr_npub: "npub1abc123",
        debt_sats: 3000,
        onboarded_at: null,
        created_at: "2025-12-01T00:00:00Z",
      }])
    );

    const res = await GET(
      makeGetRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.debtSats).toBe(3000);
    expect(data.onboardedAt).toBeNull();
  });

  it("user not found -> 404", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce("user-123");
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(
      makeGetRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(404);
  });

  it("unauthenticated -> 401", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce(null as any);

    const res = await GET(
      makeGetRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toMatch(/[Uu]nauthorized/);
  });
});

describe("DELETE /api/account", () => {
  it("successful delete -> 200 when debt is zero", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce("user-123");

    // SELECT user exists with zero debt
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "user-123", debt_sats: 0 }])
    );
    // DELETE users (CASCADE)
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await DELETE(
      makeDeleteRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    // Verify the DELETE query was called
    const deleteCall = vi.mocked(query).mock.calls[1];
    expect(deleteCall[0]).toContain("DELETE FROM users");
    expect(deleteCall[1]).toEqual(["user-123"]);
  });

  it("blocks deletion when debt > 0 -> 402", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce("user-123");

    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "user-123", debt_sats: 6000 }])
    );

    const res = await DELETE(
      makeDeleteRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(402);
    const data = await res.json();
    expect(data.error).toContain("Outstanding balance");
    expect(data.error).toContain("6000");
    expect(data.debt_sats).toBe(6000);

    // Verify DELETE was never called
    expect(vi.mocked(query).mock.calls).toHaveLength(1);
  });

  it("user not found -> 404", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce("user-123");
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await DELETE(
      makeDeleteRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/not found/i);
  });

  it("unauthenticated -> 401", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce(null as any);

    const res = await DELETE(
      makeDeleteRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toMatch(/[Uu]nauthorized/);
  });
});
