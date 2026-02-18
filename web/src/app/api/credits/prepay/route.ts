import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";
import { usdCentsToSats } from "@/lib/btc-price";

export const POST = withAuth(async (req: NextRequest, { userId }) => {
  let body: { amount_sats?: number; amount_usd_cents?: number } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is OK: creates an open-amount invoice
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

  const metadata = { userId, type: "prepayment" };

  const invoicePayload: Record<string, unknown> = {
    currency: "BTC",
    metadata,
  };

  if (amountSats) {
    // BTCPay expects amount in BTC
    invoicePayload.amount = (amountSats / 100_000_000).toFixed(8);
  }

  let invoiceRes: Response;
  try {
    invoiceRes = await fetch(
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
  } catch {
    return NextResponse.json(
      { error: "Payment server unreachable" },
      { status: 502 }
    );
  }

  if (!invoiceRes.ok) {
    const errText = await invoiceRes.text();
    console.error("BTCPay invoice creation failed:", errText);
    return NextResponse.json(
      { error: "Failed to create invoice" },
      { status: 502 }
    );
  }

  const invoice = await invoiceRes.json();

  // Fetch bolt11 Lightning invoice from payment methods.
  // BTCPay needs a moment to generate payment methods after invoice creation.
  let bolt11: string | null = null;
  try {
    await new Promise((r) => setTimeout(r, 2000));
    const pmRes = await fetch(
      `${btcpayUrl}/api/v1/stores/${btcpayStoreId}/invoices/${invoice.id}/payment-methods`,
      {
        headers: { Authorization: `token ${btcpayApiKey}` },
      }
    );
    if (pmRes.ok) {
      const methods = await pmRes.json();
      const ln = methods.find(
        (m: { paymentMethodId: string; destination: string }) =>
          m.paymentMethodId === "BTC-LN"
      );
      if (ln?.destination) {
        bolt11 = ln.destination;
      }
    }
  } catch {
    // Non-fatal: bolt11 will be null, frontend falls back to checkout URL
  }

  // Record prepayment in DB
  await query(
    `INSERT INTO btc_prepayments (user_id, btcpay_invoice_id, requested_amount_sats, status)
     VALUES ($1, $2, $3, 'pending')`,
    [userId, invoice.id, amountSats ?? null]
  );

  return NextResponse.json({
    invoiceId: invoice.id,
    checkoutLink: invoice.checkoutLink,
    bolt11,
    amount_sats: amountSats ?? null,
  }, { status: 201 });
});
