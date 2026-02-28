import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";
import { encrypt, hashEmail } from "@/lib/crypto";

export const POST = withAuth(async (req: NextRequest, { userId }) => {
  let body: { serviceId: string; email: string; password: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { serviceId, email, password } = body;

  if (!serviceId || !email || !password) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  try {
    // Check if this email is on the reneged blocklist
    const emailHash = hashEmail(email);
    const renegedCheck = await query<{ total_debt_sats: number }>(
      "SELECT total_debt_sats FROM reneged_emails WHERE email_hash = $1",
      [emailHash]
    );
    if (renegedCheck.rows.length > 0 && renegedCheck.rows[0].total_debt_sats > 0) {
      return NextResponse.json(
        {
          error: "Outstanding balance of " + renegedCheck.rows[0].total_debt_sats + " sats must be paid before adding credentials",
          debt_sats: renegedCheck.rows[0].total_debt_sats,
        },
        { status: 403 }
      );
    }

    // Verify service exists
    const svc = await query(
      "SELECT id FROM streaming_services WHERE id = $1 AND supported = TRUE",
      [serviceId]
    );
    if (svc.rows.length === 0) {
      return NextResponse.json(
        { error: "Invalid or unsupported service" },
        { status: 400 }
      );
    }

    const emailEnc = encrypt(email);
    const passwordEnc = encrypt(password);

    await query(
      `INSERT INTO streaming_credentials
         (user_id, service_id, email_enc, password_enc, email_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, service_id) DO UPDATE SET
         email_enc = EXCLUDED.email_enc,
         password_enc = EXCLUDED.password_enc,
         email_hash = EXCLUDED.email_hash,
         credential_failures = 0,
         last_failure_at = NULL,
         updated_at = NOW()`,
      [userId, serviceId, emailEnc, passwordEnc, emailHash]
    );

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (err) {
    console.error("Credentials POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});

export const GET = withAuth(async (_req: NextRequest, { userId }) => {
  try {
    const result = await query(
      `SELECT sc.service_id, ss.display_name AS service_name
       FROM streaming_credentials sc
       JOIN streaming_services ss ON ss.id = sc.service_id
       WHERE sc.user_id = $1
       ORDER BY ss.display_name`,
      [userId]
    );

    const credentials = result.rows.map((row) => ({
      serviceId: row.service_id,
      serviceName: row.service_name,
    }));

    return NextResponse.json({ credentials });
  } catch (err) {
    console.error("Credentials GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
