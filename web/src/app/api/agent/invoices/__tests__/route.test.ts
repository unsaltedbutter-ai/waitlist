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
vi.mock("@/lib/btcpay-invoice", () => ({
  createLightningInvoice: vi.fn(),
}));

import { query, transaction } from "@/lib/db";
import { createLightningInvoice } from "@/lib/btcpay-invoice";
import { POST } from "../route";

const VALID_HEX = "aabb".repeat(16);
const UNKNOWN_HEX = "eeff".repeat(16);

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/agent/invoices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(transaction).mockReset();
  vi.mocked(createLightningInvoice).mockReset();
});

describe("POST /api/agent/invoices", () => {
  it("happy path: reads price from operator_settings, creates invoice", async () => {
    const userId = "user-uuid-1";
    const jobId = "job-uuid-1";

    // 1. Price lookup from operator_settings
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ value: "3000" }]));
    // 2. User lookup
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: userId }]));
    // 3. Job lookup
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: jobId, service_id: "netflix", action: "cancel", status: "active", invoice_id: null }])
    );
    // BTCPay invoice
    vi.mocked(createLightningInvoice).mockResolvedValueOnce({
      id: "btcpay-inv-1",
      bolt11: "lnbc3000sat1...",
    });
    // Transaction wrapping UPDATE jobs + INSERT transactions
    const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
    vi.mocked(transaction).mockImplementationOnce(async (cb) => cb(txQuery as any));

    const req = makeRequest({
      job_id: jobId,
      user_npub: VALID_HEX,
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.invoice_id).toBe("btcpay-inv-1");
    expect(data.bolt11).toBe("lnbc3000sat1...");
    expect(data.amount_sats).toBe(3000);

    // Verify createLightningInvoice was called with DB-sourced amount
    expect(createLightningInvoice).toHaveBeenCalledWith({
      amountSats: 3000,
      metadata: { job_id: jobId, user_npub: VALID_HEX },
    });

    // Verify both writes happened inside the transaction
    expect(txQuery).toHaveBeenCalledTimes(2);

    // Verify job was updated with invoice_id and DB-sourced amount
    const updateCall = txQuery.mock.calls[0];
    expect(updateCall[0]).toContain("UPDATE jobs SET invoice_id");
    expect(updateCall[1]).toEqual(["btcpay-inv-1", 3000, jobId]);

    // Verify transaction row was created with DB-sourced amount
    const txInsertCall = txQuery.mock.calls[1];
    expect(txInsertCall[0]).toContain("INSERT INTO transactions");
    expect(txInsertCall[1]).toEqual([jobId, userId, "netflix", "cancel", 3000]);
  });

  it("uses custom price from operator_settings", async () => {
    const userId = "user-uuid-1";
    const jobId = "job-uuid-1";

    // Price lookup: custom price
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ value: "5000" }]));
    // User lookup
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: userId }]));
    // Job lookup
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: jobId, service_id: "netflix", action: "cancel", status: "active", invoice_id: null }])
    );
    vi.mocked(createLightningInvoice).mockResolvedValueOnce({
      id: "btcpay-inv-2",
      bolt11: "lnbc5000sat1...",
    });
    const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
    vi.mocked(transaction).mockImplementationOnce(async (cb) => cb(txQuery as any));

    const req = makeRequest({ job_id: jobId, user_npub: VALID_HEX });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.amount_sats).toBe(5000);

    expect(createLightningInvoice).toHaveBeenCalledWith({
      amountSats: 5000,
      metadata: expect.any(Object),
    });
  });

  it("ignores amount_sats from body, uses DB value", async () => {
    const userId = "user-uuid-1";
    const jobId = "job-uuid-1";

    // Price lookup: 3000 from DB
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ value: "3000" }]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: userId }]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: jobId, service_id: "netflix", action: "cancel", status: "active", invoice_id: null }])
    );
    vi.mocked(createLightningInvoice).mockResolvedValueOnce({
      id: "btcpay-inv-3",
      bolt11: "lnbc...",
    });
    const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
    vi.mocked(transaction).mockImplementationOnce(async (cb) => cb(txQuery as any));

    // Body sends 9999, but should be ignored
    const req = makeRequest({ job_id: jobId, user_npub: VALID_HEX, amount_sats: 9999 });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.amount_sats).toBe(3000);
  });

  it("missing job_id: returns 400", async () => {
    const req = makeRequest({ user_npub: VALID_HEX });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Missing required fields/);
  });

  it("missing user_npub: returns 400", async () => {
    const req = makeRequest({ job_id: "abc" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("returns 500 for invalid price configuration", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ value: "not_a_number" }]));

    const req = makeRequest({ job_id: "abc", user_npub: VALID_HEX });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toMatch(/action_price_sats/);
  });

  it("user not found: returns 404", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ value: "3000" }]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({ job_id: "abc", user_npub: UNKNOWN_HEX });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/User not found/);
  });

  it("job not found: returns 404", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ value: "3000" }]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "user-1" }]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({ job_id: "nonexistent", user_npub: VALID_HEX });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/Job not found/);
  });

  it("BTCPay call fails: returns 502", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ value: "3000" }]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "user-1" }]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "job-1", service_id: "netflix", action: "cancel", status: "active", invoice_id: null }])
    );
    vi.mocked(createLightningInvoice).mockRejectedValueOnce(
      new Error("BTCPay unreachable")
    );

    const req = makeRequest({ job_id: "job-1", user_npub: VALID_HEX });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toMatch(/Lightning invoice/);
  });

  it("invalid JSON body: returns 400", async () => {
    const req = new Request("http://localhost/api/agent/invoices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("duplicate invoice (job already has invoice_id): returns 409", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ value: "3000" }]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "user-1" }]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "job-1", service_id: "netflix", action: "cancel", status: "active", invoice_id: "existing-inv" }])
    );

    const req = makeRequest({ job_id: "job-1", user_npub: VALID_HEX });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/Invoice already exists/);
  });

  it("already-paid job (completed_paid): returns 409", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ value: "3000" }]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "user-1" }]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "job-1", service_id: "netflix", action: "cancel", status: "completed_paid", invoice_id: null }])
    );

    const req = makeRequest({ job_id: "job-1", user_npub: VALID_HEX });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/Job already paid/);
  });

  it("already-paid job (completed_eventual): returns 409", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ value: "3000" }]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "user-1" }]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "job-1", service_id: "netflix", action: "cancel", status: "completed_eventual", invoice_id: null }])
    );

    const req = makeRequest({ job_id: "job-1", user_npub: VALID_HEX });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/Job already paid/);
  });
});
