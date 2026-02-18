import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn().mockResolvedValue("operator-user-id"),
}));
vi.mock("@/lib/operator-auth", () => ({
  withOperator: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params ? await segmentData.params : undefined;
      return handler(req, { userId: "operator-user-id", params });
    };
  }),
}));

import { query } from "@/lib/db";
import { GET } from "../route";

function makeRequest(qs = ""): Request {
  const url = `http://localhost/api/operator/export/jobs${qs ? `?${qs}` : ""}`;
  return new Request(url, { method: "GET" });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/operator/export/jobs", () => {
  it("returns CSV with correct headers", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(
      makeRequest("from=2026-01-01&to=2026-01-31") as any,
      { params: Promise.resolve({}) }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="jobs-2026-01-01-to-2026-01-31.csv"'
    );
  });

  it("returns header row when no data exists", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(
      makeRequest("from=2026-01-01&to=2026-01-31") as any,
      { params: Promise.resolve({}) }
    );

    const text = await res.text();
    expect(text).toBe(
      "date,job_id,user_npub,service,flow_type,status,billing_date,created_at,completed_at\r\n"
    );
  });

  it("returns data rows with job details", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          date: "2026-01-15",
          job_id: "job-001",
          user_npub: "npub1abc123",
          service: "netflix",
          flow_type: "cancel",
          status: "completed_paid",
          billing_date: "2026-02-01",
          created_at: "2026-01-15 08:00:00+00",
          completed_at: "2026-01-15 08:05:00+00",
        },
      ])
    );

    const res = await GET(
      makeRequest("from=2026-01-01&to=2026-01-31") as any,
      { params: Promise.resolve({}) }
    );

    const text = await res.text();
    const lines = text.split("\r\n");
    expect(lines[1]).toBe(
      "2026-01-15,job-001,npub1abc123,netflix,cancel,completed_paid,2026-02-01,2026-01-15 08:00:00+00,2026-01-15 08:05:00+00"
    );
  });

  it("handles null billing_date as empty string", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          date: "2026-01-15",
          job_id: "job-002",
          user_npub: "npub1xyz",
          service: "hulu",
          flow_type: "resume",
          status: "completed_eventual",
          billing_date: null,
          created_at: "2026-01-15 12:00:00+00",
          completed_at: "2026-01-15 12:03:00+00",
        },
      ])
    );

    const res = await GET(
      makeRequest("from=2026-01-01&to=2026-01-31") as any,
      { params: Promise.resolve({}) }
    );

    const text = await res.text();
    const lines = text.split("\r\n");
    // billing_date should be empty between the two commas
    expect(lines[1]).toBe(
      "2026-01-15,job-002,npub1xyz,hulu,resume,completed_eventual,,2026-01-15 12:00:00+00,2026-01-15 12:03:00+00"
    );
  });

  it("defaults to last 90 days when no dates provided", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(200);
    const call = vi.mocked(query).mock.calls[0];
    expect(call[1]).toHaveLength(2);
    const from = call[1]![0] as string;
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns 400 for invalid from date", async () => {
    const res = await GET(
      makeRequest("from=bad&to=2026-01-31") as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when from is after to", async () => {
    const res = await GET(
      makeRequest("from=2026-02-01&to=2026-01-01") as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid status filter", async () => {
    const res = await GET(
      makeRequest("from=2026-01-01&to=2026-01-31&status=bogus") as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid status");
  });

  it("passes status filter to SQL query when provided", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await GET(
      makeRequest("from=2026-01-01&to=2026-01-31&status=completed_paid") as any,
      { params: Promise.resolve({}) }
    );

    const call = vi.mocked(query).mock.calls[0];
    expect(call[1]).toEqual(["2026-01-01", "2026-01-31", "completed_paid"]);
    // SQL should contain the status clause
    expect(call[0]).toContain("j.status = $3");
  });

  it("omits status clause from SQL when no status filter", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await GET(
      makeRequest("from=2026-01-01&to=2026-01-31") as any,
      { params: Promise.resolve({}) }
    );

    const call = vi.mocked(query).mock.calls[0];
    expect(call[1]).toEqual(["2026-01-01", "2026-01-31"]);
    expect(call[0]).not.toContain("j.status = $3");
  });
});
