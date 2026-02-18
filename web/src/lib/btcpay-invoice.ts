export interface CreateInvoiceParams {
  amountSats: number;
  metadata?: Record<string, string>;
}

export interface BtcPayInvoice {
  id: string;
  bolt11: string;
}

/**
 * Create a Lightning invoice via BTCPay Server.
 *
 * Expects BTCPAY_URL, BTCPAY_STORE_ID, and BTCPAY_API_KEY env vars.
 */
export async function createLightningInvoice(
  params: CreateInvoiceParams
): Promise<BtcPayInvoice> {
  const btcpayUrl = process.env.BTCPAY_URL;
  const storeId = process.env.BTCPAY_STORE_ID;
  const apiKey = process.env.BTCPAY_API_KEY;

  if (!btcpayUrl || !storeId || !apiKey) {
    throw new Error("BTCPay Server not configured");
  }

  const res = await fetch(
    `${btcpayUrl}/api/v1/stores/${storeId}/invoices`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `token ${apiKey}`,
      },
      body: JSON.stringify({
        amount: params.amountSats,
        currency: "SATS",
        metadata: params.metadata ?? {},
        checkout: { paymentMethods: ["BTC-LightningNetwork"] },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown");
    console.error(`BTCPay invoice creation failed (${res.status}): ${text}`);
    throw new Error("BTCPay invoice creation failed");
  }

  const data = await res.json();

  // Extract bolt11 from the invoice's payment methods
  const bolt11 =
    data.lightning?.BOLT11 ??
    data.addresses?.BTC_LightningLike ??
    data.checkoutLink ??
    "";

  if (!bolt11) {
    throw new Error("BTCPay response missing bolt11/Lightning payment data");
  }

  return {
    id: data.id,
    bolt11,
  };
}
