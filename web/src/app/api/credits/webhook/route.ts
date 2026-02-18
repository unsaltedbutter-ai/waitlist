import { NextRequest, NextResponse } from "next/server";
import { query, transaction } from "@/lib/db";
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
      m.paymentMethodId === "BTC-LN" || m.paymentMethodId === "BTC-LightningNetwork"
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

  // BTCPay config
  const btcpayUrl = process.env.BTCPAY_URL;
  const btcpayApiKey = process.env.BTCPAY_API_KEY;
  const btcpayStoreId = process.env.BTCPAY_STORE_ID;

  if (!btcpayUrl || !btcpayApiKey || !btcpayStoreId) {
    return NextResponse.json({ error: "BTCPay not configured" }, { status: 503 });
  }

  // Check if this is a prepayment invoice
  const prepayment = await query<{ id: string; user_id: string; status: string }>(
    `SELECT id, user_id, status FROM btc_prepayments WHERE btcpay_invoice_id = $1`,
    [invoiceId]
  );

  if (prepayment.rows.length > 0) {
    return handlePrepayment(prepayment.rows[0], invoiceId, btcpayUrl, btcpayApiKey, btcpayStoreId);
  }

  // Unknown invoice, ignore
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

  // Auto-resume: if user is auto_paused + onboarded + sufficient balance, activate
  const userResult = await query<{ status: string; onboarded_at: string | null }>(
    "SELECT status, onboarded_at FROM users WHERE id = $1",
    [row.user_id]
  );
  const user = userResult.rows[0];
  if (user && user.status === "auto_paused" && user.onboarded_at !== null) {
    // Check if balance covers requirements
    const { getRequiredBalance } = await import("@/lib/margin-call");
    const { notifyOrchestrator } = await import("@/lib/orchestrator-notify");

    // Get next service from rotation queue
    const nextService = await query<{ service_id: string }>(
      "SELECT service_id FROM rotation_queue WHERE user_id = $1 ORDER BY position LIMIT 1",
      [row.user_id]
    );

    if (nextService.rows.length > 0) {
      try {
        const required = await getRequiredBalance(nextService.rows[0].service_id);
        // Get current balance after the transaction committed
        const balanceResult = await query<{ credit_sats: string }>(
          "SELECT credit_sats FROM service_credits WHERE user_id = $1",
          [row.user_id]
        );
        const currentBalance = balanceResult.rows.length > 0 ? Number(balanceResult.rows[0].credit_sats) : 0;

        if (currentBalance >= required.totalSats) {
          await query(
            "UPDATE users SET status = 'active', paused_at = NULL, updated_at = NOW() WHERE id = $1",
            [row.user_id]
          );
          await notifyOrchestrator(row.user_id);
        }
      } catch {
        // Non-fatal: if margin check fails, user stays auto_paused
      }
    }
  }

  return NextResponse.json({ ok: true, credited_sats: receivedSats });
}
