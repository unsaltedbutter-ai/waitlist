import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query, transaction } from "@/lib/db";
import { createLightningInvoice } from "@/lib/btcpay-invoice";

export const POST = withAuth(async (_req: NextRequest, { userId }) => {
  try {
    const userResult = await query<{ id: string; debt_sats: number; nostr_npub: string }>(
      "SELECT id, debt_sats, nostr_npub FROM users WHERE id = $1",
      [userId]
    );

    if (userResult.rows.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const user = userResult.rows[0];

    if (user.debt_sats <= 0) {
      return NextResponse.json({ error: "No outstanding debt" }, { status: 400 });
    }

    // Find all reneged jobs that don't already have an invoice
    const renegedJobs = await query<{ id: string; invoice_id: string | null }>(
      `SELECT id, invoice_id FROM jobs
       WHERE user_id = $1 AND status = 'completed_reneged'
       ORDER BY status_updated_at ASC`,
      [userId]
    );

    // If all reneged jobs already have invoices, check if any are still unpaid.
    // In that case, return the existing invoice info for the first one.
    const jobsWithoutInvoice = renegedJobs.rows.filter((j) => !j.invoice_id);
    const jobsWithInvoice = renegedJobs.rows.filter((j) => j.invoice_id);

    if (jobsWithoutInvoice.length === 0 && jobsWithInvoice.length > 0) {
      // All reneged jobs have invoices already. Return the first one's invoice.
      const existingJob = jobsWithInvoice[0];
      return NextResponse.json({
        invoice_id: existingJob.invoice_id,
        amount_sats: user.debt_sats,
        already_exists: true,
      });
    }

    if (renegedJobs.rows.length === 0) {
      // debt_sats > 0 but no reneged jobs: data inconsistency
      return NextResponse.json(
        { error: "No unpaid jobs found (data inconsistency)" },
        { status: 400 }
      );
    }

    // Create a single Lightning invoice for the total debt
    let invoice;
    try {
      invoice = await createLightningInvoice({
        amountSats: user.debt_sats,
        metadata: {
          user_id: userId,
          type: "debt_payment",
          job_count: String(renegedJobs.rows.length),
        },
      });
    } catch {
      return NextResponse.json(
        { error: "Failed to create Lightning invoice" },
        { status: 502 }
      );
    }

    // Stamp the invoice_id on all reneged jobs that don't have one yet,
    // and create transaction rows for any that lack them
    await transaction(async (txQuery) => {
      for (const job of jobsWithoutInvoice) {
        await txQuery(
          "UPDATE jobs SET invoice_id = $1 WHERE id = $2",
          [invoice.id, job.id]
        );
      }
    });

    return NextResponse.json({
      invoice_id: invoice.id,
      bolt11: invoice.bolt11,
      amount_sats: user.debt_sats,
    });
  } catch (err) {
    console.error("Debt pay error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
