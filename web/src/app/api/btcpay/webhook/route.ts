import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { verifyInvoicePaid } from "@/lib/btcpay-invoice";
import { confirmJobPayment } from "@/lib/confirm-payment";
import { pushPaymentReceived } from "@/lib/nostr-push";

function verifyWebhookSignature(
  rawBody: string,
  sigHeader: string,
  secret: string
): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = sigHeader.replace(/^sha256=/, "");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

export async function POST(req: NextRequest) {
  const sigHeader = req.headers.get("BTCPay-Sig");
  if (!sigHeader) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const secret = process.env.BTCPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[btcpay-webhook] BTCPAY_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  const rawBody = await req.text();

  if (!verifyWebhookSignature(rawBody, sigHeader, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: { type?: string; invoiceId?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (payload.type !== "InvoiceSettled") {
    return NextResponse.json({ ok: true });
  }

  const invoiceId = payload.invoiceId;
  if (!invoiceId) {
    return NextResponse.json({ ok: true });
  }

  const jobResult = await query<{
    id: string;
    user_id: string;
    service_id: string;
    amount_sats: number | null;
  }>(
    "SELECT id, user_id, service_id, amount_sats FROM jobs WHERE invoice_id = $1",
    [invoiceId]
  );

  if (jobResult.rows.length === 0) {
    return NextResponse.json({ ok: true });
  }

  const job = jobResult.rows[0];

  const verified = await verifyInvoicePaid(invoiceId);
  if (!verified) {
    console.warn(`[btcpay-webhook] Invoice ${invoiceId} not verified as paid via API`);
    return NextResponse.json({ error: "Invoice not verified" }, { status: 200 });
  }

  const result = await confirmJobPayment(job.id);

  if (result.success) {
    const userResult = await query<{ nostr_npub: string }>(
      "SELECT nostr_npub FROM users WHERE id = $1",
      [job.user_id]
    );

    if (userResult.rows.length > 0) {
      const serviceResult = await query<{ name: string }>(
        "SELECT name FROM services WHERE id = $1",
        [job.service_id]
      );
      const serviceName = serviceResult.rows[0]?.name ?? job.service_id;

      await pushPaymentReceived(
        userResult.rows[0].nostr_npub,
        serviceName,
        job.amount_sats ?? 0,
        job.id
      ).catch((err: unknown) => {
        console.error("[btcpay-webhook] Failed to push payment notification:", err);
      });
    }
  }

  return NextResponse.json({ ok: true });
}
