import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";
import { npubToHex } from "@/lib/nostr";
import { TERMINAL_STATUSES } from "@/lib/constants";

export const GET = withOperator(async (req: NextRequest) => {
  const url = new URL(req.url);
  const npub = url.searchParams.get("npub");

  if (!npub || typeof npub !== "string" || npub.trim().length === 0) {
    return NextResponse.json(
      { error: "Missing or empty npub query parameter" },
      { status: 400 }
    );
  }

  let hex: string;
  try {
    hex = npubToHex(npub.trim());
  } catch {
    return NextResponse.json(
      { error: "Invalid npub: must be a 64-char hex string or bech32 npub1... string" },
      { status: 400 }
    );
  }

  // Look up user
  const userResult = await query<{
    id: string;
    nostr_npub: string;
    debt_sats: number;
  }>("SELECT id, nostr_npub, debt_sats FROM users WHERE nostr_npub = $1", [hex]);

  if (userResult.rows.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const user = userResult.rows[0];

  // Fetch jobs: non-terminal + terminal from last 30 days
  const terminalPlaceholders = TERMINAL_STATUSES.map(
    (_, i) => `$${i + 2}`
  ).join(", ");

  const jobsResult = await query<{
    id: string;
    service_id: string;
    action: string;
    trigger: string;
    status: string;
    status_updated_at: string;
    billing_date: string | null;
    access_end_date: string | null;
    amount_sats: number | null;
    created_at: string;
  }>(
    `SELECT id, service_id, action, trigger, status, status_updated_at,
            billing_date, access_end_date, amount_sats, created_at
     FROM jobs WHERE user_id = $1
       AND (status NOT IN (${terminalPlaceholders})
            OR status_updated_at > NOW() - INTERVAL '30 days')
     ORDER BY created_at DESC LIMIT 50`,
    [user.id, ...TERMINAL_STATUSES]
  );

  return NextResponse.json({ user, jobs: jobsResult.rows });
});
