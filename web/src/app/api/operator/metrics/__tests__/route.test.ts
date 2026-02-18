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
import { GET } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/operator/metrics");
}

/**
 * Set up mock return values for all 10 parallel queries in the metrics route.
 * Order must match the Promise.all in route.ts:
 *   0: jobsToday, 1: perf7d, 2: perf30d, 3: cache7d, 4: cache14d,
 *   5: totalUsers, 6: jobsByStatus, 7: satsIn, 8: debtTotal, 9: deadLetter
 */
function mockAllQueries(overrides?: Partial<Record<number, unknown[]>>) {
  const defaults: unknown[][] = [
    [], // 0: jobsToday
    [], // 1: perf7d
    [], // 2: perf30d
    [], // 3: cache7d
    [], // 4: cache14d
    [{ count: 0 }], // 5: totalUsers
    [], // 6: jobsByStatus
    [{ sats_in: "0" }], // 7: satsIn
    [{ total_debt: "0" }], // 8: debtTotal
    [], // 9: deadLetter
  ];

  for (let i = 0; i < 10; i++) {
    const rows = overrides?.[i] ?? defaults[i];
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult(rows as any[]));
  }
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/operator/metrics", () => {
  it("returns full metrics shape with all sections", async () => {
    mockAllQueries();

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("jobs_today");
    expect(data).toHaveProperty("agent_performance");
    expect(data).toHaveProperty("playbook_cache");
    expect(data).toHaveProperty("business");
    expect(data).toHaveProperty("problem_jobs");

    // Sub-structures
    expect(data.jobs_today).toHaveProperty("by_status");
    expect(data.jobs_today).toHaveProperty("by_service");
    expect(data.agent_performance).toHaveProperty("7d");
    expect(data.agent_performance).toHaveProperty("30d");
    expect(data.business).toHaveProperty("total_users");
    expect(data.business).toHaveProperty("active_jobs");
    expect(data.business).toHaveProperty("sats_in_30d");
    expect(data.business).toHaveProperty("total_debt");
  });

  it("returns empty arrays/objects when all queries return no rows", async () => {
    mockAllQueries();

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    expect(data.jobs_today.by_status).toEqual({});
    expect(data.jobs_today.by_service).toEqual([]);
    expect(data.agent_performance["7d"]).toEqual([]);
    expect(data.agent_performance["30d"]).toEqual([]);
    expect(data.playbook_cache).toEqual([]);
    expect(data.business.total_users).toBe(0);
    expect(data.business.active_jobs).toEqual({});
    expect(data.business.sats_in_30d).toBe(0);
    expect(data.business.total_debt).toBe(0);
    expect(data.problem_jobs).toEqual([]);
  });

  it("groups jobs today by status and by service", async () => {
    mockAllQueries({
      0: [
        { status: "pending", service_name: "Netflix", count: 3 },
        { status: "dispatched", service_name: "Netflix", count: 1 },
        { status: "pending", service_name: "Hulu", count: 2 },
        { status: "active", service_name: "Hulu", count: 1 },
      ],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    // by_status aggregates across services
    expect(data.jobs_today.by_status.pending).toBe(5);
    expect(data.jobs_today.by_status.dispatched).toBe(1);
    expect(data.jobs_today.by_status.active).toBe(1);

    // by_service breaks down per service
    expect(data.jobs_today.by_service).toHaveLength(2);
    const netflix = data.jobs_today.by_service.find(
      (s: { service: string }) => s.service === "Netflix"
    );
    expect(netflix.pending).toBe(3);
    expect(netflix.dispatched).toBe(1);
    expect(netflix.active).toBe(0);
    expect(netflix.completed_paid).toBe(0);

    const hulu = data.jobs_today.by_service.find(
      (s: { service: string }) => s.service === "Hulu"
    );
    expect(hulu.pending).toBe(2);
    expect(hulu.active).toBe(1);
  });

  it("transforms agent performance with success rate calculation", async () => {
    mockAllQueries({
      1: [
        {
          service_name: "Netflix",
          flow_type: "cancel",
          total: 10,
          succeeded: 8,
          avg_inference_steps: "3.2",
          avg_duration_seconds: "45",
          avg_steps: "5.5",
        },
      ],
      2: [
        {
          service_name: "Netflix",
          flow_type: "cancel",
          total: 50,
          succeeded: 40,
          avg_inference_steps: "3.0",
          avg_duration_seconds: "42",
          avg_steps: "5.2",
        },
      ],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    const perf7d = data.agent_performance["7d"][0];
    expect(perf7d.service_name).toBe("Netflix");
    expect(perf7d.flow_type).toBe("cancel");
    expect(perf7d.total).toBe(10);
    expect(perf7d.succeeded).toBe(8);
    expect(perf7d.success_rate).toBe(80);
    expect(perf7d.avg_inference_steps).toBe(3.2);
    expect(perf7d.avg_duration_seconds).toBe(45);
    expect(perf7d.avg_steps).toBe(5.5);

    const perf30d = data.agent_performance["30d"][0];
    expect(perf30d.success_rate).toBe(80);
    expect(perf30d.total).toBe(50);
  });

  it("calculates success_rate as 0 when total is 0", async () => {
    mockAllQueries({
      1: [
        {
          service_name: "Hulu",
          flow_type: "resume",
          total: 0,
          succeeded: 0,
          avg_inference_steps: "0",
          avg_duration_seconds: "0",
          avg_steps: "0",
        },
      ],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    expect(data.agent_performance["7d"][0].success_rate).toBe(0);
  });

  it("merges cache hit rates from 7d and 14d windows", async () => {
    mockAllQueries({
      3: [
        { service_name: "Netflix", cache_hit_pct: "72.5" },
        { service_name: "Hulu", cache_hit_pct: "60.0" },
      ],
      4: [
        { service_name: "Netflix", cache_hit_pct: "68.3" },
        { service_name: "Disney+", cache_hit_pct: "55.0" },
      ],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    expect(data.playbook_cache).toHaveLength(3);

    const netflix = data.playbook_cache.find(
      (c: { service_name: string }) => c.service_name === "Netflix"
    );
    expect(netflix.pct_7d).toBe(72.5);
    expect(netflix.pct_14d).toBe(68.3);

    // Hulu only has 7d data
    const hulu = data.playbook_cache.find(
      (c: { service_name: string }) => c.service_name === "Hulu"
    );
    expect(hulu.pct_7d).toBe(60.0);
    expect(hulu.pct_14d).toBe(0);

    // Disney+ only has 14d data
    const disney = data.playbook_cache.find(
      (c: { service_name: string }) => c.service_name === "Disney+"
    );
    expect(disney.pct_7d).toBe(0);
    expect(disney.pct_14d).toBe(55.0);
  });

  it("returns business metrics from scalar queries", async () => {
    mockAllQueries({
      5: [{ count: 42 }],
      6: [
        { status: "pending", count: 5 },
        { status: "dispatched", count: 3 },
      ],
      7: [{ sats_in: "150000" }],
      8: [{ total_debt: "9000" }],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    expect(data.business.total_users).toBe(42);
    expect(data.business.active_jobs.pending).toBe(5);
    expect(data.business.active_jobs.dispatched).toBe(3);
    expect(data.business.sats_in_30d).toBe(150000);
    expect(data.business.total_debt).toBe(9000);
  });

  it("handles null/missing scalar values gracefully", async () => {
    mockAllQueries({
      5: [],          // no rows at all
      7: [{ sats_in: null }],
      8: [{ total_debt: null }],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    expect(data.business.total_users).toBe(0);
    expect(data.business.sats_in_30d).toBe(0);
    expect(data.business.total_debt).toBe(0);
  });

  it("transforms problem jobs (dead letter) correctly", async () => {
    mockAllQueries({
      9: [
        {
          id: "job-1",
          service_name: "Netflix",
          flow_type: "cancel",
          status: "completed_reneged",
          status_updated_at: "2026-02-18T08:00:00Z",
        },
        {
          id: "job-2",
          service_name: "Hulu",
          flow_type: "resume",
          status: "user_abandon",
          status_updated_at: "2026-02-17T12:00:00Z",
        },
      ],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    expect(data.problem_jobs).toHaveLength(2);
    expect(data.problem_jobs[0]).toEqual({
      id: "job-1",
      service_name: "Netflix",
      flow_type: "cancel",
      status: "completed_reneged",
      status_updated_at: "2026-02-18T08:00:00Z",
    });
    expect(data.problem_jobs[1].status).toBe("user_abandon");
  });

  it("fires exactly 10 parallel queries", async () => {
    mockAllQueries();

    await GET(makeRequest() as any, { params: Promise.resolve({}) });

    expect(query).toHaveBeenCalledTimes(10);
  });

  it("returns 500 when a DB query fails", async () => {
    vi.mocked(query).mockRejectedValue(new Error("connection timeout"));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toMatch(/failed to fetch/i);
  });
});
