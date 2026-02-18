import { query } from "@/lib/db";
import { customAlphabet } from "nanoid";

const nanoid = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 12);

const USER_CAP = parseInt(process.env.USER_CAP ?? "5000", 10);

export async function getActiveUserCount(): Promise<number> {
  const result = await query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM users WHERE onboarded_at IS NOT NULL"
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

export function generateInviteCode(): string {
  return nanoid();
}
