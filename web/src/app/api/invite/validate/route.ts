import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export async function POST(req: NextRequest) {
  let body: { code: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { code } = body;
  if (!code || typeof code !== "string") {
    return NextResponse.json(
      { error: "Missing invite code" },
      { status: 400 }
    );
  }

  try {
    const result = await query<{ id: string }>(
      "SELECT id FROM waitlist WHERE invite_code = $1 AND invited = TRUE",
      [code]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ valid: false });
    }

    return NextResponse.json({ valid: true });
  } catch (err) {
    console.error("Invite validate error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
