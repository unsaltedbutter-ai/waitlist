import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";

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
       (user_id, service_id, email_enc, password_enc)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, service_id) DO UPDATE SET
       email_enc = EXCLUDED.email_enc,
       password_enc = EXCLUDED.password_enc`,
    [userId, serviceId, emailEnc, passwordEnc]
  );

  return NextResponse.json({ success: true }, { status: 201 });
});

export const GET = withAuth(async (_req: NextRequest, { userId }) => {
  const result = await query(
    `SELECT sc.service_id, ss.display_name AS service_name, sc.email_enc
     FROM streaming_credentials sc
     JOIN streaming_services ss ON ss.id = sc.service_id
     WHERE sc.user_id = $1
     ORDER BY ss.display_name`,
    [userId]
  );

  const credentials = result.rows.map((row) => ({
    serviceId: row.service_id,
    serviceName: row.service_name,
    email: decrypt(row.email_enc),
  }));

  return NextResponse.json({ credentials });
});
