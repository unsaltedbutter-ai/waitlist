import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

let mockUserId: string | null = "user-1";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  withAuth: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      if (!mockUserId) {
        const { NextResponse } = await import("next/server");
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const params = segmentData?.params
        ? await segmentData.params
        : undefined;
      return handler(req, { userId: mockUserId, params });
    };
  }),
}));

import { query } from "@/lib/db";
import { POST } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/pause", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  mockUserId = "user-1";
});

describe("POST /api/pause", () => {
  it("pauses an active user", async () => {
    // SELECT status
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "active" }])
    );
    // UPDATE users
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);

    // Verify UPDATE was called with paused status
    const updateCall = vi.mocked(query).mock.calls[1];
    expect(updateCall[0]).toContain("paused");
    expect(updateCall[1]).toEqual(["user-1"]);
  });

  it("pauses an auto_paused user", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "auto_paused" }])
    );
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );

    expect(res.status).toBe(200);
  });

  it("rejects pause from already-paused state", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "paused" }])
    );

    const res = await POST(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );

    expect(res.status).toBe(409);
  });

  it("requires auth", async () => {
    mockUserId = null;

    const res = await POST(
      makeRequest() as any,
      { params: Promise.resolve({}) }
    );

    expect(res.status).toBe(401);
  });
});
