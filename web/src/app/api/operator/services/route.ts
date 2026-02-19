import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export const GET = withOperator(async () => {
  const result = await query(
    "SELECT * FROM streaming_services ORDER BY display_name"
  );

  return NextResponse.json({ services: result.rows });
});

export const POST = withOperator(async (req: NextRequest) => {
  let body: {
    display_name?: string;
    signup_url?: string;
    cancel_url?: string;
    logo_url?: string;
    notes?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { display_name, signup_url, cancel_url, logo_url, notes } = body;

  if (!display_name || typeof display_name !== "string" || !display_name.trim()) {
    return NextResponse.json({ error: "display_name is required" }, { status: 400 });
  }

  if (!signup_url || typeof signup_url !== "string" || !signup_url.trim()) {
    return NextResponse.json({ error: "signup_url is required" }, { status: 400 });
  }

  const id = slugify(display_name);
  if (!id) {
    return NextResponse.json({ error: "display_name produces an empty slug" }, { status: 400 });
  }

  // Check for duplicate
  const existing = await query("SELECT id FROM streaming_services WHERE id = $1", [id]);
  if (existing.rows.length > 0) {
    return NextResponse.json({ error: "Service already exists with this id" }, { status: 409 });
  }

  const result = await query(
    `INSERT INTO streaming_services (id, display_name, signup_url, cancel_url, logo_url, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, display_name.trim(), signup_url.trim(), cancel_url?.trim() || null, logo_url?.trim() || null, notes?.trim() || null]
  );

  await query(
    `INSERT INTO operator_audit_log (action, target_type, target_id, detail)
     VALUES ($1, $2, $3, $4)`,
    ["create_service", "streaming_service", id, JSON.stringify({ display_name: display_name.trim() })]
  );

  return NextResponse.json({ service: result.rows[0] }, { status: 201 });
});
