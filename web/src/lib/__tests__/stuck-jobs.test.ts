import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { query } from "@/lib/db";
import { findStuckJobs, STUCK_THRESHOLDS } from "@/lib/stuck-jobs";

const mockQuery = vi.mocked(query);

beforeEach(() => {
  mockQuery.mockReset();
});

describe("findStuckJobs", () => {
  it("returns empty array when no jobs are stuck", async () => {
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));

    const result = await findStuckJobs();

    expect(result).toEqual([]);
  });

  it("returns stuck jobs with correct fields", async () => {
    mockQuery.mockResolvedValueOnce(
      mockQueryResult([
        {
          id: "job-1",
          service_id: "netflix",
          user_id: "user-1",
          status: "dispatched",
          status_updated_at: "2026-02-18T10:00:00Z",
          stuck_minutes: "150",
        },
        {
          id: "job-2",
          service_id: "hulu",
          user_id: "user-2",
          status: "active",
          status_updated_at: "2026-02-18T11:00:00Z",
          stuck_minutes: "45",
        },
      ])
    );

    const result = await findStuckJobs();

    expect(result).toEqual([
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
  });

  it("queries all four stuck statuses via params", async () => {
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));

    await findStuckJobs();

    // Status names are parameterized, not embedded in SQL
    const params = mockQuery.mock.calls[0][1] as string[];
    expect(params).toContain("dispatched");
    expect(params).toContain("active");
    expect(params).toContain("awaiting_otp");
    expect(params).toContain("outreach_sent");

    // SQL should have UNION ALL for the four statuses
    const sql = mockQuery.mock.calls[0][0] as string;
    const unionCount = (sql.match(/UNION ALL/g) || []).length;
    expect(unionCount).toBe(3); // 4 queries joined by 3 UNION ALLs
  });

  it("passes correct threshold parameters", async () => {
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));

    await findStuckJobs();

    const params = mockQuery.mock.calls[0][1] as string[];
    // Should contain status/minutes pairs for each threshold
    expect(params).toContain("dispatched");
    expect(params).toContain("120");
    expect(params).toContain("active");
    expect(params).toContain("30");
    expect(params).toContain("awaiting_otp");
    expect(params).toContain("20");
    expect(params).toContain("outreach_sent");
    expect(params).toContain("4320");
  });

  it("orders results by stuck_minutes descending", async () => {
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));

    await findStuckJobs();

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("ORDER BY stuck_minutes DESC");
  });

  it("parses stuck_minutes as integers", async () => {
    mockQuery.mockResolvedValueOnce(
      mockQueryResult([
        {
          id: "job-1",
          service_id: "netflix",
          user_id: "user-1",
          status: "dispatched",
          status_updated_at: "2026-02-18T10:00:00Z",
          stuck_minutes: "999",
        },
      ])
    );

    const result = await findStuckJobs();

    expect(typeof result[0].stuck_minutes).toBe("number");
    expect(result[0].stuck_minutes).toBe(999);
  });

  it("has correct threshold values", () => {
    expect(STUCK_THRESHOLDS.dispatched).toBe(120);
    expect(STUCK_THRESHOLDS.active).toBe(30);
    expect(STUCK_THRESHOLDS.awaiting_otp).toBe(20);
    expect(STUCK_THRESHOLDS.outreach_sent).toBe(4320);
  });
});
