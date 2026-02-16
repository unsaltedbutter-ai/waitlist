import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "crypto";
import { mockQueryResult } from "@/__test-utils__/fixtures";

// Mock db module
vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

// Mock btc-price module
vi.mock("@/lib/btc-price", () => ({
  satsToUsdCents: vi.fn(),
}));

import { query, transaction } from "@/lib/db";
import { satsToUsdCents } from "@/lib/btc-price";
import { POST } from "../route";

const WEBHOOK_SECRET = "whsec_test_secret";

function sign(body: string): string {
  return (
    "sha256=" +
    crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")
  );
}

function makeRequest(body: object, sig?: string | null): Request {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (sig !== null && sig !== undefined) {
    headers["btcpay-sig"] = sig;
  }
  return new Request("http://localhost/api/credits/webhook", {
    method: "POST",
    headers,
    body: raw,
  });
}

function settledPayload(invoiceId = "inv_123") {
  return { type: "InvoiceSettled", invoiceId };
}

/** Mock fetch to return Lightning payment-methods response, then optionally an invoice metadata response. */
function mockBtcpayFetch(
  totalPaid: string,
  metadata?: Record<string, unknown>,
  paymentMethodId = "BTC-LN"
) {
  const responses: Response[] = [
    new Response(
      JSON.stringify([
        { paymentMethodId, totalPaid },
      ]),
      { status: 200 }
    ),
  ];
  if (metadata) {
    responses.push(
      new Response(JSON.stringify({ metadata }), { status: 200 })
    );
  }
  const spy = vi.spyOn(global, "fetch");
  for (const r of responses) {
    spy.mockResolvedValueOnce(r);
  }
  return spy;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("BTCPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("BTCPAY_URL", "https://btcpay.test");
  vi.stubEnv("BTCPAY_API_KEY", "key_test");
  vi.stubEnv("BTCPAY_STORE_ID", "store_test");
  vi.mocked(query).mockReset();
  vi.mocked(transaction).mockReset();
  vi.mocked(satsToUsdCents).mockReset();
});

// ============================================================
// Prepayment (service credits) tests
// ============================================================

describe("BTCPay webhook — prepayments", () => {
  it("valid HMAC + InvoiceSettled → credits account", async () => {
    const payload = settledPayload();
    const body = JSON.stringify(payload);

    // query call 1: lookup prepayment
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "prep_1", user_id: "user_1", status: "pending" }])
    );

    // fetch BTCPay invoice details
    mockBtcpayFetch("0.00021");

    // transaction mock: just execute the callback with a mock query
    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockResolvedValue(
        mockQueryResult([{ credit_sats: 21000 }])
      );
      return cb(txQuery as any);
    });

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.credited_sats).toBe(21000);
    expect(transaction).toHaveBeenCalled();
  });

  it("legacy BTC-LightningNetwork paymentMethodId still works", async () => {
    const payload = settledPayload();
    const body = JSON.stringify(payload);

    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "prep_1", user_id: "user_1", status: "pending" }])
    );

    mockBtcpayFetch("0.00010", undefined, "BTC-LightningNetwork");

    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockResolvedValue(
        mockQueryResult([{ credit_sats: 10000 }])
      );
      return cb(txQuery as any);
    });

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.credited_sats).toBe(10000);
  });

  it("invalid HMAC → 401", async () => {
    const payload = settledPayload();
    const req = makeRequest(payload, "sha256=wrong");
    const res = await POST(req as any);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("missing signature header → 401 (security: must not skip verification)", async () => {
    const payload = settledPayload();

    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "prep_1", user_id: "user_1", status: "pending" }])
    );

    const req = makeRequest(payload, null);
    const res = await POST(req as any);

    expect(res.status).toBe(401);
  });

  it("non-InvoiceSettled event → 200, no credit", async () => {
    const payload = { type: "InvoiceCreated", invoiceId: "inv_123" };
    const body = JSON.stringify(payload);
    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);

    expect(res.status).toBe(200);
    expect(query).not.toHaveBeenCalled();
  });

  it("already-paid prepayment → idempotent 200", async () => {
    const payload = settledPayload();
    const body = JSON.stringify(payload);

    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "prep_1", user_id: "user_1", status: "paid" }])
    );

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);

    expect(res.status).toBe(200);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("unknown invoice (not prepayment, not membership) → 200, no credit", async () => {
    const payload = settledPayload("inv_unknown");
    const body = JSON.stringify(payload);

    // btc_prepayments: not found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // membership_payments: not found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);

    expect(res.status).toBe(200);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("missing invoiceId → 400", async () => {
    const payload = { type: "InvoiceSettled" };
    const body = JSON.stringify(payload);
    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);

    expect(res.status).toBe(400);
  });

  it("BTCPay API failure → 502", async () => {
    const payload = settledPayload();
    const body = JSON.stringify(payload);

    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "prep_1", user_id: "user_1", status: "pending" }])
    );

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 })
    );

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);

    expect(res.status).toBe(502);
  });
});

