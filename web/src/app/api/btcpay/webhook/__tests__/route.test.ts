import { createHmac } from "crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/btcpay-invoice", () => ({
  verifyInvoicePaid: vi.fn(),
}));

vi.mock("@/lib/confirm-payment", () => ({
  confirmJobPayment: vi.fn(),
}));

vi.mock("@/lib/nostr-push", () => ({
  pushPaymentReceived: vi.fn(),
}));

import { query } from "@/lib/db";
import { verifyInvoicePaid } from "@/lib/btcpay-invoice";
import { confirmJobPayment } from "@/lib/confirm-payment";
import { pushPaymentReceived } from "@/lib/nostr-push";
import { POST } from "../route";

const WEBHOOK_SECRET = "test-webhook-secret-abc123";

beforeEach(() => {
  vi.stubEnv("BTCPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.mocked(query).mockReset();
  vi.mocked(verifyInvoicePaid).mockReset();
  vi.mocked(confirmJobPayment).mockReset();
  vi.mocked(pushPaymentReceived).mockReset();
});

function signPayload(body: string): string {
  const hmac = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  return `sha256=${hmac}`;
}

function makeWebhookRequest(
  body: Record<string, unknown>,
  sigOverride?: string
): Request {
  const raw = JSON.stringify(body);
  const sig = sigOverride ?? signPayload(raw);

  return new Request("http://localhost/api/btcpay/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "BTCPay-Sig": sig,
    },
    body: raw,
  });
}

function makeWebhookRequestNoSig(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/btcpay/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/btcpay/webhook", () => {
  it("processes valid settled invoice: confirms payment, sends push, returns 200", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(
        mockQueryResult([{
          id: "job-1",
          user_id: "user-1",
          service_id: "netflix",
          amount_sats: 3000,
        }])
      )
      .mockResolvedValueOnce(
        mockQueryResult([{ nostr_npub: "deadbeef" }])
      )
      .mockResolvedValueOnce(
        mockQueryResult([{ name: "Netflix" }])
      );

    vi.mocked(verifyInvoicePaid).mockResolvedValue(true);
    vi.mocked(confirmJobPayment).mockResolvedValue({
      success: true,
      job: { id: "job-1" } as any,
    });
    vi.mocked(pushPaymentReceived).mockResolvedValue(undefined);

    const res = await POST(
      makeWebhookRequest({ type: "InvoiceSettled", invoiceId: "inv-abc" }) as any
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    expect(verifyInvoicePaid).toHaveBeenCalledWith("inv-abc");
    expect(confirmJobPayment).toHaveBeenCalledWith("job-1");
    expect(pushPaymentReceived).toHaveBeenCalledWith("deadbeef", "Netflix", 3000, "job-1");
  });

  it("rejects request with invalid signature (401)", async () => {
    const res = await POST(
      makeWebhookRequest(
        { type: "InvoiceSettled", invoiceId: "inv-abc" },
        "sha256=0000000000000000000000000000000000000000000000000000000000000000"
      ) as any
    );

    expect(res.status).toBe(401);
    expect(confirmJobPayment).not.toHaveBeenCalled();
  });

  it("rejects request with missing BTCPay-Sig header (401)", async () => {
    const res = await POST(
      makeWebhookRequestNoSig({ type: "InvoiceSettled", invoiceId: "inv-abc" }) as any
    );

    expect(res.status).toBe(401);
  });

  it("acknowledges non-InvoiceSettled events with 200 without processing", async () => {
    const res = await POST(
      makeWebhookRequest({ type: "InvoiceCreated", invoiceId: "inv-abc" }) as any
    );

    expect(res.status).toBe(200);
    expect(query).not.toHaveBeenCalled();
    expect(confirmJobPayment).not.toHaveBeenCalled();
  });

  it("returns 200 when no matching job for invoice_id", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeWebhookRequest({ type: "InvoiceSettled", invoiceId: "inv-no-job" }) as any
    );

    expect(res.status).toBe(200);
    expect(confirmJobPayment).not.toHaveBeenCalled();
  });

  it("returns 200 without processing when verifyInvoicePaid returns false", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        id: "job-1",
        user_id: "user-1",
        service_id: "netflix",
        amount_sats: 3000,
      }])
    );
    vi.mocked(verifyInvoicePaid).mockResolvedValue(false);

    const res = await POST(
      makeWebhookRequest({ type: "InvoiceSettled", invoiceId: "inv-unverified" }) as any
    );

    expect(res.status).toBe(200);
    expect(confirmJobPayment).not.toHaveBeenCalled();
  });

  it("still returns 200 when confirmJobPayment reports already paid", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        id: "job-1",
        user_id: "user-1",
        service_id: "netflix",
        amount_sats: 3000,
      }])
    );
    vi.mocked(verifyInvoicePaid).mockResolvedValue(true);
    vi.mocked(confirmJobPayment).mockResolvedValue({
      success: false,
      error: "Already paid",
      status: 409,
    });

    const res = await POST(
      makeWebhookRequest({ type: "InvoiceSettled", invoiceId: "inv-dup" }) as any
    );

    expect(res.status).toBe(200);
    expect(pushPaymentReceived).not.toHaveBeenCalled();
  });

  it("falls back to service_id when services table has no row", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(
        mockQueryResult([{
          id: "job-1",
          user_id: "user-1",
          service_id: "hulu",
          amount_sats: 3000,
        }])
      )
      .mockResolvedValueOnce(
        mockQueryResult([{ nostr_npub: "aabbcc" }])
      )
      .mockResolvedValueOnce(
        mockQueryResult([])
      );

    vi.mocked(verifyInvoicePaid).mockResolvedValue(true);
    vi.mocked(confirmJobPayment).mockResolvedValue({
      success: true,
      job: { id: "job-1" } as any,
    });
    vi.mocked(pushPaymentReceived).mockResolvedValue(undefined);

    await POST(
      makeWebhookRequest({ type: "InvoiceSettled", invoiceId: "inv-hulu" }) as any
    );

    expect(pushPaymentReceived).toHaveBeenCalledWith("aabbcc", "hulu", 3000, "job-1");
  });
});
