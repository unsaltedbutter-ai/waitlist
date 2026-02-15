import { query, transaction } from "@/lib/db";
import { customAlphabet } from "nanoid";

const nanoid = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 12);

const USER_CAP = parseInt(process.env.USER_CAP ?? "5000", 10);

export async function getActiveUserCount(): Promise<number> {
  const result = await query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM users WHERE status IN ('active', 'expiring')"
  );
  return parseInt(result.rows[0].count, 10);
}

export async function isAtCapacity(): Promise<boolean> {
  const count = await getActiveUserCount();
  return count >= USER_CAP;
}

export function getUserCap(): number {
  return USER_CAP;
}

interface ReferralTier {
  codesPerUser: number;
  expiresInDays: number | null;
}

export function getReferralTier(activeCount: number): ReferralTier {
  if (activeCount < 500) return { codesPerUser: 3, expiresInDays: null };
  if (activeCount < 1000) return { codesPerUser: 2, expiresInDays: null };
  if (activeCount < 2000) return { codesPerUser: 1, expiresInDays: null };
  if (activeCount < 4000) return { codesPerUser: 1, expiresInDays: 30 };
  return { codesPerUser: 0, expiresInDays: null };
}

export function generateInviteCode(): string {
  return nanoid();
}

export async function generateReferralCodes(
  userId: string,
  activeUserCount: number
): Promise<void> {
  const tier = getReferralTier(activeUserCount);
  if (tier.codesPerUser === 0) return;

  const expiresExpr = tier.expiresInDays
    ? `NOW() + INTERVAL '${tier.expiresInDays} days'`
    : "NULL";

  for (let i = 0; i < tier.codesPerUser; i++) {
    const code = nanoid();
    await query(
      `INSERT INTO referral_codes (owner_id, code, status, expires_at)
       VALUES ($1, $2, 'active', ${expiresExpr})`,
      [userId, code]
    );
  }
}

/**
 * Validate an invite code. Returns the code row if valid, null otherwise.
 * Does NOT consume the code.
 */
export async function validateInviteCode(code: string): Promise<{
  valid: boolean;
  expired?: boolean;
  codeRow?: { id: string; owner_id: string; status: string; expires_at: string | null };
}> {
  const result = await query<{
    id: string;
    owner_id: string;
    status: string;
    expires_at: string | null;
  }>(
    "SELECT id, owner_id, status, expires_at FROM referral_codes WHERE code = $1",
    [code]
  );

  if (result.rows.length === 0) {
    return { valid: false };
  }

  const row = result.rows[0];

  if (row.status !== "active") {
    return { valid: false };
  }

  // Check expiry
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    // Mark as expired
    await query(
      "UPDATE referral_codes SET status = 'expired' WHERE id = $1",
      [row.id]
    );
    return { valid: false, expired: true };
  }

  return { valid: true, codeRow: row };
}

/**
 * Consume an invite code: mark it as used and set used_by_id.
 * Should be called inside a transaction.
 */
export async function consumeInviteCode(
  codeId: string,
  usedById: string
): Promise<void> {
  await query(
    "UPDATE referral_codes SET status = 'used', used_by_id = $1 WHERE id = $2",
    [usedById, codeId]
  );
}
