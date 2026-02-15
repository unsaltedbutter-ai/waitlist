import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";
import { generateInviteCode, isAtCapacity } from "@/lib/capacity";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

export const POST = withOperator(async (req: NextRequest) => {
  let body: { waitlistId: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { waitlistId } = body;
  if (!waitlistId) {
    return NextResponse.json(
      { error: "Missing waitlistId" },
      { status: 400 }
    );
  }

  // Check capacity
  if (await isAtCapacity()) {
    return NextResponse.json(
      { error: "At capacity" },
      { status: 403 }
    );
  }

  // Check waitlist entry exists and hasn't been invited
  const entry = await query<{ id: string; invited: boolean }>(
    "SELECT id, invited FROM waitlist WHERE id = $1",
    [waitlistId]
  );

  if (entry.rows.length === 0) {
    return NextResponse.json(
      { error: "Waitlist entry not found" },
      { status: 404 }
    );
  }

  if (entry.rows[0].invited) {
    return NextResponse.json(
      { error: "Already invited" },
      { status: 409 }
    );
  }

  // Generate invite code and store on waitlist entry
  const code = generateInviteCode();

  await query(
    `UPDATE waitlist
     SET invited = TRUE, invited_at = NOW(), invite_code = $1
     WHERE id = $2`,
    [code, waitlistId]
  );

  const inviteLink = `${BASE_URL}/login?code=${code}`;

  return NextResponse.json({ code, inviteLink }, { status: 201 });
});
