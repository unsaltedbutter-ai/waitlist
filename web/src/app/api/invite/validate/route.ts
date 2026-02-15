import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/lib/capacity";

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

  const result = await validateInviteCode(code);

  if (!result.valid) {
    return NextResponse.json({
      valid: false,
      ...(result.expired ? { expired: true } : {}),
    });
  }

  return NextResponse.json({ valid: true });
}
