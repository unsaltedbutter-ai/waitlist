import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "crypto";
import { mockQueryResult } from "@/__test-utils__/fixtures";

// Mock db module
vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query, transaction } from "@/lib/db";
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

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("BTCPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("BTCPAY_URL", "https://btcpay.test");
  vi.stubEnv("BTCPAY_API_KEY", "key_test");
  vi.stubEnv("BTCPAY_STORE_ID", "store_test");
  vi.mocked(query).mockReset();
  vi.mocked(transaction).mockReset();
});

describe("BTCPay webhook", () => {
  it("valid HMAC + InvoiceSettled → credits account", async () => {
    const payload = settledPayload();
    const body = JSON.stringify(payload);

    // query call 1: lookup prepayment
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "prep_1", user_id: "user_1", status: "pending" }])
    );

    // fetch BTCPay invoice details
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { paymentMethodId: "BTC-LightningNetwork", totalPaid: "0.00021" },
        ]),
        { status: 200 }
      )
    );

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

  it("invalid HMAC → 401", async () => {
    const payload = settledPayload();
    const req = makeRequest(payload, "sha256=wrong");
    const res = await POST(req as any);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("missing signature header → 401 (security: must not skip verification)", async () => {
    // This tests the security bug fix — missing sig header should NOT
    // skip verification. If the code still has the bug, this test fails
    // because it will return 200 instead of 401.
    const payload = settledPayload();

    // Set up mocks as if it would succeed (to prove we never get there)
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "prep_1", user_id: "user_1", status: "pending" }])
    );

    const req = makeRequest(payload, null); // no sig header
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

  it("already-paid invoice → idempotent 200", async () => {
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

  it("unknown invoice → 200, no credit", async () => {
    const payload = settledPayload("inv_unknown");
    const body = JSON.stringify(payload);

    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest(payload, sign(body));
    const res = await POST(req as any);

    expect(res.status).toBe(200);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("missing invoiceId → 400", async () => {
    const payload = { type: "InvoiceSettled" }; // no invoiceId
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
