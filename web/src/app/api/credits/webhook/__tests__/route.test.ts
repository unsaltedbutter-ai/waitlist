import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "crypto";
import { mockQueryResult } from "@/__test-utils__/fixtures";

// Mock db module
vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

// Mock auto-resume dependencies (dynamically imported by the route)
vi.mock("@/lib/margin-call", () => ({
  getRequiredBalance: vi.fn(),
}));
vi.mock("@/lib/orchestrator-notify", () => ({
  notifyOrchestrator: vi.fn(),
}));

import { query, transaction } from "@/lib/db";
import { getRequiredBalance } from "@/lib/margin-call";
import { notifyOrchestrator } from "@/lib/orchestrator-notify";
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

/** Mock fetch to return Lightning payment-methods response. */
function mockBtcpayFetch(
  totalPaid: string,
  _metadata?: Record<string, unknown>,
  paymentMethodId = "BTC-LN"
) {
  const spy = vi.spyOn(global, "fetch");
  spy.mockResolvedValueOnce(
    new Response(
      JSON.stringify([
        { paymentMethodId, totalPaid },
      ]),
      { status: 200 }
    ),
  );
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
  vi.mocked(getRequiredBalance).mockReset();
  vi.mocked(notifyOrchestrator).mockReset();
});

// ============================================================
// Prepayment (service credits) tests
// ============================================================

describe("BTCPay webhook: prepayments", () => {
  it("valid HMAC + InvoiceSettled credits account", async () => {
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

    // post-transaction: user status query (not auto_paused, so no resume)
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "active", onboarded_at: "2026-01-01T00:00:00Z" }])
    );

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

    // post-transaction: user status query
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "active", onboarded_at: "2026-01-01T00:00:00Z" }])
    );

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.credited_sats).toBe(10000);
  });

  it("invalid HMAC returns 401", async () => {
    const payload = settledPayload();
    const req = makeRequest(payload, "sha256=wrong");
    const res = await POST(req as any);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("missing signature header returns 401 (must not skip verification)", async () => {
    const payload = settledPayload();

    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "prep_1", user_id: "user_1", status: "pending" }])
    );

    const req = makeRequest(payload, null);
    const res = await POST(req as any);

    expect(res.status).toBe(401);
  });

  it("non-InvoiceSettled event returns 200, no credit", async () => {
    const payload = { type: "InvoiceCreated", invoiceId: "inv_123" };
    const body = JSON.stringify(payload);
    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);

    expect(res.status).toBe(200);
    expect(query).not.toHaveBeenCalled();
  });

  it("already-paid prepayment returns idempotent 200", async () => {
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

  it("unknown invoice (not in btc_prepayments) returns 200, no credit", async () => {
    const payload = settledPayload("inv_unknown");
    const body = JSON.stringify(payload);

    // btc_prepayments: not found (single query, no membership lookup)
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);

    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("missing invoiceId returns 400", async () => {
    const payload = { type: "InvoiceSettled" };
    const body = JSON.stringify(payload);
    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);

    expect(res.status).toBe(400);
  });

  it("BTCPay API failure returns 502", async () => {
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
// Auto-resume tests
// ============================================================

describe("BTCPay webhook: auto-resume after prepayment", () => {
  /** Helper: set up a standard prepayment flow through the transaction, then
   *  configure the post-transaction queries for auto-resume testing. */
  function setupPrepaymentFlow(receivedSats: number) {
    const payload = settledPayload("inv_resume");
    const body = JSON.stringify(payload);

    // query 1: lookup prepayment
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "prep_ar", user_id: "user_ar", status: "pending" }])
    );

    // fetch BTCPay payment-methods
    const btcAmount = (receivedSats / 100_000_000).toFixed(8);
    mockBtcpayFetch(btcAmount);

    // transaction: execute callback, return credit_sats
    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockResolvedValue(
        mockQueryResult([{ credit_sats: receivedSats }])
      );
      return cb(txQuery as any);
    });

    return { payload, body };
  }

  it("auto_paused + onboarded user with sufficient balance gets activated", async () => {
    const { payload, body } = setupPrepaymentFlow(50000);

    // post-transaction query 2: user status + onboarded_at
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "auto_paused", onboarded_at: "2026-01-15T00:00:00Z" }])
    );

    // query 3: rotation_queue (next service)
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ service_id: "svc_netflix" }])
    );

    // getRequiredBalance returns less than current balance
    vi.mocked(getRequiredBalance).mockResolvedValueOnce({
      totalSats: 40000,
      giftCardSats: 35000,
      marginSats: 5000,
    } as any);

    // query 4: current balance from service_credits
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ credit_sats: "50000" }])
    );

    // query 5: UPDATE users SET status = 'active'
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    // notifyOrchestrator resolves
    vi.mocked(notifyOrchestrator).mockResolvedValueOnce(undefined as any);

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.credited_sats).toBe(50000);

    // Verify user was activated
    const updateCall = vi.mocked(query).mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("UPDATE users SET status")
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall![1]).toContain("user_ar");

    // Verify orchestrator was notified
    expect(notifyOrchestrator).toHaveBeenCalledWith("user_ar");
  });

  it("auto_paused user without onboarding does not activate", async () => {
    const { payload, body } = setupPrepaymentFlow(50000);

    // post-transaction query 2: user is auto_paused but NOT onboarded
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "auto_paused", onboarded_at: null }])
    );

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.credited_sats).toBe(50000);

    // Should NOT have queried rotation_queue or updated status
    const updateCall = vi.mocked(query).mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("UPDATE users SET status")
    );
    expect(updateCall).toBeUndefined();
    expect(notifyOrchestrator).not.toHaveBeenCalled();
  });

  it("active user does not change status", async () => {
    const { payload, body } = setupPrepaymentFlow(30000);

    // post-transaction query 2: user is already active
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ status: "active", onboarded_at: "2026-01-10T00:00:00Z" }])
    );

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.credited_sats).toBe(30000);

    // Should NOT have queried rotation_queue or updated status
    const updateCall = vi.mocked(query).mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("UPDATE users SET status")
    );
    expect(updateCall).toBeUndefined();
    expect(notifyOrchestrator).not.toHaveBeenCalled();
  });
});
