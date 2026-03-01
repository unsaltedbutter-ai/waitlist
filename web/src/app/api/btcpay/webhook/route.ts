import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { verifyInvoicePaid } from "@/lib/btcpay-invoice";
import { confirmJobPayment } from "@/lib/confirm-payment";
import { pushPaymentReceived, pushAudioPaymentReceived } from "@/lib/nostr-push";

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

  // 1. Check cancel/resume jobs table
  const jobResult = await query<{
    id: string;
    user_id: string;
    service_id: string;
    amount_sats: number | null;
  }>(
    "SELECT id, user_id, service_id, amount_sats FROM jobs WHERE invoice_id = $1",
    [invoiceId]
  );

  if (jobResult.rows.length > 0) {
    return handleConciergePayment(invoiceId, jobResult.rows[0]);
  }

  // 2. Check audio_jobs table
  const audioJobResult = await query<{
    id: string;
    requester_npub: string;
    tweet_id: string;
    amount_sats: number;
    was_cached: boolean;
    audio_cache_id: string | null;
  }>(
    `SELECT id, requester_npub, tweet_id, amount_sats, was_cached, audio_cache_id
     FROM audio_jobs WHERE invoice_id = $1`,
    [invoiceId]
  );

  if (audioJobResult.rows.length > 0) {
    return handleAudioPayment(invoiceId, audioJobResult.rows[0]);
  }

  // 3. Check audio_purchases for refill invoices
  const refillResult = await query<{
    id: string;
    max_plays: number;
  }>(
    "SELECT id, max_plays FROM audio_purchases WHERE refill_invoice_id = $1",
    [invoiceId]
  );

  if (refillResult.rows.length > 0) {
    return handleAudioRefill(invoiceId, refillResult.rows[0]);
  }

  // No matching record found
  return NextResponse.json({ ok: true });
}

// -- Cancel/resume payment (existing logic) ---------------------------------

async function handleConciergePayment(
  invoiceId: string,
  job: { id: string; user_id: string; service_id: string; amount_sats: number | null }
): Promise<NextResponse> {
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
      const serviceResult = await query<{ display_name: string }>(
        "SELECT display_name FROM streaming_services WHERE id = $1",
        [job.service_id]
      );
      const serviceName = serviceResult.rows[0]?.display_name ?? job.service_id;

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

// -- Audio payment ----------------------------------------------------------

async function handleAudioPayment(
  invoiceId: string,
  audioJob: {
    id: string;
    requester_npub: string;
    tweet_id: string;
    amount_sats: number;
    was_cached: boolean;
    audio_cache_id: string | null;
  }
): Promise<NextResponse> {
  const verified = await verifyInvoicePaid(invoiceId);
  if (!verified) {
    console.warn(`[btcpay-webhook] Audio invoice ${invoiceId} not verified as paid`);
    return NextResponse.json({ error: "Invoice not verified" }, { status: 200 });
  }

  // Update job status to paid
  await query(
    "UPDATE audio_jobs SET status = 'paid', updated_at = NOW() WHERE id = $1",
    [audioJob.id]
  );

  // Record revenue
  await query(
    `INSERT INTO revenue_ledger (service_id, action, amount_sats, payment_status, source, job_completed_at)
     VALUES ('audio', 'tts', $1, 'paid', 'audio', NOW())`,
    [audioJob.amount_sats]
  );

  // Get tweet text + author for the push (TTS bot needs it for synthesis)
  const cacheResult = await query<{ tweet_text: string; tweet_author: string | null }>(
    "SELECT tweet_text, tweet_author FROM audio_cache WHERE id = $1",
    [audioJob.audio_cache_id]
  );
  const tweetText = cacheResult.rows[0]?.tweet_text ?? "";
  const tweetAuthor = cacheResult.rows[0]?.tweet_author ?? null;

  // Push to TTS Bot via Nostr
  await pushAudioPaymentReceived(
    audioJob.requester_npub,
    audioJob.amount_sats,
    audioJob.id,
    audioJob.audio_cache_id ?? "",
    tweetText,
    tweetAuthor,
    audioJob.was_cached
  ).catch((err: unknown) => {
    console.error("[btcpay-webhook] Failed to push audio payment notification:", err);
  });

  return NextResponse.json({ ok: true });
}

// -- Audio refill -----------------------------------------------------------

async function handleAudioRefill(
  invoiceId: string,
  purchase: { id: string; max_plays: number }
): Promise<NextResponse> {
  const verified = await verifyInvoicePaid(invoiceId);
  if (!verified) {
    console.warn(`[btcpay-webhook] Refill invoice ${invoiceId} not verified as paid`);
    return NextResponse.json({ error: "Invoice not verified" }, { status: 200 });
  }

  // Reset plays and clear refill invoice
  await query(
    `UPDATE audio_purchases
     SET plays_remaining = max_plays, refill_invoice_id = NULL
     WHERE id = $1`,
    [purchase.id]
  );

  // Record revenue
  const refillSats = parseInt(process.env.AUDIO_REFILL_SATS || "250");
  await query(
    `INSERT INTO revenue_ledger (service_id, action, amount_sats, payment_status, source, job_completed_at)
     VALUES ('audio', 'refill', $1, 'paid', 'audio', NOW())`,
    [refillSats]
  );

  return NextResponse.json({ ok: true });
}
