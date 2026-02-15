import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export const POST = withAuth(async (req: NextRequest, { userId }) => {
  let body: { consentType: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { consentType } = body;
  if (!consentType || !["authorization", "confirmation"].includes(consentType)) {
    return NextResponse.json(
      { error: "Invalid consent type" },
      { status: 400 }
    );
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const userAgent = req.headers.get("user-agent") || "unknown";

  await query(
    `INSERT INTO user_consents (user_id, consent_type, ip_address, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [userId, consentType, ip, userAgent]
  );

  return NextResponse.json({ success: true }, { status: 201 });
});
