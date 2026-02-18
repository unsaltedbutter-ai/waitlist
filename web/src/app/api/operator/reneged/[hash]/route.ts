import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

export const DELETE = withOperator(
  async (req: NextRequest, { params }: { userId: string; params?: Record<string, string> }) => {
    const hash = params?.hash;
    if (!hash) {
      return NextResponse.json({ error: "Missing email hash" }, { status: 400 });
    }

    let body: { reason?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { reason } = body;

    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      return NextResponse.json({ error: "reason is required" }, { status: 400 });
    }

    // Verify entry exists
    const result = await query<{ email_hash: string; total_debt_sats: number }>(
      "SELECT email_hash, total_debt_sats FROM reneged_emails WHERE email_hash = $1",
      [hash]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Reneged email entry not found" }, { status: 404 });
    }

    const entry = result.rows[0];

    // Delete the entry
    await query("DELETE FROM reneged_emails WHERE email_hash = $1", [hash]);

    // Write audit log
    await query(
      `INSERT INTO operator_audit_log (action, target_type, target_id, detail)
       VALUES ($1, $2, $3, $4)`,
      [
        "delete_reneged_email",
        "reneged_email",
        hash,
        JSON.stringify({ total_debt_sats: entry.total_debt_sats, reason: reason.trim() }),
      ]
    );

    return NextResponse.json({ ok: true });
  }
);
