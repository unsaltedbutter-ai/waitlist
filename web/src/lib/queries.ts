import { query } from "@/lib/db";

export interface UserRow {
  id: string;
  nostr_npub: string;
  debt_sats: number;
  onboarded_at: string | null;
  created_at: string;
}

/**
 * Look up a user by their Nostr npub (URL-encoded or plain).
 * Returns the user row or null if not found.
 */
export async function getUserByNpub(
  npub: string
): Promise<UserRow | null> {
  const decoded = decodeURIComponent(npub);
  const result = await query<UserRow>(
    "SELECT id, nostr_npub, debt_sats, onboarded_at, created_at FROM users WHERE nostr_npub = $1",
    [decoded]
  );
  return result.rows[0] ?? null;
}
