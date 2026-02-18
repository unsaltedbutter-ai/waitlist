import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { transaction } from "@/lib/db";
import { confirmJobPayment } from "@/lib/confirm-payment";

const JOB_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

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
    email_hash: null as string | null,
    billing_date: "2026-03-01",
    access_end_date: "2026-03-15",
    outreach_count: 1,
    next_outreach_at: null,
    created_at: "2026-02-15T05:00:00Z",
    status_updated_at: "2026-02-18T10:00:00Z",
    ...overrides,
  };
}

function mockTx(
  jobRow: ReturnType<typeof makeJobRow> | null,
  updatedOverrides: Record<string, unknown> = {}
) {
  const capturedCalls: { sql: string; params: unknown[] }[] = [];

  vi.mocked(transaction).mockImplementationOnce(async (cb) => {
    const txQuery = vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      capturedCalls.push({ sql, params });

      if (capturedCalls.length === 1) {
        return mockQueryResult(jobRow ? [jobRow] : []);
      }

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

describe("confirmJobPayment", () => {
  it("reneged job transitions to completed_eventual with debt decrement and revenue ledger", async () => {
    const jobRow = makeJobRow("completed_reneged", {
      amount_sats: 3000,
      email_hash: "abc123hash",
    });
    const captured = mockTx(jobRow, { status: "completed_eventual" });

    const result = await confirmJobPayment(JOB_ID);

    expect(result.success).toBe(true);
    expect(result.job?.status).toBe("completed_eventual");

    const debtCall = captured.find((c) => c.sql.includes("debt_sats"));
    expect(debtCall).toBeTruthy();
    expect(debtCall!.params).toContain(3000);
    expect(debtCall!.params).toContain("user-1");

    const renegedUpdate = captured.find((c) => c.sql.includes("UPDATE reneged_emails"));
    expect(renegedUpdate).toBeTruthy();
    expect(renegedUpdate!.params).toContain("abc123hash");
    expect(renegedUpdate!.params).toContain(3000);

    const renegedDelete = captured.find((c) => c.sql.includes("DELETE FROM reneged_emails"));
    expect(renegedDelete).toBeTruthy();

    const ledgerCall = captured.find((c) => c.sql.includes("INSERT INTO revenue_ledger"));
    expect(ledgerCall).toBeTruthy();
    expect(ledgerCall!.params).toContain("eventual");
  });

  it("invoice job transitions to completed_paid with revenue ledger", async () => {
    const jobRow = makeJobRow("active", { invoice_id: "inv-456", amount_sats: 3000 });
    const captured = mockTx(jobRow, { status: "completed_paid" });

    const result = await confirmJobPayment(JOB_ID);

    expect(result.success).toBe(true);
    expect(result.job?.status).toBe("completed_paid");

    const txnCall = captured.find((c) => c.sql.includes("UPDATE transactions"));
    expect(txnCall).toBeTruthy();
    expect(txnCall!.params).toContain("paid");

    const ledgerCall = captured.find((c) => c.sql.includes("INSERT INTO revenue_ledger"));
    expect(ledgerCall).toBeTruthy();
    expect(ledgerCall!.params).toContain("paid");
  });

  it("returns 409 for already-paid job", async () => {
    mockTx(makeJobRow("completed_paid"));

    const result = await confirmJobPayment(JOB_ID);

    expect(result.success).toBe(false);
    expect(result.status).toBe(409);
    expect(result.error).toContain("Already paid");
  });

  it("returns 404 when job not found", async () => {
    mockTx(null);

    const result = await confirmJobPayment(JOB_ID);

    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain("not found");
  });

  it("returns 400 when job is not in a payable state", async () => {
    mockTx(makeJobRow("active", { invoice_id: null }));

    const result = await confirmJobPayment(JOB_ID);

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("not in a payable state");
  });

  it("skips debt and reneged_emails operations when amount_sats is null", async () => {
    const jobRow = makeJobRow("completed_reneged", {
      amount_sats: null,
      email_hash: "abc123hash",
    });
    const captured = mockTx(jobRow, { status: "completed_eventual" });

    const result = await confirmJobPayment(JOB_ID);

    expect(result.success).toBe(true);

    const debtCall = captured.find((c) => c.sql.includes("debt_sats"));
    expect(debtCall).toBeUndefined();

    const ledgerCall = captured.find((c) => c.sql.includes("revenue_ledger"));
    expect(ledgerCall).toBeUndefined();

    const renegedCall = captured.find((c) => c.sql.includes("reneged_emails"));
    expect(renegedCall).toBeUndefined();
  });
});
