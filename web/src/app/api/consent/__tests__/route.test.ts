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
import { POST } from "../route";

function makeRequest(
  body: object | string,
  headers?: Record<string, string>
): Request {
  const isString = typeof body === "string";
  return new Request("http://localhost/api/consent", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: isString ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("POST /api/consent", () => {
  it("saves authorization consent and returns 201", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({ consentType: "authorization" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("saves confirmation consent and returns 201", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({ consentType: "confirmation" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("passes correct parameters to DB insert", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({ consentType: "authorization" }, {
      "x-forwarded-for": "1.2.3.4, 5.6.7.8",
      "user-agent": "TestBrowser/1.0",
    });
    await POST(req as any, { params: Promise.resolve({}) });

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain("INSERT INTO user_consents");
    expect(params).toEqual([
      "test-user",
      "authorization",
      "1.2.3.4",
      "TestBrowser/1.0",
    ]);
  });

  it("uses x-real-ip when x-forwarded-for is absent", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({ consentType: "authorization" }, {
      "x-real-ip": "10.0.0.1",
      "user-agent": "TestBrowser/1.0",
    });
    await POST(req as any, { params: Promise.resolve({}) });

    const params = vi.mocked(query).mock.calls[0][1] as unknown[];
    expect(params[2]).toBe("10.0.0.1");
  });

  it("falls back to 'unknown' when no IP or user-agent headers exist", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    // Build request with no forwarding or user-agent headers
    const req = new Request("http://localhost/api/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consentType: "authorization" }),
    });
    await POST(req as any, { params: Promise.resolve({}) });

    const params = vi.mocked(query).mock.calls[0][1] as unknown[];
    expect(params[2]).toBe("unknown");
    expect(params[3]).toBe("unknown");
  });

  it("rejects missing consentType with 400", async () => {
    const res = await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/consent type/i);
  });

  it("rejects invalid consentType with 400", async () => {
    const res = await POST(
      makeRequest({ consentType: "bogus" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/consent type/i);
  });

  it("rejects invalid JSON with 400", async () => {
    const req = new Request("http://localhost/api/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/invalid json/i);
  });
});
