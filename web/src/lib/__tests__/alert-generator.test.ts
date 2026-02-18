import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

vi.mock("@/lib/stuck-jobs", () => ({
  findStuckJobs: vi.fn(),
}));

vi.mock("@/lib/capacity", () => ({
  getActiveUserCount: vi.fn(),
  getUserCap: vi.fn().mockReturnValue(5000),
}));

import { query } from "@/lib/db";
import { findStuckJobs } from "@/lib/stuck-jobs";
import { getActiveUserCount, getUserCap } from "@/lib/capacity";
import { generateAlerts } from "@/lib/alert-generator";

const mockQuery = vi.mocked(query);
const mockFindStuckJobs = vi.mocked(findStuckJobs);
const mockGetActiveUserCount = vi.mocked(getActiveUserCount);

beforeEach(() => {
  mockQuery.mockReset();
  mockFindStuckJobs.mockReset();
  mockGetActiveUserCount.mockReset();

  // Defaults: no stuck jobs, low capacity, no debt
  mockFindStuckJobs.mockResolvedValue([]);
  mockGetActiveUserCount.mockResolvedValue(100);

  // Default query responses for dedup checks and debt query
  mockQuery.mockResolvedValue(mockQueryResult([]));
});

/** Mock the debt query (called after capacity check) */
function mockDebtQuery(totalDebt: number) {
  // The debt query is the last query call. We need to set it up properly.
  // After capacity check, the order is:
  //   - (optional capacity dedup check)
  //   - debt SUM query
  //   - (optional debt dedup check)
  // We mock all query calls to return empty by default, then override specific ones.
  mockQuery.mockImplementation(async (sql: string) => {
    if (typeof sql === "string" && sql.includes("SUM(debt_sats)")) {
      return mockQueryResult([{ total_debt: String(totalDebt) }]);
    }
    // Default: return empty (used for dedup checks and inserts)
    return mockQueryResult([]);
  });
}

describe("generateAlerts", () => {
  // --- No alerts scenario ---

  it("returns zeros when nothing is wrong", async () => {
    mockDebtQuery(0);

    const result = await generateAlerts();

    expect(result).toEqual({
      created: 0,
      stuck_jobs: 0,
      capacity_warning: false,
      debt_warning: false,
    });
  });

  // --- Stuck job alerts ---

  it("creates alerts for stuck jobs", async () => {
    mockFindStuckJobs.mockResolvedValue([
      {
        id: "job-1",
        service_id: "netflix",
        user_id: "user-1",
        status: "dispatched",
        status_updated_at: "2026-02-18T10:00:00Z",
        stuck_minutes: 150,
      },
    ]);
    mockDebtQuery(0);

    const result = await generateAlerts();

    expect(result.stuck_jobs).toBe(1);
    expect(result.created).toBe(1);

    // Verify the INSERT was called with correct alert data
    const insertCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO operator_alerts")
    );
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0][1]).toEqual([
      "stuck_job",
      "critical",
      "Stuck job: dispatched for 150m",
      expect.stringContaining("job-1"),
      "job-1",
      "user-1",
    ]);
  });

  it("deduplicates stuck job alerts (skips if unacknowledged alert exists)", async () => {
    mockFindStuckJobs.mockResolvedValue([
      {
        id: "job-1",
        service_id: "netflix",
        user_id: "user-1",
        status: "dispatched",
        status_updated_at: "2026-02-18T10:00:00Z",
        stuck_minutes: 150,
      },
    ]);

    // Return an existing alert for the dedup check, empty for everything else
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && sql.includes("operator_alerts") && sql.includes("SELECT") && sql.includes("stuck_job")) {
        return mockQueryResult([{ id: "existing-alert-id" }]);
      }
      if (typeof sql === "string" && sql.includes("SUM(debt_sats)")) {
        return mockQueryResult([{ total_debt: "0" }]);
      }
      return mockQueryResult([]);
    });

    const result = await generateAlerts();

    expect(result.stuck_jobs).toBe(1);
    expect(result.created).toBe(0);
  });

  it("creates alerts for multiple stuck jobs", async () => {
    mockFindStuckJobs.mockResolvedValue([
      {
        id: "job-1",
        service_id: "netflix",
        user_id: "user-1",
        status: "dispatched",
        status_updated_at: "2026-02-18T10:00:00Z",
        stuck_minutes: 150,
      },
      {
        id: "job-2",
        service_id: "hulu",
        user_id: "user-2",
        status: "active",
        status_updated_at: "2026-02-18T11:00:00Z",
        stuck_minutes: 45,
      },
    ]);
    mockDebtQuery(0);

    const result = await generateAlerts();

    expect(result.stuck_jobs).toBe(2);
    expect(result.created).toBe(2);
  });

  // --- Capacity warning ---

  it("creates capacity warning when > 90% full", async () => {
    mockGetActiveUserCount.mockResolvedValue(4600);
    mockDebtQuery(0);

    const result = await generateAlerts();

    expect(result.capacity_warning).toBe(true);
    expect(result.created).toBe(1);

    const insertCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO operator_alerts")
    );
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0][1]).toEqual([
      "capacity_warning",
      "warning",
      "Capacity at 92%",
      expect.stringContaining("4600"),
    ]);
  });

  it("does not create capacity warning at exactly 90%", async () => {
    mockGetActiveUserCount.mockResolvedValue(4500);
    mockDebtQuery(0);

    const result = await generateAlerts();

    expect(result.capacity_warning).toBe(false);
  });

  it("deduplicates capacity warning", async () => {
    mockGetActiveUserCount.mockResolvedValue(4600);

    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.includes("capacity_warning") && sql.includes("SELECT")) {
        return mockQueryResult([{ id: "existing-cap-alert" }]);
      }
      if (typeof sql === "string" && sql.includes("SUM(debt_sats)")) {
        return mockQueryResult([{ total_debt: "0" }]);
      }
      return mockQueryResult([]);
    });

    const result = await generateAlerts();

    expect(result.capacity_warning).toBe(false);
    expect(result.created).toBe(0);
  });

  // --- Debt warning ---

  it("creates debt warning when total debt > 100,000 sats", async () => {
    mockDebtQuery(150_000);

    const result = await generateAlerts();

    expect(result.debt_warning).toBe(true);
    expect(result.created).toBe(1);
  });

  it("does not create debt warning at exactly 100,000 sats", async () => {
    mockDebtQuery(100_000);

    const result = await generateAlerts();

    expect(result.debt_warning).toBe(false);
  });

  it("deduplicates debt warning", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.includes("SUM(debt_sats)")) {
        return mockQueryResult([{ total_debt: "200000" }]);
      }
      if (typeof sql === "string" && sql.includes("debt_warning") && sql.includes("SELECT")) {
        return mockQueryResult([{ id: "existing-debt-alert" }]);
      }
      return mockQueryResult([]);
    });

    const result = await generateAlerts();

    expect(result.debt_warning).toBe(false);
  });

  // --- Combined ---

  it("can create stuck, capacity, and debt alerts in a single run", async () => {
    mockFindStuckJobs.mockResolvedValue([
      {
        id: "job-1",
        service_id: "netflix",
        user_id: "user-1",
        status: "dispatched",
        status_updated_at: "2026-02-18T10:00:00Z",
        stuck_minutes: 150,
      },
    ]);
    mockGetActiveUserCount.mockResolvedValue(4700);
    mockDebtQuery(200_000);

    const result = await generateAlerts();

    expect(result.created).toBe(3);
    expect(result.stuck_jobs).toBe(1);
    expect(result.capacity_warning).toBe(true);
    expect(result.debt_warning).toBe(true);
  });
});
