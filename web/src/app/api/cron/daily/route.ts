import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runDailyCron } from "@/lib/cron-daily";

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const auth = req.headers.get("authorization");
  if (!auth) return false;

  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) return false;

  if (token.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(secret));
}

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runDailyCron();
    return NextResponse.json(result);
  } catch (err) {
    console.error("Daily cron error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
