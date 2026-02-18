import { NextRequest, NextResponse } from "next/server";
import { verifyEvent, type Event } from "nostr-tools";
import { query, transaction } from "@/lib/db";
import { createToken, needsOnboarding } from "@/lib/auth";
import { isAtCapacity } from "@/lib/capacity";

// Replay protection: track consumed event IDs with 5-minute TTL
const consumedEvents = new Map<string, number>(); // eventId -> expiresAt (ms)

function cleanupConsumedEvents() {
  const now = Date.now();
  consumedEvents.forEach((expiresAt, id) => {
    if (now > expiresAt) consumedEvents.delete(id);
  });
}

export async function POST(req: NextRequest) {
  cleanupConsumedEvents();
  let body: { event: Event; inviteCode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { event, inviteCode } = body;
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

  // Replay protection: reject already-consumed events
  if (consumedEvents.has(event.id)) {
    return NextResponse.json({ error: "Event already used" }, { status: 401 });
  }
  consumedEvents.set(event.id, Date.now() + 5 * 60 * 1000);

  const npub = event.pubkey;

  // Check if user already exists
  const existing = await query<{ id: string }>(
    "SELECT id FROM users WHERE nostr_npub = $1",
    [npub]
  );

  if (existing.rows.length > 0) {
    // Existing user: login, no invite code needed
    const userId = existing.rows[0].id;
    await query("UPDATE users SET updated_at = NOW() WHERE id = $1", [userId]);
    const token = await createToken(userId);
    const onboarding = await needsOnboarding(userId);
    return NextResponse.json({ token, userId, ...(onboarding && { needsOnboarding: true }) });
  }

  // New user — require invite code
  if (!inviteCode) {
    return NextResponse.json(
      { error: "Invite code required" },
      { status: 403 }
    );
  }

  // Validate invite code against waitlist (must not already be redeemed)
  const codeCheck = await query<{ id: string }>(
    "SELECT id FROM waitlist WHERE invite_code = $1 AND invited = TRUE AND redeemed_at IS NULL",
    [inviteCode]
  );
  if (codeCheck.rows.length === 0) {
    return NextResponse.json(
      { error: "Invalid or expired invite code" },
      { status: 403 }
    );
  }

  // Check capacity
  if (await isAtCapacity()) {
    return NextResponse.json(
      { error: "At capacity" },
      { status: 403 }
    );
  }

  // Create user and redeem invite code in a single transaction
  const userId = await transaction(async (txQuery) => {
    const result = await txQuery<{ id: string }>(
      `INSERT INTO users (nostr_npub, status)
       VALUES ($1, 'auto_paused')
       RETURNING id`,
      [npub]
    );
    await txQuery(
      "UPDATE waitlist SET redeemed_at = NOW() WHERE invite_code = $1",
      [inviteCode]
    );
    return result.rows[0].id;
  });

  const token = await createToken(userId);

  return NextResponse.json({ token, userId }, { status: 201 });
}
