import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getUserByNpub } from "@/lib/queries";

const SERVICE_ID_REGEX = /^[a-z][a-z0-9_]{1,30}$/;

export const GET = withAgentAuth(async (_req: NextRequest, { params }) => {
  const npub = params?.npub;
  const service = params?.service;

  if (!npub || !service) {
    return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
  }

  if (!SERVICE_ID_REGEX.test(service)) {
    return NextResponse.json({ error: "Invalid service ID format" }, { status: 400 });
  }

  try {
    const user = await getUserByNpub(npub);

    if (!user) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const userId = user.id;

    // Verify a dispatched, active, or awaiting_otp job exists for this user+service
    const jobResult = await query<{ id: string }>(
      `SELECT id FROM jobs
       WHERE user_id = $1 AND service_id = $2 AND status IN ('dispatched', 'active', 'awaiting_otp', 'outreach_sent')
       LIMIT 1`,
      [userId, service]
    );

    if (jobResult.rows.length === 0) {
      return NextResponse.json(
        { error: "No active job for this user and service" },
        { status: 403 }
      );
    }

    // Look up credentials
    const credResult = await query<{ email_enc: Buffer; password_enc: Buffer }>(
      "SELECT email_enc, password_enc FROM streaming_credentials WHERE user_id = $1 AND service_id = $2",
      [userId, service]
    );

    if (credResult.rows.length === 0) {
      return NextResponse.json(
        { error: "No credentials found" },
        { status: 404 }
      );
    }

    const row = credResult.rows[0];
    const email = decrypt(row.email_enc);
    const password = decrypt(row.password_enc);

    return NextResponse.json({ email, password });
  } catch (err) {
    console.error("Agent credentials lookup error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
