import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { createLightningInvoice } from "@/lib/btcpay-invoice";

const DEFAULT_REFILL_SATS = 250;

/**
 * POST /api/audio/[token]/refill
 *
 * Public (token is auth). Create a BTCPay invoice to refill plays.
 * Returns { invoice_id, bolt11, amount_sats }
 */
export async function POST(
  req: NextRequest,
  segmentData: { params: Promise<Record<string, string>> }
) {
  const params = await segmentData.params;
  const token = params.token;

  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  // Look up the purchase
  const result = await query<{
    id: string;
    plays_remaining: number;
    max_plays: number;
    refill_invoice_id: string | null;
  }>(
    "SELECT id, plays_remaining, max_plays, refill_invoice_id FROM audio_purchases WHERE token = $1",
    [token]
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const purchase = result.rows[0];

  // Don't allow refill if plays are still available
  if (purchase.plays_remaining > 0) {
    return NextResponse.json(
      { error: "Plays still remaining" },
      { status: 400 }
    );
  }

  // If there's already a pending refill invoice, return it
  if (purchase.refill_invoice_id) {
    return NextResponse.json({
      invoice_id: purchase.refill_invoice_id,
      amount_sats: DEFAULT_REFILL_SATS,
      already_pending: true,
    });
  }

  const refillSats = parseInt(process.env.AUDIO_REFILL_SATS || String(DEFAULT_REFILL_SATS));

  // Create BTCPay invoice
  const invoice = await createLightningInvoice({
    amountSats: refillSats,
    metadata: {
      type: "audio_refill",
      token: token,
    },
  });

  // Store refill invoice ID on the purchase
  await query(
    "UPDATE audio_purchases SET refill_invoice_id = $2 WHERE id = $1",
    [purchase.id, invoice.id]
  );

  return NextResponse.json({
    invoice_id: invoice.id,
    bolt11: invoice.bolt11,
    amount_sats: refillSats,
  });
}
