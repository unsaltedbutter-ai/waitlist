const BITREFILL_API_URL = process.env.BITREFILL_API_URL || "https://api.bitrefill.com/v2";

function getApiKey(): string {
  const key = process.env.BITREFILL_API_KEY;
  if (!key) throw new Error("BITREFILL_API_KEY not set");
  return key;
}

async function bitrefillFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const res = await fetch(`${BITREFILL_API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
      ...options.headers,
    },
  });
  return res;
}

export interface BitrefillOrder {
  id: string;
  status: string;
  payment: {
    lightningInvoice?: string;
    amount?: number;
  };
}

export interface BitrefillGiftCard {
  pin?: string;
  code?: string;
  url?: string;
}

/**
 * Create a Bitrefill order for a gift card.
 */
export async function createOrder(
  productId: string,
  amountCents: number
): Promise<BitrefillOrder> {
  const res = await bitrefillFetch("/orders", {
    method: "POST",
    body: JSON.stringify({
      product_id: productId,
      quantity: 1,
      value: amountCents / 100, // Bitrefill expects USD
      payment_method: "lightning",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bitrefill createOrder failed: ${res.status} ${err}`);
  }

  return res.json();
}

/**
 * Pay for an order using BTCPay Server's internal Lightning wallet.
 * This pays the Lightning invoice that Bitrefill provided.
 */
export async function payOrderViaBtcpay(
  lightningInvoice: string
): Promise<void> {
  const btcpayUrl = process.env.BTCPAY_URL;
  const btcpayApiKey = process.env.BTCPAY_API_KEY;
  const btcpayStoreId = process.env.BTCPAY_STORE_ID;

  if (!btcpayUrl || !btcpayApiKey || !btcpayStoreId) {
    throw new Error("BTCPay not configured");
  }

  const res = await fetch(
    `${btcpayUrl}/api/v1/stores/${btcpayStoreId}/lightning/BTC/invoices/pay`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `token ${btcpayApiKey}`,
      },
      body: JSON.stringify({ BOLT11: lightningInvoice }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`BTCPay Lightning payment failed: ${res.status} ${err}`);
  }
}

/**
 * Retrieve the gift card code/pin after payment is confirmed.
 */
export async function getGiftCardCode(
  orderId: string
): Promise<BitrefillGiftCard> {
  const res = await bitrefillFetch(`/orders/${orderId}`);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bitrefill getOrder failed: ${res.status} ${err}`);
  }

  const order = await res.json();

  if (order.status !== "delivered" && order.status !== "completed") {
    throw new Error(`Order ${orderId} not yet delivered: ${order.status}`);
  }

  // Bitrefill returns gift card details in the order response
  const card = order.cards?.[0] || order.items?.[0];
  if (!card) {
    throw new Error(`No gift card data in order ${orderId}`);
  }

  return {
    pin: card.pin,
    code: card.code || card.pin,
    url: card.link,
  };
}
