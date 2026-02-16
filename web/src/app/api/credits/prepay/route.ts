import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";
import { usdCentsToSats } from "@/lib/btc-price";

type MembershipPlan = "solo" | "duo";
type BillingPeriod = "monthly" | "annual";

export const POST = withAuth(async (req: NextRequest, { userId }) => {
  let body: {
    amount_usd_cents?: number;
    amount_sats?: number;
    membership_plan?: MembershipPlan;
    billing_period?: BillingPeriod;
    service_credit_usd_cents?: number;
  } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is OK — creates open-amount invoice
  }

  const isMembership =
    body.membership_plan !== undefined && body.billing_period !== undefined;

  // Validate membership fields if present
  if (isMembership) {
    if (!["solo", "duo"].includes(body.membership_plan!)) {
      return NextResponse.json(
        { error: "Invalid membership_plan" },
        { status: 400 }
      );
    }
    if (!["monthly", "annual"].includes(body.billing_period!)) {
      return NextResponse.json(
        { error: "Invalid billing_period" },
        { status: 400 }
      );
    }
  }

  let amountSats: number | undefined;
  if (body.amount_sats) {
    amountSats = body.amount_sats;
  } else if (body.amount_usd_cents) {
    amountSats = await usdCentsToSats(body.amount_usd_cents);
  }

  // Add service credit (gift card cost) for membership invoices
  let serviceCreditSats = 0;
  if (isMembership && body.service_credit_usd_cents && body.service_credit_usd_cents > 0) {
    serviceCreditSats = await usdCentsToSats(body.service_credit_usd_cents);
    amountSats = (amountSats ?? 0) + serviceCreditSats;
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

  const metadata: Record<string, unknown> = isMembership
    ? {
        userId,
        type: "membership",
        membership_plan: body.membership_plan,
        billing_period: body.billing_period,
        service_credit_usd_cents: body.service_credit_usd_cents ?? 0,
        service_credit_sats: serviceCreditSats,
      }
    : { userId, type: "prepayment" };

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

  if (isMembership) {
    // Record membership payment (pending) so the webhook can find it
    const now = new Date();
    const periodEnd =
      body.billing_period === "annual"
        ? new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())
        : new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());

    await query(
      `INSERT INTO membership_payments
         (user_id, btcpay_invoice_id, amount_sats, amount_usd_cents, period_start, period_end, status)
       VALUES ($1, $2, $3, 0, $4, $5, 'pending')`,
      [userId, invoice.id, amountSats ?? 0, now.toISOString(), periodEnd.toISOString()]
    );
  } else {
    // Record prepayment in DB
    await query(
      `INSERT INTO btc_prepayments (user_id, btcpay_invoice_id, requested_amount_sats, status)
       VALUES ($1, $2, $3, 'pending')`,
      [userId, invoice.id, amountSats ?? null]
    );
  }

  return NextResponse.json({
    invoiceId: invoice.id,
    checkoutLink: invoice.checkoutLink,
    bolt11,
    amount_sats: amountSats ?? null,
  }, { status: 201 });
});
