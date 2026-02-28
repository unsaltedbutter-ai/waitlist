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

const mockQuery = vi.mocked(query);

function makeRequest(jobId: string): Request {
  return new Request(`http://localhost/api/operator/jobs/${jobId}`, {
    method: "GET",
  });
}

const JOB_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";

const sampleJob = {
  id: JOB_ID,
  user_id: USER_ID,
  service_id: "netflix",
  action: "cancel",
  trigger: "scheduled",
  status: "completed_paid",
  status_updated_at: "2026-02-18T12:00:00Z",
  billing_date: "2026-03-01",
  access_end_date: "2026-02-28",
  outreach_count: 1,
  next_outreach_at: null,
  amount_sats: 3000,
  invoice_id: "inv-123",
  created_at: "2026-02-17T10:00:00Z",
};

const sampleUser = {
  id: USER_ID,
  nostr_npub: "abc123hex",
};

const sampleLog = {
  id: "log-1",
  flow_type: "cancel",
  success: true,
  duration_seconds: 45,
  step_count: 8,
  inference_count: 3,
  error_message: null,
  created_at: "2026-02-18T11:30:00Z",
};

const sampleTransaction = {
  id: "tx-1",
  amount_sats: 3000,
  status: "paid",
  created_at: "2026-02-18T12:00:00Z",
  paid_at: "2026-02-18T12:05:00Z",
};

const sampleHistory = {
  id: "hist-1",
  from_status: null,
  to_status: "pending",
  changed_by: "cron",
  created_at: "2026-02-17T10:00:00Z",
};

beforeEach(() => {
  mockQuery.mockReset();
});

describe("GET /api/operator/jobs/[id]", () => {
  it("returns 400 for invalid UUID format", async () => {
    const res = await GET(makeRequest("not-a-uuid") as any, {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid job ID");
  });

  it("returns 404 when job not found", async () => {
    // job query returns empty
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest(JOB_ID) as any, {
      params: Promise.resolve({ id: JOB_ID }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("Job not found");
  });

  it("returns complete job detail with all related data", async () => {
    // 1. job query
    mockQuery.mockResolvedValueOnce(mockQueryResult([sampleJob]));
    // 2. user query
    mockQuery.mockResolvedValueOnce(mockQueryResult([sampleUser]));
    // 3. action_logs query
    mockQuery.mockResolvedValueOnce(mockQueryResult([sampleLog]));
    // 4. transaction query
    mockQuery.mockResolvedValueOnce(mockQueryResult([sampleTransaction]));
    // 5. status_history query
    mockQuery.mockResolvedValueOnce(mockQueryResult([sampleHistory]));

    const res = await GET(makeRequest(JOB_ID) as any, {
      params: Promise.resolve({ id: JOB_ID }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.job).toEqual(sampleJob);
    expect(data.user).toEqual(sampleUser);
    expect(data.action_logs).toEqual([sampleLog]);
    expect(data.transaction).toEqual(sampleTransaction);
    expect(data.status_history).toEqual([sampleHistory]);
  });

  it("returns null transaction when none exists", async () => {
    mockQuery.mockResolvedValueOnce(mockQueryResult([sampleJob]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([sampleUser]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([])); // no transaction
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest(JOB_ID) as any, {
      params: Promise.resolve({ id: JOB_ID }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.transaction).toBeNull();
    expect(data.action_logs).toEqual([]);
    expect(data.status_history).toEqual([]);
  });

  it("returns null user when user has been deleted", async () => {
    mockQuery.mockResolvedValueOnce(mockQueryResult([sampleJob]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([])); // user deleted
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest(JOB_ID) as any, {
      params: Promise.resolve({ id: JOB_ID }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.user).toBeNull();
  });

  it("queries action_logs ordered by created_at ASC", async () => {
    mockQuery.mockResolvedValueOnce(mockQueryResult([sampleJob]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([sampleUser]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));

    await GET(makeRequest(JOB_ID) as any, {
      params: Promise.resolve({ id: JOB_ID }),
    });

    // Third query is action_logs
    const logsQuery = mockQuery.mock.calls[2][0] as string;
    expect(logsQuery).toContain("action_logs");
    expect(logsQuery).toContain("ORDER BY created_at ASC");
  });

  it("queries status_history ordered by created_at ASC", async () => {
    mockQuery.mockResolvedValueOnce(mockQueryResult([sampleJob]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([sampleUser]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));

    await GET(makeRequest(JOB_ID) as any, {
      params: Promise.resolve({ id: JOB_ID }),
    });

    // Fifth query is status_history
    const historyQuery = mockQuery.mock.calls[4][0] as string;
    expect(historyQuery).toContain("job_status_history");
    expect(historyQuery).toContain("ORDER BY created_at ASC");
  });

  it("passes the job_id to all related queries", async () => {
    mockQuery.mockResolvedValueOnce(mockQueryResult([sampleJob]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([sampleUser]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));
    mockQuery.mockResolvedValueOnce(mockQueryResult([]));

    await GET(makeRequest(JOB_ID) as any, {
      params: Promise.resolve({ id: JOB_ID }),
    });

    // Query 0: jobs WHERE id = $1
    expect(mockQuery.mock.calls[0][1]).toEqual([JOB_ID]);
    // Query 1: users WHERE id = $1 (user_id)
    expect(mockQuery.mock.calls[1][1]).toEqual([USER_ID]);
    // Query 2: action_logs WHERE job_id = $1
    expect(mockQuery.mock.calls[2][1]).toEqual([JOB_ID]);
    // Query 3: transactions WHERE job_id = $1
    expect(mockQuery.mock.calls[3][1]).toEqual([JOB_ID]);
    // Query 4: status_history WHERE job_id = $1
    expect(mockQuery.mock.calls[4][1]).toEqual([JOB_ID]);
  });
});
