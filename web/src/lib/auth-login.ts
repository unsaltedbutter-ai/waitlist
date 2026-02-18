/**
 * Shared login/signup helpers used by both /api/auth/nostr and /api/auth/nostr-otp routes.
 */
import { query, transaction } from "@/lib/db";
import { createToken, needsOnboarding } from "@/lib/auth";
import { isAtCapacity } from "@/lib/capacity";

export type LoginResult = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * Login an existing user: update timestamp, create JWT, check onboarding.
 * Returns null if the npub has no matching user row.
 */
export async function loginExistingUser(
  npub: string
): Promise<LoginResult | null> {
  const existing = await query<{ id: string }>(
    "UPDATE users SET updated_at = NOW() WHERE nostr_npub = $1 RETURNING id",
    [npub]
  );

  if (existing.rows.length === 0) return null;

  const userId = existing.rows[0].id;
  const token = await createToken(userId);
  const onboarding = await needsOnboarding(userId);

  return {
    status: 200,
    body: { token, userId, ...(onboarding && { needsOnboarding: true }) },
  };
}

/**
 * Create a new user and redeem a waitlist entry in one transaction.
 * Checks capacity before proceeding.
 *
 * @param npub - hex pubkey for the new user
 * @param waitlistId - the waitlist row ID to mark as redeemed
 * @returns LoginResult with 201 on success, 403 if at capacity
 */
export async function createUserWithInvite(
  npub: string,
  waitlistId: string
): Promise<LoginResult> {
  if (await isAtCapacity()) {
    return { status: 403, body: { error: "At capacity" } };
  }

  const userId = await transaction(async (txQuery) => {
    const result = await txQuery<{ id: string }>(
      `INSERT INTO users (nostr_npub) VALUES ($1) RETURNING id`,
      [npub]
    );
    await txQuery(
      "UPDATE waitlist SET redeemed_at = NOW() WHERE id = $1",
      [waitlistId]
    );
    return result.rows[0].id;
  });

  const token = await createToken(userId);

  return { status: 201, body: { token, userId } };
}

/**
 * Auto-lookup a waitlist entry by npub hex. Returns the waitlist row ID if found, null otherwise.
 */
export async function lookupInviteByNpub(
  npubHex: string
): Promise<string | null> {
  const inviteCheck = await query<{ id: string }>(
    "SELECT id FROM waitlist WHERE nostr_npub = $1 AND invited = TRUE AND redeemed_at IS NULL",
    [npubHex]
  );
  return inviteCheck.rows.length > 0 ? inviteCheck.rows[0].id : null;
}
