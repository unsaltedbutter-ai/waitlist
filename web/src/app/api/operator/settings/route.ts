import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

export const GET = withOperator(async () => {
  const result = await query<{ value: string }>(
    "SELECT value FROM operator_settings WHERE key = 'action_price_sats'"
  );

  const raw = result.rows[0]?.value ?? "3000";
  const parsed = parseInt(raw, 10);

  return NextResponse.json({
    action_price_sats: Number.isFinite(parsed) && parsed > 0 ? parsed : 3000,
  });
});

export const PATCH = withOperator(async (req: NextRequest) => {
  let body: { action_price_sats?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { action_price_sats } = body;

  if (
    typeof action_price_sats !== "number" ||
    !Number.isInteger(action_price_sats) ||
    action_price_sats <= 0 ||
    action_price_sats > 1_000_000
  ) {
    return NextResponse.json(
      { error: "action_price_sats must be a positive integer <= 1,000,000" },
      { status: 400 }
    );
  }

  await query(
    "UPDATE operator_settings SET value = $1, updated_at = NOW() WHERE key = 'action_price_sats'",
    [String(action_price_sats)]
  );

  await query(
    `INSERT INTO operator_audit_log (action, target_type, target_id, detail)
     VALUES ($1, $2, $3, $4)`,
    [
      "update_setting",
      "operator_settings",
      "action_price_sats",
      JSON.stringify({ new_value: action_price_sats }),
    ]
  );

  return NextResponse.json({ action_price_sats });
});
