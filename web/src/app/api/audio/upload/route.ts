import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query, transaction } from "@/lib/db";
import { writeFile, mkdir } from "fs/promises";
import { randomBytes } from "crypto";
import { join } from "path";

const AUDIO_DIR = "/data/audio";

function generateToken(): string {
  // 16-char URL-safe base62 token
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(16);
  let token = "";
  for (let i = 0; i < 16; i++) {
    token += chars[bytes[i] % chars.length];
  }
  return token;
}

/**
 * POST /api/audio/upload
 *
 * HMAC-authenticated. Upload MP3 file and create purchase token.
 *
 * Multipart form: file (MP3), audio_cache_id, audio_job_id,
 * duration_seconds, tts_model, tts_voice, max_plays
 *
 * Returns: { token, file_path }
 */
export const POST = withAgentAuth(
  async (req: NextRequest, { body }: { body: string; params?: Record<string, string> }) => {
    // For multipart uploads, we need to re-parse the request
    // The withAgentAuth already consumed the body as text, but for multipart
    // we need the original request. Since HMAC is verified on empty body for
    // multipart, we re-read from the original request headers.
    const contentType = req.headers.get("content-type") || "";

    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "Expected multipart/form-data" },
        { status: 400 }
      );
    }

    // Re-parse the multipart data from the body string
    // Actually, withAgentAuth consumed the body as text. For multipart uploads,
    // the HMAC is computed over an empty string body. We need a different approach.
    // Let's parse the form data from the raw request.
    let formData: FormData;
    try {
      // Clone trick: NextRequest allows re-reading if we construct from body
      formData = await new Request(req.url, {
        method: "POST",
        headers: req.headers,
        body: body,
      }).formData();
    } catch {
      return NextResponse.json(
        { error: "Failed to parse form data" },
        { status: 400 }
      );
    }

    const file = formData.get("file") as File | null;
    const audioCacheId = formData.get("audio_cache_id") as string | null;
    const audioJobId = formData.get("audio_job_id") as string | null;
    const durationSeconds = formData.get("duration_seconds") as string | null;
    const ttsModel = formData.get("tts_model") as string | null;
    const ttsVoice = formData.get("tts_voice") as string | null;
    const maxPlays = formData.get("max_plays") as string | null;

    if (!file || !audioCacheId || !audioJobId) {
      return NextResponse.json(
        { error: "Missing required fields (file, audio_cache_id, audio_job_id)" },
        { status: 400 }
      );
    }

    // Write MP3 to disk
    const filePath = `audio/${audioCacheId}.mp3`;
    const fullPath = join(AUDIO_DIR, `${audioCacheId}.mp3`);

    await mkdir(AUDIO_DIR, { recursive: true });
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(fullPath, buffer);

    const token = generateToken();

    // Update cache + create purchase in a transaction
    const result = await transaction(async (txQuery) => {
      // Update audio_cache with file info
      await txQuery(
        `UPDATE audio_cache
         SET file_path = $2, file_size_bytes = $3, duration_seconds = $4,
             tts_model = $5, tts_voice = $6, last_accessed_at = NOW()
         WHERE id = $1`,
        [
          audioCacheId,
          filePath,
          buffer.length,
          durationSeconds ? parseInt(durationSeconds) : null,
          ttsModel,
          ttsVoice,
        ]
      );

      // Update job status to completed
      const jobResult = await txQuery<{ requester_npub: string; audio_cache_id: string }>(
        `UPDATE audio_jobs SET status = 'completed', updated_at = NOW()
         WHERE id = $1 RETURNING requester_npub, audio_cache_id`,
        [audioJobId]
      );

      const job = jobResult.rows[0];

      // Create purchase token
      const plays = maxPlays ? parseInt(maxPlays) : 3;
      await txQuery(
        `INSERT INTO audio_purchases (
           token, audio_job_id, audio_cache_id, requester_npub,
           plays_remaining, max_plays
         ) VALUES ($1, $2, $3, $4, $5, $5)`,
        [token, audioJobId, audioCacheId, job.requester_npub, plays]
      );

      return { token, file_path: filePath };
    });

    return NextResponse.json(result, { status: 201 });
  }
);
