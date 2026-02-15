import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export async function GET() {
  const result = await query<{
    id: string;
    label: string;
    field_type: string;
    options: string[] | null;
    placeholder: string | null;
  }>(
    `SELECT id, label, field_type, options, placeholder
     FROM signup_questions
     ORDER BY display_order`
  );

  return NextResponse.json({ questions: result.rows });
}
