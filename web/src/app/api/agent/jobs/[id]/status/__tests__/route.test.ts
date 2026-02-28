import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));
// No crypto mock needed: status route reads email_hash directly from DB
vi.mock("@/lib/agent-auth", () => ({
  withAgentAuth: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params
        ? await segmentData.params
        : undefined;
      const body = await req.text();
      return handler(req, { body, params });
    };
  }),
}));

import { query, transaction } from "@/lib/db";
import { PATCH } from "../route";

const JOB_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function makeRequest(body: object): Request {
  return new Request(`http://localhost/api/agent/jobs/${JOB_ID}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockJobLookup(status: string) {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([{
      id: JOB_ID,
      status,
    }])
  );
}

function mockAtomicUpdate(newStatus: string, overrides: Record<string, unknown> = {}) {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([{
      id: JOB_ID,
      user_id: "user-1",
      service_id: "netflix",
      action: "cancel",
      trigger: "scheduled",
      status: newStatus,
      billing_date: "2026-03-01",
      access_end_date: null,
      outreach_count: 0,
      next_outreach_at: null,
      amount_sats: null,
      invoice_id: null,
      created_at: "2026-02-15T05:00:00Z",
      status_updated_at: "2026-02-18T10:30:00Z",
      ...overrides,
    }])
  );
}

/** Simulate the atomic UPDATE returning 0 rows (concurrent change). */
function mockAtomicUpdateEmpty() {
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(transaction).mockReset();
});

describe("PATCH /api/agent/jobs/[id]/status", () => {
  // -- UUID validation --

  it("rejects non-UUID job ID with 400", async () => {
    const res = await PATCH(
      makeRequest({ status: "active" }) as any,
      { params: Promise.resolve({ id: "not-a-uuid" }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid job ID format");
  });

  it("rejects SQL-injection-style job ID", async () => {
    const res = await PATCH(
      makeRequest({ status: "active" }) as any,
      { params: Promise.resolve({ id: "'; DROP TABLE jobs;--" }) }
    );
    expect(res.status).toBe(400);
  });

  // -- amount_sats validation --

  it("rejects non-integer amount_sats", async () => {
    const res = await PATCH(
      makeRequest({ status: "completed_paid", amount_sats: 3.5 }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("amount_sats must be a positive integer");
  });

  it("rejects zero amount_sats", async () => {
    const res = await PATCH(
      makeRequest({ status: "completed_paid", amount_sats: 0 }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("amount_sats must be a positive integer");
  });

  it("rejects negative amount_sats", async () => {
    const res = await PATCH(
      makeRequest({ status: "completed_paid", amount_sats: -100 }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it("rejects NaN amount_sats", async () => {
    const req = new Request(`http://localhost/api/agent/jobs/${JOB_ID}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "completed_paid", amount_sats: "not_a_number" }),
    });
    // JSON.parse will turn "not_a_number" into a string, which is not an integer
    const res = await PATCH(req as any, { params: Promise.resolve({ id: JOB_ID }) });
    expect(res.status).toBe(400);
  });

  // -- Concurrent status change (409) --

  it("returns 409 when status changed concurrently", async () => {
    mockJobLookup("dispatched");
    // Atomic UPDATE returns 0 rows (another request changed the status)
    mockAtomicUpdateEmpty();
    // Re-read to distinguish 404 vs 409: job still exists
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "active" }])
    );

    const res = await PATCH(
      makeRequest({ status: "outreach_sent" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain("concurrently");
  });

  it("returns 404 when job deleted between SELECT and UPDATE", async () => {
    mockJobLookup("dispatched");
    // Atomic UPDATE returns 0 rows
    mockAtomicUpdateEmpty();
    // Re-read: job no longer exists
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await PATCH(
      makeRequest({ status: "outreach_sent" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(404);
  });

  // -- Valid transitions --

  it("dispatched -> outreach_sent", async () => {
    mockJobLookup("dispatched");
    mockAtomicUpdate("outreach_sent");

    const res = await PATCH(
      makeRequest({ status: "outreach_sent" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.status).toBe("outreach_sent");

    // Verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("dispatched");
  });

  it("dispatched -> active (on-demand jobs skip outreach)", async () => {
    mockJobLookup("dispatched");
    mockAtomicUpdate("active");

    const res = await PATCH(
      makeRequest({ status: "active" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.status).toBe("active");

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("dispatched");
  });

  it("dispatched -> implied_skip", async () => {
    mockJobLookup("dispatched");
    mockAtomicUpdate("implied_skip");

    const res = await PATCH(
      makeRequest({ status: "implied_skip" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.status).toBe("implied_skip");

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("dispatched");
  });

  it("outreach_sent -> snoozed", async () => {
    mockJobLookup("outreach_sent");
    mockAtomicUpdate("snoozed");

    const res = await PATCH(
      makeRequest({ status: "snoozed" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.status).toBe("snoozed");

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("outreach_sent");
  });

  it("outreach_sent -> active", async () => {
    mockJobLookup("outreach_sent");
    mockAtomicUpdate("active");

    const res = await PATCH(
      makeRequest({ status: "active" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.status).toBe("active");

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("outreach_sent");
  });

  it("outreach_sent -> user_skip", async () => {
    mockJobLookup("outreach_sent");
    mockAtomicUpdate("user_skip");

    const res = await PATCH(
      makeRequest({ status: "user_skip" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.status).toBe("user_skip");

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("outreach_sent");
  });

  it("snoozed -> dispatched", async () => {
    mockJobLookup("snoozed");
    mockAtomicUpdate("dispatched");

    const res = await PATCH(
      makeRequest({ status: "dispatched" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.status).toBe("dispatched");

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("snoozed");
  });

  it("active -> awaiting_otp", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("awaiting_otp");

    const res = await PATCH(
      makeRequest({ status: "awaiting_otp" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.status).toBe("awaiting_otp");

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("active");
  });

  it("active -> completed_paid", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_paid");

    const res = await PATCH(
      makeRequest({ status: "completed_paid" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.status).toBe("completed_paid");

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("active");
  });

  it("active -> completed_eventual", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_eventual");

    const res = await PATCH(
      makeRequest({ status: "completed_eventual" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("active");
  });

  it("active -> completed_reneged", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_reneged");

    const res = await PATCH(
      makeRequest({ status: "completed_reneged" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("active");
  });

  it("awaiting_otp -> active", async () => {
    mockJobLookup("awaiting_otp");
    mockAtomicUpdate("active");

    const res = await PATCH(
      makeRequest({ status: "active" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.status).toBe("active");

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("awaiting_otp");
  });

  it("awaiting_otp -> user_abandon", async () => {
    mockJobLookup("awaiting_otp");
    mockAtomicUpdate("user_abandon");

    const res = await PATCH(
      makeRequest({ status: "user_abandon" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("awaiting_otp");
  });

  it("awaiting_otp -> completed_paid", async () => {
    mockJobLookup("awaiting_otp");
    mockAtomicUpdate("completed_paid");

    const res = await PATCH(
      makeRequest({ status: "completed_paid" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("awaiting_otp");
  });

  it("awaiting_otp -> completed_eventual", async () => {
    mockJobLookup("awaiting_otp");
    mockAtomicUpdate("completed_eventual");

    const res = await PATCH(
      makeRequest({ status: "completed_eventual" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("awaiting_otp");
  });

  it("awaiting_otp -> completed_reneged", async () => {
    mockJobLookup("awaiting_otp");
    mockAtomicUpdate("completed_reneged");

    const res = await PATCH(
      makeRequest({ status: "completed_reneged" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    // Finding 2.3: verify atomic WHERE clause includes current status
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("AND status =");
    expect(updateCall[1]).toContain("awaiting_otp");
  });

  it("dispatched -> failed", async () => {
    mockJobLookup("dispatched");
    mockAtomicUpdate("failed");

    const res = await PATCH(
      makeRequest({ status: "failed" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.status).toBe("failed");
  });

  it("active -> failed", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("failed");

    const res = await PATCH(
      makeRequest({ status: "failed" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.status).toBe("failed");
  });

  it("awaiting_otp -> failed", async () => {
    mockJobLookup("awaiting_otp");
    mockAtomicUpdate("failed");

    const res = await PATCH(
      makeRequest({ status: "failed" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.status).toBe("failed");
  });

  it("failed -> anything returns 400 (terminal state)", async () => {
    mockJobLookup("failed");

    const res = await PATCH(
      makeRequest({ status: "active" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
  });

  // -- Invalid transitions --

  it("pending -> active returns 400", async () => {
    mockJobLookup("pending");

    const res = await PATCH(
      makeRequest({ status: "active" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid transition");
  });

  it("dispatched -> completed_paid returns 400", async () => {
    mockJobLookup("dispatched");

    const res = await PATCH(
      makeRequest({ status: "completed_paid" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it("completed_paid -> anything returns 400 (terminal state)", async () => {
    mockJobLookup("completed_paid");

    const res = await PATCH(
      makeRequest({ status: "active" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it("user_skip -> anything returns 400 (terminal state)", async () => {
    mockJobLookup("user_skip");

    const res = await PATCH(
      makeRequest({ status: "dispatched" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it("outreach_sent -> dispatched returns 400 (must go through snoozed)", async () => {
    mockJobLookup("outreach_sent");

    const res = await PATCH(
      makeRequest({ status: "dispatched" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
  });

  // -- Missing job --

  it("nonexistent job returns 404", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await PATCH(
      makeRequest({ status: "active" }) as any,
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) }
    );
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("not found");
  });

  // -- Metadata updates --

  it("updates next_outreach_at with status change", async () => {
    mockJobLookup("outreach_sent");
    mockAtomicUpdate("snoozed", { next_outreach_at: "2026-02-20T10:00:00Z" });

    const res = await PATCH(
      makeRequest({
        status: "snoozed",
        next_outreach_at: "2026-02-20T10:00:00Z",
      }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    // Verify the SQL includes next_outreach_at
    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("next_outreach_at");
    expect(updateCall[1]).toContain("2026-02-20T10:00:00Z");
  });

  it("updates outreach_count with status change", async () => {
    mockJobLookup("dispatched");
    mockAtomicUpdate("outreach_sent", { outreach_count: 2 });

    const res = await PATCH(
      makeRequest({ status: "outreach_sent", outreach_count: 2 }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("outreach_count");
    expect(updateCall[1]).toContain(2);
  });

  it("updates access_end_date with status change", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_paid", { access_end_date: "2026-03-15" });

    const res = await PATCH(
      makeRequest({
        status: "completed_paid",
        access_end_date: "2026-03-15",
      }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("access_end_date");
  });

  it("updates amount_sats with status change", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_reneged", { amount_sats: 3000 });

    // Mock transaction for the reneg path
    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
      return cb(txQuery as any);
    });

    const res = await PATCH(
      makeRequest({ status: "completed_reneged", amount_sats: 3000 }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("amount_sats");
    expect(updateCall[1]).toContain(3000);
  });

  it("updates billing_date with status change", async () => {
    mockJobLookup("dispatched");
    mockAtomicUpdate("outreach_sent", { billing_date: "2026-04-01" });

    const res = await PATCH(
      makeRequest({ status: "outreach_sent", billing_date: "2026-04-01" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    const updateCall = vi.mocked(query).mock.calls[1];
    const sql = updateCall[0] as string;
    expect(sql).toContain("billing_date");
  });

  // -- Missing / invalid body --

  it("invalid JSON returns 400", async () => {
    const req = new Request(`http://localhost/api/agent/jobs/${JOB_ID}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await PATCH(req as any, { params: Promise.resolve({ id: JOB_ID }) });
    expect(res.status).toBe(400);
  });

  it("missing status field returns 400", async () => {
    const res = await PATCH(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Missing status");
  });

  // -- Reneg path: completed_reneged with amount_sats inserts into reneged_emails --

  it("completed_reneged with amount_sats triggers reneg transaction", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_reneged", { amount_sats: 3000, user_id: "user-1", service_id: "netflix" });

    const capturedCalls: { sql: string; params: unknown[] }[] = [];
    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        capturedCalls.push({ sql, params });
        if (sql.includes("streaming_credentials")) {
          return mockQueryResult([{ email_hash: "hash_attacker@example.com" }]);
        }
        return mockQueryResult([]);
      });
      return cb(txQuery as any);
    });

    const res = await PATCH(
      makeRequest({ status: "completed_reneged", amount_sats: 3000 }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    expect(transaction).toHaveBeenCalledOnce();

    // Verify email_hash stored on job
    const jobHashCall = capturedCalls.find((c) => c.sql.includes("UPDATE jobs SET email_hash"));
    expect(jobHashCall).toBeTruthy();
    expect(jobHashCall!.params[0]).toBe(JOB_ID);
    expect(jobHashCall!.params[1]).toBe("hash_attacker@example.com");

    // Verify debt_sats incremented
    const debtCall = capturedCalls.find((c) => c.sql.includes("UPDATE users SET debt_sats"));
    expect(debtCall).toBeTruthy();
    expect(debtCall!.sql).toContain("debt_sats + $2");
    expect(debtCall!.params).toContain(3000);

    // Verify reneged_emails upsert
    const renegedCall = capturedCalls.find((c) => c.sql.includes("INSERT INTO reneged_emails"));
    expect(renegedCall).toBeTruthy();
    expect(renegedCall!.params[0]).toBe("hash_attacker@example.com");
    expect(renegedCall!.params[1]).toBe(3000);
  });

  it("completed_reneged without amount_sats skips reneg transaction", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_reneged", { amount_sats: null });

    const res = await PATCH(
      makeRequest({ status: "completed_reneged" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("completed_reneged does NOT insert into revenue_ledger (debt, not income)", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_reneged", { amount_sats: 3000, user_id: "user-1", service_id: "netflix" });

    const capturedCalls: { sql: string; params: unknown[] }[] = [];
    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        capturedCalls.push({ sql, params });
        if (sql.includes("streaming_credentials")) {
          return mockQueryResult([{ email_hash: "hash_test@example.com" }]);
        }
        return mockQueryResult([]);
      });
      return cb(txQuery as any);
    });

    const res = await PATCH(
      makeRequest({ status: "completed_reneged", amount_sats: 3000 }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    const ledgerCall = capturedCalls.find((c) => c.sql.includes("revenue_ledger"));
    expect(ledgerCall).toBeUndefined();
  });

  it("completed_reneged skips reneg when no credentials found", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_reneged", { amount_sats: 3000, user_id: "user-1", service_id: "netflix" });

    const capturedCalls: { sql: string; params: unknown[] }[] = [];
    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        capturedCalls.push({ sql, params });
        return mockQueryResult([]);
      });
      return cb(txQuery as any);
    });

    const res = await PATCH(
      makeRequest({ status: "completed_reneged", amount_sats: 3000 }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    // Only the credential lookup should have been called (no debt/reneged queries)
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].sql).toContain("streaming_credentials");
  });

  it("completed_reneged skips reneg when email_hash is null", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_reneged", { amount_sats: 3000, user_id: "user-1", service_id: "netflix" });

    const capturedCalls: { sql: string; params: unknown[] }[] = [];
    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        capturedCalls.push({ sql, params });
        if (sql.includes("streaming_credentials")) {
          return mockQueryResult([{ email_hash: null }]);
        }
        return mockQueryResult([]);
      });
      return cb(txQuery as any);
    });

    const res = await PATCH(
      makeRequest({ status: "completed_reneged", amount_sats: 3000 }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    // Only the credential lookup should have been called
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].sql).toContain("streaming_credentials");
  });

  // -- Rotation queue next_billing_date updates --

  it("cancel completion sets next_billing_date to NULL", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_paid", { action: "cancel", user_id: "user-1", service_id: "netflix", access_end_date: "2026-03-15" });

    const res = await PATCH(
      makeRequest({ status: "completed_paid", access_end_date: "2026-03-15" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    // Find the rotation_queue UPDATE call (after job lookup, atomic update, recordStatusChange)
    const calls = vi.mocked(query).mock.calls;
    const rqCall = calls.find((c) =>
      typeof c[0] === "string" && (c[0] as string).includes("rotation_queue") && (c[0] as string).includes("NULL")
    );
    expect(rqCall).toBeTruthy();
    expect(rqCall![0]).toContain("next_billing_date = NULL");
    expect(rqCall![1]).toEqual(["user-1", "netflix"]);
  });

  it("resume completion sets next_billing_date to CURRENT_DATE + 30", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_paid", { action: "resume", user_id: "user-1", service_id: "hulu" });

    const res = await PATCH(
      makeRequest({ status: "completed_paid" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    const calls = vi.mocked(query).mock.calls;
    const rqCall = calls.find((c) =>
      typeof c[0] === "string" && (c[0] as string).includes("rotation_queue") && (c[0] as string).includes("CURRENT_DATE + 30")
    );
    expect(rqCall).toBeTruthy();
    expect(rqCall![1]).toEqual(["user-1", "hulu"]);
  });

  it("user_skip on cancel job advances next_billing_date by 30 days", async () => {
    mockJobLookup("outreach_sent");
    mockAtomicUpdate("user_skip", { action: "cancel", user_id: "user-1", service_id: "netflix" });

    const res = await PATCH(
      makeRequest({ status: "user_skip" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    const calls = vi.mocked(query).mock.calls;
    const rqCall = calls.find((c) =>
      typeof c[0] === "string" && (c[0] as string).includes("rotation_queue") && (c[0] as string).includes("next_billing_date + 30")
    );
    expect(rqCall).toBeTruthy();
    expect(rqCall![1]).toEqual(["user-1", "netflix"]);
  });

  it("implied_skip on cancel job advances next_billing_date by 30 days", async () => {
    mockJobLookup("dispatched");
    mockAtomicUpdate("implied_skip", { action: "cancel", user_id: "user-1", service_id: "netflix" });

    const res = await PATCH(
      makeRequest({ status: "implied_skip" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    const calls = vi.mocked(query).mock.calls;
    const rqCall = calls.find((c) =>
      typeof c[0] === "string" && (c[0] as string).includes("rotation_queue") && (c[0] as string).includes("next_billing_date + 30")
    );
    expect(rqCall).toBeTruthy();
  });

  it("user_skip on resume job does not update rotation_queue", async () => {
    mockJobLookup("outreach_sent");
    mockAtomicUpdate("user_skip", { action: "resume", user_id: "user-1", service_id: "netflix" });

    const res = await PATCH(
      makeRequest({ status: "user_skip" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    const calls = vi.mocked(query).mock.calls;
    const rqCall = calls.find((c) =>
      typeof c[0] === "string" && (c[0] as string).includes("rotation_queue")
    );
    expect(rqCall).toBeUndefined();
  });

  it("failed status does not update rotation_queue", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("failed", { action: "cancel", user_id: "user-1", service_id: "netflix" });

    const res = await PATCH(
      makeRequest({ status: "failed" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    const calls = vi.mocked(query).mock.calls;
    const rqCall = calls.find((c) =>
      typeof c[0] === "string" && (c[0] as string).includes("rotation_queue")
    );
    expect(rqCall).toBeUndefined();
  });

  // -- access_end_date fallback --

  it("cancel completion without access_end_date defaults to CURRENT_DATE + 14 days and marks approximate", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_paid", { action: "cancel", user_id: "user-1", service_id: "netflix", access_end_date: null });

    const res = await PATCH(
      makeRequest({ status: "completed_paid" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    const calls = vi.mocked(query).mock.calls;
    const fallbackCall = calls.find((c) =>
      typeof c[0] === "string" && (c[0] as string).includes("access_end_date") && (c[0] as string).includes("14 days")
    );
    expect(fallbackCall).toBeTruthy();
    expect(fallbackCall![1]).toEqual([JOB_ID]);
    // Verify approximate flag is set in the same UPDATE
    expect(fallbackCall![0]).toContain("access_end_date_approximate = true");
  });

  it("cancel completion with access_end_date does not apply fallback", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_paid", { action: "cancel", user_id: "user-1", service_id: "netflix", access_end_date: "2026-03-15" });

    const res = await PATCH(
      makeRequest({ status: "completed_paid", access_end_date: "2026-03-15" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    const calls = vi.mocked(query).mock.calls;
    const fallbackCall = calls.find((c) =>
      typeof c[0] === "string" && (c[0] as string).includes("14 days")
    );
    expect(fallbackCall).toBeUndefined();
  });

  it("resume completion does not apply access_end_date fallback", async () => {
    mockJobLookup("active");
    mockAtomicUpdate("completed_paid", { action: "resume", user_id: "user-1", service_id: "netflix", access_end_date: null });

    const res = await PATCH(
      makeRequest({ status: "completed_paid" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    const calls = vi.mocked(query).mock.calls;
    const fallbackCall = calls.find((c) =>
      typeof c[0] === "string" && (c[0] as string).includes("14 days")
    );
    expect(fallbackCall).toBeUndefined();
  });
});
