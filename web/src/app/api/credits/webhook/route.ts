import { NextRequest, NextResponse } from "next/server";
import { query, transaction } from "@/lib/db";
import { satsToUsdCents } from "@/lib/btc-price";
import crypto, { timingSafeEqual } from "crypto";

/**
 * Fetch the actual sats received for a BTCPay invoice via the payment-methods API.
 * Returns 0 if no Lightning payment found.
 */
async function fetchReceivedSats(
  invoiceId: string,
  btcpayUrl: string,
  btcpayApiKey: string,
  btcpayStoreId: string
): Promise<{ sats: number } | { error: string; status: number }> {
  const invoiceRes = await fetch(
    `${btcpayUrl}/api/v1/stores/${btcpayStoreId}/invoices/${invoiceId}/payment-methods`,
    {
      headers: { Authorization: `token ${btcpayApiKey}` },
    }
  );
  if (!invoiceRes.ok) {
    return { error: "Failed to fetch invoice details", status: 502 };
  }
  const methods = await invoiceRes.json();
  const lightning = methods.find(
    (m: { paymentMethodId: string; totalPaid: string }) =>
      m.paymentMethodId === "BTC-LightningNetwork"
  );
  const sats = lightning
    ? Math.round(parseFloat(lightning.totalPaid) * 100_000_000)
    : 0;
  return { sats };
}

export async function POST(req: NextRequest) {
  // Verify BTCPay webhook signature
  const sigHeader = req.headers.get("btcpay-sig");
  const webhookSecret = process.env.BTCPAY_WEBHOOK_SECRET;

  if (!webhookSecret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  const rawBody = await req.text();

  if (!sigHeader) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  const expectedSig = "sha256=" + crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  const sigBuf = Buffer.from(sigHeader);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
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

  // BTCPay config — needed for both paths
  const btcpayUrl = process.env.BTCPAY_URL;
  const btcpayApiKey = process.env.BTCPAY_API_KEY;
  const btcpayStoreId = process.env.BTCPAY_STORE_ID;

  if (!btcpayUrl || !btcpayApiKey || !btcpayStoreId) {
    return NextResponse.json({ error: "BTCPay not configured" }, { status: 503 });
  }

  // --- Check if this is a prepayment invoice ---
  const prepayment = await query<{ id: string; user_id: string; status: string }>(
    `SELECT id, user_id, status FROM btc_prepayments WHERE btcpay_invoice_id = $1`,
    [invoiceId]
  );

  if (prepayment.rows.length > 0) {
    return handlePrepayment(prepayment.rows[0], invoiceId, btcpayUrl, btcpayApiKey, btcpayStoreId);
  }

  // --- Check if this is a membership payment invoice ---
  const membership = await query<{
    id: string; user_id: string; status: string;
    period_start: string; period_end: string;
  }>(
    `SELECT id, user_id, status, period_start, period_end
     FROM membership_payments WHERE btcpay_invoice_id = $1`,
    [invoiceId]
  );

  if (membership.rows.length > 0) {
    return handleMembershipPayment(
      membership.rows[0], invoiceId, btcpayUrl, btcpayApiKey, btcpayStoreId
    );
  }

  // Unknown invoice — ignore
  return NextResponse.json({ ok: true });
}

/** Handle a prepayment (service credit top-up) webhook. */
async function handlePrepayment(
  row: { id: string; user_id: string; status: string },
  invoiceId: string,
  btcpayUrl: string,
  btcpayApiKey: string,
  btcpayStoreId: string
): Promise<NextResponse> {
  if (row.status === "paid") {
    return NextResponse.json({ ok: true });
  }

  const result = await fetchReceivedSats(invoiceId, btcpayUrl, btcpayApiKey, btcpayStoreId);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const receivedSats = result.sats;
  if (receivedSats <= 0) {
    return NextResponse.json({ error: "No payment received" }, { status: 400 });
  }

  await transaction(async (txQuery) => {
    await txQuery(
      `INSERT INTO service_credits (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [row.user_id]
    );

    const creditUpdate = await txQuery(
      `UPDATE service_credits
       SET credit_sats = credit_sats + $2, updated_at = NOW()
       WHERE user_id = $1
       RETURNING credit_sats`,
      [row.user_id, receivedSats]
    );

    const newBalance = creditUpdate.rows[0].credit_sats;

    await txQuery(
      `INSERT INTO credit_transactions
         (user_id, type, amount_sats, balance_after_sats, reference_id, description)
       VALUES ($1, 'prepayment', $2, $3, $4, $5)`,
      [row.user_id, receivedSats, newBalance, row.id, `Lightning prepayment: ${receivedSats} sats`]
    );

    await txQuery(
      `UPDATE btc_prepayments
       SET status = 'paid', received_amount_sats = $2, updated_at = NOW()
       WHERE btcpay_invoice_id = $1`,
      [invoiceId, receivedSats]
    );
  });

  return NextResponse.json({ ok: true, credited_sats: receivedSats });
}

/** Handle a membership payment webhook. */
async function handleMembershipPayment(
  row: { id: string; user_id: string; status: string; period_start: string; period_end: string },
  invoiceId: string,
  btcpayUrl: string,
  btcpayApiKey: string,
  btcpayStoreId: string
): Promise<NextResponse> {
  if (row.status === "paid") {
    return NextResponse.json({ ok: true });
  }

  const result = await fetchReceivedSats(invoiceId, btcpayUrl, btcpayApiKey, btcpayStoreId);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const receivedSats = result.sats;
  if (receivedSats <= 0) {
    return NextResponse.json({ error: "No payment received" }, { status: 400 });
  }

  // Fetch the invoice metadata to determine plan and billing period
  const invoiceRes = await fetch(
    `${btcpayUrl}/api/v1/stores/${btcpayStoreId}/invoices/${invoiceId}`,
    {
      headers: { Authorization: `token ${btcpayApiKey}` },
    }
  );
  if (!invoiceRes.ok) {
    return NextResponse.json({ error: "Failed to fetch invoice metadata" }, { status: 502 });
  }
  const invoiceData = await invoiceRes.json();
  const meta = invoiceData.metadata ?? {};

  const membershipPlan: string = meta.membership_plan;
  const billingPeriod: string = meta.billing_period;

  if (!membershipPlan || !billingPeriod) {
    console.error("Membership invoice missing plan metadata:", invoiceId);
    return NextResponse.json({ error: "Missing membership metadata" }, { status: 400 });
  }

  const amountUsdCents = await satsToUsdCents(receivedSats);

  await transaction(async (txQuery) => {
    // Update user membership info
    await txQuery(
      `UPDATE users
       SET membership_plan = $2,
           billing_period = $3,
           membership_expires_at = $4,
           status = 'active',
           updated_at = NOW()
       WHERE id = $1`,
      [row.user_id, membershipPlan, billingPeriod, row.period_end]
    );

    // Mark membership payment as paid
    await txQuery(
      `UPDATE membership_payments
       SET status = 'paid', amount_sats = $2, amount_usd_cents = $3
       WHERE btcpay_invoice_id = $1`,
      [invoiceId, receivedSats, amountUsdCents]
    );
  });

  return NextResponse.json({ ok: true, membership: membershipPlan, billing_period: billingPeriod });
}
