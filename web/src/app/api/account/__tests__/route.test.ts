import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

const { mockAuthenticateRequest } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
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

import { query, transaction } from "@/lib/db";
import { DELETE } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/account", { method: "DELETE" });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(transaction).mockReset();
  mockAuthenticateRequest.mockReset();
});

describe("DELETE /api/account", () => {
  it("successful delete with credit balance -> 200", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce("user-123");
    vi.mocked(transaction).mockImplementation(async (cb) => {
      return cb(vi.mocked(query) as any);
    });

    // SELECT user
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ email: "user@test.com", nostr_npub: null }])
    );
    // SELECT credits
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ credit_sats: "50000" }])
    );
    // INSERT pending_refunds
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // DELETE users
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await DELETE(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    // Verify pending_refunds insert was called with correct args
    const insertCall = vi.mocked(query).mock.calls[2];
    expect(insertCall[0]).toContain("INSERT INTO pending_refunds");
    expect(insertCall[1]).toEqual(["user@test.com", 50000]);
  });

  it("successful delete with zero balance -> 200", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce("user-123");
    vi.mocked(transaction).mockImplementation(async (cb) => {
      return cb(vi.mocked(query) as any);
    });

    // SELECT user
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ email: "zero@test.com", nostr_npub: null }])
    );
    // SELECT credits — no rows
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // INSERT pending_refunds
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // DELETE users
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await DELETE(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);

    // Verify pending_refunds insert has amount_sats=0
    const insertCall = vi.mocked(query).mock.calls[2];
    expect(insertCall[0]).toContain("INSERT INTO pending_refunds");
    expect(insertCall[1]).toEqual(["zero@test.com", 0]);
  });

  it("nostr-only user -> 200", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce("user-123");
    vi.mocked(transaction).mockImplementation(async (cb) => {
      return cb(vi.mocked(query) as any);
    });

    // SELECT user — no email, nostr only
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ email: null, nostr_npub: "abc123hex" }])
    );
    // SELECT credits
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ credit_sats: "1000" }])
    );
    // INSERT pending_refunds
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // DELETE users
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await DELETE(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);

    // Verify pending_refunds insert uses nostr_npub as contact
    const insertCall = vi.mocked(query).mock.calls[2];
    expect(insertCall[0]).toContain("INSERT INTO pending_refunds");
    expect(insertCall[1]).toEqual(["abc123hex", 1000]);
  });

  it("unauthenticated -> 401", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce(null as any);

    const res = await DELETE(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toMatch(/[Uu]nauthorized/);
  });
});
