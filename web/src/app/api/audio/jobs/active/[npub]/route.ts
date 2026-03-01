import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";

/**
 * GET /api/audio/jobs/active/[npub]
 *
 * HMAC-authenticated. Check if a user has an in-flight audio job.
 * Returns { has_active: boolean, job_id?: string }
 */
export const GET = withAgentAuth(
  async (req: NextRequest, { params }: { body: string; params?: Record<string, string> }) => {
    const npub = params?.npub;
    if (!npub) {
      return NextResponse.json({ error: "Missing npub" }, { status: 400 });
    }

    const result = await query<{
      id: string;
      status: string;
      amount_sats: number;
      was_cached: boolean;
      audio_cache_id: string | null;
    }>(
      `SELECT id, status, amount_sats, was_cached, audio_cache_id FROM audio_jobs
       WHERE requester_npub = $1
         AND status NOT IN ('completed', 'failed', 'refunded')
       ORDER BY created_at DESC
       LIMIT 1`,
      [npub]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ has_active: false });
    }

    const job = result.rows[0];

    // Fetch tweet text/author from cache for zap handler
    let tweet_text: string | null = null;
    let tweet_author: string | null = null;
    if (job.audio_cache_id) {
      const cacheResult = await query<{ tweet_text: string; tweet_author: string | null }>(
        "SELECT tweet_text, tweet_author FROM audio_cache WHERE id = $1",
        [job.audio_cache_id]
      );
      if (cacheResult.rows.length > 0) {
        tweet_text = cacheResult.rows[0].tweet_text;
        tweet_author = cacheResult.rows[0].tweet_author;
      }
    }

    return NextResponse.json({
      has_active: true,
      job_id: job.id,
      status: job.status,
      amount_sats: job.amount_sats,
      was_cached: job.was_cached,
      audio_cache_id: job.audio_cache_id,
      tweet_text,
      tweet_author,
    });
  }
);
