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
  return new Request("http://localhost/api/agent/heartbeat", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("POST /api/agent/heartbeat", () => {
  it("upserts heartbeat for valid component", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({ component: "orchestrator" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    expect(vi.mocked(query)).toHaveBeenCalledOnce();
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain("INSERT INTO system_heartbeats");
    expect(sql).toContain("ON CONFLICT");
    expect(params![0]).toBe("orchestrator");
    expect(params![1]).toBeNull();
  });

  it("accepts optional payload", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const payload = { version: "1.2.0", uptime_s: 3600 };
    const req = makeRequest({ component: "agent", payload });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const [, params] = vi.mocked(query).mock.calls[0];
    expect(params![0]).toBe("agent");
    expect(params![1]).toBe(JSON.stringify(payload));
  });

  it("accepts inference component", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({ component: "inference" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
  });

  it("returns 400 for missing component", async () => {
    const req = makeRequest({});
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid component/);
  });

  it("returns 400 for invalid component name", async () => {
    const req = makeRequest({ component: "database" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid component/);
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/api/agent/heartbeat", {
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

    const req = makeRequest({ component: "orchestrator" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toMatch(/Internal server error/);
  });
});
