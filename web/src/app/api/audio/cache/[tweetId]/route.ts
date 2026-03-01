import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";

/**
 * GET /api/audio/cache/[tweetId]
 *
 * HMAC-authenticated. Check if a cached audio entry exists for a tweet.
 * Returns the cache entry or 404.
 */
export const GET = withAgentAuth(
  async (req: NextRequest, { params }: { body: string; params?: Record<string, string> }) => {
    const tweetId = params?.tweetId;
    if (!tweetId) {
      return NextResponse.json({ error: "Missing tweetId" }, { status: 400 });
    }

    const result = await query<{
      id: string;
      tweet_id: string;
      tweet_url: string;
      tweet_text: string;
      tweet_author: string | null;
      char_count: number;
      file_path: string | null;
      file_size_bytes: number | null;
      duration_seconds: number | null;
      tts_model: string | null;
      tts_voice: string | null;
    }>(
      `SELECT id, tweet_id, tweet_url, tweet_text, tweet_author,
              char_count, file_path, file_size_bytes, duration_seconds,
              tts_model, tts_voice
       FROM audio_cache WHERE tweet_id = $1`,
      [tweetId]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Touch last_accessed_at (LRU)
    await query(
      "UPDATE audio_cache SET last_accessed_at = NOW() WHERE tweet_id = $1",
      [tweetId]
    );

    return NextResponse.json(result.rows[0]);
  }
);
