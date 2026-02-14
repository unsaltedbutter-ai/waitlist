import { NextRequest, NextResponse } from "next/server";
import { query, transaction } from "@/lib/db";
import crypto from "crypto";

export async function POST(req: NextRequest) {
  // Verify BTCPay webhook signature
  const sigHeader = req.headers.get("btcpay-sig");
  const webhookSecret = process.env.BTCPAY_WEBHOOK_SECRET;

  if (!webhookSecret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  const rawBody = await req.text();

  if (sigHeader) {
    const expectedSig = "sha256=" + crypto
      .createHmac("sha256", webhookSecret)
      .update(rawBody)
      .digest("hex");

    if (sigHeader !== expectedSig) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  const event = JSON.parse(rawBody);

  // Only handle settled invoices
  if (event.type !== "InvoiceSettled") {
    return NextResponse.json({ ok: true });
  }

  const invoiceId = event.invoiceId;
  if (!invoiceId) {
    return NextResponse.json({ error: "Missing invoiceId" }, { status: 400 });
  }

  // Look up our prepayment record
  const prepayment = await query(
    `SELECT id, user_id, status FROM btc_prepayments WHERE btcpay_invoice_id = $1`,
    [invoiceId]
  );

  if (prepayment.rows.length === 0) {
    // Not a prepayment invoice — might be a membership payment. Ignore.
    return NextResponse.json({ ok: true });
  }

  if (prepayment.rows[0].status === "paid") {
    // Already processed — idempotent
    return NextResponse.json({ ok: true });
  }

  const { user_id } = prepayment.rows[0];

  // Fetch actual amount from BTCPay
  const btcpayUrl = process.env.BTCPAY_URL;
  const btcpayApiKey = process.env.BTCPAY_API_KEY;
  const btcpayStoreId = process.env.BTCPAY_STORE_ID;

  let receivedSats: number;
  if (btcpayUrl && btcpayApiKey && btcpayStoreId) {
    const invoiceRes = await fetch(
      `${btcpayUrl}/api/v1/stores/${btcpayStoreId}/invoices/${invoiceId}/payment-methods`,
      {
        headers: { Authorization: `token ${btcpayApiKey}` },
      }
    );
    if (invoiceRes.ok) {
      const methods = await invoiceRes.json();
      const lightning = methods.find(
        (m: { paymentMethodId: string; totalPaid: string }) =>
          m.paymentMethodId === "BTC-LightningNetwork"
      );
      receivedSats = lightning
        ? Math.round(parseFloat(lightning.totalPaid) * 100_000_000)
        : 0;
    } else {
      return NextResponse.json({ error: "Failed to fetch invoice details" }, { status: 502 });
    }
  } else {
    return NextResponse.json({ error: "BTCPay not configured" }, { status: 503 });
  }

  if (receivedSats <= 0) {
    return NextResponse.json({ error: "No payment received" }, { status: 400 });
  }

  // Credit account in a transaction
  await transaction(async (txQuery) => {
    // Ensure credit record exists
    await txQuery(
      `INSERT INTO service_credits (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [user_id]
    );

    // Add credits
    const creditUpdate = await txQuery(
      `UPDATE service_credits
       SET credit_sats = credit_sats + $2, updated_at = NOW()
       WHERE user_id = $1
       RETURNING credit_sats`,
      [user_id, receivedSats]
    );

    const newBalance = creditUpdate.rows[0].credit_sats;

    // Record transaction
    await txQuery(
      `INSERT INTO credit_transactions
         (user_id, type, amount_sats, balance_after_sats, reference_id, description)
       VALUES ($1, 'prepayment', $2, $3, $4, $5)`,
      [user_id, receivedSats, newBalance, prepayment.rows[0].id, `Lightning prepayment: ${receivedSats} sats`]
    );

    // Mark prepayment as paid
    await txQuery(
      `UPDATE btc_prepayments
       SET status = 'paid', received_amount_sats = $2, updated_at = NOW()
       WHERE btcpay_invoice_id = $1`,
      [invoiceId, receivedSats]
    );
  });

  return NextResponse.json({ ok: true, credited_sats: receivedSats });
}
