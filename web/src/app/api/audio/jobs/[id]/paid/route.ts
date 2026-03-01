import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query, transaction } from "@/lib/db";

/**
 * POST /api/audio/jobs/[id]/paid
 *
 * HMAC-authenticated. Mark an audio job as paid (via zap).
 * Records revenue in revenue_ledger.
 *
 * Body: { zap_event_id?: string }
 *
 * Returns job details including audio_cache_id, was_cached, tweet_text, tweet_author.
 * Returns 409 if already paid.
 */
export const POST = withAgentAuth(
  async (req: NextRequest, { body, params }: { body: string; params?: Record<string, string> }) => {
    const jobId = params?.id;
    if (!jobId) {
      return NextResponse.json({ error: "Missing job id" }, { status: 400 });
    }

    let data: { zap_event_id?: string } = {};
    if (body) {
      try {
        data = JSON.parse(body);
      } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
      }
    }

    const result = await transaction(async (txQuery) => {
      // Lock the row
      const jobResult = await txQuery<{
        id: string;
        status: string;
        amount_sats: number;
        was_cached: boolean;
        audio_cache_id: string | null;
        requester_npub: string;
      }>(
        "SELECT id, status, amount_sats, was_cached, audio_cache_id, requester_npub FROM audio_jobs WHERE id = $1 FOR UPDATE",
        [jobId]
      );

      if (jobResult.rows.length === 0) {
        return { error: "not_found" as const };
      }

      const job = jobResult.rows[0];

      if (job.status !== "pending_payment") {
        return { error: "already_paid" as const };
      }

      // Mark paid
      await txQuery(
        "UPDATE audio_jobs SET status = 'paid', updated_at = NOW() WHERE id = $1",
        [jobId]
      );

      // Record revenue
      await txQuery(
        `INSERT INTO revenue_ledger (service_id, action, amount_sats, payment_status, source, job_completed_at)
         VALUES ('audio', 'tts', $1, 'paid', 'audio', NOW())`,
        [job.amount_sats]
      );

      // Fetch tweet text + author from cache
      let tweetText = "";
      let tweetAuthor: string | null = null;
      if (job.audio_cache_id) {
        const cacheResult = await txQuery<{ tweet_text: string; tweet_author: string | null }>(
          "SELECT tweet_text, tweet_author FROM audio_cache WHERE id = $1",
          [job.audio_cache_id]
        );
        if (cacheResult.rows.length > 0) {
          tweetText = cacheResult.rows[0].tweet_text;
          tweetAuthor = cacheResult.rows[0].tweet_author;
        }
      }

      return {
        job: {
          id: job.id,
          requester_npub: job.requester_npub,
          amount_sats: job.amount_sats,
          was_cached: job.was_cached,
          audio_cache_id: job.audio_cache_id,
          tweet_text: tweetText,
          tweet_author: tweetAuthor,
        },
      };
    });

    if (result.error === "not_found") {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    if (result.error === "already_paid") {
      return NextResponse.json({ error: "Already paid" }, { status: 409 });
    }

    return NextResponse.json(result.job);
  }
);
