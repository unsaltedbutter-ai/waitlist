import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query, transaction } from "@/lib/db";
import { createLightningInvoice } from "@/lib/btcpay-invoice";

/**
 * POST /api/audio/jobs
 *
 * HMAC-authenticated. Create an audio job + BTCPay invoice.
 * Also upserts the audio_cache row with extracted text.
 *
 * Body: {
 *   requester_npub, tweet_id, tweet_url, tweet_text, tweet_author?,
 *   char_count, amount_sats, was_cached, audio_cache_id?, voice?
 * }
 *
 * Returns: { job_id, invoice_id, bolt11, audio_cache_id }
 */
export const POST = withAgentAuth(
  async (req: NextRequest, { body }: { body: string; params?: Record<string, string> }) => {
    let data: {
      requester_npub: string;
      tweet_id: string;
      tweet_url: string;
      tweet_text: string;
      tweet_author?: string;
      char_count: number;
      amount_sats: number;
      was_cached: boolean;
      audio_cache_id?: string;
      voice?: string;
    };

    try {
      data = JSON.parse(body);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!data.requester_npub || !data.tweet_id || !data.tweet_url || !data.tweet_text) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const result = await transaction(async (txQuery) => {
      // Upsert audio_cache (insert text if new, or reuse existing)
      let audioCacheId = data.audio_cache_id;

      if (!audioCacheId) {
        const cacheResult = await txQuery<{ id: string }>(
          `INSERT INTO audio_cache (tweet_id, tweet_url, tweet_text, tweet_author, char_count)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tweet_id) DO UPDATE SET last_accessed_at = NOW()
           RETURNING id`,
          [data.tweet_id, data.tweet_url, data.tweet_text, data.tweet_author ?? null, data.char_count]
        );
        audioCacheId = cacheResult.rows[0].id;
      }

      // Create BTCPay invoice
      const invoice = await createLightningInvoice({
        amountSats: data.amount_sats,
        metadata: {
          type: "audio",
          tweet_id: data.tweet_id,
          requester: data.requester_npub.substring(0, 16),
        },
      });

      // Create audio_job
      const jobResult = await txQuery<{ id: string }>(
        `INSERT INTO audio_jobs (
           requester_npub, tweet_id, tweet_url, status,
           invoice_id, amount_sats, was_cached, audio_cache_id
         ) VALUES ($1, $2, $3, 'pending_payment', $4, $5, $6, $7)
         RETURNING id`,
        [
          data.requester_npub,
          data.tweet_id,
          data.tweet_url,
          invoice.id,
          data.amount_sats,
          data.was_cached,
          audioCacheId,
        ]
      );

      return {
        job_id: jobResult.rows[0].id,
        invoice_id: invoice.id,
        bolt11: invoice.bolt11,
        audio_cache_id: audioCacheId,
      };
    });

    return NextResponse.json(result, { status: 201 });
  }
);
