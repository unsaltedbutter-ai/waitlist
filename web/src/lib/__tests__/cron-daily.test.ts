import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

vi.mock("@/lib/nostr-push", () => ({
  pushJobsReady: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/job-history", () => ({
  recordStatusChange: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/alert-generator", () => ({
  generateAlerts: vi.fn().mockResolvedValue({ created: 0, stuck_jobs: 0, capacity_warning: false, debt_warning: false }),
}));

import { query } from "@/lib/db";
import { pushJobsReady } from "@/lib/nostr-push";
import { recordStatusChange } from "@/lib/job-history";
import { generateAlerts } from "@/lib/alert-generator";
import { runDailyCron } from "@/lib/cron-daily";

const mockQuery = vi.mocked(query);
const mockPushJobsReady = vi.mocked(pushJobsReady);

beforeEach(() => {
  mockQuery.mockReset();
  mockPushJobsReady.mockReset();
  mockPushJobsReady.mockResolvedValue(undefined);
});

/**
 * Execution order of queries in runDailyCron:
 *   1. findUpcomingCancels
 *   2. createJob for each cancel candidate (one query per candidate)
 *   3. findUpcomingResumes
 *   4. createJob for each resume candidate (one query per candidate)
 *   5. findStaleJobs
 *   6. countDebtUsers
 *   7. pruneOldRecords (4 parallel DELETEs via Promise.all)
 *
 * Mock helpers must be called in this exact order to match.
 */

type CancelRow = { user_id: string; service_id: string; billing_date: string };
type ResumeRow = { user_id: string; service_id: string };

function mockQueryOnce<T extends Record<string, unknown>>(rows: T[]) {
  mockQuery.mockResolvedValueOnce(mockQueryResult(rows));
}

/**
 * Set up all mocks for a full runDailyCron execution.
 * Mocks are pushed in the exact order the queries execute.
 */
function setupMocks(opts: {
  cancelCandidates?: CancelRow[];
  resumeCandidates?: ResumeRow[];
  cancelJobIds?: string[];
  resumeJobIds?: string[];
  staleJobIds?: string[];
  debtUserCount?: number;
}) {
  const cancels = opts.cancelCandidates ?? [];
  const resumes = opts.resumeCandidates ?? [];
  const cancelIds = opts.cancelJobIds ?? cancels.map((_, i) => `cancel-job-${i + 1}`);
  const resumeIds = opts.resumeJobIds ?? resumes.map((_, i) => `resume-job-${i + 1}`);
  const staleIds = opts.staleJobIds ?? [];
  const debtCount = opts.debtUserCount ?? 0;

  // 1. findUpcomingCancels
  mockQueryOnce(cancels);

  // 2. createJob for each cancel
  for (const id of cancelIds) {
    mockQueryOnce([{ id }]);
  }

  // 3. findUpcomingResumes
  mockQueryOnce(resumes);

  // 4. createJob for each resume
  for (const id of resumeIds) {
    mockQueryOnce([{ id }]);
  }

  // 5. findStaleJobs
  mockQueryOnce(staleIds.map((id) => ({ id })));

  // 6. countDebtUsers
  mockQueryOnce([{ count: String(debtCount) }]);

  // 7. pruneOldRecords (4 parallel DELETEs)
  for (let i = 0; i < 4; i++) {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: "DELETE", oid: 0, fields: [] } as any);
  }
}

