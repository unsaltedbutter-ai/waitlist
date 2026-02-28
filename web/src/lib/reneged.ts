import { query } from "@/lib/db";

export async function checkEmailBlocklist(
  userId: string,
  serviceId: string
): Promise<{ blocked: boolean; debt_sats: number }> {
  const credResult = await query<{ email_hash: string | null }>(
    "SELECT email_hash FROM streaming_credentials WHERE user_id = $1 AND service_id = $2",
    [userId, serviceId]
  );

  if (credResult.rows.length === 0 || !credResult.rows[0].email_hash) {
    return { blocked: false, debt_sats: 0 };
  }

  const hash = credResult.rows[0].email_hash;

  const renegedResult = await query<{ total_debt_sats: number }>(
    "SELECT total_debt_sats FROM reneged_emails WHERE email_hash = $1",
    [hash]
  );

  if (renegedResult.rows.length === 0) {
    return { blocked: false, debt_sats: 0 };
  }

  const debt = renegedResult.rows[0].total_debt_sats;
  return { blocked: debt > 0, debt_sats: debt };
}
