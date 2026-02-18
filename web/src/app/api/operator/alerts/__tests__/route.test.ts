import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/operator-auth", () => ({
  withOperator: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params
        ? await segmentData.params
        : undefined;
      return handler(req, { userId: "operator-user", params });
    };
  }),
}));

import { query } from "@/lib/db";
import { GET, POST } from "../route";

function makePostRequest(body: object | string): Request {
  const isString = typeof body === "string";
  return new Request("http://localhost/api/operator/alerts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: isString ? body : JSON.stringify(body),
  });
}

function makeGetRequest(): Request {
  return new Request("http://localhost/api/operator/alerts");
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/operator/alerts", () => {
  const mockAlerts = [
    {
      id: "alert-1",
      alert_type: "job_failure",
      severity: "critical",
      title: "Netflix cancel failed",
      message: "OTP timeout after 3 retries",
      created_at: "2026-02-18T10:00:00Z",
    },
    {
      id: "alert-2",
      alert_type: "debt_threshold",
      severity: "warning",
      title: "User debt over limit",
      message: "User xyz has 9000 sats debt",
      created_at: "2026-02-18T09:00:00Z",
    },
  ];

  it("returns unacknowledged alerts", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult(mockAlerts));

    const res = await GET(makeGetRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.alerts).toHaveLength(2);
    expect(data.alerts[0].id).toBe("alert-1");
    expect(data.alerts[0].severity).toBe("critical");
    expect(data.alerts[1].id).toBe("alert-2");
  });

  it("returns empty alerts array when none exist", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeGetRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.alerts).toEqual([]);
  });

  it("queries for unacknowledged alerts with severity ordering", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await GET(makeGetRequest() as any, { params: Promise.resolve({}) });

    expect(query).toHaveBeenCalledOnce();
    const sql = vi.mocked(query).mock.calls[0][0] as string;
    expect(sql).toContain("acknowledged = FALSE");
    expect(sql).toContain("CASE severity");
    expect(sql).toContain("LIMIT 50");
  });

  it("returns 500 when the DB query fails", async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error("connection refused"));

    const res = await GET(makeGetRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toMatch(/failed to fetch/i);
  });
});

describe("POST /api/operator/alerts", () => {
  it("acknowledges alerts by IDs and returns count", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makePostRequest({ ids: ["alert-1", "alert-2"] }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.acknowledged).toBe(2);
  });

  it("passes IDs array to the update query", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await POST(
      makePostRequest({ ids: ["alert-1", "alert-3"] }) as any,
      { params: Promise.resolve({}) }
    );

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain("UPDATE operator_alerts");
    expect(sql).toContain("acknowledged = TRUE");
    expect(params).toEqual([["alert-1", "alert-3"]]);
  });

  it("rejects empty ids array with 400", async () => {
    const res = await POST(
      makePostRequest({ ids: [] }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/non-empty/i);
  });

  it("rejects missing ids field with 400", async () => {
    const res = await POST(
      makePostRequest({}) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/non-empty/i);
  });

  it("rejects non-array ids with 400", async () => {
    const res = await POST(
      makePostRequest({ ids: "alert-1" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/non-empty/i);
  });

  it("returns 500 when the DB query fails", async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error("deadlock detected"));

    const res = await POST(
      makePostRequest({ ids: ["alert-1"] }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toMatch(/failed to acknowledge/i);
  });
});
