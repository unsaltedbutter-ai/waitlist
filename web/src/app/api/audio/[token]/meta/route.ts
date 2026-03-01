import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

/**
 * GET /api/audio/[token]/meta
 *
 * Public (token is auth). Returns tweet text, author, plays remaining.
 * Used by the listen page to display info and check play availability.
 */
export async function GET(
  req: NextRequest,
  segmentData: { params: Promise<Record<string, string>> }
) {
  const params = await segmentData.params;
  const token = params.token;

  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const result = await query<{
    token: string;
    plays_remaining: number;
    max_plays: number;
    last_played_at: string | null;
    tweet_text: string;
    tweet_author: string | null;
    tweet_url: string;
    char_count: number;
    duration_seconds: number | null;
    file_path: string | null;
  }>(
    `SELECT
       p.token, p.plays_remaining, p.max_plays, p.last_played_at,
       c.tweet_text, c.tweet_author, c.tweet_url, c.char_count,
       c.duration_seconds, c.file_path
     FROM audio_purchases p
     JOIN audio_cache c ON c.id = p.audio_cache_id
     WHERE p.token = $1`,
    [token]
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const row = result.rows[0];

  return NextResponse.json({
    token: row.token,
    plays_remaining: row.plays_remaining,
    max_plays: row.max_plays,
    tweet_text: row.tweet_text,
    tweet_author: row.tweet_author,
    tweet_url: row.tweet_url,
    char_count: row.char_count,
    duration_seconds: row.duration_seconds,
    has_audio: row.file_path !== null,
    exhausted: row.plays_remaining <= 0,
  });
}
