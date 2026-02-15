import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";

export const POST = withAuth(async (req: NextRequest, { userId }) => {
  let body: { answers: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { answers } = body;

  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return NextResponse.json(
      { error: "Missing or invalid answers object" },
      { status: 400 }
    );
  }

  const keys = Object.keys(answers);
  if (keys.length === 0) {
    return NextResponse.json(
      { error: "Answers object is empty" },
      { status: 400 }
    );
  }

  // Validate all keys exist in signup_questions
  const validQuestions = await query<{ id: string }>(
    "SELECT id FROM signup_questions"
  );
  const validIds = new Set(validQuestions.rows.map((r) => r.id));

  const invalidKeys = keys.filter((k) => !validIds.has(k));
  if (invalidKeys.length > 0) {
    return NextResponse.json(
      { error: `Invalid question keys: ${invalidKeys.join(", ")}` },
      { status: 400 }
    );
  }

  const encrypted = encrypt(JSON.stringify(answers));

  await query(
    `UPDATE users SET signup_answers_enc = $1, updated_at = NOW() WHERE id = $2`,
    [encrypted, userId]
  );

  return NextResponse.json({ success: true });
});

export const GET = withAuth(async (_req: NextRequest, { userId }) => {
  const result = await query<{ signup_answers_enc: Buffer | null }>(
    "SELECT signup_answers_enc FROM users WHERE id = $1",
    [userId]
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ answers: {} });
  }

  const { signup_answers_enc } = result.rows[0];

  if (!signup_answers_enc) {
    return NextResponse.json({ answers: {} });
  }

  const decrypted = decrypt(Buffer.from(signup_answers_enc));
  const answers = JSON.parse(decrypted);

  return NextResponse.json({ answers });
});
