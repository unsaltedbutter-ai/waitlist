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

function makeRequest(days?: string | number): Request {
  const url =
    days !== undefined
      ? `http://localhost/api/operator/revenue/daily?days=${days}`
      : "http://localhost/api/operator/revenue/daily";
  return new Request(url, { method: "GET" });
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/operator/revenue/daily", () => {
  // --- Default days ---

  it("defaults to 90 days when no param provided", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    // Should have 91 entries (90 days ago through today inclusive)
    expect(data.length).toBe(91);
  });

  // --- Custom days ---

  it("respects custom days parameter", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest(7) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    // 7 days ago through today = 8 entries
    expect(data.length).toBe(8);
  });

  it("days=1 returns 2 entries (yesterday and today)", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest(1) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(2);
  });

  it("days=365 is accepted", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest(365) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
  });

  // --- Invalid days ---

  it("days=0 returns 400", async () => {
    const res = await GET(makeRequest(0) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/[Ii]nvalid days/);
  });

  it("negative days returns 400", async () => {
    const res = await GET(makeRequest(-5) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(400);
  });

  it("days > 365 returns 400", async () => {
    const res = await GET(makeRequest(366) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(400);
  });

  it("non-numeric days returns 400", async () => {
    const res = await GET(makeRequest("abc") as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(400);
  });

  it("float days returns 400", async () => {
    const res = await GET(makeRequest("3.5") as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(400);
  });

  // --- Empty database ---

  it("returns zero-value entries for each day when no transactions exist", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest(3) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    // 3 days ago + 2 days ago + yesterday + today = 4 entries
    expect(data.length).toBe(4);
    for (const entry of data) {
      expect(entry.sats).toBe(0);
      expect(entry.jobs).toBe(0);
    }
    // All cumulative should be 0
    expect(data[data.length - 1].cumulative_sats).toBe(0);
  });

  // --- Single day with transactions ---

  it("returns correct sats and jobs for a day with data", async () => {
    const today = todayStr();
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        date: today,
        total_sats: "48000",
        job_count: "16",
        paid_sats: "42000",
        eventual_sats: "6000",
      }])
    );

    const res = await GET(makeRequest(3) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    const todayEntry = data.find(
      (e: { date: string }) => e.date === today
    );
    expect(todayEntry).toBeDefined();
    expect(todayEntry.sats).toBe(48000);
    expect(todayEntry.jobs).toBe(16);
    expect(todayEntry.paid_sats).toBe(42000);
    expect(todayEntry.eventual_sats).toBe(6000);
  });

  // --- Cumulative calculation ---

  it("cumulative_sats is a correct running total", async () => {
    const day1 = daysAgo(2);
    const day2 = daysAgo(1);
    const day3 = todayStr();

    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { date: day1, total_sats: "10000", job_count: "3", paid_sats: "10000", eventual_sats: "0" },
        { date: day2, total_sats: "20000", job_count: "5", paid_sats: "15000", eventual_sats: "5000" },
        { date: day3, total_sats: "15000", job_count: "4", paid_sats: "15000", eventual_sats: "0" },
      ])
    );

    const res = await GET(makeRequest(2) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data).toHaveLength(3);
    expect(data[0].date).toBe(day1);
    expect(data[0].sats).toBe(10000);
    expect(data[0].cumulative_sats).toBe(10000);

    expect(data[1].date).toBe(day2);
    expect(data[1].sats).toBe(20000);
    expect(data[1].cumulative_sats).toBe(30000);

    expect(data[2].date).toBe(day3);
    expect(data[2].sats).toBe(15000);
    expect(data[2].cumulative_sats).toBe(45000);
  });

  // --- Zero-fill ---

  it("days with no ledger entries still appear in output", async () => {
    // Only day 1 and day 3 have data, day 2 should be zero-filled
    const day1 = daysAgo(3);
    const day3 = daysAgo(1);

    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { date: day1, total_sats: "10000", job_count: "2", paid_sats: "10000", eventual_sats: "0" },
        { date: day3, total_sats: "5000", job_count: "1", paid_sats: "5000", eventual_sats: "0" },
      ])
    );

    const res = await GET(makeRequest(3) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    // Should have 4 entries (3 days ago through today)
    expect(data.length).toBe(4);

    // day 2 (daysAgo(2)) should be zero-filled
    const day2Str = daysAgo(2);
    const day2Entry = data.find(
      (e: { date: string }) => e.date === day2Str
    );
    expect(day2Entry).toBeDefined();
    expect(day2Entry.sats).toBe(0);
    expect(day2Entry.jobs).toBe(0);

    // Cumulative should carry over from day 1
    expect(day2Entry.cumulative_sats).toBe(10000);
  });

  // --- Only paid/eventual counted ---

  it("query targets revenue_ledger table", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await GET(makeRequest(7) as any, {
      params: Promise.resolve({}),
    });

    const sql = vi.mocked(query).mock.calls[0][0] as string;
    expect(sql).toContain("revenue_ledger");
    expect(sql).toContain("payment_status");
  });

  // --- Output order ---

  it("output is ordered by date ascending", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest(5) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    for (let i = 1; i < data.length; i++) {
      expect(data[i].date > data[i - 1].date).toBe(true);
    }
  });

  // --- Date range starts from correct day ---

  it("first entry date matches the start of the range", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest(5) as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();
    expect(data[0].date).toBe(daysAgo(5));
  });

  it("last entry date is today", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest(5) as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();
    expect(data[data.length - 1].date).toBe(todayStr());
  });

  // -- Ledger-specific fields --

  it("zero-filled days have zero paid_sats and eventual_sats", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest(3) as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    for (const entry of data) {
      expect(entry.paid_sats).toBe(0);
      expect(entry.eventual_sats).toBe(0);
    }
  });

  it("returns paid_sats and eventual_sats breakdown per day", async () => {
    const today = todayStr();
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        date: today,
        total_sats: "6000",
        job_count: "2",
        paid_sats: "3000",
        eventual_sats: "3000",
      }])
    );

    const res = await GET(makeRequest(1) as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();
    const todayEntry = data.find((e: { date: string }) => e.date === today);
    expect(todayEntry.paid_sats).toBe(3000);
    expect(todayEntry.eventual_sats).toBe(3000);
    expect(todayEntry.sats).toBe(6000);
  });
});
