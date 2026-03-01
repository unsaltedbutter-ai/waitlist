import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { readFile, stat } from "fs/promises";
import { join } from "path";

const AUDIO_DIR = "/data/audio";

/**
 * GET /api/audio/[token]/stream
 *
 * Public (token is auth). Serve MP3 audio with Range support.
 * Decrements plays_remaining on first request per session
 * (uses a short-lived cookie to avoid burning plays on seek/refresh).
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

  // Look up the purchase + cache
  const result = await query<{
    id: string;
    plays_remaining: number;
    audio_cache_id: string;
    file_path: string | null;
  }>(
    `SELECT p.id, p.plays_remaining, p.audio_cache_id, c.file_path
     FROM audio_purchases p
     JOIN audio_cache c ON c.id = p.audio_cache_id
     WHERE p.token = $1`,
    [token]
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const purchase = result.rows[0];

  if (!purchase.file_path) {
    return NextResponse.json(
      { error: "Audio not yet available" },
      { status: 404 }
    );
  }

  // Check plays
  if (purchase.plays_remaining <= 0) {
    return NextResponse.json(
      { error: "No plays remaining" },
      { status: 410 }
    );
  }

  // Check session cookie to avoid burning plays on seek/refresh
  const sessionCookie = req.cookies.get(`audio_session_${token}`)?.value;
  const shouldBurnPlay = !sessionCookie;

  if (shouldBurnPlay) {
    await query(
      `UPDATE audio_purchases
       SET plays_remaining = plays_remaining - 1, last_played_at = NOW()
       WHERE id = $1 AND plays_remaining > 0`,
      [purchase.id]
    );

    // Touch LRU
    await query(
      "UPDATE audio_cache SET last_accessed_at = NOW() WHERE id = $1",
      [purchase.audio_cache_id]
    );
  }

  // Read the MP3 file
  const fullPath = join(AUDIO_DIR, `${purchase.audio_cache_id}.mp3`);

  let fileBuffer: Buffer;
  let fileSize: number;
  try {
    const fileStat = await stat(fullPath);
    fileSize = fileStat.size;
    fileBuffer = await readFile(fullPath);
  } catch {
    return NextResponse.json(
      { error: "Audio file not found on disk" },
      { status: 404 }
    );
  }

  // Handle Range requests for seeking
  const rangeHeader = req.headers.get("range");
  const headers: Record<string, string> = {
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  };

  // Set session cookie (30 min, prevents re-burning on seek)
  const cookieValue = `1; Path=/api/audio/${token}/stream; Max-Age=1800; SameSite=Strict; Secure; HttpOnly`;
  headers["Set-Cookie"] = `audio_session_${token}=${cookieValue}`;

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1]);
      const end = match[2] ? parseInt(match[2]) : fileSize - 1;
      const chunk = fileBuffer.subarray(start, end + 1);

      headers["Content-Range"] = `bytes ${start}-${end}/${fileSize}`;
      headers["Content-Length"] = String(chunk.length);

      return new NextResponse(chunk as unknown as BodyInit, { status: 206, headers });
    }
  }

  headers["Content-Length"] = String(fileSize);
  return new NextResponse(fileBuffer as unknown as BodyInit, { status: 200, headers });
}
