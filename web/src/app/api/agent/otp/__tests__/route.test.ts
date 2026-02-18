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
  return new Request("http://localhost/api/agent/otp", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("POST /api/agent/otp", () => {
  it("creates OTP and returns code", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ code: "123456789012" }])
    );

    const req = makeRequest({ npub_hex: "aabb" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.code).toBe("123456789012");

    expect(vi.mocked(query)).toHaveBeenCalledOnce();
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain("INSERT INTO nostr_otp");
    expect(params![0]).toBe("aabb");
  });

  it("returns 400 for missing npub_hex", async () => {
    const req = makeRequest({});
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Missing npub_hex/);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/api/agent/otp", {
      method: "POST",
      body: "not json",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid JSON/);
  });

  it("returns 500 on db error", async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error("db down"));

    const req = makeRequest({ npub_hex: "aabb" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(500);
  });
});
