import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
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

import { query } from "@/lib/db";
import { createLightningInvoice } from "@/lib/btcpay-invoice";
import { POST } from "../route";

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/agent/invoices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(createLightningInvoice).mockReset();
});

describe("POST /api/agent/invoices", () => {
  it("happy path: creates invoice, stores on job, creates transaction", async () => {
    const userId = "user-uuid-1";
    const jobId = "job-uuid-1";

    // User lookup
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: userId }]));
    // Job lookup
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: jobId, service_id: "netflix", action: "cancel", status: "active", invoice_id: null }])
    );
    // BTCPay invoice
    vi.mocked(createLightningInvoice).mockResolvedValueOnce({
      id: "btcpay-inv-1",
      bolt11: "lnbc3000sat1...",
    });
    // Update job with invoice_id
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Insert transaction
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({
      job_id: jobId,
      amount_sats: 3000,
      user_npub: "npub1abc",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.invoice_id).toBe("btcpay-inv-1");
    expect(data.bolt11).toBe("lnbc3000sat1...");
    expect(data.amount_sats).toBe(3000);

    // Finding 2.4: Verify createLightningInvoice was called with the exact request amount
    expect(createLightningInvoice).toHaveBeenCalledWith({
      amountSats: 3000,
      metadata: { job_id: jobId, user_npub: "npub1abc" },
    });

    // Verify job was updated with invoice_id
    const updateCall = vi.mocked(query).mock.calls[2];
    expect(updateCall[0]).toContain("UPDATE jobs SET invoice_id");
    expect(updateCall[1]).toEqual(["btcpay-inv-1", 3000, jobId]);

    // Finding 2.4: Verify the UPDATE query sets the correct amount_sats value (3000)
    const updateParams = updateCall[1] as unknown[];
    expect(updateParams[1]).toBe(3000);

    // Verify transaction was created
    const txCall = vi.mocked(query).mock.calls[3];
    expect(txCall[0]).toContain("INSERT INTO transactions");
    expect(txCall[1]).toEqual([jobId, userId, "netflix", "cancel", 3000]);

    // Finding 2.4: Verify the transaction row also has the correct amount_sats
    const txParams = txCall[1] as unknown[];
    expect(txParams[4]).toBe(3000);
  });

  it("missing fields: returns 400", async () => {
    const req = makeRequest({ job_id: "abc" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Missing required fields/);
  });

  it("missing amount_sats: returns 400", async () => {
    const req = makeRequest({ job_id: "abc", user_npub: "npub1abc" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("missing user_npub: returns 400", async () => {
    const req = makeRequest({ job_id: "abc", amount_sats: 3000 });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("amount_sats = 0: returns 400", async () => {
    const req = makeRequest({ job_id: "abc", amount_sats: 0, user_npub: "npub1abc" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/positive integer/);
  });

  it("negative amount_sats: returns 400", async () => {
    const req = makeRequest({ job_id: "abc", amount_sats: -100, user_npub: "npub1abc" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/positive integer/);
  });

  it("NaN amount_sats (serializes to null): returns 400", async () => {
    // JSON.stringify(NaN) produces null, so amount_sats becomes null after round-trip
    const req = makeRequest({ job_id: "abc", amount_sats: NaN, user_npub: "npub1abc" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("Infinity amount_sats (serializes to null): returns 400", async () => {
    // JSON.stringify(Infinity) produces null, so amount_sats becomes null after round-trip
    const req = makeRequest({ job_id: "abc", amount_sats: Infinity, user_npub: "npub1abc" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("string amount_sats: returns 400", async () => {
    const req = makeRequest({ job_id: "abc", amount_sats: "3000", user_npub: "npub1abc" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/positive integer/);
  });

  it("float amount_sats: returns 400", async () => {
    const req = makeRequest({ job_id: "abc", amount_sats: 3000.5, user_npub: "npub1abc" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/positive integer/);
  });

  it("user not found: returns 404", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({ job_id: "abc", amount_sats: 3000, user_npub: "npub1unknown" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/User not found/);
  });

  it("job not found: returns 404", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "user-1" }]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({ job_id: "nonexistent", amount_sats: 3000, user_npub: "npub1abc" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/Job not found/);
  });

  it("BTCPay call fails: returns 502", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "user-1" }]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "job-1", service_id: "netflix", action: "cancel", status: "active", invoice_id: null }])
    );
    vi.mocked(createLightningInvoice).mockRejectedValueOnce(
      new Error("BTCPay unreachable")
    );

    const req = makeRequest({ job_id: "job-1", amount_sats: 3000, user_npub: "npub1abc" });
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
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "user-1" }]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "job-1", service_id: "netflix", action: "cancel", status: "active", invoice_id: "existing-inv" }])
    );

    const req = makeRequest({ job_id: "job-1", amount_sats: 3000, user_npub: "npub1abc" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/Invoice already exists/);
  });

  it("already-paid job (completed_paid): returns 409", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "user-1" }]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "job-1", service_id: "netflix", action: "cancel", status: "completed_paid", invoice_id: null }])
    );

    const req = makeRequest({ job_id: "job-1", amount_sats: 3000, user_npub: "npub1abc" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/Job already paid/);
  });

  it("already-paid job (completed_eventual): returns 409", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "user-1" }]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "job-1", service_id: "netflix", action: "cancel", status: "completed_eventual", invoice_id: null }])
    );

    const req = makeRequest({ job_id: "job-1", amount_sats: 3000, user_npub: "npub1abc" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/Job already paid/);
  });
});
