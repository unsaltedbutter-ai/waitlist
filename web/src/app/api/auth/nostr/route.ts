import { NextRequest, NextResponse } from "next/server";
import { verifyEvent, type Event } from "nostr-tools";
import { query } from "@/lib/db";
import { createToken } from "@/lib/auth";

export async function POST(req: NextRequest) {
  let body: { event: Event };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { event } = body;
  if (!event) {
    return NextResponse.json(
      { error: "Missing signed event" },
      { status: 400 }
    );
  }

  // Verify kind 22242 (NIP-42 auth)
  if (event.kind !== 22242) {
    return NextResponse.json(
      { error: "Invalid event kind, expected 22242" },
      { status: 400 }
    );
  }

  // Verify signature
  const valid = verifyEvent(event);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Check event is recent (within 5 minutes)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > 300) {
    return NextResponse.json({ error: "Event expired" }, { status: 401 });
  }

  const npub = event.pubkey;

  // Upsert user
  const result = await query(
    `INSERT INTO users (nostr_npub, status, membership_type)
     VALUES ($1, 'active', 'monthly')
     ON CONFLICT (nostr_npub) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [npub]
  );

  const userId = result.rows[0].id;
  const token = await createToken(userId);

  return NextResponse.json({ token, userId });
}
