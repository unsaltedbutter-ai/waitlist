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

  const bpResult = await query<{ status: string }>(
    `SELECT status FROM btc_prepayments
     WHERE user_id = $1 AND btcpay_invoice_id = $2
     LIMIT 1`,
    [userId, invoiceId]
  );

  if (bpResult.rows.length > 0) {
    const dbStatus = bpResult.rows[0].status;
    return NextResponse.json({
      status: dbStatus === "paid" ? "paid" : "pending",
    });
  }

  return NextResponse.json(
    { error: "Invoice not found" },
    { status: 404 }
  );
});
