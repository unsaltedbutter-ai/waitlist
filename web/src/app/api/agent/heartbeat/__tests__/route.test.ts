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

  // -- job_ids sync tests --

  it("returns cancelled_jobs as empty array when no job_ids sent", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({ component: "orchestrator" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cancelled_jobs).toEqual([]);
  });

  it("returns cancelled_jobs for terminal job_ids", async () => {
    // Heartbeat upsert
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Job sync query
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", status: "user_skip" },
      ])
    );

    const req = makeRequest({
      component: "orchestrator",
      job_ids: [
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "11111111-2222-3333-4444-555555555555",
      ],
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cancelled_jobs).toHaveLength(1);
    expect(data.cancelled_jobs[0].id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(data.cancelled_jobs[0].status).toBe("user_skip");

    // Verify sync query was called
    expect(vi.mocked(query)).toHaveBeenCalledTimes(2);
    const [sql] = vi.mocked(query).mock.calls[1];
    expect(sql).toContain("SELECT id, status FROM jobs");
  });

  it("returns empty cancelled_jobs for empty job_ids array", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({
      component: "orchestrator",
      job_ids: [],
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cancelled_jobs).toEqual([]);
    // Only heartbeat upsert query, no sync query
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
  });

  it("skips sync query for invalid job_ids (non-UUID)", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({
      component: "orchestrator",
      job_ids: ["not-a-uuid", "also-bad"],
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cancelled_jobs).toEqual([]);
    // Only heartbeat upsert, no sync query
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
  });

  it("returns cancelled_jobs empty when all job_ids are non-terminal", async () => {
    // Heartbeat upsert
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Sync query: no terminal matches
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({
      component: "orchestrator",
      job_ids: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cancelled_jobs).toEqual([]);
  });

  it("ignores job_ids when not an array", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({
      component: "orchestrator",
      job_ids: "not-an-array",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cancelled_jobs).toEqual([]);
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
  });
});
