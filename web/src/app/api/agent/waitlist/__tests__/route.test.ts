import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/agent-auth", () => ({
  withAgentAuth: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const body = await req.text();
      const params = segmentData?.params
        ? await segmentData.params
        : undefined;
      return handler(req, { body, params });
    };
  }),
}));

import { query } from "@/lib/db";
import { POST } from "../route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/agent/waitlist", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("POST /api/agent/waitlist", () => {
  it("adds new entry to waitlist", async () => {
    // SELECT returns no existing row
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // INSERT succeeds
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({ npub_hex: "aabb" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("added");
    expect(data.invite_code).toBeNull();
  });

  it("returns already_invited with invite_code", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ invited: true, invite_code: "ABC123" }])
    );

    const req = makeRequest({ npub_hex: "aabb" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("already_invited");
    expect(data.invite_code).toBe("ABC123");
  });

  it("returns already_waitlisted", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ invited: false, invite_code: null }])
    );

    const req = makeRequest({ npub_hex: "aabb" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("already_waitlisted");
    expect(data.invite_code).toBeNull();
  });

  it("returns 400 for missing npub_hex", async () => {
    const req = makeRequest({});
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/api/agent/waitlist", {
      method: "POST",
      body: "not json",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(400);
  });

  it("returns 500 on db error", async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error("db down"));

    const req = makeRequest({ npub_hex: "aabb" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(500);
  });
});
