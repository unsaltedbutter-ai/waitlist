import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export const GET = withAuth(async (req: NextRequest, { userId }) => {
  const invoiceId = req.nextUrl.searchParams.get("invoiceId");
  if (!invoiceId) {
    return NextResponse.json(
      { error: "invoiceId is required" },
      { status: 400 }
    );
  }

  const result = await query<{ status: string }>(
    `SELECT status FROM membership_payments
     WHERE user_id = $1 AND btcpay_invoice_id = $2
     LIMIT 1`,
    [userId, invoiceId]
  );

  if (result.rows.length === 0) {
    return NextResponse.json(
      { error: "Invoice not found" },
      { status: 404 }
    );
  }

  const dbStatus = result.rows[0].status;
  return NextResponse.json({
    status: dbStatus === "paid" ? "paid" : "pending",
  });
});