// ============================================================
// Membership payment tests
// ============================================================

describe("BTCPay webhook — membership payments", () => {
  it("membership invoice settled → updates user plan and records payment", async () => {
    const payload = settledPayload("inv_mem_1");
    const body = JSON.stringify(payload);

    // query 1: btc_prepayments — not found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // query 2: membership_payments — found
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        id: "mp_1",
        user_id: "user_1",
        status: "pending",
        period_start: "2026-02-15T00:00:00Z",
        period_end: "2026-03-15T00:00:00Z",
      }])
    );

    // fetch 1: payment-methods (sats received)
    // fetch 2: invoice metadata (plan + billing_period)
    mockBtcpayFetch("0.00044", {
      userId: "user_1",
      type: "membership",
      membership_plan: "solo",
      billing_period: "monthly",
    });

    // satsToUsdCents mock
    vi.mocked(satsToUsdCents).mockResolvedValueOnce(299);

    // transaction mock
    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
      return cb(txQuery as any);
    });

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.membership).toBe("solo");
    expect(data.billing_period).toBe("monthly");
    expect(satsToUsdCents).toHaveBeenCalledWith(44000);
    expect(transaction).toHaveBeenCalled();

    // Verify the transaction callback received correct SQL
    const txQuery = vi.mocked(transaction).mock.calls[0][0];
    const mockTxFn = vi.fn().mockResolvedValue(mockQueryResult([]));
    await txQuery(mockTxFn as any);

    // First call: UPDATE users
    const userUpdate = mockTxFn.mock.calls[0];
    expect(userUpdate[0]).toContain("UPDATE users");
    expect(userUpdate[1]).toEqual([
      "user_1", "solo", "monthly", "2026-03-15T00:00:00Z",
    ]);

    // Second call: UPDATE membership_payments
    const mpUpdate = mockTxFn.mock.calls[1];
    expect(mpUpdate[0]).toContain("UPDATE membership_payments");
    expect(mpUpdate[1]).toEqual(["inv_mem_1", 44000, 299]);
  });

  it("annual membership invoice → correct metadata passed through", async () => {
    const payload = settledPayload("inv_mem_annual");
    const body = JSON.stringify(payload);

    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        id: "mp_2",
        user_id: "user_2",
        status: "pending",
        period_start: "2026-02-15T00:00:00Z",
        period_end: "2027-02-15T00:00:00Z",
      }])
    );

    mockBtcpayFetch("0.00035", {
      userId: "user_2",
      type: "membership",
      membership_plan: "duo",
      billing_period: "annual",
    });

    vi.mocked(satsToUsdCents).mockResolvedValueOnce(399);

    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
      return cb(txQuery as any);
    });

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.membership).toBe("duo");
    expect(data.billing_period).toBe("annual");
  });

  it("already-paid membership → idempotent 200", async () => {
    const payload = settledPayload("inv_mem_paid");
    const body = JSON.stringify(payload);

    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        id: "mp_3",
        user_id: "user_1",
        status: "paid",
        period_start: "2026-02-15T00:00:00Z",
        period_end: "2026-03-15T00:00:00Z",
      }])
    );

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);

    expect(res.status).toBe(200);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("membership invoice with no Lightning payment → 400", async () => {
    const payload = settledPayload("inv_mem_empty");
    const body = JSON.stringify(payload);

    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        id: "mp_4",
        user_id: "user_1",
        status: "pending",
        period_start: "2026-02-15T00:00:00Z",
        period_end: "2026-03-15T00:00:00Z",
      }])
    );

    // payment-methods returns no Lightning entry
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200 })
    );

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);

    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("membership invoice metadata fetch failure → 502", async () => {
    const payload = settledPayload("inv_mem_fail");
    const body = JSON.stringify(payload);

    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        id: "mp_5",
        user_id: "user_1",
        status: "pending",
        period_start: "2026-02-15T00:00:00Z",
        period_end: "2026-03-15T00:00:00Z",
      }])
    );

    const fetchSpy = vi.spyOn(global, "fetch");
    // payment-methods succeeds
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { paymentMethodId: "BTC-LightningNetwork", totalPaid: "0.00044" },
        ]),
        { status: 200 }
      )
    );
    // invoice metadata fetch fails
    fetchSpy.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 })
    );

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);

    expect(res.status).toBe(502);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("membership invoice with missing plan metadata → 400", async () => {
    const payload = settledPayload("inv_mem_noplan");
    const body = JSON.stringify(payload);

    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        id: "mp_6",
        user_id: "user_1",
        status: "pending",
        period_start: "2026-02-15T00:00:00Z",
        period_end: "2026-03-15T00:00:00Z",
      }])
    );

    // payment-methods + invoice metadata (missing membership_plan)
    const fetchSpy = vi.spyOn(global, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { paymentMethodId: "BTC-LightningNetwork", totalPaid: "0.00044" },
        ]),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ metadata: { userId: "user_1", type: "membership" } }),
        { status: 200 }
      )
    );

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);

    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });
});
