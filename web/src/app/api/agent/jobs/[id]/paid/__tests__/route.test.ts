import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));
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

import { transaction } from "@/lib/db";
import { POST } from "../route";

const JOB_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function makeRequest(body: object = {}): Request {
  return new Request(`http://localhost/api/agent/jobs/${JOB_ID}/paid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeJobRow(
  status: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: JOB_ID,
    user_id: "user-1",
    service_id: "netflix",
    action: "cancel",
    trigger: "scheduled",
    status,
    amount_sats: 3000,
    invoice_id: "inv-123",
    billing_date: "2026-03-01",
    access_end_date: "2026-03-15",
    outreach_count: 1,
    next_outreach_at: null,
    created_at: "2026-02-15T05:00:00Z",
    status_updated_at: "2026-02-18T10:00:00Z",
    ...overrides,
  };
}

/**
 * Sets up the transaction mock so that the callback receives a txQuery
 * that returns the given rows for the first call (SELECT FOR UPDATE),
 * and captures all subsequent calls for assertion.
 */
function mockTx(
  jobRow: ReturnType<typeof makeJobRow> | null,
  updatedOverrides: Record<string, unknown> = {}
) {
  const capturedCalls: { sql: string; params: unknown[] }[] = [];

  vi.mocked(transaction).mockImplementationOnce(async (cb) => {
    const txQuery = vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      capturedCalls.push({ sql, params });

      // First call is the SELECT FOR UPDATE
      if (capturedCalls.length === 1) {
        return mockQueryResult(jobRow ? [jobRow] : []);
      }

      // Second call is UPDATE jobs ... RETURNING *
      if (capturedCalls.length === 2 && sql.includes("UPDATE jobs")) {
        const updatedRow = {
          ...(jobRow || {}),
          ...updatedOverrides,
          status_updated_at: "2026-02-18T12:00:00Z",
        };
        return mockQueryResult([updatedRow]);
      }

      return mockQueryResult([]);
    });
    return cb(txQuery as any);
  });

  return capturedCalls;
}

beforeEach(() => {
  vi.mocked(transaction).mockReset();
});

describe("POST /api/agent/jobs/[id]/paid", () => {
  // -- UUID validation --

  it("rejects non-UUID job ID with 400", async () => {
    const res = await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: "not-a-uuid" }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid job ID format");
  });

  it("rejects SQL-injection-style job ID", async () => {
    const res = await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: "1; DROP TABLE jobs;--" }) }
    );
    expect(res.status).toBe(400);
  });

  // -- Concurrent payment (double-decrement prevention) --

  it("prevents double payment via FOR UPDATE lock", async () => {
    const jobRow = makeJobRow("completed_reneged", { amount_sats: 3000 });
    const captured = mockTx(jobRow, { status: "completed_eventual" });

    const res = await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);

    // Verify the SELECT uses FOR UPDATE
    expect(captured[0].sql).toContain("FOR UPDATE");
  });

  // -- Normal flows --

  it("reneged job converts to completed_eventual with debt reduction", async () => {
    const jobRow = makeJobRow("completed_reneged", { amount_sats: 3000 });
    const captured = mockTx(jobRow, { status: "completed_eventual" });

    const res = await POST(
      makeRequest({ zap_event_id: "zap-abc" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.job.status).toBe("completed_eventual");

    expect(transaction).toHaveBeenCalledOnce();

    // Verify debt decrement happened
    const debtCall = captured.find((c) => c.sql.includes("debt_sats"));
    expect(debtCall).toBeTruthy();
    expect(debtCall!.sql).toContain("GREATEST(0, debt_sats - $2)");
    expect(debtCall!.params).toContain(3000);
    expect(debtCall!.params).toContain("user-1");
  });

  it("invoice payment marks as completed_paid", async () => {
    const jobRow = makeJobRow("active", { invoice_id: "inv-456", amount_sats: 3000 });
    const captured = mockTx(jobRow, { status: "completed_paid" });

    const res = await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.job.status).toBe("completed_paid");

    // Verify the transaction row status is "paid"
    const txnCall = captured.find((c) => c.sql.includes("UPDATE transactions"));
    expect(txnCall).toBeTruthy();
    expect(txnCall!.params).toContain("paid");
  });

  it("already-paid job (completed_paid) returns 409", async () => {
    const jobRow = makeJobRow("completed_paid");
    mockTx(jobRow);

    const res = await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain("Already paid");
  });

  it("already-paid job (completed_eventual) returns 409", async () => {
    const jobRow = makeJobRow("completed_eventual");
    mockTx(jobRow);

    const res = await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain("Already paid");
  });

  it("job not found returns 404", async () => {
    mockTx(null);

    const res = await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("not found");
  });

  it("job without invoice and not reneged returns 400", async () => {
    const jobRow = makeJobRow("active", { invoice_id: null });
    mockTx(jobRow);

    const res = await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("not in a payable state");
  });

  it("debt_sats properly decremented for reneged job", async () => {
    const jobRow = makeJobRow("completed_reneged", { amount_sats: 3000 });
    const captured = mockTx(jobRow, { status: "completed_eventual" });

    await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );

    const debtCall = captured.find((c) => c.sql.includes("debt_sats"));
    expect(debtCall).toBeTruthy();
    expect(debtCall!.sql).toContain("GREATEST(0, debt_sats - $2)");
    expect(debtCall!.params).toContain(3000);
    expect(debtCall!.params).toContain("user-1");
  });

  it("skips debt decrement when amount_sats is null", async () => {
    const jobRow = makeJobRow("completed_reneged", { amount_sats: null });
    const captured = mockTx(jobRow, { status: "completed_eventual" });

    await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );

    const debtCall = captured.find((c) => c.sql.includes("debt_sats"));
    expect(debtCall).toBeUndefined();
  });

  it("transaction updates transaction row status to eventual for reneged", async () => {
    const jobRow = makeJobRow("completed_reneged", { amount_sats: 3000 });
    const captured = mockTx(jobRow, { status: "completed_eventual" });

    await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );

    const txnCall = captured.find((c) => c.sql.includes("UPDATE transactions"));
    expect(txnCall).toBeTruthy();
    expect(txnCall!.params).toContain("eventual");
  });

  it("transaction updates transaction row status to paid for invoice payment", async () => {
    const jobRow = makeJobRow("active", { invoice_id: "inv-456", amount_sats: 3000 });
    const captured = mockTx(jobRow, { status: "completed_paid" });

    await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );

    const txnCall = captured.find((c) => c.sql.includes("UPDATE transactions"));
    expect(txnCall).toBeTruthy();
    expect(txnCall!.params).toContain("paid");
  });

  it("invalid JSON returns 400", async () => {
    const req = new Request(`http://localhost/api/agent/jobs/${JOB_ID}/paid`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json{",
    });
    const res = await POST(req as any, { params: Promise.resolve({ id: JOB_ID }) });
    expect(res.status).toBe(400);
  });
});
