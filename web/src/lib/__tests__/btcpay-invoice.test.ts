import { describe, it, expect, beforeEach, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { createLightningInvoice, verifyInvoicePaid } from "@/lib/btcpay-invoice";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("BTCPAY_URL", "https://btcpay.example.com");
  vi.stubEnv("BTCPAY_STORE_ID", "store-abc123");
  vi.stubEnv("BTCPAY_API_KEY", "key-secret");
  mockFetch.mockReset();
});

function btcpayResponse(body: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe("createLightningInvoice", () => {
  it("happy path: constructs correct URL, headers, body and returns bolt11", async () => {
    mockFetch.mockResolvedValue(
      btcpayResponse({
        id: "inv-001",
        lightning: { BOLT11: "lnbc3000n1pexample" },
      })
    );

    const result = await createLightningInvoice({ amountSats: 3000 });

    expect(result.id).toBe("inv-001");
    expect(result.bolt11).toBe("lnbc3000n1pexample");

    // Verify fetch was called with the correct URL
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://btcpay.example.com/api/v1/stores/store-abc123/invoices"
    );
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(opts.headers["Authorization"]).toBe("token key-secret");

    const body = JSON.parse(opts.body);
    expect(body.amount).toBe(3000);
    expect(body.currency).toBe("SATS");
    expect(body.checkout.paymentMethods).toEqual(["BTC-LightningNetwork"]);
  });

  it("passes metadata when provided", async () => {
    mockFetch.mockResolvedValue(
      btcpayResponse({ id: "inv-002", lightning: { BOLT11: "lnbc..." } })
    );

    await createLightningInvoice({
      amountSats: 3000,
      metadata: { job_id: "job-xyz", user_id: "user-abc" },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.metadata).toEqual({ job_id: "job-xyz", user_id: "user-abc" });
  });

  it("uses empty metadata object when metadata is not provided", async () => {
    mockFetch.mockResolvedValue(
      btcpayResponse({ id: "inv-003", lightning: { BOLT11: "lnbc..." } })
    );

    await createLightningInvoice({ amountSats: 5000 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.metadata).toEqual({});
  });

  describe("bolt11 extraction fallback chain", () => {
    it("prefers lightning.BOLT11", async () => {
      mockFetch.mockResolvedValue(
        btcpayResponse({
          id: "inv-fb1",
          lightning: { BOLT11: "lnbc-from-lightning" },
          addresses: { BTC_LightningLike: "lnbc-from-addresses" },
          checkoutLink: "https://btcpay.example.com/checkout/inv-fb1",
        })
      );

      const result = await createLightningInvoice({ amountSats: 3000 });
      expect(result.bolt11).toBe("lnbc-from-lightning");
    });

    it("falls back to addresses.BTC_LightningLike when lightning is absent", async () => {
      mockFetch.mockResolvedValue(
        btcpayResponse({
          id: "inv-fb2",
          addresses: { BTC_LightningLike: "lnbc-from-addresses" },
          checkoutLink: "https://btcpay.example.com/checkout/inv-fb2",
        })
      );

      const result = await createLightningInvoice({ amountSats: 3000 });
      expect(result.bolt11).toBe("lnbc-from-addresses");
    });

    it("falls back to checkoutLink when both lightning and addresses are absent", async () => {
      mockFetch.mockResolvedValue(
        btcpayResponse({
          id: "inv-fb3",
          checkoutLink: "https://btcpay.example.com/checkout/inv-fb3",
        })
      );

      const result = await createLightningInvoice({ amountSats: 3000 });
      expect(result.bolt11).toBe(
        "https://btcpay.example.com/checkout/inv-fb3"
      );
    });

    it("throws when no bolt11 source is available", async () => {
      mockFetch.mockResolvedValue(
        btcpayResponse({ id: "inv-fb4" })
      );

      await expect(
        createLightningInvoice({ amountSats: 3000 })
      ).rejects.toThrow("BTCPay response missing bolt11/Lightning payment data");
    });
  });

  it("throws on non-200 response with a meaningful message", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve("Invalid amount"),
    });

    await expect(
      createLightningInvoice({ amountSats: 3000 })
    ).rejects.toThrow("BTCPay invoice creation failed");
  });

  it("throws on non-200 even if text() rejects", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error("body read failure")),
    });

    await expect(
      createLightningInvoice({ amountSats: 3000 })
    ).rejects.toThrow("BTCPay invoice creation failed");
  });

  it("throws on invalid JSON response", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    });

    await expect(
      createLightningInvoice({ amountSats: 3000 })
    ).rejects.toThrow();
  });

  it("propagates network errors from fetch", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      createLightningInvoice({ amountSats: 3000 })
    ).rejects.toThrow("fetch failed");
  });

  it("passes amountSats correctly for different values", async () => {
    mockFetch.mockResolvedValue(
      btcpayResponse({ id: "inv-amt", lightning: { BOLT11: "lnbc..." } })
    );

    await createLightningInvoice({ amountSats: 10000 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.amount).toBe(10000);
  });

  it("throws when BTCPAY_URL is not set", async () => {
    vi.stubEnv("BTCPAY_URL", "");

    await expect(
      createLightningInvoice({ amountSats: 3000 })
    ).rejects.toThrow("BTCPay Server not configured");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when BTCPAY_STORE_ID is not set", async () => {
    vi.stubEnv("BTCPAY_STORE_ID", "");

    await expect(
      createLightningInvoice({ amountSats: 3000 })
    ).rejects.toThrow("BTCPay Server not configured");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when BTCPAY_API_KEY is not set", async () => {
    vi.stubEnv("BTCPAY_API_KEY", "");

    await expect(
      createLightningInvoice({ amountSats: 3000 })
    ).rejects.toThrow("BTCPay Server not configured");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("verifyInvoicePaid", () => {
  it("returns true for Settled status", async () => {
    mockFetch.mockResolvedValue(
      btcpayResponse({ status: "Settled" })
    );

    const result = await verifyInvoicePaid("inv-001");
    expect(result).toBe(true);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://btcpay.example.com/api/v1/stores/store-abc123/invoices/inv-001"
    );
  });

  it("returns true for Processing status", async () => {
    mockFetch.mockResolvedValue(
      btcpayResponse({ status: "Processing" })
    );

    const result = await verifyInvoicePaid("inv-002");
    expect(result).toBe(true);
  });

  it("returns false for New status", async () => {
    mockFetch.mockResolvedValue(
      btcpayResponse({ status: "New" })
    );

    const result = await verifyInvoicePaid("inv-003");
    expect(result).toBe(false);
  });

  it("returns false for Expired status", async () => {
    mockFetch.mockResolvedValue(
      btcpayResponse({ status: "Expired" })
    );

    const result = await verifyInvoicePaid("inv-004");
    expect(result).toBe(false);
  });

  it("returns false on fetch error", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));

    const result = await verifyInvoicePaid("inv-005");
    expect(result).toBe(false);
  });

  it("returns false on non-200 response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await verifyInvoicePaid("inv-006");
    expect(result).toBe(false);
  });

  it("returns false when env vars are not set", async () => {
    vi.stubEnv("BTCPAY_URL", "");

    const result = await verifyInvoicePaid("inv-007");
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
