import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";
import { usdCentsToSats } from "@/lib/btc-price";

export const POST = withAuth(async (req: NextRequest, { userId }) => {
  let body: { amount_usd_cents?: number; amount_sats?: number } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is OK — creates open-amount invoice
  }

  let amountSats: number | undefined;
  if (body.amount_sats) {
    amountSats = body.amount_sats;
  } else if (body.amount_usd_cents) {
    amountSats = await usdCentsToSats(body.amount_usd_cents);
  }

  // Create BTCPay invoice
  const btcpayUrl = process.env.BTCPAY_URL;
  const btcpayApiKey = process.env.BTCPAY_API_KEY;
  const btcpayStoreId = process.env.BTCPAY_STORE_ID;

  if (!btcpayUrl || !btcpayApiKey || !btcpayStoreId) {
    return NextResponse.json(
      { error: "Payment system not configured" },
      { status: 503 }
    );
  }

  const invoicePayload: Record<string, unknown> = {
    currency: "BTC",
    metadata: { userId, type: "prepayment" },
  };

  if (amountSats) {
    // BTCPay expects amount in BTC
    invoicePayload.amount = (amountSats / 100_000_000).toFixed(8);
  }

  const invoiceRes = await fetch(
    `${btcpayUrl}/api/v1/stores/${btcpayStoreId}/invoices`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `token ${btcpayApiKey}`,
      },
      body: JSON.stringify(invoicePayload),
    }
  );

  if (!invoiceRes.ok) {
    const errText = await invoiceRes.text();
    console.error("BTCPay invoice creation failed:", errText);
    return NextResponse.json(
      { error: "Failed to create invoice" },
      { status: 502 }
    );
  }

  const invoice = await invoiceRes.json();

  // Record prepayment in DB
  await query(
    `INSERT INTO btc_prepayments (user_id, btcpay_invoice_id, requested_amount_sats, status)
     VALUES ($1, $2, $3, 'pending')`,
    [userId, invoice.id, amountSats ?? null]
  );

  return NextResponse.json({
    invoiceId: invoice.id,
    checkoutLink: invoice.checkoutLink,
    amount_sats: amountSats ?? null,
  }, { status: 201 });
});
