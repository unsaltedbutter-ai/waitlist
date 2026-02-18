import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  withAuth: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params
        ? await segmentData.params
        : undefined;
      return handler(req, { userId: "test-user", params });
    };
  }),
}));
vi.mock("@/lib/btcpay-invoice", () => ({
  createLightningInvoice: vi.fn(),
}));

import { query, transaction } from "@/lib/db";
import { createLightningInvoice } from "@/lib/btcpay-invoice";
import { POST } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/debt/pay", { method: "POST" });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(transaction).mockReset();
  vi.mocked(createLightningInvoice).mockReset();
});

describe("POST /api/debt/pay", () => {
  it("creates invoice for total debt and stamps reneged jobs", async () => {
    // User lookup
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "test-user", debt_sats: 6000, nostr_npub: "npub1abc" }])
    );
    // Reneged jobs
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { id: "job-1", invoice_id: null },
        { id: "job-2", invoice_id: null },
      ])
    );
    // BTCPay
    vi.mocked(createLightningInvoice).mockResolvedValueOnce({
      id: "btcpay-debt-1",
      bolt11: "lnbc6000sat1...",
    });
    // Transaction
    const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
    vi.mocked(transaction).mockImplementationOnce(async (cb) => cb(txQuery as any));

    const res = await POST(makeRequest() as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.invoice_id).toBe("btcpay-debt-1");
    expect(data.bolt11).toBe("lnbc6000sat1...");
    expect(data.amount_sats).toBe(6000);

    // Invoice was created with the total debt
    expect(createLightningInvoice).toHaveBeenCalledWith({
      amountSats: 6000,
      metadata: { user_id: "test-user", type: "debt_payment", job_count: "2" },
    });

    // Both jobs updated with invoice_id inside transaction
    expect(txQuery).toHaveBeenCalledTimes(2);
    expect(txQuery.mock.calls[0][1]).toEqual(["btcpay-debt-1", "job-1"]);
    expect(txQuery.mock.calls[1][1]).toEqual(["btcpay-debt-1", "job-2"]);
  });

  it("returns 400 when user has no debt", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "test-user", debt_sats: 0, nostr_npub: "npub1abc" }])
    );

    const res = await POST(makeRequest() as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toMatch(/No outstanding debt/);
  });

  it("returns 404 when user not found", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(makeRequest() as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
  });

  it("returns existing invoice when all reneged jobs already have invoices", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "test-user", debt_sats: 3000, nostr_npub: "npub1abc" }])
    );
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "job-1", invoice_id: "existing-inv-1" }])
    );

    const res = await POST(makeRequest() as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.invoice_id).toBe("existing-inv-1");
    expect(data.already_exists).toBe(true);
    expect(data.amount_sats).toBe(3000);

    // No new invoice should be created
    expect(createLightningInvoice).not.toHaveBeenCalled();
  });

  it("returns 502 when BTCPay fails", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "test-user", debt_sats: 3000, nostr_npub: "npub1abc" }])
    );
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "job-1", invoice_id: null }])
    );
    vi.mocked(createLightningInvoice).mockRejectedValueOnce(
      new Error("BTCPay unreachable")
    );

    const res = await POST(makeRequest() as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(502);
  });

  it("returns 400 when debt_sats > 0 but no reneged jobs exist", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "test-user", debt_sats: 3000, nostr_npub: "npub1abc" }])
    );
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(makeRequest() as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toMatch(/data inconsistency/);
  });

  it("only stamps jobs without existing invoices", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "test-user", debt_sats: 6000, nostr_npub: "npub1abc" }])
    );
    // One job already has an invoice, one does not
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { id: "job-1", invoice_id: "old-inv" },
        { id: "job-2", invoice_id: null },
      ])
    );
    vi.mocked(createLightningInvoice).mockResolvedValueOnce({
      id: "btcpay-debt-2",
      bolt11: "lnbc6000sat1...",
    });
    const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
    vi.mocked(transaction).mockImplementationOnce(async (cb) => cb(txQuery as any));

    const res = await POST(makeRequest() as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    // Only job-2 should be stamped (job-1 already has an invoice)
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(txQuery.mock.calls[0][1]).toEqual(["btcpay-debt-2", "job-2"]);
  });
});
