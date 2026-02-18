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

function makeRequest(period?: string): Request {
  const url = period
    ? `http://localhost/api/operator/stats?period=${period}`
    : "http://localhost/api/operator/stats";
  return new Request(url, { method: "GET" });
}

/** Mock all four queries returning empty results */
function mockEmptyQueries() {
  // jobs
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
  // revenue
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
  // by_service
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
  // users
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([{ total: "0", active: "0", with_debt: "0" }])
  );
}

/** Mock all four queries with provided data */
function mockQueries(opts: {
  jobs?: Array<{ status: string; count: string }>;
  revenue?: Array<{ status: string; total_sats: string }>;
  byService?: Array<{
    service_id: string;
    action: string;
    count: string;
    sats: string;
  }>;
  users?: { total: string; active: string; with_debt: string };
}) {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult(opts.jobs ?? [])
  );
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult(opts.revenue ?? [])
  );
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult(opts.byService ?? [])
  );
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([
      opts.users ?? { total: "0", active: "0", with_debt: "0" },
    ])
  );
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/operator/stats", () => {
  // --- Period handling ---

  it("defaults to week period when no param provided", async () => {
    mockEmptyQueries();
    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.period).toBeDefined();
    expect(data.period.start).toBeDefined();
    expect(data.period.end).toBeDefined();

    // Week: start should be 7 days before end
    const start = new Date(data.period.start);
    const end = new Date(data.period.end);
    const diffDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBe(7);
  });

  it("period=day returns 1-day range", async () => {
    mockEmptyQueries();
    const res = await GET(makeRequest("day") as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const start = new Date(data.period.start);
    const end = new Date(data.period.end);
    const diffDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBe(1);
  });

  it("period=week returns 7-day range", async () => {
    mockEmptyQueries();
    const res = await GET(makeRequest("week") as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const start = new Date(data.period.start);
    const end = new Date(data.period.end);
    const diffDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBe(7);
  });

  it("period=month returns 30-day range", async () => {
    mockEmptyQueries();
    const res = await GET(makeRequest("month") as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const start = new Date(data.period.start);
    const end = new Date(data.period.end);
    const diffDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBe(30);
  });

  it("period=all uses 1970-01-01 as start", async () => {
    mockEmptyQueries();
    const res = await GET(makeRequest("all") as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.period.start).toBe("1970-01-01");
  });

  it("invalid period returns 400", async () => {
    const res = await GET(makeRequest("yearly") as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/[Ii]nvalid period/);
  });

  // --- Empty database ---

  it("returns all zeros when database is empty", async () => {
    mockEmptyQueries();
    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.jobs).toEqual({
      total: 0,
      completed_paid: 0,
      completed_eventual: 0,
      completed_reneged: 0,
      user_skip: 0,
      user_abandon: 0,
      implied_skip: 0,
    });
    expect(data.revenue).toEqual({
      earned_sats: 0,
      outstanding_sats: 0,
    });
    expect(data.by_service).toEqual({});
    expect(data.users).toEqual({
      active: 0,
      with_debt: 0,
      total: 0,
    });
  });

  // --- Mixed job statuses ---

  it("counts each job status correctly", async () => {
    mockQueries({
      jobs: [
        { status: "completed_paid", count: "50" },
        { status: "completed_eventual", count: "10" },
        { status: "completed_reneged", count: "3" },
        { status: "user_skip", count: "7" },
        { status: "user_abandon", count: "2" },
        { status: "implied_skip", count: "4" },
      ],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    expect(data.jobs.total).toBe(76);
    expect(data.jobs.completed_paid).toBe(50);
    expect(data.jobs.completed_eventual).toBe(10);
    expect(data.jobs.completed_reneged).toBe(3);
    expect(data.jobs.user_skip).toBe(7);
    expect(data.jobs.user_abandon).toBe(2);
    expect(data.jobs.implied_skip).toBe(4);
  });

  // --- Revenue calculation ---

  it("earned_sats includes paid + eventual only", async () => {
    mockQueries({
      revenue: [
        { status: "paid", total_sats: "100000" },
        { status: "eventual", total_sats: "20000" },
        { status: "invoice_sent", total_sats: "5000" },
      ],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    expect(data.revenue.earned_sats).toBe(120000);
  });

  it("outstanding_sats includes invoice_sent only", async () => {
    mockQueries({
      revenue: [
        { status: "paid", total_sats: "100000" },
        { status: "invoice_sent", total_sats: "9000" },
      ],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    expect(data.revenue.outstanding_sats).toBe(9000);
    // paid should not be in outstanding
    expect(data.revenue.earned_sats).toBe(100000);
  });

  // --- By-service breakdown ---

  it("groups by service with separate cancel/resume counts", async () => {
    mockQueries({
      byService: [
        {
          service_id: "netflix",
          action: "cancel",
          count: "15",
          sats: "45000",
        },
        {
          service_id: "netflix",
          action: "resume",
          count: "12",
          sats: "36000",
        },
        {
          service_id: "hulu",
          action: "cancel",
          count: "5",
          sats: "15000",
        },
      ],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    expect(data.by_service.netflix).toEqual({
      cancels: 15,
      resumes: 12,
      sats: 81000,
    });
    expect(data.by_service.hulu).toEqual({
      cancels: 5,
      resumes: 0,
      sats: 15000,
    });
  });

  it("service with only resumes has zero cancels", async () => {
    mockQueries({
      byService: [
        {
          service_id: "disney_plus",
          action: "resume",
          count: "8",
          sats: "24000",
        },
      ],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    expect(data.by_service.disney_plus).toEqual({
      cancels: 0,
      resumes: 8,
      sats: 24000,
    });
  });

  // --- User counts ---

  it("returns correct user counts", async () => {
    mockQueries({
      users: { total: "104", active: "89", with_debt: "2" },
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    expect(data.users).toEqual({
      active: 89,
      with_debt: 2,
      total: 104,
    });
  });

  // --- Full response shape ---

  it("returns the complete response structure", async () => {
    mockQueries({
      jobs: [
        { status: "completed_paid", count: "118" },
        { status: "completed_eventual", count: "8" },
        { status: "completed_reneged", count: "3" },
        { status: "user_skip", count: "6" },
        { status: "user_abandon", count: "2" },
        { status: "implied_skip", count: "5" },
      ],
      revenue: [
        { status: "paid", total_sats: "370000" },
        { status: "eventual", total_sats: "8000" },
        { status: "invoice_sent", total_sats: "9000" },
      ],
      byService: [
        {
          service_id: "netflix",
          action: "cancel",
          count: "28",
          sats: "84000",
        },
        {
          service_id: "netflix",
          action: "resume",
          count: "25",
          sats: "75000",
        },
      ],
      users: { total: "104", active: "89", with_debt: "2" },
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data).toEqual({
      period: expect.objectContaining({
        start: expect.any(String),
        end: expect.any(String),
      }),
      jobs: {
        total: 142,
        completed_paid: 118,
        completed_eventual: 8,
        completed_reneged: 3,
        user_skip: 6,
        user_abandon: 2,
        implied_skip: 5,
      },
      revenue: {
        earned_sats: 378000,
        outstanding_sats: 9000,
      },
      by_service: {
        netflix: { cancels: 28, resumes: 25, sats: 159000 },
      },
      users: {
        active: 89,
        with_debt: 2,
        total: 104,
      },
    });
  });

  // --- SQL param verification ---

  it("period=all passes no date params to jobs query", async () => {
    mockEmptyQueries();
    await GET(makeRequest("all") as any, {
      params: Promise.resolve({}),
    });

    // First call is jobs query, should have empty params for 'all'
    const firstCall = vi.mocked(query).mock.calls[0];
    expect(firstCall[1]).toEqual([]);
  });

  it("period=week passes date param to jobs query", async () => {
    mockEmptyQueries();
    await GET(makeRequest("week") as any, {
      params: Promise.resolve({}),
    });

    // First call is jobs query, should have a date param
    const firstCall = vi.mocked(query).mock.calls[0];
    expect(firstCall[1]).toHaveLength(1);
    // Should be a valid date string
    expect(firstCall[1]![0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
