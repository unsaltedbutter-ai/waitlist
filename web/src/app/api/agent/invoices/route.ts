import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query, transaction } from "@/lib/db";
import { createLightningInvoice } from "@/lib/btcpay-invoice";
import { parseJsonBody } from "@/lib/parse-json-body";

export const POST = withAgentAuth(async (_req: NextRequest, { body: rawBody }) => {
  const { data: parsed, error } = parseJsonBody<{
    job_id?: string;
    amount_sats?: number;
    user_npub?: string;
  }>(rawBody);
  if (error) return error;

  const { job_id, amount_sats, user_npub } = parsed;

  if (!job_id || !user_npub || amount_sats === undefined || amount_sats === null) {
    return NextResponse.json(
      { error: "Missing required fields: job_id, amount_sats, user_npub" },
      { status: 400 }
    );
  }

  if (!Number.isInteger(amount_sats) || amount_sats <= 0) {
    return NextResponse.json(
      { error: "amount_sats must be a positive integer" },
      { status: 400 }
    );
  }

  try {
    // Verify user exists
    const userResult = await query<{ id: string }>(
      "SELECT id FROM users WHERE nostr_npub = $1",
      [user_npub]
    );

    if (userResult.rows.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const userId = userResult.rows[0].id;

    // Verify job exists and belongs to user
    const jobResult = await query<{ id: string; service_id: string; action: string; status: string; invoice_id: string | null }>(
      "SELECT id, service_id, action, status, invoice_id FROM jobs WHERE id = $1 AND user_id = $2",
      [job_id, userId]
    );

    if (jobResult.rows.length === 0) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const job = jobResult.rows[0];

    // Reject if invoice already exists for this job
    if (job.invoice_id) {
      return NextResponse.json(
        { error: "Invoice already exists for this job" },
        { status: 409 }
      );
    }

    // Reject if job is already paid
    if (job.status === "completed_paid" || job.status === "completed_eventual") {
      return NextResponse.json(
        { error: "Job already paid" },
        { status: 409 }
      );
    }

    // Create Lightning invoice via BTCPay
    let invoice;
    try {
      invoice = await createLightningInvoice({
        amountSats: amount_sats,
        metadata: { job_id, user_npub },
      });
    } catch {
      return NextResponse.json(
        { error: "Failed to create Lightning invoice" },
        { status: 502 }
      );
    }

    // Store invoice_id on job and create transaction row atomically
    await transaction(async (txQuery) => {
      await txQuery(
        "UPDATE jobs SET invoice_id = $1, amount_sats = $2 WHERE id = $3",
        [invoice.id, amount_sats, job_id]
      );
      await txQuery(
        `INSERT INTO transactions (job_id, user_id, service_id, action, amount_sats, status)
         VALUES ($1, $2, $3, $4, $5, 'invoice_sent')`,
        [job_id, userId, job.service_id, job.action, amount_sats]
      );
    });

    return NextResponse.json({
      invoice_id: invoice.id,
      bolt11: invoice.bolt11,
      amount_sats,
    });
  } catch (err) {
    console.error("Agent invoice create error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
