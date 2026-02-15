import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export async function POST(req: NextRequest) {
  let body: {
    contactType: "email" | "npub";
    contactValue: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { contactType, contactValue } = body;

  if (!contactType || !contactValue) {
    return NextResponse.json(
      { error: "Contact info required" },
      { status: 400 }
    );
  }

  if (contactType !== "email" && contactType !== "npub") {
    return NextResponse.json(
      { error: "contactType must be email or npub" },
      { status: 400 }
    );
  }

  // Validate email format
  if (contactType === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactValue)) {
    return NextResponse.json(
      { error: "Invalid email format" },
      { status: 400 }
    );
  }

  // Validate npub format (basic check)
  if (contactType === "npub" && !contactValue.startsWith("npub1")) {
    return NextResponse.json(
      { error: "Invalid npub format" },
      { status: 400 }
    );
  }

  // Check for duplicate
  if (contactType === "email") {
    const existing = await query(
      "SELECT id FROM waitlist WHERE email = $1",
      [contactValue.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      return NextResponse.json(
        { error: "You're already on the list." },
        { status: 409 }
      );
    }
  } else {
    const existing = await query(
      "SELECT id FROM waitlist WHERE nostr_npub = $1",
      [contactValue]
    );
    if (existing.rows.length > 0) {
      return NextResponse.json(
        { error: "You're already on the list." },
        { status: 409 }
      );
    }
  }

  await query(
    `INSERT INTO waitlist (email, nostr_npub)
     VALUES ($1, $2)`,
    [
      contactType === "email" ? contactValue.toLowerCase() : null,
      contactType === "npub" ? contactValue : null,
    ]
  );

  return NextResponse.json(
    { message: "You're in. We'll be in touch." },
    { status: 201 }
  );
}
