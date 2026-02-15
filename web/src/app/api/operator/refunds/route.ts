import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

export const GET = withOperator(async (_req: NextRequest) => {
  const result = await query<{
    id: string;
    contact: string;
    amount_sats: string;
    created_at: string;
  }>("SELECT id, contact, amount_sats, created_at FROM pending_refunds ORDER BY created_at ASC");

  return NextResponse.json({
    refunds: result.rows.map((r) => ({
      ...r,
      amount_sats: parseInt(r.amount_sats, 10),
    })),
  });
});

export const DELETE = withOperator(async (req: NextRequest) => {
  let body: { refundId: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { refundId } = body;
  if (!refundId) {
    return NextResponse.json({ error: "Missing refundId" }, { status: 400 });
  }

  const result = await query(
    "DELETE FROM pending_refunds WHERE id = $1",
    [refundId]
  );

  if (result.rowCount === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
});
