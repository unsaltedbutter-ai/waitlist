import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

export const GET = withOperator(async (_req: NextRequest) => {
  try {
    const result = await query(`
      SELECT id, alert_type, severity, title, message, created_at
      FROM operator_alerts
      WHERE acknowledged = FALSE
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        created_at DESC
      LIMIT 50
    `);

    return NextResponse.json({ alerts: result.rows });
  } catch (err) {
    console.error("Operator alerts error:", err);
    return NextResponse.json(
      { error: "Failed to fetch alerts" },
      { status: 500 }
    );
  }
});

export const POST = withOperator(async (req: NextRequest) => {
  try {
    const body = await req.json();
    const ids: string[] = body.ids;

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: "ids must be a non-empty array" },
        { status: 400 }
      );
    }

    await query(
      `UPDATE operator_alerts SET acknowledged = TRUE WHERE id = ANY($1)`,
      [ids]
    );

    return NextResponse.json({ acknowledged: ids.length });
  } catch (err) {
    console.error("Operator alert ack error:", err);
    return NextResponse.json(
      { error: "Failed to acknowledge alerts" },
      { status: 500 }
    );
  }
});
