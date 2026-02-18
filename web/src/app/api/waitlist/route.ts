import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import { npubToHex } from "@/lib/nostr";

const limiter = createRateLimiter(5, 15 * 60 * 1000); // 5 attempts per 15 minutes

export async function POST(req: NextRequest) {
  // Rate limit by IP
  const ip = getClientIp(req);
  const { allowed } = limiter.check(ip);

  if (!allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429 }
    );
  }

  let body: {
    nostrNpub: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { nostrNpub } = body;

  if (!nostrNpub) {
    return NextResponse.json(
      { error: "nostrNpub is required" },
      { status: 400 }
    );
  }

  // Validate and normalize npub to hex
  let npubHex: string;
  try {
    npubHex = npubToHex(nostrNpub);
  } catch {
    return NextResponse.json(
      { error: "Invalid npub format" },
      { status: 400 }
    );
  }

  try {
    // Check for duplicate
    const existing = await query(
      "SELECT id FROM waitlist WHERE nostr_npub = $1",
      [npubHex]
    );
    if (existing.rows.length > 0) {
      return NextResponse.json(
        { error: "You're already on the list." },
        { status: 409 }
      );
    }

    await query(
      "INSERT INTO waitlist (nostr_npub) VALUES ($1)",
      [npubHex]
    );

    return NextResponse.json(
      { message: "You're in. We'll be in touch." },
      { status: 201 }
    );
  } catch (err) {
    console.error("Waitlist POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
