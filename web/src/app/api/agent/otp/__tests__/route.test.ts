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

const VALID_HEX = "aabb".repeat(16);

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
  it("creates OTP and returns plaintext code (stores hash)", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: VALID_HEX }])
    );

    const req = makeRequest({ npub_hex: VALID_HEX });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    // Code is 12 digits
    expect(data.code).toMatch(/^\d{12}$/);

    expect(vi.mocked(query)).toHaveBeenCalledOnce();
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain("INSERT INTO nostr_otp");
    expect(sql).toContain("code_hash");
    expect(params![0]).toBe(VALID_HEX);
    // Second param is a SHA-256 hex digest (64 chars)
    expect(params![1]).toMatch(/^[a-f0-9]{64}$/);
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

    const req = makeRequest({ npub_hex: VALID_HEX });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(500);
  });
});
