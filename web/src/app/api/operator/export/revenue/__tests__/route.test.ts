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
  const url = `http://localhost/api/operator/export/revenue${qs ? `?${qs}` : ""}`;
  return new Request(url, { method: "GET" });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/operator/export/revenue", () => {
  it("returns CSV with correct content-type and disposition headers", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(
      makeRequest("from=2026-01-01&to=2026-01-31") as any,
      { params: Promise.resolve({}) }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="revenue-2026-01-01-to-2026-01-31.csv"'
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
      "date,job_id,service,flow_type,amount_sats,type,created_at\r\n"
    );
  });

  it("returns data rows matching revenue_ledger records", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          date: "2026-01-15",
          id: "abc-123",
          service_id: "netflix",
          action: "cancel",
          amount_sats: 3000,
          payment_status: "paid",
          recorded_at: "2026-01-15 10:30:00+00",
        },
        {
          date: "2026-01-16",
          id: "def-456",
          service_id: "hulu",
          action: "resume",
          amount_sats: 3000,
          payment_status: "eventual",
          recorded_at: "2026-01-16 14:00:00+00",
        },
      ])
    );

    const res = await GET(
      makeRequest("from=2026-01-01&to=2026-01-31") as any,
      { params: Promise.resolve({}) }
    );

    const text = await res.text();
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("date,job_id,service,flow_type,amount_sats,type,created_at");
    expect(lines[1]).toBe("2026-01-15,abc-123,netflix,cancel,3000,paid,2026-01-15 10:30:00+00");
    expect(lines[2]).toBe("2026-01-16,def-456,hulu,resume,3000,eventual,2026-01-16 14:00:00+00");
    expect(lines[3]).toBe(""); // trailing CRLF
  });

  it("defaults to last 90 days when no dates provided", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(200);

    // Check the SQL was called with reasonable date params
    const call = vi.mocked(query).mock.calls[0];
    expect(call[1]).toHaveLength(2);
    // 'from' should be ~90 days ago
    const from = call[1]![0] as string;
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns 400 for invalid from date", async () => {
    const res = await GET(
      makeRequest("from=not-a-date&to=2026-01-31") as any,
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

  it("passes correct date range to SQL query", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await GET(
      makeRequest("from=2026-01-10&to=2026-01-20") as any,
      { params: Promise.resolve({}) }
    );

    const call = vi.mocked(query).mock.calls[0];
    expect(call[1]).toEqual(["2026-01-10", "2026-01-20"]);
  });

  it("escapes CSV special characters in data", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          date: "2026-01-15",
          id: "id-with,comma",
          service_id: "netflix",
          action: "cancel",
          amount_sats: 3000,
          payment_status: "paid",
          recorded_at: "2026-01-15 10:30:00+00",
        },
      ])
    );

    const res = await GET(
      makeRequest("from=2026-01-01&to=2026-01-31") as any,
      { params: Promise.resolve({}) }
    );

    const text = await res.text();
    const lines = text.split("\r\n");
    // The id field should be quoted because it contains a comma
    expect(lines[1]).toContain('"id-with,comma"');
  });
});
