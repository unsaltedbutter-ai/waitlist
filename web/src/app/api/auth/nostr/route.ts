import { NextRequest, NextResponse } from "next/server";
import { verifyEvent, type Event } from "nostr-tools";
import {
  loginExistingUser,
  createUserWithInvite,
  validateInviteCode,
} from "@/lib/auth-login";

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

  // Existing user: login
  const loginResult = await loginExistingUser(npub);
  if (loginResult) {
    return NextResponse.json(loginResult.body, { status: loginResult.status });
  }

  // New user: require invite code
  if (!inviteCode) {
    return NextResponse.json(
      { error: "Invite code required" },
      { status: 403 }
    );
  }

  const waitlistId = await validateInviteCode(inviteCode);
  if (!waitlistId) {
    return NextResponse.json(
      { error: "Invalid or expired invite code" },
      { status: 403 }
    );
  }

  const result = await createUserWithInvite(npub, waitlistId);
  return NextResponse.json(result.body, { status: result.status });
}
