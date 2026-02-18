import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";
import { UUID_REGEX } from "@/lib/constants";

export const GET = withAgentAuth(async (_req: NextRequest, { params }) => {
  const invoiceId = params?.id;

  if (!invoiceId) {
    return NextResponse.json({ error: "Missing invoice ID" }, { status: 400 });
  }

  if (!UUID_REGEX.test(invoiceId)) {
    return NextResponse.json({ error: "Invalid invoice ID format" }, { status: 400 });
  }

  // Look up the job by invoice_id
  const jobResult = await query<{
    id: string;
    status: string;
    amount_sats: number | null;
    invoice_id: string;
  }>(
    "SELECT id, status, amount_sats, invoice_id FROM jobs WHERE invoice_id = $1",
    [invoiceId]
  );

  if (jobResult.rows.length === 0) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  const job = jobResult.rows[0];

  // Check for a matching transaction row
  const txResult = await query<{
    status: string;
    amount_sats: number;
    paid_at: string | null;
  }>(
    "SELECT status, amount_sats, paid_at FROM transactions WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1",
    [job.id]
  );

  const tx = txResult.rows[0];

  return NextResponse.json({
    invoice_id: invoiceId,
    status: tx?.status ?? "unknown",
    amount_sats: tx?.amount_sats ?? job.amount_sats ?? 0,
    paid_at: tx?.paid_at ?? null,
  });
});