describe("runDailyCron", () => {
  it("returns zeroes when no upcoming billing dates", async () => {
    setupMocks({});

    const result = await runDailyCron();

    expect(result).toEqual({
      jobs_created: 0,
      nudged: 0,
      skipped_debt: 0,
      alerts_created: 0,
      pruned: { action_logs: 0, job_status_history: 0, operator_alerts: 0, operator_audit_log: 0 },
    });
  });

  it("does not call pushJobsReady when no jobs are created and no stale jobs", async () => {
    setupMocks({});

    await runDailyCron();

    expect(mockPushJobsReady).not.toHaveBeenCalled();
  });

  it("creates cancel jobs for users with billing dates within 14 days", async () => {
    setupMocks({
      cancelCandidates: [
        { user_id: "user-1", service_id: "netflix", billing_date: "2026-03-01" },
        { user_id: "user-2", service_id: "hulu", billing_date: "2026-03-02" },
      ],
      cancelJobIds: ["job-cancel-1", "job-cancel-2"],
    });

    const result = await runDailyCron();

    expect(result.jobs_created).toBe(2);

    // call 0 = findUpcomingCancels, call 1 = createJob(user-1), call 2 = createJob(user-2)
    const insertCall1 = mockQuery.mock.calls[1];
    expect(insertCall1[0]).toContain("INSERT INTO jobs");
    expect(insertCall1[1]).toEqual([
      "user-1",
      "netflix",
      "cancel",
      "2026-03-01",
    ]);

    const insertCall2 = mockQuery.mock.calls[2];
    expect(insertCall2[0]).toContain("INSERT INTO jobs");
    expect(insertCall2[1]).toEqual([
      "user-2",
      "hulu",
      "cancel",
      "2026-03-02",
    ]);
  });

  it("creates resume jobs for users with access_end_date within 7 days", async () => {
    setupMocks({
      resumeCandidates: [
        { user_id: "user-3", service_id: "disney_plus" },
      ],
      resumeJobIds: ["job-resume-1"],
    });

    const result = await runDailyCron();

    expect(result.jobs_created).toBe(1);

    // call 0 = findUpcomingCancels, call 1 = findUpcomingResumes, call 2 = createJob
    const insertCall = mockQuery.mock.calls[2];
    expect(insertCall[0]).toContain("INSERT INTO jobs");
    expect(insertCall[1]).toEqual(["user-3", "disney_plus", "resume", null]);
  });

  it("creates both cancel and resume jobs in the same run", async () => {
    setupMocks({
      cancelCandidates: [
        { user_id: "user-1", service_id: "netflix", billing_date: "2026-03-01" },
      ],
      cancelJobIds: ["job-c1"],
      resumeCandidates: [
        { user_id: "user-2", service_id: "hulu" },
      ],
      resumeJobIds: ["job-r1"],
    });

    const result = await runDailyCron();

    expect(result.jobs_created).toBe(2);
  });

  it("sends pushJobsReady with all created job IDs", async () => {
    setupMocks({
      cancelCandidates: [
        { user_id: "user-1", service_id: "netflix", billing_date: "2026-03-01" },
      ],
      cancelJobIds: ["job-c1"],
      resumeCandidates: [
        { user_id: "user-2", service_id: "hulu" },
      ],
      resumeJobIds: ["job-r1"],
    });

    await runDailyCron();

    // First call has all newly created job IDs
    expect(mockPushJobsReady).toHaveBeenCalledWith(["job-c1", "job-r1"]);
  });

  it("nudges stale pending jobs older than 1 hour", async () => {
    setupMocks({
      staleJobIds: ["stale-1", "stale-2"],
    });

    const result = await runDailyCron();

    expect(result.nudged).toBe(2);
    expect(mockPushJobsReady).toHaveBeenCalledWith(["stale-1", "stale-2"]);
  });

  it("sends separate pushJobsReady calls for new and stale jobs", async () => {
    setupMocks({
      cancelCandidates: [
        { user_id: "user-1", service_id: "netflix", billing_date: "2026-03-01" },
      ],
      cancelJobIds: ["new-job-1"],
      staleJobIds: ["stale-1"],
    });

    await runDailyCron();

    expect(mockPushJobsReady).toHaveBeenCalledTimes(2);
    expect(mockPushJobsReady).toHaveBeenNthCalledWith(1, ["new-job-1"]);
    expect(mockPushJobsReady).toHaveBeenNthCalledWith(2, ["stale-1"]);
  });

  it("reports skipped_debt count from users with debt", async () => {
    setupMocks({
      debtUserCount: 3,
    });

    const result = await runDailyCron();

    expect(result.skipped_debt).toBe(3);
  });

  it("cancel query reads from rotation_queue.next_billing_date", async () => {
    setupMocks({});

    await runDailyCron();

    const cancelQuery = mockQuery.mock.calls[0][0] as string;
    expect(cancelQuery).toContain("rotation_queue");
    expect(cancelQuery).toContain("next_billing_date");
  });

  it("idempotency: the cancel query excludes users with existing non-terminal jobs", async () => {
    setupMocks({});

    await runDailyCron();

    const cancelQuery = mockQuery.mock.calls[0][0] as string;
    expect(cancelQuery).toContain("NOT EXISTS");
    expect(cancelQuery).toContain("status NOT IN");
  });

  it("idempotency: the resume query excludes users with existing non-terminal jobs", async () => {
    setupMocks({});

    await runDailyCron();

    // call 0 = findUpcomingCancels, call 1 = findUpcomingResumes
    const resumeQuery = mockQuery.mock.calls[1][0] as string;
    expect(resumeQuery).toContain("NOT EXISTS");
    expect(resumeQuery).toContain("status NOT IN");
  });

  it("cancel query filters for debt_sats = 0", async () => {
    setupMocks({});

    await runDailyCron();

    const cancelQuery = mockQuery.mock.calls[0][0] as string;
    expect(cancelQuery).toContain("debt_sats = 0");
  });

  it("resume query filters for debt_sats = 0", async () => {
    setupMocks({});

    await runDailyCron();

    const resumeQuery = mockQuery.mock.calls[1][0] as string;
    expect(resumeQuery).toContain("debt_sats = 0");
  });

  it("cancel query filters for next_billing_date within 14 days", async () => {
    setupMocks({});

    await runDailyCron();

    const cancelQuery = mockQuery.mock.calls[0][0] as string;
    expect(cancelQuery).toContain("next_billing_date");
    expect(cancelQuery).toContain("14 days");
  });

  it("resume query filters for access_end_date within 7 days", async () => {
    setupMocks({});

    await runDailyCron();

    const resumeQuery = mockQuery.mock.calls[1][0] as string;
    expect(resumeQuery).toContain("7 days");
  });

  it("stale jobs query checks for pending status and 1 hour age", async () => {
    setupMocks({});

    await runDailyCron();

    // call 0 = findCancels, call 1 = findResumes, call 2 = findStaleJobs
    const staleQuery = mockQuery.mock.calls[2][0] as string;
    expect(staleQuery).toContain("status = 'pending'");
    expect(staleQuery).toContain("1 hour");
  });

  it("cancel jobs are created with trigger='scheduled'", async () => {
    setupMocks({
      cancelCandidates: [
        { user_id: "user-1", service_id: "netflix", billing_date: "2026-03-01" },
      ],
      cancelJobIds: ["job-1"],
    });

    await runDailyCron();

    // call 0 = findCancels, call 1 = createJob INSERT
    const insertSQL = mockQuery.mock.calls[1][0] as string;
    expect(insertSQL).toContain("'scheduled'");
    expect(insertSQL).toContain("'pending'");
  });

  it("handles users with no next_billing_date (returns no cancel candidates)", async () => {
    // When rotation_queue entries have NULL next_billing_date, the cancel
    // query returns nothing. Correct behavior: no billing date means
    // nothing to schedule against.
    setupMocks({});

    const result = await runDailyCron();

    expect(result.jobs_created).toBe(0);
  });

  it("passes terminal statuses as query parameters", async () => {
    setupMocks({});

    await runDailyCron();

    const cancelParams = mockQuery.mock.calls[0][1] as string[];
    expect(cancelParams).toContain("completed_paid");
    expect(cancelParams).toContain("completed_eventual");
    expect(cancelParams).toContain("completed_reneged");
    expect(cancelParams).toContain("user_skip");
    expect(cancelParams).toContain("user_abandon");
    expect(cancelParams).toContain("implied_skip");
    expect(cancelParams).toContain("failed");
  });

  it("cancel query only considers onboarded users", async () => {
    setupMocks({});

    await runDailyCron();

    const cancelQuery = mockQuery.mock.calls[0][0] as string;
    expect(cancelQuery).toContain("onboarded_at IS NOT NULL");
  });

  it("resume query uses rotation_queue position 1", async () => {
    setupMocks({});

    await runDailyCron();

    const resumeQuery = mockQuery.mock.calls[1][0] as string;
    expect(resumeQuery).toContain("position = 1");
  });

  it("prunes old records from all four audit tables", async () => {
    setupMocks({});

    await runDailyCron();

    // After the 6 standard queries (cancels, resumes, stale, debt),
    // the next 4 are the prune DELETEs (parallel via Promise.all)
    const pruneStartIndex = 4; // 1 cancel + 1 resume + 1 stale + 1 debt = 4
    const pruneCalls = mockQuery.mock.calls.slice(pruneStartIndex, pruneStartIndex + 4);

    const pruneQueries = pruneCalls.map((c) => c[0] as string);
    expect(pruneQueries).toContainEqual(expect.stringContaining("DELETE FROM action_logs"));
    expect(pruneQueries).toContainEqual(expect.stringContaining("DELETE FROM job_status_history"));
    expect(pruneQueries).toContainEqual(expect.stringContaining("DELETE FROM operator_alerts"));
    expect(pruneQueries).toContainEqual(expect.stringContaining("DELETE FROM operator_audit_log"));
  });

  it("prune queries use 180-day retention interval", async () => {
    setupMocks({});

    await runDailyCron();

    const pruneStartIndex = 4;
    const pruneCalls = mockQuery.mock.calls.slice(pruneStartIndex, pruneStartIndex + 4);

    for (const call of pruneCalls) {
      expect(call[1]).toEqual(["180 days"]);
    }
  });

  it("returns prune counts in the result", async () => {
    // Override the prune mocks to return non-zero rowCounts
    mockQuery.mockReset();
    mockPushJobsReady.mockResolvedValue(undefined);

    // Standard queries (no candidates)
    mockQueryOnce([]); // findUpcomingCancels
    mockQueryOnce([]); // findUpcomingResumes
    mockQueryOnce([]); // findStaleJobs
    mockQueryOnce([{ count: "0" }]); // countDebtUsers

    // Prune queries with non-zero rowCounts
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 5, command: "DELETE", oid: 0, fields: [] } as any);
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 12, command: "DELETE", oid: 0, fields: [] } as any);
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 3, command: "DELETE", oid: 0, fields: [] } as any);
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1, command: "DELETE", oid: 0, fields: [] } as any);

    const result = await runDailyCron();

    // Promise.all ordering matches the source order in pruneOldRecords
    expect(result.pruned.action_logs).toBe(5);
    expect(result.pruned.job_status_history).toBe(12);
    expect(result.pruned.operator_alerts).toBe(3);
    expect(result.pruned.operator_audit_log).toBe(1);
  });
});
